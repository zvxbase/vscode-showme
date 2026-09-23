import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ANNOTATION_COLORS,
  type AnnotationColor,
  DEFAULT_REDACTED_PATTERNS,
  MAX_ANNOTATION_BODY_LINES,
  MAX_ANNOTATION_TEXT_CHARS,
  annotateResultSchema,
} from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANNOTATION_AUTHOR, ANNOTATION_AUTHOR_DEFAULT } from "../src/annotation-author.js";
import type { ShowMeConfig } from "../src/config.js";
import { type AnnotateDeps, handleAnnotate } from "../src/handlers/annotate.js";
import type { LineRange } from "../src/handlers/show-code.js";
import type { SymbolSurface } from "../src/handlers/symbol-prefetch.js";
import { RATE_LIMIT_MAX_HITS, RateLimiter } from "../src/rate-limit.js";

/**
 * `handleAnnotate` の単体テスト。
 *
 * 注釈の面（`AnnotationSurface`）を偽物にして、**何が画面に出るか**を数える。
 * ここで見たいのは3つで、どれも壊しても実機では気づきにくいものである:
 *
 *   1. `mode: "replace"` が冪等（同じ引数で2回呼んでも吹き出しが増えない）
 *   2. 本文が `protocol` の無害化を通っている（双方向オーバーライドが可視化される）
 *   3. 空振り・多重一致・回数制限が画面に出る（無音のオラクルを作らない）
 */

const made: string[] = [];
function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "showme-annotate-"));
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
  editorGroup: "dedicated",
  html: { maxPanels: 2 },
  disabledTools: [],
  redactedPathPatterns: [...DEFAULT_REDACTED_PATTERNS],
  maxSelectionChars: 4000,
  injectTerminalEnv: true,
  listAllWorkspaces: false,
};

interface Bubble {
  relPath: string;
  range: LineRange;
  body: string;
  /** 無印は**鍵ごと無い**。既定色に倒れていないことを既存の toEqual で言うため。 */
  color?: AnnotationColor;
}

interface Spy {
  deps: AnnotateDeps;
  /** いま出ている吹き出し（偽の面が本物と同じ置換規則で保つ）。 */
  live: Bubble[];
  /** `live` と同じ並びの id（偽の面が `indices()` を作る元）。 */
  liveIds: number[];
  /** 一度でも出した吹き出し（消えたものも含む）。 */
  added: Bubble[];
  cleared: number;
  miss: { path: string; needle: string }[];
  many: { path: string; needle: string }[];
  limited: string[];
  logged: string[];
}

function spy(
  root: string | undefined,
  options: { limiter?: RateLimiter; symbols?: SymbolSurface; maxThreads?: number } = {},
): Spy {
  const live: Bubble[] = [];
  const liveIds: number[] = [];
  const added: Bubble[] = [];
  const miss: Spy["miss"] = [];
  const many: Spy["many"] = [];
  const limited: string[] = [];
  const logged: string[] = [];
  let cleared = 0;
  const limiter = options.limiter ?? new RateLimiter();

  const self: Spy = {
    live,
    liveIds,
    added,
    get cleared() {
      return cleared;
    },
    miss,
    many,
    limited,
    logged,
    deps: {
      config: () => config,
      workspaceRoot: root,
      limiter,
      ...(options.symbols === undefined ? {} : { symbols: options.symbols }),
      annotations: {
        clearAll: () => {
          cleared += 1;
          live.length = 0;
          liveIds.length = 0;
        },
        add: (relPath, range, body, color) => {
          const bubble: Bubble =
            color === undefined ? { relPath, range, body } : { relPath, range, body, color };
          live.push(bubble);
          added.push(bubble);
          // 本物のストアと同じ約束: id は窓内で単調増加、上限を超えたら古いものから捨てる。
          const id = added.length;
          liveIds.push(id);
          while (live.length > (options.maxThreads ?? Number.POSITIVE_INFINITY)) {
            live.shift();
            liveIds.shift();
          }
          return { id };
        },
        // 本物と同じく、一覧の**いまの**位置から作る（`add` の時点の位置ではない）。
        indices: () => new Map(liveIds.map((id, i) => [id, i + 1])),
      },
      log: { info: (message) => logged.push(message) },
      statusBar: {
        flashMiss: (p, needle) => miss.push({ path: p, needle }),
        flashManyMatches: (p, needle) => many.push({ path: p, needle }),
        flashRateLimited: (p) => limited.push(p),
        // 注釈は開かないのが常なので「印だけ」の案内は出さない（D76 は `show_code` の量）。
        flashMarked: (p, line) => {
          throw new Error(`annotate が flashMarked を呼んだ: ${p}:${String(line)}`);
        },
      },
    },
  };
  return self;
}

