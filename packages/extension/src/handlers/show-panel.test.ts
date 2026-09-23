import { DEFAULT_PANEL_LIMIT, MAX_HTML_CHARS, type PanelLimit } from "@zvx/vscode-showme-protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../tool-error.js";
import { DEFAULT_PANEL_TITLE, type PanelSurface, handleShowHtml, panelTitle } from "./show-html.js";
import { handleShowNote } from "./show-note.js";

/**
 * 図とメモのハンドラ。**表示面は偽物を注入して、判断だけを見る。**
 */

function fakePanel() {
  const shown: Array<{ html: string; title: string }> = [];
  /** `refreshHtml` で差し替えられた中身（reveal しない経路）。`shown` とは別に数える。 */
  const refreshed: string[] = [];
  const watches: Array<{ relPath: string; rerender: () => Promise<void> }> = [];
  let unwatched = 0;
  const surface: PanelSurface = {
    async showHtml(html: string, title: string) {
      shown.push({ html, title });
    },
    async refreshHtml(html: string) {
      refreshed.push(html);
    },
    watch(relPath, rerender) {
      watches.push({ relPath, rerender });
    },
    unwatch() {
      unwatched += 1;
    },
  };
  return {
    shown,
    refreshed,
    watches,
    unwatchCount: () => unwatched,
    surface,
  };
}

const log = { info: () => {} };

/**
 * `readFile` を省いた deps（`html` の経路は読まない）。省くと `undefined` を返す。
 * `panel` を1枚渡すと、それが**枠1**になる（枠2は空の面。触られたら分かるように別の偽物）。
 */
function deps(
  over: Partial<Parameters<typeof handleShowHtml>[1]> & { panel: PanelSurface },
): Parameters<typeof handleShowHtml>[1] {
  const { panel, ...rest } = over;
  const other = fakePanel();
  return {
    log,
    readFile: () => undefined,
    panels: (slot) => (slot === 1 ? panel : other.surface),
    maxPanels: () => DEFAULT_PANEL_LIMIT,
    ...rest,
  };
}

/** 既定の上限（2）で、枠ごとの面を持つ deps。`panels` は spy（断ったときに呼ばれないことを見る）。 */
function slottedDeps(maxPanels: () => PanelLimit) {
  const surfaces = new Map<number, ReturnType<typeof fakePanel>>();
  const panels = vi.fn((slot: number): PanelSurface => {
    let p = surfaces.get(slot);
    if (p === undefined) {
      p = fakePanel();
      surfaces.set(slot, p);
    }
    return p.surface;
  });
  return { deps: { log, readFile: () => undefined, panels, maxPanels }, panels, surfaces };
}

describe("panelTitle", () => {
  it("未指定なら既定", () => {
    expect(panelTitle(undefined)).toBe(DEFAULT_PANEL_TITLE);
    expect(panelTitle("   ")).toBe(DEFAULT_PANEL_TITLE);
  });

  it("codicon 記法を壊す（偽の状態表示を描かせない）", () => {
    // タブに出る文字列である。`$(check)` を通すとアイコンとして展開される。
    expect(panelTitle("$(check) 正常")).not.toContain("$(check)");
  });

  it("双方向オーバーライドを可視化する", () => {
    expect(panelTitle("a\u202Eb")).not.toContain("\u202E");
  });

  it("我々の名前が必ず先に来る（なりすまし防止）", () => {
    expect(panelTitle("VS Code")).toBe("ShowMe: VS Code");
  });
});

