import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_REDACTED_PATTERNS,
  MAX_OPEN_PATHS,
  MAX_SELECTED_TEXT_CHARS,
  MAX_TABS_PER_GROUP,
  SELECTION_WITHHELD_REASONS,
  type SelectionWithheldReason,
  getEditorStateResultSchema,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import type { ShowMeConfig } from "../src/config.js";
import type { EditorGroupState, ObservedGroup, ObservedTab } from "../src/editor-observation.js";
import {
  type ActiveEditorObservation,
  type EditorStateStatus,
  type EditorStateSurface,
  type GetEditorStateDeps,
  type ObservedAnnotation,
  handleGetEditorState,
} from "../src/handlers/get-editor-state.js";
import {
  MIN_MS_SINCE_OWN_TOOL_CALL,
  OwnToolCallClock,
  SelectionMemory,
} from "../src/human-selection.js";
import { RateLimiter } from "../src/rate-limit.js";

/**
 * `handleGetEditorState` の単体テスト。
 *
 * ここが「人間が選んだものだけを返す」の実体である。8つの拒否理由それぞれで
 * `selectedText` が**入らない**こと、すべて満たしたときだけ入ることを、
 * 偽の面（`EditorStateSurface`）で判別する。
 *
 * 面を偽物にできるのは、ハンドラが `vscode` を値 import していないからである。
 * 値 import していると vitest はこのファイルを読み込めず、検査が1件も書けない。
 */

const SELECTED = "const secret = compute();";

function config(overrides: Partial<ShowMeConfig> = {}): ShowMeConfig {
  return {
    enabled: true,
    editorGroup: "dedicated",
    html: { maxPanels: 2 },
    disabledTools: [],
    redactedPathPatterns: [...DEFAULT_REDACTED_PATTERNS],
    maxSelectionChars: 4000,
    injectTerminalEnv: true,
    listAllWorkspaces: false,
    ...overrides,
  };
}

/** 共有してよい観測。各テストはここから1つだけ崩す。 */
function activeEditor(overrides: Partial<ActiveEditorObservation> = {}): ActiveEditorObservation {
  return {
    relPath: "src/app.ts",
    isActiveEditor: true,
    cursor: { line: 12, character: 4 },
    selection: { startLine: 12, startCharacter: 4, endLine: 12, endCharacter: 29 },
    empty: false,
    coversWholeDocument: false,
    visibleLines: { start: 1, end: 40 },
    readSelectedText: () => SELECTED,
    ...overrides,
  };
}

interface Fake {
  surface: EditorStateSurface;
  /** `readSelectedText` が呼ばれた回数。共有しないと決めたら0のはず。 */
  reads: () => number;
}

/** 生の観測を1枚作る。既定は「ワークスペース内の普通のファイル」。 */
function observedTab(over: Partial<ObservedTab> = {}): ObservedTab {
  return {
    label: "app.ts",
    kind: "file",
    relPath: "src/app.ts",
    own: false,
    isActive: false,
    isDirty: false,
    isPinned: false,
    isPreview: false,
    visibleLines: undefined,
    ...over,
  };
}

/**
 * パスの並びから「1列にその順でタブが開いている」観測を作る。
 *
 * 面が返すのは**生の観測**だけである（選別も畳み込みもしない）。だから
 * 検査もそこに合わせて観測を作る ―― 「どれを載せるか」は
 * `buildEditorLayout` の判断で、ハンドラはそれを呼ぶだけである。
 */
function groupsFromPaths(rels: readonly string[]): ObservedGroup[] {
  return [
    {
      viewColumn: 1,
      isActive: true,
      tabs: rels.map((rel) => observedTab({ label: rel, relPath: rel })),
    },
  ];
}

