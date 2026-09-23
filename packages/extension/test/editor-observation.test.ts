import * as path from "node:path";
import { TAB_KINDS } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  type ObservedTab,
  type ZeroBasedRange,
  buildEditorLayout,
  capSelectionRange,
  coversWholeDocument,
  observedViewColumn,
  relativizeToRoot,
  visibleLineRange,
} from "../src/editor-observation.js";

/**
 * 人間の画面の観測を線上の形に落とす判断の検査。
 *
 * **なぜこのファイルが要るのか。** これらの判断は `editor-surface.ts` の中に
 * 直に書かれていて、そのファイルは `vscode` を値 import するため vitest から
 * 読み込めなかった。レビュアが `coversWholeDocument` を `false` に、
 * `openPaths` の打ち切りを削除に潰しても、単体613件・統合50件が**すべて緑**の
 * ままだった（実測）。判定を担う層に検査が1件も当たっていなかった。
 *
 * `vscode` に触る部分（`window.state.focused` / `activeTextEditor` /
 * `tabGroups`）だけが `editor-surface.ts` に残っている。そちらは実機の統合
 * テストで判別する（`trusted.test.ts` / `two-windows.test.ts`）。
 */

const root = { scheme: "file", authority: "", fsPath: path.posix.join("/work", "repo") };

function uri(
  fsPath: string,
  scheme = "file",
  authority = "",
): {
  scheme: string;
  authority: string;
  fsPath: string;
} {
  return { scheme, authority, fsPath };
}

describe("relativizeToRoot", () => {
  it("ルートの下のファイルは相対パスになる", () => {
    expect(relativizeToRoot(root, uri("/work/repo/src/a.ts"))).toBe("src/a.ts");
  });

  it("ルートが無ければ undefined（fail closed）", () => {
    expect(relativizeToRoot(undefined, uri("/work/repo/src/a.ts"))).toBeUndefined();
  });

  it("ワークスペースの外は undefined（絶対パスが『相対パス』の顔をして出ない）", () => {
    const outside = relativizeToRoot(root, uri("/work/outside/secret.txt"));
    expect(outside).toBeUndefined();
  });

  it("ルートそのものは undefined", () => {
    expect(relativizeToRoot(root, uri("/work/repo"))).toBeUndefined();
  });

  it("scheme が違えば undefined（untitled: / git: / output: は同じファイルではない）", () => {
    expect(relativizeToRoot(root, uri("/work/repo/src/a.ts", "untitled"))).toBeUndefined();
    expect(relativizeToRoot(root, uri("/work/repo/src/a.ts", "git"))).toBeUndefined();
  });

  it("authority が違えば undefined（別ホストの vscode-remote:）", () => {
    expect(
      relativizeToRoot(root, uri("/work/repo/src/a.ts", "file", "other-host")),
    ).toBeUndefined();
  });

  it("綴りの正規化は protocol を通る（コロンを含む名前は拒否される）", () => {
    // NTFS の代替データストリーム。`normalizeWorkspaceRelative` が拒否する。
    expect(relativizeToRoot(root, uri("/work/repo/.env::$DATA"))).toBeUndefined();
  });
});

describe("coversWholeDocument", () => {
  const whole: ZeroBasedRange = {
    startLine: 0,
    startCharacter: 0,
    endLine: 9,
    endCharacter: 12,
  };

  it("文書全体ちょうどを覆っていれば true", () => {
    expect(coversWholeDocument(whole, 9, 12)).toBe(true);
  });

  it("最終行の行末より後ろを指していても true（selectAll はその形になりうる）", () => {
    expect(coversWholeDocument({ ...whole, endLine: 10, endCharacter: 99 }, 9, 12)).toBe(true);
  });

  it("先頭が 0:0 でなければ false", () => {
    expect(coversWholeDocument({ ...whole, startCharacter: 1 }, 9, 12)).toBe(false);
    expect(coversWholeDocument({ ...whole, startLine: 1, startCharacter: 0 }, 9, 12)).toBe(false);
  });

  it("末尾が文書の終わりに届いていなければ false", () => {
    expect(coversWholeDocument({ ...whole, endLine: 8 }, 9, 12)).toBe(false);
    expect(coversWholeDocument({ ...whole, endCharacter: 11 }, 9, 12)).toBe(false);
  });

  it("空の文書（1行・0桁）を空でない選択が覆えば true", () => {
    expect(coversWholeDocument({ ...whole, endLine: 0, endCharacter: 0 }, 0, 0)).toBe(true);
  });
});

