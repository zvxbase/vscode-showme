import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REDACTED_PATTERNS } from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ShowMeConfig } from "../src/config.js";
import {
  type LineRange,
  type ShowCodeDeps,
  type StagePlacement,
  handleShowCode,
} from "../src/handlers/show-code.js";
import type { SymbolLookup, SymbolSurface } from "../src/handlers/symbol-prefetch.js";
import { MIN_MS_SINCE_OWN_TOOL_CALL, OwnToolCallClock } from "../src/human-selection.js";
import { RATE_LIMIT_MAX_HITS, RateLimiter } from "../src/rate-limit.js";

/**
 * `handleShowCode` の単体テスト。
 *
 * これが1件も無かったせいで、3本の防御のうち2本が判別されていなかった（実測）:
 *
 *   - `flashMiss` / `flashManyMatches` の呼び出しを消す → 単体・統合とも全部緑
 *   - `if (!limiter.allow(key))` を `if (false)` にする → 単体・統合とも全部緑
 *
 * 設計書 §5.4 は空振りの可視化を「デバッグ用のログではなく**実装要件**」と
 * 明記している。要件なら、壊したときに落ちる検査が要る。
 *
 * ファイルシステムは本物を使う。シンボリックリンクの別名が同じ予算を引くか
 * （B1）は、実際にリンクを置かないと確かめられない。
 */

const made: string[] = [];
function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "showme-handler-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const config: ShowMeConfig = {
  enabled: true,
  features: { stage: true, html: true, layout: true },
  editorGroup: "dedicated",
  html: { maxPanels: 2 },
  redactedPathPatterns: [...DEFAULT_REDACTED_PATTERNS],
  maxSelectionChars: 4000,
  injectTerminalEnv: true,
  listAllWorkspaces: false,
  layout: { closeHumanTabs: false, closeDirtyTabs: false },
};

/** `stage` を切った設定（増分6 D76）。他は既定のまま。 */
const stageOff: ShowMeConfig = {
  ...config,
  features: { ...config.features, stage: false },
};

/**
 * シンボルを引く面の偽物。**何を引かれたかを記録する。**
 *
 * 記録が要るのは「除外パスでは一度も引かない」を見るためで、そこが
 * 判別しないと、`.env` の文書を開く経路が黙って開く。
 */
interface SymbolSpy extends SymbolSurface {
  asked: { relPath: string; name: string }[];
}

function symbolSpy(answer: SymbolLookup): SymbolSpy {
  const asked: { relPath: string; name: string }[] = [];
  return {
    asked,
    lookup: async (relPath, name) => {
      asked.push({ relPath, name });
      return answer;
    },
  };
}

interface Spy {
  deps: ShowCodeDeps;
  revealed: { relPath: string; range: LineRange; placement: StagePlacement }[];
  /** `setSpotlight` の呼び出し1回ごとに、渡された窓を丸ごと記録する。 */
  spotlights: ReadonlyMap<string, readonly LineRange[]>[];
  miss: { path: string; needle: string }[];
  many: { path: string; needle: string }[];
  limited: string[];
  /** `flashMarked` の呼び出し（印だけのとき、人間が場所を探す手がかり。D76）。 */
  marked: { path: string; line: number }[];
  logged: string[];
}