/** 結果の `resolutions` を型付きで取り出す。 */
function resolutions(result: Record<string, unknown>): Record<string, unknown>[] {
  expect(Array.isArray(result.resolutions)).toBe(true);
  return result.resolutions as Record<string, unknown>[];
}

const SOURCE = ["const a = 1;", "const target = 2;", "const b = repeated;", "const c = repeated;"]
  .join("\n")
  .concat("\n");

describe("handleAnnotate", () => {
  it("解決できた位置に吹き出しを1件出す", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);

    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "ここが入口" }] },
      s.deps,
    );

    expect(s.live).toEqual([
      { relPath: "src/a.ts", range: { startLine: 2, endLine: 2 }, body: "ここが入口" },
    ]);
    const [first] = resolutions(result);
    expect(first?.match).toBe("one");
    expect(first?.resolvedBy).toBe("text");
    expect(first?.range).toEqual({ startLine: 2, endLine: 2 });
  });

  it("返り値にファイルの内容も注釈の本文も入らない（不変条件2）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }] },
      s.deps,
    );
    expect(Object.keys(result)).toEqual(["resolutions"]);
    expect(JSON.stringify(result)).not.toContain("説明");
    expect(JSON.stringify(result)).not.toContain("const target");
  });

  /**
   * **`mode: "replace"` の冪等性。** 既定がこれである理由そのもの。
   *
   * 「同じ引数で2回」だけでなく「先に別の注釈が出ている」状態からも見る。
   * 前者だけだと、`clearAll()` を消しても2回目に同じ本文が2件並ぶだけで、
   * 「増えた」ことに気づくには件数を数える必要がある ―― 実際に数える。
   */
  it("mode: replace は同じ引数で2回呼んでも吹き出しが増えない", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const args = {
      items: [{ location: { path: "src/a.ts", text: "const target" }, text: "ここが入口" }],
    };

    await handleAnnotate(args, s.deps);
    await handleAnnotate(args, s.deps);

    expect(s.live.length).toBe(1);
    expect(s.added.length).toBe(2); // 2回とも出しはした（消してから出している）
    expect(s.cleared).toBe(2);
  });

  it("mode: replace は前の呼び出しの注釈を消す（別のファイルでも残らない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE, "src/b.ts": SOURCE });
    const s = spy(root);

    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "古い" }] },
      s.deps,
    );
    await handleAnnotate(
      { items: [{ location: { path: "src/b.ts", text: "const target" }, text: "新しい" }] },
      s.deps,
    );

    expect(s.live.map((b) => `${b.relPath}:${b.body}`)).toEqual(["src/b.ts:新しい"]);
  });

  /**
   * 1件も解決できなかったときも消す。
   *
   * 「解決できたときだけ置き換える」にすると、画面には古い説明が
   * **新しい呼び出しの結果として**残る。置換の約束はそこで破れる。
   */
  it("mode: replace は1件も解決できなくても古い注釈を消す", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);

    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "古い" }] },
      s.deps,
    );
    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "存在しない文字列" }, text: "新しい" }] },
      s.deps,
    );

    expect(s.live).toEqual([]);
  });

  it("mode: add は既存の注釈を消さずに足す", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const args = {
      items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }],
      mode: "add" as const,
    };

    await handleAnnotate(args, s.deps);
    await handleAnnotate(args, s.deps);

    expect(s.live.length).toBe(2);
    expect(s.cleared).toBe(0);
  });

  it("既定の mode は replace（未指定を危ない側に倒さない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }] },
      s.deps,
    );
    expect(s.cleared).toBe(1);
  });

  /**
   * 本文は `protocol` の無害化を通る（不変条件7 / 設計書 §4.4）。
   *
   * **不可視文字は6文字のエスケープ列で書く**（生の文字を書くと
   * `test/source-hygiene.test.ts` が落ちる）。
   */
  it("双方向オーバーライド・制御文字・ゼロ幅文字を可視化してから出す", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      {
        items: [
          {
            location: { path: "src/a.ts", text: "const target" },
            text: "a\u202eb\u200bc\u001b[31md\ne",
          },
        ],
      },
      s.deps,
    );

    const body = s.live[0]?.body ?? "";
    // 改行だけは残る（吹き出しは行を描ける面である）。危ない文字は可視化される。
    expect(body).toBe("a\\u202eb\\u200bc\\u001b[31md\ne");
    // 生の文字が残っていないこと（エスケープ列が「見えている」だけでなく、
    // 元の文字が本当に消えていること）。
    expect(body.includes("\u202e")).toBe(false);
    expect(body.includes("\u200b")).toBe(false);
    expect(body.includes("\u001b")).toBe(false);
  });

  /**
   * 吹き出しの本文は**改行を保つ**。
   *
   * 改行を潰す規則は、行の並びが意味を持つ面（出力チャネル）で行を偽装させない
   * ためのものである。吹き出しはログではないので偽の行に意味が無く、潰すと
   * 説明が実質1行になる。行き先は `protocol` の同じ関数に引数で渡している
   * （関数を分けない ―― 分けたらそれが2つ目のサニタイザである。不変条件7）。
   */
  it("本文の改行はそのまま残る（説明が1行に潰れない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      {
        items: [
          {
            location: { path: "src/a.ts", text: "const target" },
            text: "1行目\n\n2行目\n3行目",
          },
        ],
      },
      s.deps,
    );
    expect(s.live[0]?.body).toBe("1行目\n\n2行目\n3行目");
  });

  /**
   * ただし高さは有界である（人間の作業面を奪わない。不変条件10）。
   *
   * 超えた分は**捨てずに**エスケープ列に戻す ―― 捨てると「そこで改行されていた」
   * ことまで消える。
   */
  it("描ける行数を超えた改行はエスケープ列に戻り、文字は失われない", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      {
        items: [
          {
            location: { path: "src/a.ts", text: "const target" },
            text: "x\n".repeat(200),
          },
        ],
      },
      s.deps,
    );
    const body = s.live[0]?.body ?? "";
    expect(body.split("\n").length).toBe(MAX_ANNOTATION_BODY_LINES);
    expect((body.match(/x/g) ?? []).length).toBe(200);
  });

  it("面に渡る本文は常に文字列である（markdown の値を渡す口を持たない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }] },
      s.deps,
    );
    for (const bubble of s.added) expect(typeof bubble.body).toBe("string");
  });

  it("上限を超える本文は切り詰められる", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    await handleAnnotate(
      {
        items: [
          {
            location: { path: "src/a.ts", text: "const target" },
            text: "あ".repeat(MAX_ANNOTATION_TEXT_CHARS + 500),
          },
        ],
      },
      s.deps,
    );
    expect((s.live[0]?.body ?? "").length).toBeLessThanOrEqual(MAX_ANNOTATION_TEXT_CHARS);
  });

  it("空振りは吹き出しを出さず、画面に出す", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "存在しない文字列" }, text: "説明" }] },
      s.deps,
    );
    expect(s.live).toEqual([]);
    expect(s.miss).toEqual([{ path: "src/a.ts", needle: "存在しない文字列" }]);
    expect(resolutions(result)[0]?.reason).toBe("not-found");
  });

  it("多重一致は吹き出しを出さず、画面に出す（どこに出すか決められない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "repeated" }, text: "説明" }] },
      s.deps,
    );
    expect(s.live).toEqual([]);
    expect(s.many.length).toBe(1);
    expect(resolutions(result)[0]?.match).toBe("many");
  });

  it("除外パスには注釈を出さない", async () => {
    const root = workspace({ ".env": "SECRET=1\n" });
    const s = spy(root);
    const result = await handleAnnotate(
      { items: [{ location: { path: ".env", text: "SECRET" }, text: "説明" }] },
      s.deps,
    );
    expect(s.live).toEqual([]);
    expect(resolutions(result)[0]?.reason).toBe("excluded-path");
  });

  /**
   * **`show_code` と同じ予算を引く。** ツールを変えるだけで予算が倍になると、
   * 同じファイルへの絞り込みが2倍の帯域を持つ。
   */
  it("回数制限は show_code と同じ器を共有する（渡した器がそのまま減る）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const limiter = new RateLimiter();
    const s = spy(root, { limiter });

    for (let i = 0; i < RATE_LIMIT_MAX_HITS; i++) {
      await handleAnnotate(
        { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }] },
        s.deps,
      );
    }
    const over = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "説明" }] },
      s.deps,
    );

    expect(resolutions(over)[0]?.reason).toBe("rate-limited");
    expect(s.limited).toContain("src/a.ts");
    // 制限に当たった回は吹き出しを出さない（が、置換は起きているので画面は空）。
    expect(s.live).toEqual([]);
  });

  it("ワークスペースが無くても置換の約束は果たす", async () => {
    const s = spy(undefined);
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "x" }, text: "説明" }] },
      s.deps,
    );
    expect(s.cleared).toBe(1);
    expect(s.live).toEqual([]);
    expect(resolutions(result)[0]?.reason).toBe("not-found");
  });

  it("複数件をまとめて出せる（結果は入力と同じ並び・同じ件数）", async () => {
    const root = workspace({ "src/a.ts": SOURCE, "src/b.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      {
        items: [
          { location: { path: "src/a.ts", text: "const target" }, text: "1件目" },
          { location: { path: "src/a.ts", text: "存在しない" }, text: "2件目" },
          { location: { path: "src/b.ts", lines: { start: 1, end: 1 } }, text: "3件目" },
        ],
      },
      s.deps,
    );
    expect(resolutions(result).map((r) => r.match)).toEqual(["one", "none", "one"]);
    expect(s.live.map((b) => b.body)).toEqual(["1件目", "3件目"]);
  });

  it("面を繋がなければ symbol 指定は no-provider（黙って出さない、ではない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", symbol: "target" }, text: "説明" }] },
      s.deps,
    );
    expect(resolutions(result)[0]?.reason).toBe("no-provider");
    expect(s.miss.length).toBe(1);
  });

  /**
   * `annotate` も `show_code` と**同じ面・同じ組み立て**でシンボルを引く。
   *
   * 片方だけが symbol を解決できると、エージェントには「同じ位置指定なのに
   * ツールによって当たったり当たらなかったりする」と見える。
   */
  it("symbol でも吹き出しを出せる（show_code と同じ面を使う）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root, {
      symbols: {
        lookup: async () => ({ kind: "resolved", ranges: [{ startLine: 2, endLine: 2 }] }),
      },
    });
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", symbol: "target" }, text: "シンボルの説明" }] },
      s.deps,
    );
    expect(resolutions(result)[0]?.resolvedBy).toBe("symbol");
    expect(s.live).toEqual([
      { relPath: "src/a.ts", range: { startLine: 2, endLine: 2 }, body: "シンボルの説明" },
    ]);
  });

  it("引けなかった理由をそのまま返す（restricted-mode を潰さない）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root, {
      symbols: { lookup: async () => ({ kind: "unavailable", reason: "restricted-mode" }) },
    });
    const result = await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", symbol: "target" }, text: "説明" }] },
      s.deps,
    );
    expect(resolutions(result)[0]?.reason).toBe("restricted-mode");
    expect(s.live).toEqual([]);
    expect(s.miss.length).toBe(1);
  });
});