describe("visibleLineRange", () => {
  it("可視範囲が無ければ undefined", () => {
    expect(visibleLineRange([])).toBeUndefined();
  });

  it("1始まりに直す", () => {
    expect(visibleLineRange([{ startLine: 0, endLine: 4 }])).toEqual({ start: 1, end: 5 });
  });

  it("折り畳みで分かれていたら、最小と最大で畳む", () => {
    expect(
      visibleLineRange([
        { startLine: 10, endLine: 12 },
        { startLine: 2, endLine: 4 },
        { startLine: 30, endLine: 31 },
      ]),
    ).toEqual({ start: 3, end: 32 });
  });
});

describe("capSelectionRange", () => {
  /** どの行も 10 桁で終わる文書。 */
  const tenWide = (): number => 10;

  it("上限に収まる選択はそのまま返す", () => {
    const selection: ZeroBasedRange = {
      startLine: 2,
      startCharacter: 1,
      endLine: 2,
      endCharacter: 5,
    };
    expect(capSelectionRange(selection, tenWide, 100)).toEqual(selection);
  });

  it("1行の中で切り詰める", () => {
    const selection: ZeroBasedRange = {
      startLine: 2,
      startCharacter: 1,
      endLine: 2,
      endCharacter: 9,
    };
    expect(capSelectionRange(selection, tenWide, 3)).toEqual({
      startLine: 2,
      startCharacter: 1,
      endLine: 2,
      endCharacter: 4,
    });
  });

  it("改行も1文字として数える（行をまたぐと予算がその分減る）", () => {
    const selection: ZeroBasedRange = {
      startLine: 0,
      startCharacter: 8,
      endLine: 3,
      endCharacter: 10,
    };
    // 1行目に残り2文字 ＋ 改行1文字 = 3文字。予算5なら次の行で2文字ぶん。
    expect(capSelectionRange(selection, tenWide, 5)).toEqual({
      startLine: 0,
      startCharacter: 8,
      endLine: 1,
      endCharacter: 2,
    });
  });

  it("改行ちょうどで予算が尽きたら、その行の行末で止める", () => {
    const selection: ZeroBasedRange = {
      startLine: 0,
      startCharacter: 8,
      endLine: 3,
      endCharacter: 10,
    };
    // 残り2文字を消費して改行で 0 になる。行末（10桁）で止まる。
    expect(capSelectionRange(selection, tenWide, 3)).toEqual({
      startLine: 0,
      startCharacter: 8,
      endLine: 0,
      endCharacter: 10,
    });
  });

  it("上限 0 でも1文字は返す（0 桁の空範囲を作らない）", () => {
    const selection: ZeroBasedRange = {
      startLine: 0,
      startCharacter: 0,
      endLine: 5,
      endCharacter: 10,
    };
    expect(capSelectionRange(selection, tenWide, 0)).toEqual({
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 1,
    });
  });

  it("巨大な選択でも、繰り返しは上限の回数で必ず止まる", () => {
    // 100万行の選択に対して上限 10。行を辿る回数が上限で頭打ちになっていないと
    // ここで固まる（＝この検査は時間そのもので判別している）。
    let asked = 0;
    const counting = (): number => {
      asked += 1;
      return 0; // どの行も長さ 0。1行あたり改行の1文字しか進まない最悪形。
    };
    const capped = capSelectionRange(
      { startLine: 0, startCharacter: 0, endLine: 1_000_000, endCharacter: 0 },
      counting,
      10,
    );
    expect(capped.endLine).toBeLessThanOrEqual(10);
    expect(asked).toBeLessThanOrEqual(11);
  });
});

/**
 * 画面のレイアウトを畳む（設計 D37 / D37' / D38）。
 *
 * **1回の観測から `groups` と `openPaths` の2つを作る**（不変条件14）。
 * 別々に `tabGroups.all` を読むと、呼ぶタイミングの差で食い違う。
 */