describe("show_html", () => {
  it("サニタイザを通ってから表示面に渡る", async () => {
    const panel = fakePanel();
    const result = await handleShowHtml(
      { kind: "html", slot: 1, html: '<p>a</p><script>fetch("https://evil.example")</script>' },
      deps({ panel: panel.surface }),
    );
    expect(result).toEqual({ shown: true, droppedDeclarations: 0 });
    expect(panel.shown).toHaveLength(1);
    expect(panel.shown[0]?.html).not.toContain("evil.example");
    expect(panel.shown[0]?.html).toContain("a");
  });

  it("slot: 2 は枠2の面に出し、枠1の面は触らない（D61）", async () => {
    const first = fakePanel();
    const second = fakePanel();
    const panels = (slot: number) => (slot === 1 ? first.surface : second.surface);
    const maxPanels = () => DEFAULT_PANEL_LIMIT;
    const result = await handleShowHtml(
      { kind: "html", html: "<p>b</p>", slot: 2 },
      { log, readFile: () => undefined, panels, maxPanels },
    );
    expect(result).toEqual({ shown: true, droppedDeclarations: 0 });
    expect(second.shown).toHaveLength(1);
    expect(second.shown[0]?.html).toContain("b");
    expect(first.shown).toHaveLength(0);
    // `html` は見張りを止めるが、それも**枠2だけ**（枠1の見張りは独立。C4）。
    expect(second.unwatchCount()).toBe(1);
    expect(first.unwatchCount()).toBe(0);
    // 対照: slot: 1 は枠1に出る。
    await handleShowHtml(
      { kind: "html", html: "<p>a</p>", slot: 1 },
      { log, readFile: () => undefined, panels, maxPanels },
    );
    expect(first.shown).toHaveLength(1);
    expect(second.shown).toHaveLength(1);
  });

  it("path は枠ごとに見張る（slot 2 の path が slot 1 の見張りを止めない）", async () => {
    const first = fakePanel();
    const second = fakePanel();
    const panels = (slot: number) => (slot === 1 ? first.surface : second.surface);
    const maxPanels = () => DEFAULT_PANEL_LIMIT;
    const readFile = (rel: string) => (rel === "a.html" ? "<p>a</p>" : "<p>bb</p>");
    await handleShowHtml(
      { kind: "path", path: "a.html", slot: 1 },
      { log, readFile, panels, maxPanels },
    );
    await handleShowHtml(
      { kind: "path", path: "b.html", slot: 2 },
      { log, readFile, panels, maxPanels },
    );
    expect(first.watches.map((w) => w.relPath)).toEqual(["a.html"]);
    expect(second.watches.map((w) => w.relPath)).toEqual(["b.html"]);
    // 枠2の見張りが火を吹いても枠1は描き直らない。
    await second.watches[0]?.rerender();
    expect(second.refreshed).toHaveLength(1);
    expect(first.refreshed).toHaveLength(0);
  });

  it("回数制限を超えたら rate-limited で拒否する", async () => {
    const panel = fakePanel();
    await expect(
      handleShowHtml(
        { kind: "html", slot: 1, html: "<p>a</p>" },
        deps({ panel: panel.surface, allowCall: () => false }),
      ),
    ).rejects.toBeInstanceOf(ToolError);
    expect(panel.shown).toHaveLength(0);
  });
});

/**
 * パネルの上限は人間の設定（増分6.2 D80）。**判定は `handleShowHtml` の1箇所**で、
 * 比較そのものは protocol の `panelSlotAllowed`。スキーマは上限を知らない（`slot: 3` は線を通る）
 * ので、ここで断らないと3枚目が黙って出る。断るときは**面を引く前**に断る ―― `deps.panels` が
 * 呼ばれると、要るときに作る `Map` にパネルが生まれる（上限を越えた枠の実体ができる）。
 */