function spy(
  root: string | undefined,
  options: {
    limiter?: RateLimiter;
    revealFails?: boolean;
    clock?: OwnToolCallClock;
    symbols?: SymbolSurface;
    config?: ShowMeConfig;
  } = {},
): Spy {
  const revealed: Spy["revealed"] = [];
  const spotlights: Spy["spotlights"] = [];
  const miss: Spy["miss"] = [];
  const many: Spy["many"] = [];
  const limited: string[] = [];
  const marked: Spy["marked"] = [];
  const logged: string[] = [];
  const limiter = options.limiter ?? new RateLimiter();
  const cfg = options.config ?? config;
  return {
    revealed,
    spotlights,
    miss,
    many,
    limited,
    marked,
    logged,
    deps: {
      config: () => cfg,
      workspaceRoot: root,
      limiter,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.symbols === undefined ? {} : { symbols: options.symbols }),
      editor: {
        reveal: async (relPath, range, placement) => {
          if (options.revealFails === true) throw new Error("エディタを開けない");
          revealed.push({ relPath, range, placement });
        },
        setSpotlight: (byPath) => {
          spotlights.push(byPath);
        },
      },
      log: { info: (message) => logged.push(message) },
      statusBar: {
        flashMiss: (p, needle) => miss.push({ path: p, needle }),
        flashManyMatches: (p, needle) => many.push({ path: p, needle }),
        flashRateLimited: (p) => limited.push(p),
        flashMarked: (p, line) => marked.push({ path: p, line }),
      },
    },
  };
}