describe("buildEditorLayout", () => {
  const isRedacted = (rel: string): boolean => rel === ".env" || rel.endsWith(".pem");
  const limits = { maxOpenPaths: 40, maxGroups: 8, maxTabsPerGroup: 24, maxLabelChars: 200 };

  // 戻り型を `ObservedTab` に固定してある ―― 雛形の形が面から渡ってくる形と
  // ずれていたら、検査が通る前に型が落ちる。
  const tab = (over: Partial<ObservedTab> = {}): ObservedTab => ({
    label: "index.ts",
    kind: "file",
    relPath: "src/index.ts",
    own: false,
    isActive: false,
    isDirty: false,
    isPinned: false,
    isPreview: false,
    visibleLines: undefined,
    ...over,
  });

  it("列とタブをそのまま写す", () => {
    const out = buildEditorLayout(
      [
        { viewColumn: 1, isActive: true, tabs: [tab(), tab({ label: "a.ts", relPath: "a.ts" })] },
        { viewColumn: 2, isActive: false, tabs: [tab({ label: "b.ts", relPath: "b.ts" })] },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0].viewColumn).toBe(1);
    expect(out.groups[0].isActive).toBe(true);
    expect(out.groups[0].tabs).toHaveLength(2);
    expect(out.groups[1].viewColumn).toBe(2);
    expect(out.groups[1].isActive).toBeUndefined();
  });

  it("秘匿ファイルの**名前は出る**（D37）", () => {
    const out = buildEditorLayout(
      [{ viewColumn: 1, isActive: true, tabs: [tab({ label: ".env", relPath: ".env" })] }],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs[0].label).toBe(".env");
    expect(out.groups[0].tabs[0].path).toBe(".env");
    expect(out.openPaths).toContain(".env");
  });

  it("秘匿ファイルの**可視行は出ない**（§1.4）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            tab({ label: ".env", relPath: ".env", visibleLines: { start: 1, end: 20 } }),
            tab({ visibleLines: { start: 5, end: 40 } }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    // 秘匿ファイル: 可視行だけが落ちる。**人間の操作に連動して動く量**だから。
    expect(out.groups[0].tabs[0].visibleLines).toBeUndefined();
    // 普通のファイル: 出る。
    expect(out.groups[0].tabs[1].visibleLines).toEqual({ start: 5, end: 40 });
  });

  it("秘匿ファイルでも動かない旗は出る（可視行だけを落としている）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            tab({
              label: "key.pem",
              relPath: "certs/key.pem",
              isDirty: true,
              isPinned: true,
              visibleLines: { start: 3, end: 9 },
            }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    const t = out.groups[0].tabs[0];
    expect(t.isDirty).toBe(true);
    expect(t.isPinned).toBe(true);
    expect(t.visibleLines).toBeUndefined();
  });

  /**
   * **ワークスペースの外のタブは可視行も返さない**（§1.4b。レビューで見つかった漏れ）。
   *
   * 初版は `redacted` だけで切っていた。外のタブは `relPath` が `undefined` な
   * ので `redacted` が false になり、名前は伏せたまま**スクロール窓だけが
   * 返っていた** ―― 実測で `~/.aws/credentials` に対して
   * `{"label":"(ワークスペース外)","visibleLines":{"start":1,"end":14}}`。
   * それは秘匿ファイルで落とすと決めたのと**同じ量**であり、しかも人間が
   * 許可すらしていないファイルについてである。
   */
  it("ワークスペース外のタブは可視行を返さない（名前だけ伏せても足りない）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 3,
          isActive: true,
          tabs: [
            tab({
              label: "credentials",
              relPath: undefined,
              isActive: true,
              isDirty: true,
              isPinned: true,
              visibleLines: { start: 1, end: 14 },
            }),
            // 対照。**通るべきものが通る**ことも見る（片方向だと、全部落とす
            // 実装でも緑になる）。
            tab({ relPath: "src/index.ts", visibleLines: { start: 2, end: 9 } }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    const outside = out.groups[0].tabs[0];
    expect(outside.visibleLines).toBeUndefined();
    expect(Object.hasOwn(outside, "visibleLines")).toBe(false);
    // §1.4b が許すもの（列・順序・種類・アクティブ・未保存・ピン留め）は残る。
    expect(out.groups[0].viewColumn).toBe(3);
    expect(outside.kind).toBe("file");
    expect(outside.isActive).toBe(true);
    expect(outside.isDirty).toBe(true);
    expect(outside.isPinned).toBe(true);
    // 中のファイルは今までどおり返る。
    expect(out.groups[0].tabs[1].visibleLines).toEqual({ start: 2, end: 9 });
  });

  it("どのタブも path が無ければ可視行も無い（種類を問わず）", () => {
    // 1件ずつ思い出すのではなく、**組み合わせを走査して**塞ぐ。
    //
    // **語彙は直書きせず `TAB_KINDS` を回す。** 直書きすると、種類を足したときに
    // この掃き掃除だけが古い一覧のまま緑になる ―― 新しい種類は一度も
    // 走査されないまま「どのタブも塞いだ」と言うことになる。
    // （`wire.test.ts` も同じ理由で `TAB_KINDS` を回している。）
    const kinds = TAB_KINDS;
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: kinds.map((kind) =>
            tab({
              kind: kind as ObservedTab["kind"],
              relPath: undefined,
              visibleLines: { start: 1, end: 99 },
            }),
          ),
        },
      ],
      isRedacted,
      limits,
    );
    for (const t of out.groups[0].tabs) {
      expect(t.path).toBeUndefined();
      expect(t.visibleLines, `${t.kind} で可視行が返った`).toBeUndefined();
    }
  });

  /**
   * **名前を出すかどうかは種類も見る**（構造で閉じる）。
   *
   * `relPath` が立っていることだけを根拠にすると、安全は「面が
   * `TabInputWebview` に URI を付けない」という別のファイルの作法に乗る。
   * 次に足された入口が付けた瞬間、他人のパネルの題とパスが素通りする。
   */
  it("文書でない種類は relPath があっても名前を出さない", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            tab({ kind: "webview", label: "Copilot Chat", relPath: "src/index.ts" }),
            tab({ kind: "terminal", label: "zsh - /home/me/.aws", relPath: "src/index.ts" }),
            tab({ kind: "other", label: "Settings", relPath: "src/index.ts" }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs.map((t) => t.label)).toEqual(["(other)", "(terminal)", "(other)"]);
    for (const t of out.groups[0].tabs) expect(t.path).toBeUndefined();
    // `openPaths` も同じ答えを使う（1箇所で決める）。
    expect(out.openPaths).toEqual([]);
  });

  it("ワークスペース外のファイル名は返さない（D37'）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [tab({ label: "credentials", relPath: undefined })],
        },
      ],
      isRedacted,
      limits,
    );
    const t = out.groups[0].tabs[0];
    expect(t.label).toBe("(outside workspace)");
    expect(t.path).toBeUndefined();
    // タブ自体は消えない ―― レイアウトに穴を空けない。
    expect(out.groups[0].tabs).toHaveLength(1);
    expect(out.openPaths).toEqual([]);
  });

  it("端末の見出しは返さない（D37'）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [tab({ kind: "terminal", label: "zsh - /home/me/.aws", relPath: undefined })],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs[0].label).toBe("(terminal)");
    expect(out.groups[0].tabs[0].kind).toBe("terminal");
  });

  it("自分の webview は題をそのまま出し、own が立つ（D41）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 2,
          isActive: false,
          tabs: [tab({ kind: "webview", label: "構成図", relPath: undefined, own: true })],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs[0].label).toBe("構成図");
    expect(out.groups[0].tabs[0].own).toBe(true);
  });

  it("自分の webview には slot が付く。面が渡した値をそのまま写す（C5 / D61）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 2,
          isActive: false,
          tabs: [
            tab({ kind: "webview", label: "前の図", relPath: undefined, own: true, slot: 1 }),
            tab({ kind: "webview", label: "今の図", relPath: undefined, own: true, slot: 2 }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs.map((t) => t.slot)).toEqual([1, 2]);
    expect(out.groups[0].tabs.map((t) => t.own)).toEqual([true, true]);
  });

  it("slot が無い（人間の webview・テキストタブ）なら欄ごと省く", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            tab(),
            tab({ kind: "webview", label: "Copilot Chat", relPath: undefined, own: false }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    for (const t of out.groups[0].tabs) expect("slot" in t).toBe(false);
  });

  it("他人の webview は題を出さない（D37'）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 2,
          isActive: false,
          tabs: [tab({ kind: "webview", label: "Copilot Chat", relPath: undefined, own: false })],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.groups[0].tabs[0].label).toBe("(other)");
    expect(out.groups[0].tabs[0].own).toBeUndefined();
  });

  it("差分・ノートブックも外なら「(ワークスペース外)」、種類不明は「(その他)」", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            tab({ kind: "diff", label: "secrets.yml (Working Tree)", relPath: undefined }),
            tab({ kind: "notebook", label: "private.ipynb", relPath: undefined }),
            tab({ kind: "notebook-diff", label: "private.ipynb (diff)", relPath: undefined }),
            tab({ kind: "other", label: "Settings", relPath: undefined }),
          ],
        },
      ],
      isRedacted,
      limits,
    );
    const labels = out.groups[0].tabs.map((t) => t.label);
    expect(labels).toEqual([
      "(outside workspace)",
      "(outside workspace)",
      "(outside workspace)",
      "(other)",
    ]);
  });

  it("状態の旗は false のとき欄ごと省く", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [tab({ isDirty: true, isPinned: false, isPreview: true, isActive: true })],
        },
      ],
      isRedacted,
      limits,
    );
    const t = out.groups[0].tabs[0];
    expect(t.isDirty).toBe(true);
    expect(t.isPreview).toBe(true);
    expect(t.isActive).toBe(true);
    expect(t.isPinned).toBeUndefined();
    expect(Object.hasOwn(t, "isPinned")).toBe(false);
  });

  it("openPaths は groups と同じ観測から作る（重複を潰し、順序を保つ）", () => {
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [tab({ relPath: "a.ts" }), tab({ relPath: "b.ts" })],
        },
        {
          viewColumn: 2,
          isActive: false,
          tabs: [tab({ relPath: "a.ts" }), tab({ relPath: "c.ts" })],
        },
      ],
      isRedacted,
      limits,
    );
    expect(out.openPaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("列・タブ・パスに上限がある", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => tab({ relPath: `f${i}.ts` }));
    const out = buildEditorLayout(
      Array.from({ length: 20 }, (_, c) => ({
        viewColumn: c + 1,
        isActive: c === 0,
        tabs: many(50),
      })),
      isRedacted,
      { maxOpenPaths: 5, maxGroups: 3, maxTabsPerGroup: 4, maxLabelChars: 200 },
    );
    expect(out.groups).toHaveLength(3);
    expect(out.groups[0].tabs).toHaveLength(4);
    expect(out.openPaths).toHaveLength(5);
  });

  it("openPaths は列・タブの**表示**上限では削らない（自分の上限だけで切る）", () => {
    // 1列に26枚。表示は maxTabsPerGroup=4 で切るが、平坦な一覧は
    // maxOpenPaths=40 まで載る。ここを表示上限で切ると
    // 「`openPaths.length === 上限` なら溢れている」という合図が壊れ、
    // 溢れていないのに溢れたように（あるいは逆に）読めてしまう。
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: Array.from({ length: 26 }, (_, i) => tab({ relPath: `f${i}.ts` })),
        },
      ],
      isRedacted,
      { maxOpenPaths: 40, maxGroups: 8, maxTabsPerGroup: 4, maxLabelChars: 200 },
    );
    expect(out.groups[0].tabs).toHaveLength(4);
    expect(out.openPaths).toHaveLength(26);
    expect(out.openPaths[25]).toBe("f25.ts");
  });

  it("見出しは長さで切る", () => {
    const out = buildEditorLayout(
      [{ viewColumn: 1, isActive: true, tabs: [tab({ label: "あ".repeat(500) })] }],
      isRedacted,
      { ...limits, maxLabelChars: 10 },
    );
    expect(out.groups[0].tabs[0].label.length).toBeLessThanOrEqual(10);
  });

  it("どの見出しも同じ切り詰めを通る（置き換えた固定文字列も）", () => {
    // 上限は1箇所で決める。置き換えた見出しだけ素通りさせると、
    // 「見出しは高々 maxLabelChars 文字」という量が2箇所で決まることになる。
    const out = buildEditorLayout(
      [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [tab({ label: "/home/me/.aws/credentials", relPath: undefined })],
        },
      ],
      isRedacted,
      { ...limits, maxLabelChars: 3 },
    );
    expect(out.groups[0].tabs[0].label).toBe("(o…");
  });

  it("観測が空なら空のレイアウト", () => {
    const out = buildEditorLayout([], isRedacted, limits);
    expect(out).toEqual({ groups: [], openPaths: [] });
  });
});

/**
 * **列番号の読めた／読めないは、この1つの述語で決める**（不変条件14）。
 *
 * `get_editor_state` の `groups`（`editor-surface.ts`）と `arrange_editors` の人間の列
 * （`arrange-surface.ts`）は同じ量を読む。別々に書くと後から書いたほうが緩くなる
 * ―― 実際 `typeof === "number"` だけの版は `ViewColumn.Active`（-1）を通した。
 */
describe("observedViewColumn", () => {
  it("1 以上の整数はそのまま返す", () => {
    for (const v of [1, 2, 3, 9]) expect(observedViewColumn(v)).toBe(v);
  });

  it("負の別名（Active = -1 / Beside = -2）と 0 は観測ではない", () => {
    for (const v of [-1, -2, 0]) expect(observedViewColumn(v), String(v)).toBeUndefined();
  });

  it("整数でない・数でないものは観測ではない（1 に丸めない）", () => {
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "1", {}]) {
      expect(observedViewColumn(v), String(v)).toBeUndefined();
    }
  });
});