/**
 * `mode: "clear"`（設計 D54）。
 *
 * 「解決しない位置を1件渡して replace の副作用で消す」に頼らない。それは実装の
 * 順序（先に `clearAll()`）に依存した経路で、次に誰かが「1件も解決しなければ
 * 消さない」に直したら消す手段が無くなる。
 */
describe("mode: clear（D54）", () => {
  it("全部消して、何も足さず、resolutions は空", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    // 前提: 消す前に何か出ている（出ていなければ「消えた」は空虚に真になる）。
    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "const target" }, text: "消す前" }] },
      s.deps,
    );
    expect(s.live.length).toBe(1);
    const clearedBefore = s.cleared;

    const result = await handleAnnotate({ mode: "clear" }, s.deps);

    expect(s.cleared).toBe(clearedBefore + 1);
    expect(s.live).toEqual([]);
    expect(s.added.length).toBe(1); // clear で新しく足したものは無い
    expect(resolutions(result)).toEqual([]);
  });

  it("回数制限に数えない（読むものが無い）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const limiter = new RateLimiter();
    const allow = vi.spyOn(limiter, "allow");
    const s = spy(root, { limiter });
    await handleAnnotate({ mode: "clear" }, s.deps);
    expect(allow).not.toHaveBeenCalled();
  });

  it("ワークスペースが無くても消える（置換の約束と同じ）", async () => {
    const s = spy(undefined);
    const result = await handleAnnotate({ mode: "clear" }, s.deps);
    expect(s.cleared).toBe(1);
    expect(resolutions(result)).toEqual([]);
  });
});