describe("handleShowCode", () => {
  it("1件当たったら、その行を人間の画面に見せてハイライトする", async () => {
    const root = workspace({ "src/a.ts": "one\nTARGET\nthree\n" });
    const s = spy(root);
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "TARGET" }] }, s.deps);

    expect(out.resolutions).toEqual([
      {
        resolvedBy: "text",
        match: "one",
        range: { startLine: 2, endLine: 2 },
        normalizedPath: "src/a.ts",
      },
    ]);
    expect(s.revealed).toEqual([
      {
        relPath: "src/a.ts",
        range: { startLine: 2, endLine: 2 },
        placement: { slot: 0, layout: "single" },
      },
    ]);
    expect(s.spotlights).toEqual([new Map([["src/a.ts", [{ startLine: 2, endLine: 2 }]]])]);
  });

  it("エディタに触りに来たことを時計に刻む（get_editor_state と対で意味を持つ）", async () => {
    // `show_code` は選択を変更しない（不変条件3）が、エディタを開き直すと
    // VS Code 自身が表示状態（＝以前の選択）を復元しうる。直後の
    // `get_editor_state` を `too-soon-after-tool` で止めるための刻みである。
    const root = workspace({ "src/a.ts": "one\nTARGET\nthree\n" });
    const clock = new OwnToolCallClock();
    expect(clock.msSince()).toBe(Number.POSITIVE_INFINITY);
    await handleShowCode(
      { locations: [{ path: "src/a.ts", text: "TARGET" }] },
      spy(root, { clock }).deps,
    );
    expect(clock.msSince()).toBeLessThan(MIN_MS_SINCE_OWN_TOOL_CALL);
  });

  it("空振りでも刻む（開けなかった直後の窓を無防備にしない）", async () => {
    const root = workspace({ "src/a.ts": "one\ntwo\n" });
    const clock = new OwnToolCallClock();
    await handleShowCode(
      { locations: [{ path: "src/a.ts", text: "NOPE" }] },
      spy(root, { clock }).deps,
    );
    expect(clock.msSince()).toBeLessThan(MIN_MS_SINCE_OWN_TOOL_CALL);
  });

  it("空振りを人間に見せる（設計書 §5.4 の実装要件。ログではない）", async () => {
    // 黙らせると、`.env` に対して探す文字列を変えながら何百回も問い合わせて
    // 内容を絞り込む攻撃が、人間の画面に一切出なくなる。
    const root = workspace({ "src/a.ts": "one\ntwo\n" });
    const s = spy(root);
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "NOPE" }] }, s.deps);

    expect(s.miss).toEqual([{ path: "src/a.ts", needle: "NOPE" }]);
    expect(s.revealed).toEqual([]);
    expect((out.resolutions as { match: string }[])[0]?.match).toBe("none");
  });

  it("多重一致も人間に見せる（候補を返すだけでエディタは開かない）", async () => {
    const root = workspace({ "src/a.ts": "HIT\nx\nHIT\n" });
    const s = spy(root);
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "HIT" }] }, s.deps);

    expect(s.many).toEqual([{ path: "src/a.ts", needle: "HIT" }]);
    expect(s.miss).toEqual([]);
    expect(s.revealed).toEqual([]);
    expect((out.resolutions as { match: string }[])[0]?.match).toBe("many");
  });

  it("回数制限に当たった試行も人間に見せ、rate-limited を返す", async () => {
    const root = workspace({ "src/a.ts": "TARGET\n" });
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
    const s = spy(root, { limiter });
    const call = () =>
      handleShowCode({ locations: [{ path: "src/a.ts", text: "TARGET" }] }, s.deps);

    await call();
    await call();
    const out = await call();

    expect(s.limited).toEqual(["src/a.ts"]);
    expect(out.resolutions).toEqual([
      { resolvedBy: "none", match: "none", reason: "rate-limited", normalizedPath: "src/a.ts" },
    ]);
    // 制限に当たった要求は画面を動かさない
    expect(s.revealed.length).toBe(2);
  });

  it("自己参照シンボリックリンクで綴りを変えても予算は共有される（B1）", async () => {
    // `s -> .` を1本置くと `s/t.txt` / `s/s/t.txt` / … が無限に作れる。
    // 綴りを鍵にしていると、リンク1本で制限が実質無くなる（`path` の上限
    // 1024 字で 511 段 = 30回/分が 15,360回/分になる）。
    const root = workspace({ "t.txt": "TARGET\n" });
    fs.symlinkSync(".", path.join(root, "s"));
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    const s = spy(root, { limiter });

    const spellings = ["t.txt", "s/t.txt", "s/s/t.txt", "s/s/s/t.txt", "./s/s/s/s/t.txt"];
    const matches: string[] = [];
    for (const p of spellings) {
      const out = await handleShowCode({ locations: [{ path: p, text: "TARGET" }] }, s.deps);
      matches.push((out.resolutions as { reason?: string }[])[0]?.reason ?? "ok");
    }

    // 予算3本を使い切ったあとは、綴りを変えても通らない。
    expect(matches).toEqual(["ok", "ok", "ok", "rate-limited", "rate-limited"]);
    expect(s.limited).toEqual(["s/s/s/t.txt", "./s/s/s/s/t.txt"]);
    // 綴りを撒いても追跡中の鍵は1本しか増えない（鍵の上限を埋められない）。
    expect(limiter.trackedKeys()).toBe(1);
  });

  it("既定の上限は 30 回で、31 回目から落ちる", async () => {
    const root = workspace({ "t.txt": "TARGET\n" });
    const s = spy(root, { limiter: new RateLimiter() });
    for (let i = 0; i < RATE_LIMIT_MAX_HITS; i += 1) {
      await handleShowCode({ locations: [{ path: "t.txt", text: "TARGET" }] }, s.deps);
    }
    expect(s.limited).toEqual([]);
    const out = await handleShowCode({ locations: [{ path: "t.txt", text: "TARGET" }] }, s.deps);
    expect((out.resolutions as { reason?: string }[])[0]?.reason).toBe("rate-limited");
  });

  it("秘匿パスは開かず、excluded-path を返す", async () => {
    const root = workspace({ ".env": "SECRET=1\n" });
    const s = spy(root);
    const out = await handleShowCode({ locations: [{ path: ".env", text: "SECRET" }] }, s.deps);

    expect(out.resolutions).toEqual([
      { resolvedBy: "none", match: "none", reason: "excluded-path", normalizedPath: ".env" },
    ]);
    expect(s.revealed).toEqual([]);
    // 空振りとしてではあれ、画面には出る（無音のオラクルを作らない）
    expect(s.miss).toEqual([{ path: ".env", needle: "SECRET" }]);
  });

  it("秘匿パスの実在・不在で予算の鍵が変わらない（存在のオラクルを作らない）", async () => {
    const withEnv = workspace({ ".env": "SECRET=1\n" });
    const withoutEnv = workspace({ "a.txt": "x\n" });
    const a = new RateLimiter({ limit: 5, windowMs: 60_000 });
    const b = new RateLimiter({ limit: 5, windowMs: 60_000 });
    await handleShowCode(
      { locations: [{ path: ".env", text: "S" }] },
      spy(withEnv, { limiter: a }).deps,
    );
    await handleShowCode(
      { locations: [{ path: ".env", text: "S" }] },
      spy(withoutEnv, { limiter: b }).deps,
    );
    // 同じ鍵を1本ずつ使った状態になること（鍵が違えば実在が読める）
    expect(a.trackedKeys()).toBe(1);
    expect(b.trackedKeys()).toBe(1);
    expect(a.allow("no-canonical:path")).toBe(true);
    expect(b.allow("no-canonical:path")).toBe(true);
  });

  it("エディタを開けなかったら位置を返さない（無音のオラクルを作らない）", async () => {
    const root = workspace({ "src/a.ts": "TARGET\n" });
    const s = spy(root, { revealFails: true });
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "TARGET" }] }, s.deps);

    expect(out.resolutions).toEqual([
      { resolvedBy: "none", match: "none", reason: "not-found", normalizedPath: "src/a.ts" },
    ]);
    expect(s.miss).toEqual([{ path: "src/a.ts", needle: "TARGET" }]);
    // **空の窓でも1回置き換える**（D67）。前回のスポットライトが残ると、開けなかった
    // 位置の代わりに前の呼び出しの指差しが「今ここ」に見える。
    expect(s.spotlights).toEqual([new Map()]);
  });

  it("スポットライトは1回の呼び出しの全ファイルを1つの窓で渡す（D67: 窓ごと）", async () => {
    const root = workspace({ "src/a.ts": "TARGET_A\n", "src/b.ts": "TARGET_B\n" });
    const s = spy(root);
    await handleShowCode(
      {
        locations: [
          { path: "src/a.ts", text: "TARGET_A" },
          { path: "src/b.ts", text: "TARGET_B" },
        ],
        layout: "split",
      },
      s.deps,
    );
    // **ちょうど1回。** ファイルごとに呼ぶと、後のファイルの窓が前のファイルの分を消す
    // （窓ごとの置き換えは画家の契約で、ハンドラは1回の呼び出しを1つの窓にまとめる）。
    expect(s.spotlights).toHaveLength(1);
    expect(s.spotlights[0]).toEqual(
      new Map([
        ["src/a.ts", [{ startLine: 1, endLine: 1 }]],
        ["src/b.ts", [{ startLine: 1, endLine: 1 }]],
      ]),
    );
  });

  it("何も解決できなくても、空の窓で1回置き換える（前回の指差しを残さない）", async () => {
    const root = workspace({ "src/a.ts": "nothing here\n" });
    const s = spy(root);
    const out = await handleShowCode(
      { locations: [{ path: "src/a.ts", text: "MISSING" }] },
      s.deps,
    );
    expect(out.resolutions[0]?.match).toBe("none");
    expect(s.revealed).toEqual([]);
    expect(s.spotlights).toEqual([new Map()]);
  });

  it("同じファイルに2件当たったら、後の1件で前の1件を消さない", async () => {
    const root = workspace({ "src/a.ts": "AAA\nBBB\n" });
    const s = spy(root);
    await handleShowCode(
      {
        locations: [
          { path: "src/a.ts", text: "AAA" },
          { path: "src/a.ts", text: "BBB" },
        ],
      },
      s.deps,
    );
    expect(s.spotlights).toEqual([
      new Map([
        [
          "src/a.ts",
          [
            { startLine: 1, endLine: 1 },
            { startLine: 2, endLine: 2 },
          ],
        ],
      ]),
    ]);
  });

  it("ワークスペースが無ければ何も開かず not-found を返す", async () => {
    const s = spy(undefined);
    const out = await handleShowCode({ locations: [{ path: "a.ts", text: "x" }] }, s.deps);
    expect(out.resolutions).toEqual([{ resolvedBy: "none", match: "none", reason: "not-found" }]);
    expect(s.revealed).toEqual([]);
  });

  it("返り値の normalizedPath は正準パスではない（リンクの指す先を明かさない）", async () => {
    // 予算の鍵は realpath 後で作るが、返り値に realpath の結果を載せてはいけない。
    // 載せると show_code の返り値がシンボリックリンクの解決器になる。
    const root = workspace({ "t.txt": "TARGET\n" });
    fs.symlinkSync("t.txt", path.join(root, "alias.txt"));
    const s = spy(root);
    const out = await handleShowCode(
      { locations: [{ path: "alias.txt", text: "TARGET" }] },
      s.deps,
    );
    expect((out.resolutions as { normalizedPath?: string }[])[0]?.normalizedPath).toBe("alias.txt");
  });

  describe("layout（設計書 §2A.7）", () => {
    const three = {
      "src/a.ts": "TARGET_A\n",
      "src/b.ts": "TARGET_B\n",
      "src/c.ts": "TARGET_C\n",
    };

    it("layout を指定しなければ single（1列にタブとして重ねる）", async () => {
      const s = spy(workspace(three));
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "TARGET_A" },
            { path: "src/b.ts", text: "TARGET_B" },
          ],
        },
        s.deps,
      );
      expect(s.revealed.map((r) => r.placement.layout)).toEqual(["single", "single"]);
    });

    it("split は枠を昇順に配る（2箇所が別の列に並ぶ）", async () => {
      // 枠の番号が実際の列になるのは Stage 側。ここで固定するのは
      // 「0 の次は 1」＝降順に開かないこと。降順に渡すと VS Code の
      // 列作成の丸めで手前の列に落ち、2列にならない。
      const s = spy(workspace(three));
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "TARGET_A" },
            { path: "src/b.ts", text: "TARGET_B" },
          ],
          layout: "split",
        },
        s.deps,
      );
      expect(s.revealed.map((r) => r.placement)).toEqual([
        { slot: 0, layout: "split" },
        { slot: 1, layout: "split" },
      ]);
    });

    it("3箇所でも枠は 0,1,2 まで（列の上限は舞台側が持つ）", async () => {
      const s = spy(workspace(three));
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "TARGET_A" },
            { path: "src/b.ts", text: "TARGET_B" },
            { path: "src/c.ts", text: "TARGET_C" },
          ],
          layout: "split",
        },
        s.deps,
      );
      expect(s.revealed.map((r) => r.placement.slot)).toEqual([0, 1, 2]);
    });

    it("開かなかった位置は枠を消費しない（空振り1件で舞台の1列目が空にならない）", async () => {
      const s = spy(workspace(three));
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "NOPE" },
            { path: "src/b.ts", text: "TARGET_B" },
          ],
          layout: "split",
        },
        s.deps,
      );
      expect(s.revealed.map((r) => r.placement.slot)).toEqual([0]);
      expect(s.revealed[0]?.relPath).toBe("src/b.ts");
    });

    it("開けなかった位置も枠を消費しない", async () => {
      const s = spy(workspace(three), { revealFails: true });
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "TARGET_A" },
            { path: "src/b.ts", text: "TARGET_B" },
          ],
          layout: "split",
        },
        s.deps,
      );
      // reveal は投げるので何も記録されないが、枠が進んでいないことは
      // 次に成功した位置が枠0を使うことで確かめる（下の合成）。
      expect(s.revealed).toEqual([]);
    });

    it("先頭が開けなくても、次に開けた位置は舞台の1列目を使う", async () => {
      const root = workspace(three);
      let failNext = true;
      const revealed: { relPath: string; placement: StagePlacement }[] = [];
      const deps: ShowCodeDeps = {
        ...spy(root).deps,
        editor: {
          reveal: async (relPath, _range, placement) => {
            if (failNext) {
              failNext = false;
              throw new Error("エディタを開けない");
            }
            revealed.push({ relPath, placement });
          },
          setSpotlight: () => {},
        },
      };
      await handleShowCode(
        {
          locations: [
            { path: "src/a.ts", text: "TARGET_A" },
            { path: "src/b.ts", text: "TARGET_B" },
          ],
          layout: "split",
        },
        deps,
      );
      expect(revealed).toEqual([{ relPath: "src/b.ts", placement: { slot: 0, layout: "split" } }]);
    });
  });
});