function fakeSurface(options: {
  focused?: boolean;
  active?: ActiveEditorObservation | undefined | "none";
  openPaths?: string[];
  groups?: ObservedGroup[];
  annotations?: ObservedAnnotation[];
}): Fake {
  let reads = 0;
  const base = options.active === "none" ? undefined : (options.active ?? activeEditor());
  const active =
    base === undefined
      ? undefined
      : {
          ...base,
          readSelectedText: (maxChars: number): string => {
            reads += 1;
            return base.readSelectedText(maxChars);
          },
        };
  return {
    surface: {
      windowFocused: () => options.focused ?? true,
      activeEditor: () => active,
      groups: () =>
        options.groups ?? groupsFromPaths(options.openPaths ?? ["src/app.ts", "README.md"]),
      annotations: () => options.annotations ?? [],
    },
    reads: () => reads,
  };
}

/** 呼び出し予算の可視化は別ファイル（`get-editor-state-budget.test.ts`）の関心事。ここでは何もしない。 */
const noopStatusBar: EditorStateStatus = { flashEditorStateRateLimited: () => {} };

function run(fake: Fake, overrides: Partial<GetEditorStateDeps> = {}): Record<string, unknown> {
  return handleGetEditorState({
    config,
    surface: fake.surface,
    memory: new SelectionMemory(),
    clock: new OwnToolCallClock(),
    // **予算も検査ごとに新しくする。** 共有の器を使うと、このファイルの検査を
    // 何本か走らせただけで上限に当たり、見たかったものが `rate-limited` に
    // 覆われる（実際に12件がそう落ちた）。共有の器を使うことそのものは
    // `get-editor-state-budget.test.ts` が別のファイルで見ている。
    limiter: new RateLimiter(),
    statusBar: noopStatusBar,
    ...overrides,
  });
}

/** 自ツールがたった今エディタに触った状態の時計。 */
function justTouched(): OwnToolCallClock {
  const clock = new OwnToolCallClock();
  clock.mark(0);
  return clock;
}