describe("注釈の色 → 作成者名（D57）", () => {
  it("5色すべてに固定の作成者名がある（絵文字＋イニシャル）", () => {
    for (const color of ANNOTATION_COLORS) {
      expect(ANNOTATION_AUTHOR[color], color).toMatch(/^ShowMe [🟡🟢🔴🔵🟣] [YGRBP]$/u);
    }
  });

  it("対応表は語彙を網羅する（足し忘れが型で落ちる）", () => {
    expect(Object.keys(ANNOTATION_AUTHOR).sort()).toEqual([...ANNOTATION_COLORS].sort());
  });

  it("絵文字とイニシャルが色と一致する（写し間違いを捕まえる）", () => {
    // **値そのものを主張する。** イニシャルだけを見ていると、`blue: "ShowMe 🔴 B"` の
    // ような絵文字の写し間違いが正規表現・重複・接頭辞の検査をすべて通り抜ける
    // （レビューで指摘）。5つとも完全一致で固定する。
    expect(ANNOTATION_AUTHOR.yellow).toBe("ShowMe 🟡 Y");
    expect(ANNOTATION_AUTHOR.green).toBe("ShowMe 🟢 G");
    expect(ANNOTATION_AUTHOR.red).toBe("ShowMe 🔴 R");
    expect(ANNOTATION_AUTHOR.blue).toBe("ShowMe 🔵 B");
    expect(ANNOTATION_AUTHOR.purple).toBe("ShowMe 🟣 P");
  });

  it("無印は色を持たない固定名", () => {
    expect(ANNOTATION_AUTHOR_DEFAULT).toBe("ShowMe");
  });

  it("値は6つの相異なるリテラルで、エージェントの文字列が入る経路が無い", () => {
    // 作成者名の偽装（設計書 §5.4: 人間の名前や「VS Code」を名乗る吹き出し）を
    // 構造で塞ぐ。値はすべて `ShowMe` で始まるリテラルで、色名は鍵の照合にしか使われない。
    const all = [...Object.values(ANNOTATION_AUTHOR), ANNOTATION_AUTHOR_DEFAULT];
    expect(new Set(all).size).toBe(all.length);
    for (const v of all) expect(v.startsWith("ShowMe")).toBe(true);
  });
});