/**
 * **`stage` を切ると `show_code` は印だけ**（増分6 §C4 / D76）。
 *
 * 設定が縛るのはエージェントであって人間ではない（§C5）。位置は解決して返し、
 * 塗りはスポットライトに登録する（見えていれば貼る。見えていなければ人間が
 * 開いたときに貼る）が、**開かない・スクロールしない・列を作らない**。
 * ステータスバーに `path:line` を出す ―― 開かない結果を黙らせない（§5.4）。
 */
describe("handleShowCode — stage を切ったら印だけ（D76）", () => {
  it("開かないが、位置は解決して返し、塗りは登録する", async () => {
    const root = workspace({ "src/a.ts": "one\nTARGET\nthree\n" });
    const s = spy(root, { config: stageOff });
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "TARGET" }] }, s.deps);

    // **結果の形は設定で変えない**（D76: `opened` のような欄を足さない。`list_workspaces` で分かる）。
    expect(out.resolutions).toEqual([
      {
        resolvedBy: "text",
        match: "one",
        range: { startLine: 2, endLine: 2 },
        normalizedPath: "src/a.ts",
      },
    ]);
    expect(s.revealed).toEqual([]);
    expect(s.spotlights).toEqual([new Map([["src/a.ts", [{ startLine: 2, endLine: 2 }]]])]);
    // 人間が場所を探せるように `path:line`（1始まり）。空振りの可視化と同じ経路。
    expect(s.marked).toEqual([{ path: "src/a.ts", line: 2 }]);
    expect(s.miss).toEqual([]);
  });

  it("layout: split でも開かない（列を作らない）。2件とも登録し、2件とも案内する", async () => {
    const root = workspace({ "src/a.ts": "TARGET_A\n", "src/b.ts": "x\nx\nTARGET_B\n" });
    const s = spy(root, { config: stageOff });
    const out = await handleShowCode(
      {
        locations: [
          { path: "src/a.ts", text: "TARGET_A" },
          { path: "src/b.ts", text: "TARGET_B" },
        ],
        layout: "split",
      },
      s.deps,
    );

    expect((out.resolutions as { match: string }[]).map((r) => r.match)).toEqual(["one", "one"]);
    expect(s.revealed).toEqual([]);
    expect(s.spotlights).toEqual([
      new Map([
        ["src/a.ts", [{ startLine: 1, endLine: 1 }]],
        ["src/b.ts", [{ startLine: 3, endLine: 3 }]],
      ]),
    ]);
    expect(s.marked).toEqual([
      { path: "src/a.ts", line: 1 },
      { path: "src/b.ts", line: 3 },
    ]);
  });

  it("空振りは空振りとして見せる（印の案内は出さない）", async () => {
    const root = workspace({ "src/a.ts": "one\ntwo\n" });
    const s = spy(root, { config: stageOff });
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "NOPE" }] }, s.deps);

    expect((out.resolutions as { match: string }[])[0]?.match).toBe("none");
    expect(s.miss).toEqual([{ path: "src/a.ts", needle: "NOPE" }]);
    expect(s.marked).toEqual([]);
    expect(s.revealed).toEqual([]);
    // 空の窓でも1回置き換える（D67）。
    expect(s.spotlights).toEqual([new Map()]);
  });

  it("多重一致も同じ（候補を返すだけで、印も案内も無い）", async () => {
    const root = workspace({ "src/a.ts": "HIT\nx\nHIT\n" });
    const s = spy(root, { config: stageOff });
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", text: "HIT" }] }, s.deps);

    expect((out.resolutions as { match: string }[])[0]?.match).toBe("many");
    expect(s.many).toEqual([{ path: "src/a.ts", needle: "HIT" }]);
    expect(s.marked).toEqual([]);
    expect(s.spotlights).toEqual([new Map()]);
  });

  it("stage が on なら開き、印の案内は出さない（既存の振る舞いのまま）", async () => {
    const root = workspace({ "src/a.ts": "TARGET\n" });
    const s = spy(root);
    await handleShowCode({ locations: [{ path: "src/a.ts", text: "TARGET" }] }, s.deps);

    expect(s.revealed).toHaveLength(1);
    expect(s.marked).toEqual([]);
  });

  it("印だけでも、エディタに触りに来たことは刻む", async () => {
    // 塗りは人間のエディタに貼られる（見えていれば今、見えていなければ開いたとき）。
    // 直後の `get_editor_state` に対する窓は開くときと同じに置く。
    const root = workspace({ "src/a.ts": "TARGET\n" });
    const clock = new OwnToolCallClock();
    await handleShowCode(
      { locations: [{ path: "src/a.ts", text: "TARGET" }] },
      spy(root, { clock, config: stageOff }).deps,
    );
    expect(clock.msSince()).toBeLessThan(MIN_MS_SINCE_OWN_TOOL_CALL);
  });
});