describe("handleGetEditorState", () => {
  it("人間が選んだテキストを返す（「これ何？」が成立する）", () => {
    const fake = fakeSurface({});
    const result = run(fake);
    expect(result.selectedText).toBe(SELECTED);
    expect(result.selectionWithheld).toBeUndefined();
    expect(result.activePath).toBe("src/app.ts");
    expect(result.cursor).toEqual({ line: 12, character: 4 });
    expect(result.selection).toEqual({
      startLine: 12,
      startCharacter: 4,
      endLine: 12,
      endCharacter: 29,
    });
    expect(result.visibleLines).toEqual({ start: 1, end: 40 });
    expect(result.openPaths).toEqual(["src/app.ts", "README.md"]);
  });

  it("結果は線上の結果スキーマ（strict）を通る", () => {
    const parsed = getEditorStateResultSchema.safeParse(run(fakeSurface({})));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe("選択テキストを返さない8つの理由", () => {
  /** 理由ごとに「その条件だけを外した」呼び出しを作る。 */
  const CASES: Record<
    SelectionWithheldReason,
    () => { fake: Fake; deps: Partial<GetEditorStateDeps> }
  > = {
    "outside-workspace": () => ({
      fake: fakeSurface({ active: activeEditor({ relPath: undefined }) }),
      deps: {},
    }),
    redacted: () => ({
      fake: fakeSurface({ active: activeEditor({ relPath: ".env" }) }),
      deps: {},
    }),
    empty: () => ({
      fake: fakeSurface({ active: activeEditor({ empty: true }) }),
      deps: {},
    }),
    "whole-document": () => ({
      fake: fakeSurface({ active: activeEditor({ coversWholeDocument: true }) }),
      deps: {},
    }),
    "not-focused": () => ({ fake: fakeSurface({ focused: false }), deps: {} }),
    "not-active": () => ({
      fake: fakeSurface({ active: activeEditor({ isActiveEditor: false }) }),
      deps: {},
    }),
    "too-soon-after-tool": () => ({
      fake: fakeSurface({}),
      deps: { clock: justTouched(), now: () => MIN_MS_SINCE_OWN_TOOL_CALL - 1 },
    }),
    "already-returned": () => {
      const memory = new SelectionMemory();
      const fake = fakeSurface({});
      // 一度返させてから、同じ選択でもう一度呼ぶ。
      handleGetEditorState({
        config,
        surface: fake.surface,
        memory,
        clock: new OwnToolCallClock(),
        statusBar: noopStatusBar,
      });
      return { fake, deps: { memory } };
    },
  };

  for (const reason of SELECTION_WITHHELD_REASONS) {
    it(`${reason}: selectedText が入らず、理由が返る`, () => {
      const { fake, deps } = CASES[reason]();
      const readsBefore = fake.reads();
      const result = run(fake, deps);
      expect(result.selectionWithheld).toBe(reason);
      expect(result).not.toHaveProperty("selectedText");
      // **共有しないと決めたら、テキストを読みにも行かない。**
      expect(fake.reads()).toBe(readsBefore);
      expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
    });
  }

  it("8つすべてに検査がある（語彙が増えたら落ちる）", () => {
    expect(Object.keys(CASES).sort()).toEqual([...SELECTION_WITHHELD_REASONS].sort());
  });
});

describe("除外パス", () => {
  it("選択テキストだけでなく、範囲・カーソル・可視行も返さない", () => {
    // 範囲だけでも情報になる。何行目の何桁までか、が分かれば、人間が行末へ
    // カーソルを動かすたびにその行の長さが読める。KEY=value の形式が分かって
    // いるファイルでは、それは値の長さそのものである。
    const result = run(fakeSurface({ active: activeEditor({ relPath: ".env" }) }));
    expect(result.selectionWithheld).toBe("redacted");
    expect(result).not.toHaveProperty("selectedText");
    expect(result).not.toHaveProperty("selection");
    expect(result).not.toHaveProperty("cursor");
    expect(result).not.toHaveProperty("visibleLines");
  });

  it("パスは返す（除外に当たることは show_code に問えば分かる）", () => {
    const result = run(fakeSurface({ active: activeEditor({ relPath: ".env" }) }));
    expect(result.activePath).toBe(".env");
  });

  it("大文字小文字を変えても除外を迂回できない", () => {
    const result = run(fakeSurface({ active: activeEditor({ relPath: ".ENV" }) }));
    expect(result.selectionWithheld).toBe("redacted");
  });

  it("設定で足したパターンも効く（加算専用）", () => {
    const result = run(fakeSurface({ active: activeEditor({ relPath: "notes/private.md" }) }), {
      config: () => config({ redactedPathPatterns: [...DEFAULT_REDACTED_PATTERNS, "private.md"] }),
    });
    expect(result.selectionWithheld).toBe("redacted");
  });
});

describe("ワークスペースの外", () => {
  it("パスも位置も返さない（相対パスを作れない場所は名指ししない）", () => {
    const result = run(fakeSurface({ active: activeEditor({ relPath: undefined }) }));
    expect(result.selectionWithheld).toBe("outside-workspace");
    expect(result).not.toHaveProperty("activePath");
    expect(result).not.toHaveProperty("selection");
    expect(result).not.toHaveProperty("cursor");
  });
});

describe("エディタが無いとき", () => {
  it("openPaths だけを返し、理由を付ける（「選択が無い」と区別できるようにする）", () => {
    const result = run(fakeSurface({ active: "none" }));
    expect(result.selectionWithheld).toBe("not-active");
    expect(result.openPaths).toEqual(["src/app.ts", "README.md"]);
    expect(result).not.toHaveProperty("activePath");
    expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("上限", () => {
  it("設定の上限で切り詰める", () => {
    const long = "x".repeat(500);
    const fake = fakeSurface({ active: activeEditor({ readSelectedText: () => long }) });
    const result = run(fake, { config: () => config({ maxSelectionChars: 100 }) });
    expect((result.selectedText as string).length).toBe(100);
  });

  it("設定が protocol の絶対上限より大きくても、絶対上限で切れる", () => {
    // 上限を拡張側の善意にだけ委ねない。信頼境界はソケットなので、線に載る
    // 大きさは型で有界でなければならない。
    const long = "x".repeat(MAX_SELECTED_TEXT_CHARS * 2);
    const fake = fakeSurface({ active: activeEditor({ readSelectedText: () => long }) });
    const result = run(fake, { config: () => config({ maxSelectionChars: 1_000_000 }) });
    expect((result.selectedText as string).length).toBe(MAX_SELECTED_TEXT_CHARS);
    expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
  });

  it("面には上限を渡す（読む側でも大きな文字列を組み立てさせない）", () => {
    let asked = -1;
    const fake = fakeSurface({
      active: activeEditor({
        readSelectedText: (maxChars: number) => {
          asked = maxChars;
          return SELECTED;
        },
      }),
    });
    run(fake, { config: () => config({ maxSelectionChars: 123 }) });
    expect(asked).toBe(123);
  });

  it("サロゲートペアを割らない（上限を1ずつ動かして境界を跨がせる）", () => {
    // 絵文字は 2 コード単位なので、上限を 1 ずつ動かせば境界がペアの内側にも
    // 外側にも来る。片方の上限でだけ通る実装を残さない。
    const long = "\u{1F600}".repeat(400);
    const fake = fakeSurface({ active: activeEditor({ readSelectedText: () => long }) });
    for (let limit = 2; limit <= 20; limit++) {
      const text = run(fake, { config: () => config({ maxSelectionChars: limit }) })
        .selectedText as string;
      expect(text.length).toBeLessThanOrEqual(limit);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff, `上限 ${limit} で上位が孤立`).toBe(true);
        }
        if (code >= 0xdc00 && code <= 0xdfff) {
          const prev = text.charCodeAt(i - 1);
          expect(prev >= 0xd800 && prev <= 0xdbff, `上限 ${limit} で下位が孤立`).toBe(true);
        }
      }
    }
  });

  it("切り詰めたことが読み手に分かる（末尾に省略記号が付く）", () => {
    // 黙って切ると、エージェントは「選択はここで終わっている」と読む。
    const long = "x".repeat(500);
    const fake = fakeSurface({ active: activeEditor({ readSelectedText: () => long }) });
    const text = run(fake, { config: () => config({ maxSelectionChars: 100 }) })
      .selectedText as string;
    expect(text.endsWith("…")).toBe(true);
    // 切り詰めていないときは付かない。
    expect(run(fakeSurface({})).selectedText).toBe(SELECTED);
  });

  it("選択テキストは無害化（エスケープ）されない", () => {
    // サニタイザは人間の画面に載せるためのもの。ここの読み手はエージェントで、
    // 制御文字をエスケープ列に置き換えたら、それは選択されたテキストではない
    // 別の文字列になる。
    const raw = "a\tb\nc";
    const fake = fakeSurface({ active: activeEditor({ readSelectedText: () => raw }) });
    expect(run(fake).selectedText).toBe(raw);
  });

  it("openPaths の本数はスキーマの上限に収まる", () => {
    const many = Array.from({ length: MAX_OPEN_PATHS }, (_, i) => `src/f${i}.ts`);
    const result = run(fakeSurface({ openPaths: many }));
    expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
  });
});

/**
 * `openPaths` は**人間が開いているタブの観測**である（設計 D37）。
 *
 * 増分3 までは除外パスを落とし、落とした件数を `openPathsHidden` で返していた。
 * 増分4 でその判断を覆した ―― 伏せて得ていたのは「`.env` が存在する」の1ビット
 * だけで、それは `show_code` に問えば `excluded-path` として既に読める。一方、
 * 伏せるとレイアウトに穴が空き、片づけの判断（`arrange_editors`）に使えない
 * 一覧になる。**名前は出し、中身（可視行・カーソル・選択）は伏せる。**
 */
describe("openPaths は秘匿ファイルも載せる（D37）", () => {
  it("秘匿パスも並ぶ", () => {
    const result = run(fakeSurface({ openPaths: ["src/app.ts", ".env", "docs/notes.md"] }));
    expect(result.openPaths).toEqual(["src/app.ts", ".env", "docs/notes.md"]);
  });

  it("openPathsHidden は**返さない**（同じ量を2箇所で返さない）", () => {
    // 名前が出るようになれば、この数は「上限で溢れた分」だけになり、
    // それは `openPaths.length` から読める。
    const result = run(fakeSurface({ openPaths: ["src/app.ts", ".env"] }));
    expect(result).not.toHaveProperty("openPathsHidden");
  });

  it("重複は潰し、最初に現れた順を保つ", () => {
    const result = run(fakeSurface({ openPaths: ["b.ts", "a.ts", "b.ts", "c.ts"] }));
    expect(result.openPaths).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("秘匿パスを含む結果も結果スキーマを通る", () => {
    const result = run(fakeSurface({ openPaths: [".env", "src/app.ts"] }));
    expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
  });

  it("秘匿パスが active でも、パスそのものは返る（伏せても隠せるものが無い）", () => {
    const result = run(
      fakeSurface({ active: activeEditor({ relPath: ".env" }), openPaths: [".env"] }),
    );
    expect(result.activePath).toBe(".env");
    expect(result.openPaths).toEqual([".env"]);
    expect(result.selectedText).toBeUndefined();
    expect(result.selectionWithheld).toBe("redacted");
  });
});

/**
 * レイアウトを返す（設計 D37 / D37' / D38）。
 *
 * 判断そのものは `buildEditorLayout`（純関数）の検査が覆っている。ここで
 * 見るのは**ハンドラが面の観測をその関数に正しく渡し、結果を線に載せるか**と、
 * **予算がいちばん先に当たるか**である。
 */
describe("レイアウトを返す（設計 D37/D37'/D38）", () => {
  function groupsOf(result: Record<string, unknown>): EditorGroupState[] {
    const groups = result.groups;
    expect(Array.isArray(groups), JSON.stringify(result)).toBe(true);
    return groups as EditorGroupState[];
  }

  it("groups が結果に載る", () => {
    const result = run(
      fakeSurface({
        groups: [
          {
            viewColumn: 1,
            isActive: true,
            tabs: [
              observedTab({
                label: "index.ts",
                relPath: "src/index.ts",
                isActive: true,
                visibleLines: { start: 1, end: 30 },
              }),
            ],
          },
        ],
      }),
    );
    const groups = groupsOf(result);
    expect(groups).toHaveLength(1);
    expect(groups[0].viewColumn).toBe(1);
    expect(groups[0].isActive).toBe(true);
    expect(groups[0].tabs[0].path).toBe("src/index.ts");
    expect(groups[0].tabs[0].visibleLines).toEqual({ start: 1, end: 30 });
    // **同じ観測から畳む。** 面に2度目の問い合わせをしていない。
    expect(result.openPaths).toEqual(["src/index.ts"]);
  });

  it("秘匿ファイルは名前が載り、可視行が落ちる", () => {
    const result = run(
      fakeSurface({
        groups: [
          {
            viewColumn: 1,
            isActive: true,
            tabs: [
              observedTab({
                label: ".env",
                relPath: ".env",
                isActive: true,
                isDirty: true,
                visibleLines: { start: 1, end: 12 },
              }),
            ],
          },
        ],
      }),
    );
    const tab = groupsOf(result)[0].tabs[0];
    expect(tab.label).toBe(".env");
    expect(tab.path).toBe(".env");
    expect(tab.visibleLines).toBeUndefined();
    // 動かない1ビットは残る（落としているのは連動して動く量だけ）。
    expect(tab.isDirty).toBe(true);
    expect(result.openPaths).toContain(".env");
  });

  it("秘匿の判定は設定の除外リストそのもの（対照つき）", () => {
    // 対照が無いと、「可視行が落ちた」が別の理由（観測に入っていない）でも
    // 成り立つ。**同じ面**に対して、利用者の追加パターンだけを変えて比べる。
    const surface = fakeSurface({
      groups: [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            observedTab({
              label: "token.txt",
              relPath: "secrets/token.txt",
              visibleLines: { start: 2, end: 8 },
            }),
          ],
        },
      ],
    });
    const withoutExtra = run(surface);
    expect(groupsOf(withoutExtra)[0].tabs[0].visibleLines).toEqual({ start: 2, end: 8 });

    const withExtra = run(surface, {
      config: () => config({ redactedPathPatterns: ["secrets/*"] }),
    });
    expect(groupsOf(withExtra)[0].tabs[0].visibleLines).toBeUndefined();
    // 名前は伏せない（D37）。
    expect(groupsOf(withExtra)[0].tabs[0].path).toBe("secrets/token.txt");
  });

  it("ワークスペース外は名前を返さず、タブは残る（D37'）", () => {
    const result = run(
      fakeSurface({
        groups: [
          {
            viewColumn: 1,
            isActive: true,
            tabs: [observedTab({ label: "id_rsa", relPath: undefined })],
          },
        ],
      }),
    );
    const tab = groupsOf(result)[0].tabs[0];
    expect(tab.label).toBe("(outside workspace)");
    expect(tab.path).toBeUndefined();
    expect(result.openPaths).toEqual([]);
  });

  it("列が無ければ groups の鍵ごと省く", () => {
    const result = run(fakeSurface({ groups: [] }));
    expect(result).not.toHaveProperty("groups");
    expect(result.openPaths).toEqual([]);
  });

  it("結果はスキーマを通る", () => {
    const result = run(fakeSurface({}));
    expect(getEditorStateResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(true);
  });

  it("表示の上限は openPaths を切らない（上限は独立した量）", () => {
    // 1列に MAX_OPEN_PATHS 本。表示は MAX_TABS_PER_GROUP で切れるが、
    // 平坦な一覧はそれでは切れない。ここを表示上限で切ると
    // 「`openPaths.length === MAX_OPEN_PATHS` なら溢れている」が壊れる。
    const many = Array.from({ length: MAX_OPEN_PATHS }, (_, i) => `src/f${i}.ts`);
    const result = run(fakeSurface({ openPaths: many }));
    expect(result.openPaths).toHaveLength(MAX_OPEN_PATHS);
    expect(groupsOf(result)[0].tabs).toHaveLength(MAX_TABS_PER_GROUP);
    expect(getEditorStateResultSchema.safeParse(result).success).toBe(true);
  });

  it("回数制限で断られたときは groups も返らない", () => {
    // 予算はいちばん先に当たる。断ったのに構造だけ返すと、軌跡を取る経路が残る。
    let observed = 0;
    const fake = fakeSurface({});
    const counting: EditorStateSurface = {
      ...fake.surface,
      groups: () => {
        observed += 1;
        return fake.surface.groups();
      },
    };
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000, maxKeys: 1 });
    expect(() =>
      handleGetEditorState({
        config,
        surface: counting,
        memory: new SelectionMemory(),
        clock: new OwnToolCallClock(),
        limiter,
        statusBar: noopStatusBar,
      }),
    ).toThrow();
    // **観測にすら行かない。** 返さないだけでは足りない。
    expect(observed).toBe(0);
  });
});

describe("同じ選択を二度返さない", () => {
  it("二度目は already-returned、人間が動かせばまた返る", () => {
    const memory = new SelectionMemory();
    const first = fakeSurface({});
    expect(run(first, { memory }).selectedText).toBe(SELECTED);
    expect(run(first, { memory }).selectionWithheld).toBe("already-returned");

    // 人間が別の範囲を選び直した。
    const moved = fakeSurface({
      active: activeEditor({
        selection: { startLine: 20, startCharacter: 0, endLine: 20, endCharacter: 9 },
      }),
    });
    expect(run(moved, { memory }).selectedText).toBe(SELECTED);
    // 前の範囲へ戻れば、また返せる（覚えるのは直前の1つだけ）。
    expect(run(first, { memory }).selectedText).toBe(SELECTED);
  });

  it("共有しなかった選択は覚えない（窓に戻った直後に返せる）", () => {
    const memory = new SelectionMemory();
    const unfocused = fakeSurface({ focused: false });
    expect(run(unfocused, { memory }).selectionWithheld).toBe("not-focused");
    const focused = fakeSurface({});
    expect(run(focused, { memory }).selectedText).toBe(SELECTED);
  });
});

describe("自ツールが触った直後", () => {
  it("上限を過ぎれば返る", () => {
    const clock = justTouched();
    const fake = fakeSurface({});
    expect(run(fake, { clock, now: () => MIN_MS_SINCE_OWN_TOOL_CALL - 1 }).selectionWithheld).toBe(
      "too-soon-after-tool",
    );
    expect(run(fake, { clock, now: () => MIN_MS_SINCE_OWN_TOOL_CALL }).selectedText).toBe(SELECTED);
  });
});

describe("selectedText が入る経路は1つだけ", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "handlers", "get-editor-state.ts"),
    "utf8",
  );

  it("ハンドラのソースに代入が1箇所しかない", () => {
    // 経路が2本になった瞬間、片方だけに条件が付いた形が生まれる。実際に
    // 「片方だけ直る」で壊れたものが、このリポジトリには既にいくつもある。
    const assignments = source.match(/result\.selectedText\s*=/g) ?? [];
    expect(assignments.length).toBe(1);
  });

  it("その代入は verdict.share を通った後にしかない", () => {
    const guard = source.indexOf("if (!verdict.share)");
    const assignment = source.indexOf("result.selectedText =");
    expect(guard).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(guard);
  });

  it("検査器が実際に代入を数えられる", () => {
    // 「1箇所しかない」を信用する前に、判定が本当に当たることを確かめる。
    expect(
      ("result.selectedText = a;\nresult.selectedText=b;".match(/result\.selectedText\s*=/g) ?? [])
        .length,
    ).toBe(2);
  });
});

/**
 * `annotations`（増分6 D72 / §C6）。**面の `annotations()` 1回から作る**
 * （`groups` / `openPaths` と同じ形。不変条件14）。本文は載らない。
 */
describe("annotations（D72）", () => {
  const observed = (over: Partial<ObservedAnnotation> = {}): ObservedAnnotation => ({
    id: 1,
    index: 1,
    relPath: "src/app.ts",
    line: 12,
    color: "red",
    resolved: false,
    ...over,
  });

  it("id・index・path・line・color・resolved を index 順に写す", () => {
    const fake = fakeSurface({
      annotations: [
        observed({ id: 7, index: 1, relPath: "src/a.ts", line: 3, color: "red" }),
        observed({ id: 9, index: 2, relPath: "src/b.ts", line: 40, color: undefined }),
        observed({ id: 10, index: 3, relPath: "src/a.ts", line: 5, color: "blue", resolved: true }),
      ],
    });
    const result = run(fake);
    expect(result.annotations).toEqual([
      { id: 7, index: 1, path: "src/a.ts", line: 3, color: "red", resolved: false },
      { id: 9, index: 2, path: "src/b.ts", line: 40, resolved: false },
      { id: 10, index: 3, path: "src/a.ts", line: 5, color: "blue", resolved: true },
    ]);
    // 無印は鍵ごと無い（`undefined` の鍵を線に載せない）。
    const second = (result.annotations as Record<string, unknown>[])[1];
    expect(second !== undefined && "color" in second).toBe(false);
  });

  it("注釈が無ければ鍵ごと省く（groups と同じ約束）", () => {
    const result = run(fakeSurface({ annotations: [] }));
    expect("annotations" in result).toBe(false);
  });

  it("本文はどの鍵にも載らない（§C6）", () => {
    const result = run(fakeSurface({ annotations: [observed()] }));
    const [entry] = result.annotations as Record<string, unknown>[];
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["color", "id", "index", "line", "path", "resolved"].sort(),
    );
  });

  it("結果は線上の結果スキーマ（strict）を通る", () => {
    const fake = fakeSurface({
      annotations: [observed(), observed({ id: 2, index: 2, color: undefined, resolved: true })],
    });
    const parsed = getEditorStateResultSchema.safeParse(run(fake));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("相対パスにできない注釈は載せない（起きない経路だが、起きたら黙って名指ししない）", () => {
    const fake = fakeSurface({
      annotations: [observed({ relPath: undefined }), observed({ id: 2, index: 2 })],
    });
    const result = run(fake);
    expect(result.annotations).toEqual([
      { id: 2, index: 2, path: "src/app.ts", line: 12, color: "red", resolved: false },
    ]);
  });

  it("予算で断られたときは annotations も返らない（投げる）", () => {
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000 });
    expect(() => run(fakeSurface({ annotations: [observed()] }), { limiter })).toThrow();
  });
});