describe("色は面まで届く（設計 D47）", () => {
  const SRC = "const target = 1;\nconst other = 2;\n";

  it("送った色がそのまま面に渡る", async () => {
    const root = workspace({ "src/a.ts": SRC });
    const s = spy(root);
    await handleAnnotate(
      {
        items: [{ location: { path: "src/a.ts", text: "target" }, text: "赤", color: "red" }],
      },
      s.deps,
    );
    expect(s.live).toEqual([
      { relPath: "src/a.ts", range: { startLine: 1, endLine: 1 }, body: "赤", color: "red" },
    ]);
  });

  it("省略すると色を渡さない（既定色に倒れない）", async () => {
    const root = workspace({ "src/a.ts": SRC });
    const s = spy(root);
    await handleAnnotate(
      { items: [{ location: { path: "src/a.ts", text: "target" }, text: "無印" }] },
      s.deps,
    );
    const bubble = s.live[0];
    expect(bubble).toBeDefined();
    // **`undefined` ではなく鍵ごと無いこと。** ここが `"yellow"` に倒れていると、
    // 「無印」という状態が消える。
    expect(bubble !== undefined && "color" in bubble).toBe(false);
  });
});

/**
 * `resolution` に `id` と `index` が載る（増分6 D71）。
 *
 * 載るのは**吹き出しが出た項目だけ**。出せなかった項目（空振り・多重一致）に
 * 番号を付けると、エージェントは「出た」と読む。番号を決めるのはストアで、
 * ハンドラは面が返した値を写すだけ（順番を決める場所を2つにしない。§C3）。
 */