/**
 * `symbol` 解決（設計書 §3.4）。
 *
 * 面（`SymbolSurface`）は偽物にする。本物は `executeDocumentSymbolProvider` を
 * 引き直すので、ここで見たいのは**引いた結果をどう読むか**だけである。
 * 「1回で諦めない」ほうは `symbol-lookup.test.ts` が見る。
 */
describe("handleShowCode — symbol 解決", () => {
  const SOURCE = "line1\nline2\nline3\nline4\n";

  it("一覧が取れて名前が当たれば、その範囲を見せる", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const symbols = symbolSpy({ kind: "resolved", ranges: [{ startLine: 2, endLine: 3 }] });
    const s = spy(root, { symbols });

    const out = await handleShowCode(
      { locations: [{ path: "src/a.ts", symbol: "target" }] },
      s.deps,
    );

    expect(out.resolutions).toEqual([
      {
        resolvedBy: "symbol",
        match: "one",
        range: { startLine: 2, endLine: 3 },
        normalizedPath: "src/a.ts",
      },
    ]);
    expect(symbols.asked).toEqual([{ relPath: "src/a.ts", name: "target" }]);
    expect(s.revealed.length).toBe(1);
  });

  /**
   * **`not-found` は一覧が取れたときにしか名乗れない**（設計書 §3.4）。
   *
   * 面が「引けた」と言ったときだけ空配列が渡り、そこで初めて `not-found` になる。
   */
  it("一覧は取れたが名前が無ければ not-found", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root, { symbols: symbolSpy({ kind: "resolved", ranges: [] }) });
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", symbol: "nope" }] }, s.deps);
    const [first] = out.resolutions as { reason?: string; resolvedBy?: string }[];
    expect(first?.reason).toBe("not-found");
    expect(first?.resolvedBy).toBe("symbol");
  });

  it("引けなかったときは面が名乗った理由をそのまま返す（restricted-mode / no-provider）", async () => {
    const root = workspace({ "src/a.ts": SOURCE, "data/a.json": "{}\n" });

    const restricted = spy(root, {
      symbols: symbolSpy({ kind: "unavailable", reason: "restricted-mode" }),
    });
    const ts = await handleShowCode(
      { locations: [{ path: "src/a.ts", symbol: "target" }] },
      restricted.deps,
    );
    expect(ts.resolutions).toEqual([
      {
        resolvedBy: "symbol",
        match: "none",
        reason: "restricted-mode",
        normalizedPath: "src/a.ts",
      },
    ]);
    // 引けなかったことも画面に出す（無音のオラクルを作らない）。
    expect(restricted.miss).toEqual([{ path: "src/a.ts", needle: "target" }]);

    const none = spy(root, { symbols: symbolSpy({ kind: "unavailable", reason: "no-provider" }) });
    const json = await handleShowCode(
      { locations: [{ path: "data/a.json", symbol: "target" }] },
      none.deps,
    );
    const [first] = json.resolutions as { reason?: string }[];
    expect(first?.reason).toBe("no-provider");
  });

  /**
   * **引けなかった理由に `not-found` は入らない。**
   *
   * 入る形にすると「一覧は取れなかったが、その名前は無い」と言うことになり、
   * ファイルの実在と中身についての主張を、根拠なしに返す道が開く。
   */
  it("引けなかったときの理由は2つだけ（not-found を名乗らない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    for (const reason of ["restricted-mode", "no-provider"] as const) {
      const s = spy(root, { symbols: symbolSpy({ kind: "unavailable", reason }) });
      const out = await handleShowCode(
        { locations: [{ path: "src/a.ts", symbol: "target" }] },
        s.deps,
      );
      const [first] = out.resolutions as { reason?: string }[];
      expect(first?.reason).toBe(reason);
      expect(first?.reason).not.toBe("not-found");
    }
  });

  it("除外パスでは一度も引かない（文書を開かせない）", async () => {
    const root = workspace({ ".env": "SECRET=1\n" });
    const symbols = symbolSpy({ kind: "resolved", ranges: [{ startLine: 1, endLine: 1 }] });
    const s = spy(root, { symbols });
    const out = await handleShowCode({ locations: [{ path: ".env", symbol: "SECRET" }] }, s.deps);
    const [first] = out.resolutions as { reason?: string }[];
    expect(first?.reason).toBe("excluded-path");
    expect(symbols.asked).toEqual([]);
  });

  it("除外パスへのシンボリックリンクでも引かない（realpath 後にもう一度当てる）", async () => {
    const root = workspace({ ".env": "SECRET=1\n" });
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs-link.md"));
    const symbols = symbolSpy({ kind: "resolved", ranges: [{ startLine: 1, endLine: 1 }] });
    const s = spy(root, { symbols });
    await handleShowCode({ locations: [{ path: "docs-link.md", symbol: "SECRET" }] }, s.deps);
    expect(symbols.asked).toEqual([]);
  });

  it("text 指定があるときは引かない（text が優先される）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const symbols = symbolSpy({ kind: "resolved", ranges: [{ startLine: 4, endLine: 4 }] });
    const s = spy(root, { symbols });
    const out = await handleShowCode(
      { locations: [{ path: "src/a.ts", text: "line2", symbol: "target" }] },
      s.deps,
    );
    const [first] = out.resolutions as { resolvedBy?: string }[];
    expect(first?.resolvedBy).toBe("text");
    expect(symbols.asked).toEqual([]);
  });

  it("回数制限に当たった要求では引かない（制限の後に置いてある）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const limiter = new RateLimiter({ limit: 1 });
    const symbols = symbolSpy({ kind: "resolved", ranges: [{ startLine: 1, endLine: 1 }] });
    const s = spy(root, { limiter, symbols });
    const loc = { path: "src/a.ts", symbol: "target" };
    await handleShowCode({ locations: [loc] }, s.deps);
    await handleShowCode({ locations: [loc] }, s.deps);
    expect(symbols.asked.length).toBe(1);
  });

  it("面を繋がなければ no-provider（増分1と同じ振る舞いに戻る）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const out = await handleShowCode({ locations: [{ path: "src/a.ts", symbol: "t" }] }, s.deps);
    const [first] = out.resolutions as { reason?: string }[];
    expect(first?.reason).toBe("no-provider");
  });
});