describe("show_html の上限（D80: showme.html.maxPanels）", () => {
  const table: Array<{ max: PanelLimit; slot: number; shown: boolean }> = [
    { max: 1, slot: 1, shown: true },
    { max: 1, slot: 2, shown: false },
    { max: 2, slot: 1, shown: true },
    { max: 2, slot: 2, shown: true },
    { max: 2, slot: 3, shown: false },
    { max: 2, slot: 999, shown: false },
    { max: 5, slot: 5, shown: true },
    { max: 5, slot: 6, shown: false },
    { max: "unlimited", slot: 1, shown: true },
    { max: "unlimited", slot: 10, shown: true },
    { max: "unlimited", slot: 999, shown: true },
  ];
  for (const { max, slot, shown } of table) {
    it(`max ${String(max)} × slot ${slot} → ${shown ? "出す" : "invalid-request で断る"}`, async () => {
      const d = slottedDeps(() => max);
      const call = handleShowHtml({ kind: "html", html: "<p>x</p>", slot }, d.deps);
      if (shown) {
        await expect(call).resolves.toEqual({ shown: true, droppedDeclarations: 0 });
        expect(d.panels).toHaveBeenCalledTimes(1);
        expect(d.panels).toHaveBeenCalledWith(slot);
        expect(d.surfaces.get(slot)?.shown).toHaveLength(1);
      } else {
        await expect(call).rejects.toMatchObject({ code: "invalid-request" });
        // **面を引かない**（引くと上限を越えた枠の実体が生まれる）。
        expect(d.panels).not.toHaveBeenCalled();
        expect(d.surfaces.size).toBe(0);
      }
    });
  }

  it("断りの文言は枠と上限を言う（人間が途中で設定を変えても、エージェントは文言で上限を知る）", async () => {
    const d = slottedDeps(() => 2);
    await expect(
      handleShowHtml({ kind: "html", html: "<p>x</p>", slot: 3 }, d.deps),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "slot 3 exceeds showme.html.maxPanels (2)",
    });
    const five = slottedDeps(() => 5);
    await expect(
      handleShowHtml({ kind: "path", path: "a.html", slot: 7 }, five.deps),
    ).rejects.toMatchObject({ message: "slot 7 exceeds showme.html.maxPanels (5)" });
  });

  it("path でも上限は同じ1箇所で、読む前に断る（readFile を呼ばない ―― 断りが存在の口にならない）", async () => {
    const d = slottedDeps(() => 1);
    const readFile = vi.fn(() => "<p>secret-ish</p>");
    await expect(
      handleShowHtml({ kind: "path", path: "a.html", slot: 2 }, { ...d.deps, readFile }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(readFile).not.toHaveBeenCalled();
    expect(d.panels).not.toHaveBeenCalled();
  });

  it("上限は呼び出しのたびに読む（人間が途中で設定を変えたら次の呼び出しから効く）", async () => {
    let max: PanelLimit = 2;
    const d = slottedDeps(() => max);
    await expect(
      handleShowHtml({ kind: "html", html: "<p>x</p>", slot: 3 }, d.deps),
    ).rejects.toMatchObject({ code: "invalid-request" });
    max = 3;
    await expect(
      handleShowHtml({ kind: "html", html: "<p>x</p>", slot: 3 }, d.deps),
    ).resolves.toEqual({ shown: true, droppedDeclarations: 0 });
    max = 2;
    await expect(
      handleShowHtml({ kind: "html", html: "<p>x</p>", slot: 3 }, d.deps),
    ).rejects.toMatchObject({ message: "slot 3 exceeds showme.html.maxPanels (2)" });
  });

  it("回数制限が上限より先（断られた呼び出しも予算を食う。上限の断りを回数の外に置かない）", async () => {
    const d = slottedDeps(() => 2);
    await expect(
      handleShowHtml(
        { kind: "html", html: "<p>x</p>", slot: 3 },
        { ...d.deps, allowCall: () => false },
      ),
    ).rejects.toMatchObject({ code: "rate-limited" });
  });
});

describe("show_note", () => {
  function fakeNotes(initial?: { uri: string; version: number; isClosed: boolean }) {
    let observed = initial;
    const calls: string[] = [];
    return {
      calls,
      surface: {
        observe: () => observed,
        async openNew(_text: string, _language: string) {
          calls.push("openNew");
          observed = { uri: "untitled:Untitled-9", version: 1, isClosed: false };
          return { uri: observed.uri, version: observed.version };
        },
        async replace(_text: string) {
          calls.push("replace");
          if (observed === undefined) throw new Error("no doc");
          observed = { ...observed, version: observed.version + 1 };
          return { uri: observed.uri, version: observed.version };
        },
      },
    };
  }

  it("初回は新しいドキュメントを開く", async () => {
    const notes = fakeNotes();
    const remember = vi.fn();
    const result = await handleShowNote(
      { text: "メモ" },
      { notes: notes.surface, lastWrite: () => undefined, rememberWrite: remember, log },
    );
    expect(result).toEqual({ shown: true, reusedDocument: false });
    expect(notes.calls).toEqual(["openNew"]);
    expect(remember).toHaveBeenCalledWith({ uri: "untitled:Untitled-9", version: 1 });
  });

  it("誰も触っていなければ同じドキュメントを使い回す", async () => {
    const notes = fakeNotes({ uri: "untitled:Untitled-1", version: 5, isClosed: false });
    const result = await handleShowNote(
      { text: "メモ2" },
      {
        notes: notes.surface,
        lastWrite: () => ({ uri: "untitled:Untitled-1", version: 5 }),
        rememberWrite: () => {},
        log,
      },
    );
    expect(result).toEqual({ shown: true, reusedDocument: true });
    expect(notes.calls).toEqual(["replace"]);
  });

  it("人間が編集していたら上書きせず新しく開く", async () => {
    // **これが人間の書いたものを守っている経路である。**
    const notes = fakeNotes({ uri: "untitled:Untitled-1", version: 6, isClosed: false });
    const result = await handleShowNote(
      { text: "メモ3" },
      {
        notes: notes.surface,
        lastWrite: () => ({ uri: "untitled:Untitled-1", version: 5 }),
        rememberWrite: () => {},
        log,
      },
    );
    expect(result).toEqual({ shown: true, reusedDocument: false });
    expect(notes.calls).toEqual(["openNew"]);
  });

  it("回数制限を超えたら何も開かない", async () => {
    const notes = fakeNotes();
    await expect(
      handleShowNote(
        { text: "メモ" },
        {
          notes: notes.surface,
          lastWrite: () => undefined,
          rememberWrite: () => {},
          allowCall: () => false,
          log,
        },
      ),
    ).rejects.toBeInstanceOf(ToolError);
    expect(notes.calls).toEqual([]);
  });
});

describe("落とした宣言の件数がエージェントに返る（実地で気づけなかったため）", () => {
  it("show_html は落とした数を返す", async () => {
    const panel = fakePanel();
    const result = await handleShowHtml(
      { kind: "html", slot: 1, html: '<p style="color:#111; position:fixed">a</p>' },
      deps({ panel: panel.surface }),
    );
    expect(result.droppedDeclarations).toBe(1);
  });
});

/**
 * `show_html` の `path`（設計 D52 / C4）。
 *
 * **関門は `readFile`（= `readWorkspaceFile`）が持つ。** ここでは `readFile` の
 * 戻りだけを見て、パスの判定を足していないことを検査する（「読めない」は
 * 理由を問わず1つの code）。
 */
describe("show_html の path（D52 / C4）", () => {
  it("path のときは readFile で読み、同じサニタイザを通して出す", async () => {
    const panel = fakePanel();
    const readFile = vi.fn(() => '<p>ok</p><img src="https://evil.example/x">');
    const result = await handleShowHtml(
      { kind: "path", slot: 1, path: "docs/a.html" },
      deps({ readFile, panel: panel.surface }),
    );
    expect(readFile).toHaveBeenCalledWith("docs/a.html");
    expect(panel.shown).toHaveLength(1);
    expect(panel.shown[0]?.html).toContain("<p>ok</p>");
    expect(panel.shown[0]?.html).not.toContain("evil.example");
    // 鍵は2つだけ（不変条件2）。中身も長さも返らない。
    expect(result).toEqual({ shown: true, droppedDeclarations: 0 });
    expect(Object.keys(result).sort()).toEqual(["droppedDeclarations", "shown"]);
  });

  it("読めなければ excluded-path で断る。理由は1つ（存在も中身も漏らさない）", async () => {
    for (const rel of [".env", ".env.nope", "nope.html", "../outside.html"]) {
      const panel = fakePanel();
      await expect(
        handleShowHtml(
          { kind: "path", slot: 1, path: rel },
          deps({ readFile: () => undefined, panel: panel.surface }),
        ),
      ).rejects.toMatchObject({ code: "excluded-path" });
      expect(panel.shown).toHaveLength(0);
      expect(panel.watches).toHaveLength(0);
    }
  });

  it("読めない path でも呼び出しは回数制限に数える（オラクル対策の前段）", async () => {
    const allowCall = vi.fn(() => true);
    const panel = fakePanel();
    await expect(
      handleShowHtml(
        { kind: "path", slot: 1, path: ".env" },
        deps({ allowCall, readFile: () => undefined, panel: panel.surface }),
      ),
    ).rejects.toMatchObject({ code: "excluded-path" });
    expect(allowCall).toHaveBeenCalledTimes(1);
  });

  it("読んだ中身が MAX_HTML_CHARS を超えたら invalid-request（単位は文字。inline と同じ上限）", async () => {
    const panel = fakePanel();
    await expect(
      handleShowHtml(
        { kind: "path", slot: 1, path: "big.html" },
        deps({ readFile: () => "x".repeat(MAX_HTML_CHARS + 1), panel: panel.surface }),
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(panel.shown).toHaveLength(0);
    // 肯定対照: ちょうど上限は通る。
    const ok = fakePanel();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "big.html" },
      deps({ readFile: () => "x".repeat(MAX_HTML_CHARS), panel: ok.surface }),
    );
    expect(ok.shown).toHaveLength(1);
  });

  it("title の既定はファイル名（basename）。指定があればそちら", async () => {
    const panel = fakePanel();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "docs/overview.html" },
      deps({ readFile: () => "<p>x</p>", panel: panel.surface }),
    );
    expect(panel.shown[0]?.title).toBe("ShowMe: overview.html");
    await handleShowHtml(
      { kind: "path", slot: 1, path: "docs/overview.html", title: "図" },
      deps({ readFile: () => "<p>x</p>", panel: panel.surface }),
    );
    expect(panel.shown[1]?.title).toBe("ShowMe: 図");
  });

  it("path のときは見張りを登録し、html のときは登録せず前の見張りを止める", async () => {
    const panel = fakePanel();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "a.html" },
      deps({ readFile: () => "<p>x</p>", panel: panel.surface }),
    );
    expect(panel.watches).toHaveLength(1);
    expect(panel.watches[0]?.relPath).toBe("a.html");
    expect(panel.unwatchCount()).toBe(0);

    await handleShowHtml(
      { kind: "html", slot: 1, html: "<p>y</p>" },
      deps({ panel: panel.surface }),
    );
    expect(panel.watches).toHaveLength(1);
    expect(panel.unwatchCount()).toBe(1);
  });

  it("再描画の閉包は関門を通り直し、読めなければ描き直さない（そのまま）", async () => {
    const panel = fakePanel();
    let content: string | undefined = "<p>v1</p>";
    const readFile = vi.fn(() => content);
    await handleShowHtml(
      { kind: "path", slot: 1, path: "a.html" },
      deps({ readFile, panel: panel.surface }),
    );
    const rerender = panel.watches[0]?.rerender;
    expect(rerender).toBeDefined();
    if (rerender === undefined) return;

    content = '<p>v2</p><img src="https://evil.example/y">';
    await rerender();
    expect(readFile).toHaveBeenCalledTimes(2);
    // **再描画は `refreshHtml`（reveal しない経路）で、`showHtml` は初回の1回だけ。**
    // 保存のたびに `showHtml` を呼ぶと、パネルが列の前面に出て人間のタブを奪う。
    expect(panel.shown).toHaveLength(1);
    expect(panel.refreshed).toHaveLength(1);
    expect(panel.refreshed[0]).toContain("v2");
    // 再描画も同じサニタイザを通る（不変条件7）。
    expect(panel.refreshed[0]).not.toContain("evil.example");

    // 秘匿になった／消えた／リンクが外を指した ―― 描き直さない。投げもしない。
    content = undefined;
    await expect(rerender()).resolves.toBeUndefined();
    expect(panel.refreshed).toHaveLength(1);

    // 大きすぎる ―― これも描き直さない。
    content = "x".repeat(MAX_HTML_CHARS + 1);
    await expect(rerender()).resolves.toBeUndefined();
    expect(panel.refreshed).toHaveLength(1);

    // 読める状態に戻れば、また描く。
    content = "<p>v3</p>";
    await rerender();
    expect(panel.refreshed).toHaveLength(2);
    expect(panel.refreshed[1]).toContain("v3");
    expect(panel.shown).toHaveLength(1);
  });

  it("再描画の失敗は記録だけして投げない（線に載せる先が無い）", async () => {
    const panel = fakePanel();
    panel.surface.refreshHtml = async () => {
      throw new Error("webview が消えた");
    };
    const info = vi.fn();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "a.html" },
      deps({ readFile: () => "<p>x</p>", panel: panel.surface, log: { info } }),
    );
    info.mockClear();
    const rerender = panel.watches[0]?.rerender;
    if (rerender === undefined) throw new Error("見張りが無い");
    await expect(rerender()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    // 記録に理由の文字列を載せない。
    expect(JSON.stringify(info.mock.calls[0])).not.toContain("webview が消えた");
  });

  it("title の既定は関門と同じ正規化を通した basename（生の綴りをそのまま切らない）", async () => {
    const panel = fakePanel();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "docs\\overview.html" },
      deps({ readFile: () => "<p>x</p>", panel: panel.surface }),
    );
    expect(panel.shown[0]?.title).toBe("ShowMe: overview.html");
  });

  it("再描画は回数制限に数えない（人間の保存の速さで有界）", async () => {
    const allowCall = vi.fn(() => true);
    const panel = fakePanel();
    await handleShowHtml(
      { kind: "path", slot: 1, path: "a.html" },
      deps({ allowCall, readFile: () => "<p>x</p>", panel: panel.surface }),
    );
    expect(allowCall).toHaveBeenCalledTimes(1);
    allowCall.mockClear();
    const rerender = panel.watches[0]?.rerender;
    if (rerender === undefined) throw new Error("見張りが無い");
    await rerender();
    await rerender();
    expect(allowCall).not.toHaveBeenCalled();
    expect(panel.refreshed).toHaveLength(2);
  });

  it("初回は readFile を1回しか呼ばない（判定と描画で読み直さない）", async () => {
    const panel = fakePanel();
    const readFile = vi.fn(() => "<p>x</p>");
    await handleShowHtml(
      { kind: "path", slot: 1, path: "a.html" },
      deps({ readFile, panel: panel.surface }),
    );
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