describe("resolution の id と index（D71）", () => {
  it("出せた項目には面が返した id と index がそのまま載る", async () => {
    const root = workspace({ "src/a.ts": SOURCE, "src/b.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      {
        items: [
          { location: { path: "src/a.ts", text: "const target" }, text: "1件目" },
          { location: { path: "src/b.ts", lines: { start: 1, end: 1 } }, text: "2件目" },
        ],
      },
      s.deps,
    );
    const [first, second] = resolutions(result);
    expect(first).toMatchObject({ match: "one", id: 1, index: 1 });
    expect(second).toMatchObject({ match: "one", id: 2, index: 2 });
  });

  it("出せなかった項目（none / many）には id も index も無い", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      {
        items: [
          { location: { path: "src/a.ts", text: "存在しない" }, text: "空振り" },
          { location: { path: "src/a.ts", text: "repeated" }, text: "多重" },
          { location: { path: "src/a.ts", text: "const target" }, text: "出る" },
        ],
      },
      s.deps,
    );
    const [none, many, one] = resolutions(result);
    expect(none?.match).toBe("none");
    expect(many?.match).toBe("many");
    for (const r of [none, many]) {
      expect(r !== undefined && "id" in r).toBe(false);
      expect(r !== undefined && "index" in r).toBe(false);
    }
    // 出せたのは3件目だけなので、一覧の位置は 1（配列の位置 3 ではない）。
    expect(one).toMatchObject({ match: "one", id: 1, index: 1 });
  });

  it("mode: add は続き番号（id は増え続け、index は既存の後ろ）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const item = { location: { path: "src/a.ts", text: "const target" }, text: "説明" };
    await handleAnnotate({ items: [item, item] }, s.deps);
    const result = await handleAnnotate({ items: [item], mode: "add" }, s.deps);
    expect(resolutions(result)[0]).toMatchObject({ id: 3, index: 3 });
  });

  it("mode: replace は index が 1 から始まり直し、id は戻らない", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const item = { location: { path: "src/a.ts", text: "const target" }, text: "説明" };
    await handleAnnotate({ items: [item, item] }, s.deps);
    const result = await handleAnnotate({ items: [item] }, s.deps);
    expect(resolutions(result)[0]).toMatchObject({ id: 3, index: 1 });
  });

  /**
   * **`index` は全部足した後に1回で決める**（不変条件14）。ループの中で `add` の返り値を
   * 写すと、後続の項目が上限の押し出しを起こしたときに先の項目の `index` が1つ大きく、
   * 吹き出し（`1/2 ·`）と結果（`index: 2`）が別の数を言う。
   */
  it("同じ呼び出しの後続が押し出しを起こしても、index は呼び出しの後の位置", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    // 上限2の偽ストア。3件目を足すと1件目が押し出され、2件目は 2 → 1 にずれる。
    const s = spy(root, { maxThreads: 2 });
    const item = { location: { path: "src/a.ts", text: "const target" }, text: "説明" };
    await handleAnnotate({ items: [item] }, s.deps);
    const result = await handleAnnotate({ items: [item, item], mode: "add" }, s.deps);
    const [first, second] = resolutions(result);
    // 押し出しの後の一覧は [id2, id3]。add の時点で読んでいれば first は 2 と答える。
    expect(first).toMatchObject({ id: 2, index: 1 });
    expect(second).toMatchObject({ id: 3, index: 2 });
    expect(s.liveIds).toEqual([2, 3]);
  });

  it("同じ呼び出しの中で押し出された項目は id だけで index が無い", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root, { maxThreads: 1 });
    const item = { location: { path: "src/a.ts", text: "const target" }, text: "説明" };
    const result = await handleAnnotate({ items: [item, item] }, s.deps);
    const [first, second] = resolutions(result);
    expect(first).toMatchObject({ id: 1 });
    expect(first !== undefined && "index" in first).toBe(false);
    expect(second).toMatchObject({ id: 2, index: 1 });
  });

  it("mode: clear の結果は空のまま（番号を付けるものが無い）", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate({ mode: "clear" }, s.deps);
    expect(resolutions(result)).toEqual([]);
  });

  it("結果は線上の annotate 結果スキーマ（strict）を通る", async () => {
    const root = workspace({ "src/a.ts": SOURCE });
    const s = spy(root);
    const result = await handleAnnotate(
      {
        items: [
          { location: { path: "src/a.ts", text: "const target" }, text: "出る" },
          { location: { path: "src/a.ts", text: "存在しない" }, text: "空振り" },
        ],
      },
      s.deps,
    );
    const parsed = annotateResultSchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
