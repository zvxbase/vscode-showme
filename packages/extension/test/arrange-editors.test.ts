import {
  ARRANGE_ACTIONS,
  ARRANGE_WITHHELD_REASONS,
  type ArrangeAction,
  arrangeActionCloses,
  arrangeActionMoves,
  arrangeEditorsResultSchema,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ArrangePermissions,
  TARGET_GROUPS,
  firstStageColumn,
  layoutWouldMergeHumanColumn,
} from "../src/arrange-policy.js";
import type { ShowMeConfig } from "../src/config.js";
import {
  type ArrangeEditorsArgs,
  type ArrangeEditorsDeps,
  type ArrangeLayoutAction,
  type ArrangeSurface,
  type ArrangeTab,
  type MoveOutcome,
  handleArrangeEditors,
} from "../src/handlers/arrange-editors.js";
import { ToolError } from "../src/tool-error.js";
import type { WorkspacePathVerdict } from "../src/workspace-path-gate.js";

/**
 * `handleArrangeEditors` の単体テスト。
 *
 * **この道具は人間のワークスペースに触る唯一のものである。** だから
 * 「閉じてよいか」の判断は `arrange-policy.ts` に、「どれを候補にするか」は
 * ここに置き、面（`arrange-surface.ts`）には何も決めさせない。面は `vscode` を
 * 値で import するので**単体で1件も確かめられない** ―― 判断がそちらに漏れると、
 * この道具でいちばん確かめなければならない箇所が無検査になる。
 *
 * 検査の作法:
 *
 * - **否定の主張には対照を付ける。** 「閉じなかった」は、入力が壊れていても真に
 *   なる。同じ入力が設定次第で**閉じる**ことを隣で見せて、落ちた理由を指させる
 * - **断った枚数を返していないこと**を、鍵の一覧と「枚数を変えても結果が同じ」の
 *   両方で見る（枚数は人間のタブを数える口になる）
 */

/** 面の偽物。**何を渡されたかだけ**を記録し、判断はしない（本物と同じ役割）。 */
/** 列 `1..n`（`tabGroups.all` の `viewColumn` の観測に相当）。 */
const columns = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/**
 * 面の偽物。`moveTabs` は本物と同じ**形**をなぞる ―― 1枚ごとに `decide` に面の
 * 新しい観測（`groupColumns` / `humanColumn`）を渡し、止められたら残りを動かさない。
 * `fail` で「この札は動かせなかった」を作れる。判断はしない。
 */
const surface = (
  over: Partial<ArrangeSurface> = {},
  fail: (id: string) => boolean = () => false,
): ArrangeSurface => {
  const s: ArrangeSurface = {
    listTabs: () => [],
    closeTabs: vi.fn(async () => true),
    applyLayout: vi.fn(async () => true),
    moveTabs: vi.fn(async (ids, decide) => {
      const outcome: MoveOutcome = { moved: 0, failed: 0 };
      for (const id of ids) {
        const decision = decide({ columns: s.groupColumns(), humanColumn: s.humanColumn() });
        if (!decision.ok) {
          outcome.halted = decision.reason;
          break;
        }
        if (fail(id)) outcome.failed += 1;
        else outcome.moved += 1;
      }
      return outcome;
    }),
    movePanel: vi.fn(async () => true),
    // 既定は「人間の列だけ」（1グループ、人間は列1）。どのプリセットも減らさないので安全。
    // 巻き込みの検査は、この2つを明示して上書きする。
    groupColumns: () => columns(1),
    humanColumn: () => 1,
    ...over,
  };
  return s;
};

/** `moveTabs` に渡った札の並び（呼び出しごと）。 */
const movedIds = (s: ArrangeSurface): string[][] =>
  (s.moveTabs as ReturnType<typeof vi.fn>).mock.calls.map((call) => [...(call[0] as string[])]);

const tab = (over: Partial<ArrangeTab> & { id: string }): ArrangeTab => ({
  kind: "text",
  own: false,
  isDirty: false,
  isActive: false,
  viewing: false,
  ...over,
});

const config = (layout: Partial<ArrangePermissions> = {}): (() => ShowMeConfig) => {
  const full: ShowMeConfig = {
    enabled: true,
    editorGroup: "dedicated",
    html: { maxPanels: 2 },
    disabledTools: [],
    redactedPathPatterns: [],
    maxSelectionChars: 4000,
    injectTerminalEnv: true,
    listAllWorkspaces: false,
    layout: { closeHumanTabs: false, closeDirtyTabs: false, ...layout },
  };
  return () => full;
};

/**
 * 関門の偽物。`acceptWorkspacePath` の形を写す ―― `..` を含む綴りは正準化して返し、
 * `secret` を含むものは除外、`missing` を含むものは無い、と決める。判断の中身は
 * `workspace-path-gate.test.ts` が持ち、ここは「ハンドラが関門の**答え**を使っている」
 * ことだけを見る。
 */
const acceptPath = (raw: string): WorkspacePathVerdict => {
  if (raw.includes("secret")) return { ok: false, reason: "excluded-path" };
  if (raw.includes("missing")) return { ok: false, reason: "invalid-path" };
  const canonical = raw.replace(/^src\/\.\.\//, "");
  return { ok: true, canonical, realPath: `/ws/${canonical}` };
};

const deps = (over: Partial<ArrangeEditorsDeps> = {}): ArrangeEditorsDeps => ({
  surface: surface(),
  config: config(),
  acceptPath,
  clearSpotlight: vi.fn(),
  log: { info: vi.fn() },
  ...over,
});

/** 人間のタブが混ざった、ありふれた画面。`active` は人間が今見ている列である。 */
const MIXED: readonly ArrangeTab[] = [
  tab({ id: "active", isActive: true }),
  tab({ id: "h1" }),
  tab({ id: "h2", isDirty: true }),
  // `path` は `argsFor("move-tab")` が指す先（振り分けと線上の形の検査で使う）。
  tab({ id: "p1", own: true, path: "src/a.ts" }),
];

describe("handleArrangeEditors: 候補の選び方", () => {
  it("close-own は自分のもの（パネルもテキストタブも）だけを閉じる", async () => {
    const closeTabs = vi.fn(async () => true);
    // `own` は面が webview の `viewType` と `OpenedByAgent` の記録から決めて渡す。
    // ハンドラは種類を見ない ―― own のテキストタブも own のパネルも同じ候補である。
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "p1", own: true }),
            tab({ id: "mine.ts", own: true }),
            tab({ id: "t1" }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["p1", "mine.ts"]);
    expect(result.closed).toBe(2);
    expect(result.done).toBe(true);
  });

  it("close-own は人間のタブを候補にしない（設定を全部立てても）", async () => {
    // 「自分のパネルを閉じる」に人間のタブが混ざったら、語彙が嘘になる。
    const closeTabs = vi.fn(async () => true);
    await handleArrangeEditors(
      { action: "close-own" },
      deps({
        config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
        surface: surface({ listTabs: () => [...MIXED], closeTabs }),
      }),
    );
    // 対照: 同じ画面・同じ設定で `close-other-tabs` なら人間のタブが渡る。
    // これが無いと「候補が空だから呼ばれなかった」でも緑になる。
    expect(closeTabs).toHaveBeenCalledWith(["p1"]);
  });

  it("自分のパネルは、その列でアクティブでも、設定が全部 false でも閉じる", async () => {
    // `isActive`（列ごと）は close-own の除外条件ではない。除外するのは
    // `viewing`（窓に1枚）だけである。4B の「未保存でも閉じる」は D53' で消えた
    // （下の「床1 ―― 人間が見ているタブは触らない」の節に対照がある）。
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "p1", own: true, isActive: true })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["p1"]);
    expect(result.closed).toBe(1);
    expect(result.withheld).toBeUndefined();
  });

  it("アクティブなタブは close-other-tabs で閉じない", async () => {
    const closeTabs = vi.fn(async () => true);
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1" })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["h1"]);
  });

  it("対照: 同じタブも、アクティブでなければ閉じる", async () => {
    // 上の検査が「`active` という札だから落ちた」ではなく
    // 「`isActive` だから落ちた」ことを示す対照。
    const closeTabs = vi.fn(async () => true);
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
        surface: surface({
          listTabs: () => [tab({ id: "active" }), tab({ id: "h1" })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["active", "h1"]);
  });

  it("自分のアクティブなパネルも close-other-tabs では閉じない", async () => {
    // 除外はアクティブかどうかだけで決まる。所有で例外を作らない
    // ―― 作ると「人間が見ている列」と「自分のもの」が別々の判断になる。
    const closeTabs = vi.fn(async () => true);
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "p-active", own: true, isActive: true }),
            tab({ id: "p2", own: true }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["p2"]);
  });
});

/**
 * **片づけたのに指差しが残るのは片づけていない**（増分6 D67）。`close-own` は
 * `show_code` のスポットライトも消す。消すのは画家（`Highlights.clearSpotlight`）で、
 * ハンドラは「片づいたときに1回呼ぶ」だけを決める。
 */
describe("handleArrangeEditors: close-own はスポットライトを消す（D67）", () => {
  it("close-own が片づいたら clearSpotlight を1回呼ぶ", async () => {
    const clearSpotlight = vi.fn();
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({ listTabs: () => [tab({ id: "p1", own: true })] }),
        clearSpotlight,
      }),
    );
    expect(result.done).toBe(true);
    expect(clearSpotlight).toHaveBeenCalledTimes(1);
  });

  it("閉じるものが無くても片づいたことに変わりは無い ―― 消す", async () => {
    // 「何も開いていないが前の指差しだけ残っている」は、まさに片づけて欲しい状態である。
    const clearSpotlight = vi.fn();
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({ surface: surface({ listTabs: () => [] }), clearSpotlight }),
    );
    expect(result.done).toBe(true);
    expect(clearSpotlight).toHaveBeenCalledTimes(1);
  });

  it("close-other-tabs では消さない（人間のタブを片づける語で自分の指差しを消さない）", async () => {
    const clearSpotlight = vi.fn();
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true }),
        surface: surface({ listTabs: () => [...MIXED] }),
        clearSpotlight,
      }),
    );
    expect(clearSpotlight).not.toHaveBeenCalled();
  });

  it("断られた own タブが残っても、片づいた（done）なら消す ―― 指差しは中身ではなく指", async () => {
    // 人間が見ている own タブは床1 で残る。それでも人間は「片づけて」と言ったのであり、
    // 残した指差しに人間が戻る手段も消す手段も無い（§C1）。
    const clearSpotlight = vi.fn();
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "p1", own: true, viewing: true }),
            tab({ id: "p2", own: true }),
          ],
        }),
        clearSpotlight,
      }),
    );
    expect(result.done).toBe(true);
    expect(result.withheld).toEqual(["viewing-tab"]);
    expect(clearSpotlight).toHaveBeenCalledTimes(1);
  });

  it("面が失敗したら（done: false）消さない ―― 何も変わっていない", async () => {
    const clearSpotlight = vi.fn();
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "p1", own: true })],
          closeTabs: vi.fn(async () => false),
        }),
        clearSpotlight,
      }),
    );
    expect(result.done).toBe(false);
    expect(clearSpotlight).not.toHaveBeenCalled();
  });
});

describe("handleArrangeEditors: 既定では人間のタブに届かない（D41 / D43）", () => {
  it("既定では close-other-tabs が人間のタブを1枚も閉じない", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "active", isActive: true }),
            tab({ id: "h1" }),
            tab({ id: "h2", isDirty: true }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.withheld).toContain("human-tabs-not-allowed");
  });

  it("対照: 同じ画面でも closeHumanTabs を立てれば閉じる", async () => {
    // 直前の検査が「候補の作り方を壊したから閉じなかった」でも緑になるのを防ぐ。
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true }),
        surface: surface({
          listTabs: () => [
            tab({ id: "active", isActive: true }),
            tab({ id: "h1" }),
            tab({ id: "h2", isDirty: true }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["h1"]);
    expect(result.closed).toBe(1);
    // 未保存は床（D43）。closeHumanTabs だけでは届かない。
    expect(result.withheld).toContain("dirty-tabs-not-allowed");
  });

  it("両方立てて初めて未保存も閉じる", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
        surface: surface({
          listTabs: () => [
            tab({ id: "active", isActive: true }),
            tab({ id: "h1" }),
            tab({ id: "h2", isDirty: true }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["h1", "h2"]);
    expect(result.closed).toBe(2);
    expect(result.withheld).toBeUndefined();
  });

  it("closeDirtyTabs だけでは人間のタブに届かない（2つの設定は直交）", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeDirtyTabs: true }),
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1" })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
    expect(result.withheld).toContain("human-tabs-not-allowed");
  });
});

describe("handleArrangeEditors: 床1 ―― 人間が見ているタブは触らない（C1）", () => {
  it("自分のタブでも viewing なら close-own で残り、withheld は viewing-tab", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "p-viewing", own: true, viewing: true })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, withheld: ["viewing-tab"] });
  });

  it("対照: 同じタブも viewing でなければ閉じる（落ちた理由は viewing だけ）", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "p-viewing", own: true, viewing: false })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["p-viewing"]);
    expect(result).toEqual({ done: true, closed: 1 });
  });

  it("closeHumanTabs と closeDirtyTabs を両方立てても viewing には触らない（床は設定で外れない）", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
        surface: surface({
          // `isActive: false` なのに `viewing: true` はあり得ないが、候補の絞り込み
          // （`!isActive`）ではなく**述語**が落としていることを見るために分けてある。
          listTabs: () => [tab({ id: "v", viewing: true }), tab({ id: "h1" })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["h1"]);
    expect(result).toEqual({ done: true, closed: 1, withheld: ["viewing-tab"] });
  });

  it("viewing だけで断った自分のタブに、設定の理由を付けない", async () => {
    // viewing は設定で外れないので、「human-tabs-not-allowed」を返すと
    // エージェントは人間に設定を頼み、立ててもまた断られる。
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({ listTabs: () => [tab({ id: "v", own: true, viewing: true })] }),
      }),
    );
    expect(result.withheld).toEqual(["viewing-tab"]);
  });

  it("自分の未保存タブを断ると dirty-tabs-not-allowed（床2 は自分のものにも掛かる。D53'）", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "mine-dirty", own: true, isDirty: true })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, withheld: ["dirty-tabs-not-allowed"] });
  });

  it("対照: closeDirtyTabs を立てれば自分の未保存タブは閉じる", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        config: config({ closeDirtyTabs: true }),
        surface: surface({
          listTabs: () => [tab({ id: "mine-dirty", own: true, isDirty: true })],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["mine-dirty"]);
    expect(result).toEqual({ done: true, closed: 1 });
  });
});

describe("handleArrangeEditors: 断ったことは言うが、枚数は言わない", () => {
  it("断った理由が無いときは withheld を付けない（片づいた、と区別できる）", async () => {
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({ listTabs: () => [tab({ id: "active", isActive: true })] }),
      }),
    );
    expect(result).toEqual({ done: true, closed: 0 });
  });

  it("断った枚数が変わっても結果は同じ（人間のタブを数える口にしない）", async () => {
    const one = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1" })],
        }),
      }),
    );
    const many = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "active", isActive: true }),
            tab({ id: "h1" }),
            tab({ id: "h2" }),
            tab({ id: "h3" }),
            tab({ id: "h4" }),
            tab({ id: "h5" }),
          ],
        }),
      }),
    );
    // 対照: 入力が実際に違うこと（加工が空振りしていないこと）を先に主張する。
    expect(one).not.toEqual({ done: true, closed: 0 });
    expect(many).toEqual(one);
  });

  it("結果の鍵は done / closed / withheld の3つだけ", async () => {
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1", isDirty: true })],
        }),
      }),
    );
    expect(Object.keys(result).sort()).toEqual(["closed", "done", "withheld"]);
  });

  it("同じ理由を2度言わない（何枚あるかを数の形で漏らさない）", async () => {
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true }),
        surface: surface({
          listTabs: () => [
            tab({ id: "active", isActive: true }),
            tab({ id: "d1", isDirty: true }),
            tab({ id: "d2", isDirty: true }),
            tab({ id: "d3", isDirty: true }),
          ],
        }),
      }),
    );
    expect(result.withheld).toEqual(["dirty-tabs-not-allowed"]);
  });

  it("既定で未保存の人間のタブを断ると、立てるべき設定を両方言う", async () => {
    // 未保存の人間のタブは closeHumanTabs と closeDirtyTabs の**両方**が要る。
    // 片方しか言わないと、エージェントは片方だけ人間に頼んで、また断られる。
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1", isDirty: true })],
        }),
      }),
    );
    expect(result.withheld?.slice().sort()).toEqual(
      ["dirty-tabs-not-allowed", "human-tabs-not-allowed"].sort(),
    );
  });

  it("断った1枚には必ず理由が付く（無言で断る組み合わせが無い）", () => {
    // 設定4通り × タブ8通り（own × dirty × viewing）を総当たりする。**無言の拒否が1つでもあると、
    // エージェントは「片づいた」と読んで呼び続ける。**
    const promises: Array<Promise<void>> = [];
    let evaluated = 0;
    for (const closeHumanTabs of [false, true]) {
      for (const closeDirtyTabs of [false, true]) {
        for (const own of [false, true]) {
          for (const isDirty of [false, true]) {
            for (const viewing of [false, true]) {
              const label = `${closeHumanTabs}/${closeDirtyTabs}/own=${own}/dirty=${isDirty}/viewing=${viewing}`;
              evaluated += 1;
              promises.push(
                handleArrangeEditors(
                  { action: "close-other-tabs" },
                  deps({
                    config: config({ closeHumanTabs, closeDirtyTabs }),
                    surface: surface({
                      listTabs: () => [
                        tab({ id: "active", isActive: true }),
                        tab({ id: "x", own, isDirty, viewing }),
                      ],
                    }),
                  }),
                ).then((result) => {
                  if (result.closed === 0) {
                    // 1枚が候補で、閉じていない ＝ 断った。理由が要る。
                    expect(result.withheld ?? [], label).not.toHaveLength(0);
                  } else {
                    expect(result.closed, label).toBe(1);
                  }
                }),
              );
            }
          }
        }
      }
    }
    expect(evaluated).toBe(32);
    return Promise.all(promises).then(() => undefined);
  });

  it("withheld の語は閉じた語彙から出ない", async () => {
    const result = await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "active", isActive: true }), tab({ id: "h1", isDirty: true })],
        }),
      }),
    );
    for (const reason of result.withheld ?? []) {
      expect(ARRANGE_WITHHELD_REASONS as readonly string[], reason).toContain(reason);
    }
    expect(
      result.withheld ?? [],
      "理由が1つも出ていないなら、この検査は何も見ていない",
    ).not.toHaveLength(0);
  });
});

describe("handleArrangeEditors: 面の呼び方", () => {
  it("閉じるものが無いときは closeTabs を呼ばない（空の指示を渡さない）", async () => {
    const closeTabs = vi.fn(async () => true);
    // 自分のパネルが1枚も無い画面。
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({ surface: surface({ listTabs: () => [tab({ id: "h1" })], closeTabs }) }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0 });
  });

  it("タブが1枚も無くても closeTabs を呼ばない", async () => {
    const closeTabs = vi.fn(async () => true);
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({ surface: surface({ listTabs: () => [], closeTabs }) }),
    );
    expect(closeTabs).not.toHaveBeenCalled();
  });

  it("面が失敗したら done: false で、閉じた数は 0 と言う", async () => {
    // `closed` は**実際に閉じた数**である（D51）。面が失敗したのに
    // 「3枚閉じた」と言うと、エージェントは次に何をすべきか判断できない。
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "p1", own: true }), tab({ id: "p2", own: true })],
          closeTabs: vi.fn(async () => false),
        }),
      }),
    );
    expect(result.done).toBe(false);
    expect(result.closed).toBe(0);
  });

  it("レイアウトの組み替えはタブを閉じない", async () => {
    const closeTabs = vi.fn(async () => true);
    const applyLayout = vi.fn(async () => true);
    const layoutActions = ARRANGE_ACTIONS.filter(
      (action) => !arrangeActionCloses(action) && !arrangeActionMoves(action),
    );
    for (const action of layoutActions) {
      const result = await handleArrangeEditors(
        { action },
        deps({ surface: surface({ listTabs: () => [...MIXED], closeTabs, applyLayout }) }),
      );
      expect(closeTabs, action).not.toHaveBeenCalled();
      expect(result.closed, action).toBe(0);
      expect(result.withheld, action).toBeUndefined();
    }
    expect(layoutActions.length, "組み替えの語が1つも無いなら、この検査は何も見ていない").toBe(5);
    expect(applyLayout).toHaveBeenCalledTimes(layoutActions.length);
  });

  it("語彙の全語が、arrangeActionCloses / arrangeActionMoves の言うとおりに振り分けられる", async () => {
    // **振り分けを2箇所で決めない**（不変条件14）。ここで語を並べ直すのではなく、
    // 語彙の側の述語と突き合わせる ―― 語を足したら、この検査が自動で当たる。
    for (const action of ARRANGE_ACTIONS) {
      const closeTabs = vi.fn(async () => true);
      const applyLayout = vi.fn(async () => true);
      // 動かす語は引数の形が語ごとに違う（move-tab: path+toColumn / move-panel: toColumn）。
      // 形が合わないと invalid-request で落ちて、振り分けを見る前に終わる。
      await handleArrangeEditors(
        argsFor(action),
        deps({
          config: config({ closeHumanTabs: true, closeDirtyTabs: true }),
          surface: surface({ listTabs: () => [...MIXED], closeTabs, applyLayout }),
        }),
      );
      if (arrangeActionCloses(action)) {
        expect(closeTabs, action).toHaveBeenCalled();
        expect(applyLayout, action).not.toHaveBeenCalled();
      } else if (arrangeActionMoves(action)) {
        expect(applyLayout, action).not.toHaveBeenCalled();
        expect(closeTabs, action).not.toHaveBeenCalled();
      } else {
        expect(applyLayout, action).toHaveBeenCalledWith(action);
        expect(closeTabs, action).not.toHaveBeenCalled();
      }
    }
  });

  it("組み替えは面の返り値をそのまま done にする", async () => {
    const result = await handleArrangeEditors(
      { action: "grid" },
      deps({ surface: surface({ applyLayout: vi.fn(async () => false) }) }),
    );
    expect(result).toEqual({ done: false, closed: 0 });
  });

  it("listTabs は1回しか呼ばない（観測の途中で画面が変わらないように）", async () => {
    const listTabs = vi.fn((): ArrangeTab[] => [...MIXED]);
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        config: config({ closeHumanTabs: true }),
        surface: surface({ listTabs }),
      }),
    );
    expect(listTabs).toHaveBeenCalledTimes(1);
  });
});

/**
 * **プリセットが人間の列を巻き込むなら、呼ばない**（設計 §C3 / D55-2。所見4b・4c）。
 *
 * 判定そのもの（真理値表）は `arrange-policy.test.ts` にある。ここで見るのは
 * ハンドラが**判定のとおりに面を呼ぶ／呼ばない**こと ―― 合流は一方通行なので、
 * 「呼んでから戻す」は無い。`applyLayout` の呼び出し回数 0 が証拠である。
 *
 * 否定（呼ばれない）には対照（同じ画面で人間の列だけ変えれば呼ばれる）を付ける。
 */
describe("handleArrangeEditors: 人間の列が合流するプリセットは呼ばない（D55-2）", () => {
  it("人間が列2で3列 → two-columns は呼ばずに断る（列3が人間の列に流れ込む）", async () => {
    const applyLayout = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "two-columns" },
      deps({
        surface: surface({ applyLayout, groupColumns: () => columns(3), humanColumn: () => 2 }),
      }),
    );
    expect(applyLayout).not.toHaveBeenCalled();
    expect(result).toEqual({ done: false, closed: 0, withheld: ["human-column-would-merge"] });
  });

  it("対照: 同じ3列でも人間が列1なら two-columns は呼ばれる（列3が列2に合流。人間は無事）", async () => {
    const applyLayout = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "two-columns" },
      deps({
        surface: surface({ applyLayout, groupColumns: () => columns(3), humanColumn: () => 1 }),
      }),
    );
    expect(applyLayout).toHaveBeenCalledWith("two-columns");
    expect(result).toEqual({ done: true, closed: 0 });
  });

  it("人間が列3で3列 → two-columns は断る（人間の列そのものが流れ込む）", async () => {
    const applyLayout = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "two-columns" },
      deps({
        surface: surface({ applyLayout, groupColumns: () => columns(3), humanColumn: () => 3 }),
      }),
    );
    expect(applyLayout).not.toHaveBeenCalled();
    expect(result.withheld).toEqual(["human-column-would-merge"]);
  });

  it("even-widths は減らさないので、何列でも人間がどこに居ても通る", async () => {
    for (const [groupCount, humanColumn] of [
      [1, 1],
      [3, 3],
      [5, 2],
    ] as const) {
      const applyLayout = vi.fn(async () => true);
      const result = await handleArrangeEditors(
        { action: "even-widths" },
        deps({
          surface: surface({
            applyLayout,
            groupColumns: () => columns(groupCount),
            humanColumn: () => humanColumn,
          }),
        }),
      );
      expect(applyLayout, `${groupCount}/${humanColumn}`).toHaveBeenCalledWith("even-widths");
      expect(result, `${groupCount}/${humanColumn}`).toEqual({ done: true, closed: 0 });
    }
  });

  it("閉じない語すべてが、判定のとおりに呼ばれる／呼ばれない（判定は policy 1箇所）", async () => {
    // **ここで判定を書き直さない**（不変条件14）。`TARGET_GROUPS` と
    // `layoutWouldMergeHumanColumn` を同じ引数で呼び、その値と面の呼び出しを突き合わせる。
    // 語を足したら自動で当たる。
    const layoutActions = ARRANGE_ACTIONS.filter(
      (a) => !arrangeActionCloses(a) && !arrangeActionMoves(a),
    );
    let evaluated = 0;
    for (const action of layoutActions) {
      for (const groupCount of [1, 2, 3, 4, 5]) {
        for (let humanColumn = 1; humanColumn <= groupCount; humanColumn += 1) {
          const applyLayout = vi.fn(async () => true);
          const result = await handleArrangeEditors(
            { action },
            deps({
              surface: surface({
                applyLayout,
                groupColumns: () => columns(groupCount),
                humanColumn: () => humanColumn,
              }),
            }),
          );
          const merges = layoutWouldMergeHumanColumn(
            TARGET_GROUPS[action as ArrangeLayoutAction],
            groupCount,
            humanColumn,
          );
          const label = `${action} groups=${groupCount} human=${humanColumn}`;
          if (merges) {
            expect(applyLayout, label).not.toHaveBeenCalled();
            expect(result, label).toEqual({
              done: false,
              closed: 0,
              withheld: ["human-column-would-merge"],
            });
          } else {
            expect(applyLayout, label).toHaveBeenCalledWith(action);
            expect(result, label).toEqual({ done: true, closed: 0 });
          }
          evaluated += 1;
        }
      }
    }
    expect(evaluated).toBe(5 * 15); // 5語 × Σ(1..5)
  });

  it("人間の列が観測できないなら、減らす操作は呼ばずに断る（推測で通さない）", async () => {
    // 観測できないときに 1 を名乗ると、`>=` の最も緩い値になって合流を許す ――
    // 安全側の判定に fail-open の既定値を置かない（D39。編集面の7件目と同じ形）。
    const applyLayout = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "two-columns" },
      deps({
        surface: surface({
          applyLayout,
          groupColumns: () => columns(3),
          humanColumn: () => undefined,
        }),
      }),
    );
    expect(applyLayout).not.toHaveBeenCalled();
    expect(result).toEqual({ done: false, closed: 0, withheld: ["human-column-would-merge"] });
    // 対照: 減らさない操作は、観測できなくても通る（断る理由が無い）。
    const even = vi.fn(async () => true);
    const evenResult = await handleArrangeEditors(
      { action: "even-widths" },
      deps({
        surface: surface({
          applyLayout: even,
          groupColumns: () => columns(3),
          humanColumn: () => undefined,
        }),
      }),
    );
    expect(even).toHaveBeenCalledWith("even-widths");
    expect(evenResult).toEqual({ done: true, closed: 0 });
  });

  it("断ったことを記録する（理由つき）", async () => {
    const info = vi.fn();
    await handleArrangeEditors(
      { action: "grid" },
      deps({
        surface: surface({ groupColumns: () => columns(5), humanColumn: () => 4 }),
        log: { info },
      }),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("arrange_editors withheld");
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      action: "grid",
      reason: "human-column-would-merge",
    });
  });

  it("閉じる語では列の数を見ない（プリセットの判定は閉じない側の枝だけ）", async () => {
    const groupColumns = vi.fn(() => columns(3));
    const humanColumn = vi.fn(() => 3);
    await handleArrangeEditors(
      { action: "close-own" },
      deps({ surface: surface({ listTabs: () => [...MIXED], groupColumns, humanColumn }) }),
    );
    expect(groupColumns).not.toHaveBeenCalled();
    expect(humanColumn).not.toHaveBeenCalled();
  });
});

/** 語ごとに、形の合う引数を作る（動かす語は path / toColumn が要る）。 */
function argsFor(action: ArrangeAction): ArrangeEditorsArgs {
  if (action === "move-tab") return { action, path: "src/a.ts", toColumn: 2 };
  if (action === "move-panel") return { action, toColumn: 2 };
  // `close-tabs` は `paths` が要る。MIXED の own テキストタブを指す。
  if (action === "close-tabs") return { action, paths: ["src/a.ts"] };
  return { action };
}

describe("handleArrangeEditors: 線に出せる形になっている", () => {
  const ALL: readonly ArrangeAction[] = ARRANGE_ACTIONS;

  it("どの語の結果も線上のスキーマを通る", async () => {
    for (const action of ALL) {
      for (const closeHumanTabs of [false, true]) {
        const result = await handleArrangeEditors(
          argsFor(action),
          deps({
            config: config({ closeHumanTabs }),
            surface: surface({ listTabs: () => [...MIXED] }),
          }),
        );
        expect(
          arrangeEditorsResultSchema.safeParse(result).success,
          `${action}/${closeHumanTabs}: ${JSON.stringify(result)}`,
        ).toBe(true);
      }
    }
  });

  it("対照: 断った枚数を足した結果はスキーマに落ちる", () => {
    // 「スキーマを通る」が何かを見ていることの対照（`.strict()` が効いている）。
    expect(
      arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, refused: 3 }).success,
    ).toBe(false);
  });

  it("何をしたかを記録する", async () => {
    const info = vi.fn();
    await handleArrangeEditors(
      { action: "close-other-tabs" },
      deps({
        surface: surface({ listTabs: () => [...MIXED] }),
        log: { info },
      }),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("arrange_editors");
    expect(info.mock.calls[0]?.[1]).toMatchObject({ action: "close-other-tabs" });
  });
});

/**
 * **タブとパネルを動かす**（増分5 D59 / D55-1）。
 *
 * 単体で見るのは「どの候補を、どの列へ、どの述語で」だけ。実際に動くか
 * （開いてから閉じる順序、未保存が残るか、own が再記録されるか）は面の中で、
 * 統合テストが実機で言う。
 *
 * 検査の作法はこのファイルの上と同じ ―― 否定には対照を付ける。
 */
describe("handleArrangeEditors: move-tab（D59）", () => {
  /** 人間が列1に居て、舞台（列2・3）に own が散っている画面。 */
  const SPREAD: readonly ArrangeTab[] = [
    tab({ id: "h", path: "human.md", column: 1, isActive: true, viewing: true }),
    tab({ id: "a", path: "src/a.ts", column: 2, own: true, isActive: true }),
    tab({ id: "b", path: "src/b.ts", column: 3, own: true, isActive: true }),
    tab({ id: "p", kind: "webview", slot: 1, column: 3, own: true }),
  ];
  const spread = (
    over: Partial<ArrangeSurface> = {},
    fail?: (id: string) => boolean,
  ): ArrangeSurface =>
    surface(
      {
        listTabs: () => [...SPREAD],
        groupColumns: () => columns(3),
        humanColumn: () => 1,
        ...over,
      },
      fail,
    );

  it("path で指した自分のテキストタブを toColumn へ動かす", async () => {
    const s = spread();
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(movedIds(s)).toEqual([["b"]]);
    expect(result).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("面には札を1回で渡す（最初の await の前に全部引ける形。レビュー I1）", async () => {
    // 同じ文書のタブが2枚（別の列）なら候補は2枚。`moveTabs` は**1回**、両方の札で呼ばれる。
    // 1枚ずつ呼ぶ形だと、呼び出しの合間に別の要求が観測し直せる。
    const s = spread({
      listTabs: () => [
        tab({ id: "b1", path: "src/b.ts", column: 2, own: true }),
        tab({ id: "b2", path: "src/b.ts", column: 3, own: true }),
      ],
    });
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 4 },
      deps({ surface: s }),
    );
    expect(s.moveTabs).toHaveBeenCalledTimes(1);
    expect(movedIds(s)).toEqual([["b1", "b2"]]);
    expect(result.moved).toBe(2);
  });

  it("path は関門の正準名で照合する（綴りではない）", async () => {
    // `src/../src/b.ts` は関門が `src/b.ts` に直す。綴りで照合していると not-found になる。
    const raw = "src/../src/b.ts";
    expect(acceptPath(raw)).toEqual({ ok: true, canonical: "src/b.ts", realPath: "/ws/src/b.ts" });
    const s = spread();
    const result = await handleArrangeEditors(
      { action: "move-tab", path: raw, toColumn: 2 },
      deps({ surface: s }),
    );
    expect(movedIds(s)).toEqual([["b"]]);
    expect(result.moved).toBe(1);
  });

  it("関門が落とした path はその理由で落ちる（タブを見に行かない）", async () => {
    for (const [raw, code] of [
      ["src/secret.ts", "excluded-path"],
      ["src/missing.ts", "invalid-path"],
    ] as const) {
      const listTabs = vi.fn((): ArrangeTab[] => [...SPREAD]);
      const s = spread({ listTabs });
      await expect(
        handleArrangeEditors({ action: "move-tab", path: raw, toColumn: 2 }, deps({ surface: s })),
      ).rejects.toMatchObject({ name: "ToolError", code });
      // **秘匿の綴りでタブの一覧を引かない** ―― 引くと「秘匿ファイルを人間が開いているか」の
      // 口になる（答えの割れ方から読める）。
      expect(listTabs, raw).not.toHaveBeenCalled();
      expect(s.moveTabs, raw).not.toHaveBeenCalled();
    }
  });

  it("path に当たるテキストタブが無ければ not-found", async () => {
    await expect(
      handleArrangeEditors(
        { action: "move-tab", path: "src/none.ts", toColumn: 2 },
        deps({ surface: spread() }),
      ),
    ).rejects.toMatchObject({ name: "ToolError", code: "not-found" });
  });

  it("webview は path で当たらない（タブはパスで指す。題では指さない。D41）", async () => {
    // `ArrangeTab` に `label` は**無い**（構造で塞ぐ）。webview が path を持って渡ってきても、
    // `move-tab` はテキストタブしか候補にしない。
    const s = spread({
      listTabs: () => [
        tab({ id: "w", kind: "webview", slot: 1, own: true, path: "src/x.ts", column: 3 }),
      ],
    });
    await expect(
      handleArrangeEditors(
        { action: "move-tab", path: "src/x.ts", toColumn: 2 },
        deps({ surface: s }),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(s.movePanel).not.toHaveBeenCalled();
    // 「label という鍵で当たる」経路が無いことを、型ではなく値で見る。
    for (const t of SPREAD) expect(Object.keys(t)).not.toContain("label");
  });

  it("既定では人間のタブは動かない（withheld: human-tabs-not-allowed）。closeHumanTabs で動く", async () => {
    // 人間のタブ（own でない・見ていない）を列3に置く。
    const humanTab = tab({ id: "h2", path: "docs/h.md", column: 3 });
    const byDefaultSurface = spread({ listTabs: () => [...SPREAD, humanTab] });
    const byDefault = await handleArrangeEditors(
      { action: "move-tab", path: "docs/h.md", toColumn: 2 },
      deps({ surface: byDefaultSurface }),
    );
    expect(byDefaultSurface.moveTabs).not.toHaveBeenCalled();
    expect(byDefault).toEqual({
      done: true,
      closed: 0,
      moved: 0,
      withheld: ["human-tabs-not-allowed"],
    });
    // 対照: 同じ画面で設定を立てれば動く。
    const allowedSurface = spread({ listTabs: () => [...SPREAD, humanTab] });
    const allowed = await handleArrangeEditors(
      { action: "move-tab", path: "docs/h.md", toColumn: 2 },
      deps({ config: config({ closeHumanTabs: true }), surface: allowedSurface }),
    );
    expect(movedIds(allowedSurface)).toEqual([["h2"]]);
    expect(allowed).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("人間が見ているタブは、設定を全部立てても動かない（床1 / withheld: viewing-tab）", async () => {
    const s = spread();
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "human.md", toColumn: 2 },
      deps({ config: config({ closeHumanTabs: true, closeDirtyTabs: true }), surface: s }),
    );
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0, withheld: ["viewing-tab"] });
  });

  it("未保存の自分のタブは動く（move に床2 は掛からない。D59）", async () => {
    const s = spread({
      listTabs: () => [tab({ id: "b", path: "src/b.ts", column: 3, own: true, isDirty: true })],
    });
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(movedIds(s)).toEqual([["b"]]);
    expect(result).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("人間の列への移動は既定で断る（withheld: human-column-target）。closeHumanTabs で通る", async () => {
    const refusedSurface = spread();
    const refused = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 1 },
      deps({ surface: refusedSurface }),
    );
    expect(refusedSurface.moveTabs).not.toHaveBeenCalled();
    expect(refused).toEqual({
      done: false,
      closed: 0,
      moved: 0,
      withheld: ["human-column-target"],
    });
    const allowedSurface = spread();
    const allowed = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 1 },
      deps({ config: config({ closeHumanTabs: true }), surface: allowedSurface }),
    );
    expect(movedIds(allowedSurface)).toEqual([["b"]]);
    expect(allowed).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("人間の列が観測できないなら断る（推測で通さない。同じ倒し方）", async () => {
    const s = spread({ humanColumn: () => undefined });
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(result).toEqual({
      done: false,
      closed: 0,
      moved: 0,
      withheld: ["human-column-target"],
    });
  });

  it("人間が途中で移動先の列を覗いたら、そこで止まる（1枚ごとに新しい観測で決め直す。M1）", async () => {
    // 同じ文書のタブが2枚。1枚目を動かした**あと**に人間が列2に移る。
    // 面は2枚目の前に `decide` を新しい観測で呼び、断られて止まる。
    let human = 1;
    const s = surface({
      listTabs: () => [
        tab({ id: "b1", path: "src/b.ts", column: 3, own: true }),
        tab({ id: "b2", path: "src/b.ts", column: 4, own: true }),
      ],
      groupColumns: () => columns(4),
      humanColumn: () => human,
    });
    // 1枚目の移動が終わった瞬間に人間が移動先へ。
    (s.moveTabs as ReturnType<typeof vi.fn>).mockImplementation(
      async (ids: readonly string[], decide) => {
        const outcome: MoveOutcome = { moved: 0, failed: 0 };
        for (const _ of ids) {
          const d = decide({ columns: s.groupColumns(), humanColumn: s.humanColumn() });
          if (!d.ok) {
            outcome.halted = d.reason;
            break;
          }
          outcome.moved += 1;
          human = 2;
        }
        return outcome;
      },
    );
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(result).toEqual({
      done: false,
      closed: 0,
      moved: 1,
      withheld: ["human-column-target"],
    });
  });

  it("toColumn は 1..groupCount+1。外は invalid-request で、面を呼ばない", async () => {
    for (const toColumn of [0, 5, 9]) {
      const s = spread();
      await expect(
        handleArrangeEditors(
          { action: "move-tab", path: "src/b.ts", toColumn },
          deps({ surface: s }),
        ),
        String(toColumn),
      ).rejects.toMatchObject({ name: "ToolError", code: "invalid-request" });
      expect(s.moveTabs, String(toColumn)).not.toHaveBeenCalled();
    }
    // 対照: groupCount+1（新しい列）は通る。
    const s = spread();
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 4 },
      deps({ surface: s }),
    );
    expect(movedIds(s)).toEqual([["b"]]);
    expect(result.moved).toBe(1);
  });

  it("既にその列に居るタブは動かさない（開いて閉じると自分のタブを消すことになる）", async () => {
    // 同じ列へ「開いてから閉じる」と、開くのは同じタブで、閉じるのもそのタブ ―― 消える。
    const s = spread();
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 3 },
      deps({ surface: s }),
    );
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });

  it("面が失敗したら done: false で moved は 0", async () => {
    const result = await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: spread({}, () => true) }),
    );
    expect(result).toEqual({ done: false, closed: 0, moved: 0 });
  });

  it("引数の形は語ごとに1回だけ判定する（invalid-request）", async () => {
    // **スキーマの transform ではなくハンドラで**。
    const cases: ReadonlyArray<[ArrangeEditorsArgs, string]> = [
      [{ action: "move-tab", toColumn: 2 }, "move-tab に path が無い"],
      [{ action: "move-tab", path: "src/b.ts" }, "move-tab に toColumn が無い"],
      [{ action: "move-panel" }, "move-panel に toColumn が無い"],
      [{ action: "move-panel", path: "src/b.ts", toColumn: 2 }, "move-panel に path がある"],
      [{ action: "gather-own", toColumn: 2 }, "gather-own に toColumn がある"],
      [{ action: "gather-own", path: "src/b.ts" }, "gather-own に path がある"],
      [{ action: "close-own", toColumn: 2 }, "close-own に toColumn がある"],
      [{ action: "two-columns", path: "src/b.ts" }, "two-columns に path がある"],
      // `slot` は `move-panel` のときだけ（D61）。他の語に付けたら黙って無視しない。
      [{ action: "close-own", slot: 2 }, "close-own に slot がある"],
      [{ action: "grid", slot: 1 }, "grid に slot がある"],
      [{ action: "move-tab", path: "src/b.ts", toColumn: 2, slot: 2 }, "move-tab に slot がある"],
      [{ action: "gather-own", slot: 2 }, "gather-own に slot がある"],
      // `paths` は `close-tabs` だけが受け、`close-tabs` には必須。
      [{ action: "close-tabs" }, "close-tabs に paths が無い"],
      [{ action: "close-own", paths: ["src/b.ts"] }, "close-own に paths がある"],
      [{ action: "close-other-tabs", paths: ["src/b.ts"] }, "close-other-tabs に paths がある"],
      [{ action: "grid", paths: ["src/b.ts"] }, "grid に paths がある"],
      [
        { action: "move-tab", path: "src/b.ts", toColumn: 2, paths: ["src/b.ts"] },
        "move-tab に paths がある",
      ],
      [{ action: "gather-own", paths: ["src/b.ts"] }, "gather-own に paths がある"],
      [
        { action: "close-tabs", paths: ["src/b.ts"], path: "src/b.ts" },
        "close-tabs に path がある",
      ],
      [{ action: "close-tabs", paths: ["src/b.ts"], toColumn: 2 }, "close-tabs に toColumn がある"],
    ];
    for (const [args, label] of cases) {
      const s = spread();
      await expect(handleArrangeEditors(args, deps({ surface: s })), label).rejects.toMatchObject({
        name: "ToolError",
        code: "invalid-request",
      });
      expect(s.moveTabs, label).not.toHaveBeenCalled();
      expect(s.movePanel, label).not.toHaveBeenCalled();
      expect(s.closeTabs, label).not.toHaveBeenCalled();
      expect(s.applyLayout, label).not.toHaveBeenCalled();
    }
    expect(cases.length).toBe(20);
  });

  it("listTabs は1回しか呼ばない", async () => {
    const listTabs = vi.fn((): ArrangeTab[] => [...SPREAD]);
    await handleArrangeEditors(
      { action: "move-tab", path: "src/b.ts", toColumn: 2 },
      deps({ surface: spread({ listTabs }) }),
    );
    expect(listTabs).toHaveBeenCalledTimes(1);
  });
});

describe("handleArrangeEditors: move-panel（D59）", () => {
  const withPanel = (panel: ArrangeTab, over: Partial<ArrangeSurface> = {}): ArrangeSurface =>
    surface({
      listTabs: () => [tab({ id: "h", path: "human.md", column: 1, viewing: true }), panel],
      groupColumns: () => columns(3),
      humanColumn: () => 1,
      ...over,
    });

  it("自分の webview を toColumn へ動かす", async () => {
    const s = withPanel(tab({ id: "p", kind: "webview", slot: 1, own: true, column: 3 }));
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(s.movePanel).toHaveBeenCalledWith(1, 2);
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("パネルが無ければ done: true, moved: 0（断ったのではない）", async () => {
    const s = surface({
      listTabs: () => [tab({ id: "h", path: "human.md", column: 1, viewing: true })],
      groupColumns: () => columns(2),
    });
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });

  it("人間が見ているパネルは動かない（床1）", async () => {
    const s = surface({
      listTabs: () => [
        tab({ id: "p", kind: "webview", slot: 1, own: true, column: 3, viewing: true }),
      ],
      groupColumns: () => columns(3),
    });
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2 },
      deps({ config: config({ closeHumanTabs: true }), surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0, withheld: ["viewing-tab"] });
  });

  it("人間の webview（own でない）は候補にしない", async () => {
    const s = withPanel(tab({ id: "x", kind: "webview", own: false, column: 3 }));
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2 },
      deps({ config: config({ closeHumanTabs: true }), surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });

  it("人間の列へは既定で断る（同じ述語 moveTargetVerdict）", async () => {
    const s = withPanel(tab({ id: "p", kind: "webview", slot: 1, own: true, column: 3 }));
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 1 },
      deps({ surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({
      done: false,
      closed: 0,
      moved: 0,
      withheld: ["human-column-target"],
    });
  });

  it("既にその列に居れば動かさない", async () => {
    const s = withPanel(tab({ id: "p", kind: "webview", slot: 1, own: true, column: 3 }));
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 3 },
      deps({ surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });

  /** 枠1と枠2が両方出ている画面（D61）。 */
  const twoPanels = (over: Partial<ArrangeSurface> = {}): ArrangeSurface =>
    surface({
      listTabs: () => [
        tab({ id: "h", path: "human.md", column: 1, viewing: true }),
        tab({ id: "p1", kind: "webview", slot: 1, own: true, column: 3 }),
        tab({ id: "p2", kind: "webview", slot: 2, own: true, column: 3 }),
      ],
      groupColumns: () => columns(3),
      humanColumn: () => 1,
      ...over,
    });

  it("slot: 2 は枠2だけを動かす（枠1は触らない）", async () => {
    const s = twoPanels();
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2, slot: 2 },
      deps({ surface: s }),
    );
    expect(s.movePanel).toHaveBeenCalledTimes(1);
    expect(s.movePanel).toHaveBeenCalledWith(2, 2);
    expect(result).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("slot 省略は枠1（枠2は触らない）", async () => {
    const s = twoPanels();
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2 },
      deps({ surface: s }),
    );
    expect(s.movePanel).toHaveBeenCalledTimes(1);
    expect(s.movePanel).toHaveBeenCalledWith(1, 2);
    expect(result).toEqual({ done: true, closed: 0, moved: 1 });
  });

  it("指した枠が出ていなければ done: true, moved: 0（枠1があっても代わりに動かさない）", async () => {
    const s = withPanel(tab({ id: "p1", kind: "webview", slot: 1, own: true, column: 3 }));
    const result = await handleArrangeEditors(
      { action: "move-panel", toColumn: 2, slot: 2 },
      deps({ surface: s }),
    );
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });
});

describe("handleArrangeEditors: gather-own（D55-1）", () => {
  /** 人間が列1。own が列2・3 に散り、人間のタブが列3 にも1枚ある。 */
  const SCATTERED: readonly ArrangeTab[] = [
    tab({ id: "h", path: "human.md", column: 1, isActive: true, viewing: true }),
    tab({ id: "a", path: "src/a.ts", column: 2, own: true, isActive: true }),
    tab({ id: "b", path: "src/b.ts", column: 3, own: true }),
    tab({ id: "p", kind: "webview", slot: 1, column: 3, own: true, isActive: true }),
    tab({ id: "h3", path: "docs/h3.md", column: 3 }),
  ];
  const scattered = (
    over: Partial<ArrangeSurface> = {},
    fail?: (id: string) => boolean,
  ): ArrangeSurface =>
    surface(
      {
        listTabs: () => [...SCATTERED],
        groupColumns: () => columns(3),
        humanColumn: () => 1,
        ...over,
      },
      fail,
    );

  it("own を舞台の最初の列（人間の右隣）へ集める。既にそこに居るものは数えない", async () => {
    const s = scattered();
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(movedIds(s)).toEqual([["b"]]);
    expect(s.movePanel).toHaveBeenCalledWith(1, 2);
    expect(result).toEqual({ done: true, closed: 0, moved: 2 });
  });

  it("枠1と枠2が散っていれば両方集める（D61）", async () => {
    const s = scattered({
      listTabs: () => [
        tab({ id: "h", path: "human.md", column: 1, viewing: true }),
        tab({ id: "p1", kind: "webview", slot: 1, own: true, column: 3 }),
        tab({ id: "p2", kind: "webview", slot: 2, own: true, column: 4 }),
        // 既に集め先に居る枠は数えない（対照）。
        tab({ id: "b", path: "src/b.ts", column: 2, own: true }),
      ],
      groupColumns: () => columns(4),
    });
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(s.movePanel).toHaveBeenCalledTimes(2);
    expect(s.movePanel).toHaveBeenCalledWith(1, 2);
    expect(s.movePanel).toHaveBeenCalledWith(2, 2);
    expect(result).toEqual({ done: true, closed: 0, moved: 2 });
  });

  it("close-own は枠1と枠2の両方を閉じる（D61）", async () => {
    const closeTabs = vi.fn(async () => true);
    const result = await handleArrangeEditors(
      { action: "close-own" },
      deps({
        surface: surface({
          listTabs: () => [
            tab({ id: "h", path: "human.md", column: 1, viewing: true }),
            tab({ id: "p1", kind: "webview", slot: 1, own: true, column: 2 }),
            tab({ id: "p2", kind: "webview", slot: 2, own: true, column: 2 }),
          ],
          closeTabs,
        }),
      }),
    );
    expect(closeTabs).toHaveBeenCalledWith(["p1", "p2"]);
    expect(result).toEqual({ done: true, closed: 2 });
  });

  it("人間のタブは、設定を全部立てても候補にしない（own でないものは触らない）", async () => {
    const s = scattered();
    const result = await handleArrangeEditors(
      { action: "gather-own" },
      deps({ config: config({ closeHumanTabs: true, closeDirtyTabs: true }), surface: s }),
    );
    expect(movedIds(s)).toEqual([["b"]]);
    // 断ったのではなく候補に入れていない ―― withheld は無い。
    expect(result.withheld).toBeUndefined();
  });

  it("人間が見ている own は残り、withheld: viewing-tab。他は集まる", async () => {
    const s = scattered({
      listTabs: () => [
        tab({ id: "a", path: "src/a.ts", column: 2, own: true }),
        tab({ id: "b", path: "src/b.ts", column: 3, own: true, viewing: true }),
        tab({ id: "p", kind: "webview", slot: 1, column: 3, own: true }),
      ],
      // 人間が列3の own を覗いている（`activeTabGroup` は列3）。
      humanColumn: () => 3,
    });
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    // 人間が列3 → 右に列は無い → 集め先は列4（新しい列）。
    expect(movedIds(s)).toEqual([["a"]]);
    expect(s.movePanel).toHaveBeenCalledWith(1, 4);
    expect(result).toEqual({ done: true, closed: 0, moved: 2, withheld: ["viewing-tab"] });
  });

  it("人間が列2なら集め先は列3（人間の列は決して集め先にならない）", async () => {
    const s = scattered({ humanColumn: () => 2 });
    await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(movedIds(s)).toEqual([["a"]]);
    expect(s.movePanel).not.toHaveBeenCalled(); // 既に列3
  });

  it("人間が右端に居ても1回で収束する（移動先は1枚ごとに新しい観測で決め直す。レビュー I3）", async () => {
    // 列 [1,2,3]、人間が列3、own が列1と列2に1枚ずつ。最初の集め先は列4（新しい列）。
    // 1枚目（列1）を動かすと列1が空いて VS Code が閉じ、列が繰り上がる:
    // 人間は列2、残りの own は列1、動かした1枚は列3。**2枚目の集め先は列3**でなければ
    // ならない ―― 最初の 4 を使い続けると、また新しい列を作って2枚がばらける。
    let state = { columns: columns(3), human: 3 };
    const decided: number[] = [];
    const s = surface({
      listTabs: () => [
        tab({ id: "x", path: "src/x.ts", column: 1, own: true }),
        tab({ id: "y", path: "src/y.ts", column: 2, own: true }),
        tab({ id: "h", path: "human.md", column: 3, viewing: true }),
      ],
      groupColumns: () => state.columns,
      humanColumn: () => state.human,
    });
    (s.moveTabs as ReturnType<typeof vi.fn>).mockImplementation(
      async (ids: readonly string[], decide) => {
        const outcome: MoveOutcome = { moved: 0, failed: 0 };
        for (const _ of ids) {
          const d = decide({ columns: s.groupColumns(), humanColumn: s.humanColumn() });
          if (!d.ok) {
            outcome.halted = d.reason;
            break;
          }
          decided.push(d.column);
          outcome.moved += 1;
          // 元の列（人間より左）が空いて閉じ、繰り上がる。
          state = { columns: columns(state.columns.length), human: state.human - 1 };
        }
        return outcome;
      },
    );
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(decided).toEqual([4, 3]);
    expect(result).toEqual({ done: true, closed: 0, moved: 2 });
  });

  it("集め先は firstStageColumn と同じ（判定は policy 1箇所）", async () => {
    let evaluated = 0;
    for (const groupCount of [1, 2, 3, 4]) {
      for (let human = 1; human <= groupCount; human += 1) {
        const decided: number[] = [];
        // own を全列に1枚ずつ置く。
        const tabs = columns(groupCount).map((c) =>
          tab({ id: `t${c}`, path: `f${c}.ts`, column: c, own: true }),
        );
        const s = surface({
          listTabs: () => tabs,
          groupColumns: () => columns(groupCount),
          humanColumn: () => human,
        });
        (s.moveTabs as ReturnType<typeof vi.fn>).mockImplementation(
          async (ids: readonly string[], decide) => {
            for (const _ of ids) {
              const d = decide({ columns: s.groupColumns(), humanColumn: s.humanColumn() });
              if (d.ok) decided.push(d.column);
            }
            return { moved: ids.length, failed: 0 };
          },
        );
        await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
        const target = firstStageColumn(columns(groupCount), human);
        for (const to of decided) {
          expect(to, `groups=${groupCount} human=${human}`).toBe(target);
          expect(to, `groups=${groupCount} human=${human}`).not.toBe(human);
        }
        evaluated += 1;
      }
    }
    expect(evaluated).toBe(10);
  });

  it("人間の列が観測できないなら何も動かさず断る", async () => {
    const s = scattered({ humanColumn: () => undefined });
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(s.moveTabs).not.toHaveBeenCalled();
    expect(s.movePanel).not.toHaveBeenCalled();
    expect(result).toEqual({
      done: false,
      closed: 0,
      moved: 0,
      withheld: ["human-column-target"],
    });
  });

  it("集めるものが無ければ done: true, moved: 0", async () => {
    const result = await handleArrangeEditors(
      { action: "gather-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "h", path: "human.md", column: 1, viewing: true })],
        }),
      }),
    );
    expect(result).toEqual({ done: true, closed: 0, moved: 0 });
  });

  it("1枚でも面が失敗したら done: false。moved は実際に動いた数", async () => {
    const s = scattered(
      {
        listTabs: () => [
          tab({ id: "b", path: "src/b.ts", column: 3, own: true }),
          tab({ id: "c", path: "src/c.ts", column: 3, own: true }),
        ],
      },
      (id) => id === "b",
    );
    const result = await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(result).toEqual({ done: false, closed: 0, moved: 1 });
  });

  it("gather-own は closeTabs も applyLayout も呼ばない", async () => {
    const s = scattered();
    await handleArrangeEditors({ action: "gather-own" }, deps({ surface: s }));
    expect(s.closeTabs).not.toHaveBeenCalled();
    expect(s.applyLayout).not.toHaveBeenCalled();
  });
});

/**
 * **`close-tabs { paths }`: パスで指したタブだけを閉じる**。
 *
 * 人間の言葉: 「リストを渡したらそのリストに乗ったタブを消す」。`close-other-tabs` は
 * 「各列の非アクティブ」しか消えず、`close-all` は列の裏のターミナルまで消える。
 *
 * 単体で見るのは「どの候補を、どの述語で」だけ ―― 候補は指されたタブ、可否は
 * `close-own` と**同じ** `mayClose`（述語を増やさない。増分5 §C1）。パスの無いタブは
 * 指せないので構造的に候補に入らない。関門は `move-tab` と同じで、**1本でも落ちたら
 * 呼び出し全体がその理由で落ち、タブの一覧を引かない**（パスごとに答えを割ると
 * 秘匿ファイルの存在を1本ずつ確かめる口になる）。
 */
describe("handleArrangeEditors: close-tabs", () => {
  /** 人間が列1で keep.md を見ていて、人間のタブと own が列1・2に散っている画面。 */
  const LISTED: readonly ArrangeTab[] = [
    tab({ id: "keep", path: "docs/keep.md", column: 1, isActive: true, viewing: true }),
    tab({ id: "h1", path: "docs/h1.md", column: 1 }),
    tab({ id: "h2", path: "docs/h2.md", column: 1, isDirty: true }),
    tab({ id: "a", path: "src/a.ts", column: 2, own: true, isActive: true }),
    tab({ id: "b", path: "src/b.ts", column: 2, own: true }),
    tab({ id: "p", kind: "webview", slot: 1, column: 2, own: true }),
    tab({ id: "term", kind: "other", column: 2 }),
  ];
  const listed = (over: Partial<ArrangeSurface> = {}): ArrangeSurface =>
    surface({ listTabs: () => [...LISTED], groupColumns: () => columns(2), ...over });
  const closedIds = (s: ArrangeSurface): string[][] =>
    (s.closeTabs as ReturnType<typeof vi.fn>).mock.calls.map((call) => [...(call[0] as string[])]);

  it("指した自分のテキストタブだけを閉じる。指していないタブには触らない", async () => {
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/b.ts"] },
      deps({ surface: s }),
    );
    expect(closedIds(s)).toEqual([["b"]]);
    expect(result).toEqual({ done: true, closed: 1 });
  });

  it("指した2本を両方閉じる（own はどの設定でも。アクティブでも列で最前面なだけなら閉じる）", async () => {
    // `a` はその列でアクティブ（`isActive`）だが人間が見ている（`viewing`）のではない。
    // `close-other-tabs` なら候補から外れるが、`close-tabs` は指されたものが候補である。
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts", "src/b.ts"] },
      deps({ surface: s }),
    );
    expect(closedIds(s)).toEqual([["a", "b"]]);
    expect(result).toEqual({ done: true, closed: 2 });
  });

  it("可否の真理値表: own / human × viewing / dirty / plain × closeHumanTabs / closeDirtyTabs（述語は mayClose 1つ）", async () => {
    // **期待値は表で書く**（`mayClose` を呼んで導出しない ―― 導出すると述語の変異に
    // この検査が追随して緑のまま通る）。
    type Row = {
      own: boolean;
      state: "viewing" | "dirty" | "plain";
      closeHumanTabs: boolean;
      closeDirtyTabs: boolean;
      closes: boolean;
      withheld: string[];
    };
    const rows: Row[] = [];
    for (const own of [false, true]) {
      for (const state of ["viewing", "dirty", "plain"] as const) {
        for (const closeHumanTabs of [false, true]) {
          for (const closeDirtyTabs of [false, true]) {
            const reach = own || closeHumanTabs;
            const withheld: string[] = [];
            if (!reach) withheld.push("human-tabs-not-allowed");
            if (state === "dirty" && !closeDirtyTabs) withheld.push("dirty-tabs-not-allowed");
            if (state === "viewing") withheld.push("viewing-tab");
            rows.push({
              own,
              state,
              closeHumanTabs,
              closeDirtyTabs,
              closes: withheld.length === 0,
              withheld,
            });
          }
        }
      }
    }
    expect(rows.length).toBe(24);
    // 表の要点を**値で**固定する（ループが生成したものを鵜呑みにしない）。
    const pick = (own: boolean, state: Row["state"], h: boolean, d: boolean): Row => {
      const row = rows.find(
        (r) =>
          r.own === own && r.state === state && r.closeHumanTabs === h && r.closeDirtyTabs === d,
      );
      if (row === undefined) throw new Error("row missing");
      return row;
    };
    expect(pick(true, "plain", false, false).closes).toBe(true);
    expect(pick(false, "plain", false, false)).toMatchObject({
      closes: false,
      withheld: ["human-tabs-not-allowed"],
    });
    expect(pick(false, "plain", true, false).closes).toBe(true);
    expect(pick(true, "viewing", true, true)).toMatchObject({
      closes: false,
      withheld: ["viewing-tab"],
    });
    expect(pick(true, "dirty", false, false)).toMatchObject({
      closes: false,
      withheld: ["dirty-tabs-not-allowed"],
    });
    expect(pick(true, "dirty", false, true).closes).toBe(true);
    expect(pick(false, "dirty", false, false)).toMatchObject({
      closes: false,
      withheld: ["human-tabs-not-allowed", "dirty-tabs-not-allowed"],
    });
    expect(pick(false, "dirty", true, false)).toMatchObject({
      closes: false,
      withheld: ["dirty-tabs-not-allowed"],
    });
    expect(pick(false, "dirty", true, true).closes).toBe(true);

    let evaluated = 0;
    for (const row of rows) {
      const target = tab({
        id: "t",
        path: "src/t.ts",
        column: 1,
        own: row.own,
        isDirty: row.state === "dirty",
        viewing: row.state === "viewing",
        isActive: row.state === "viewing",
      });
      // 隣に指していないタブを置く ―― どの行でもそれには触らない。
      const bystander = tab({ id: "other", path: "src/other.ts", column: 1, own: true });
      const s = surface({ listTabs: () => [target, bystander] });
      const label = JSON.stringify(row);
      const result = await handleArrangeEditors(
        { action: "close-tabs", paths: ["src/t.ts"] },
        deps({
          surface: s,
          config: config({
            closeHumanTabs: row.closeHumanTabs,
            closeDirtyTabs: row.closeDirtyTabs,
          }),
        }),
      );
      if (row.closes) {
        expect(closedIds(s), label).toEqual([["t"]]);
        expect(result, label).toEqual({ done: true, closed: 1 });
      } else {
        expect(s.closeTabs, label).not.toHaveBeenCalled();
        expect(result, label).toEqual({ done: true, closed: 0, withheld: row.withheld });
      }
      evaluated += 1;
    }
    expect(evaluated).toBe(24);
  });

  it("同じパスが2列に開いていれば両方閉じる（札は1回で渡す）", async () => {
    const s = listed({
      listTabs: () => [
        tab({ id: "b1", path: "src/b.ts", column: 2, own: true }),
        tab({ id: "b2", path: "src/b.ts", column: 3, own: true }),
        tab({ id: "keep", path: "docs/keep.md", column: 1, viewing: true, isActive: true }),
      ],
    });
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/b.ts"] },
      deps({ surface: s }),
    );
    expect(s.closeTabs).toHaveBeenCalledTimes(1);
    expect(closedIds(s)).toEqual([["b1", "b2"]]);
    expect(result).toEqual({ done: true, closed: 2 });
  });

  it("開いていないパスは notOpen に載る（送った綴りのまま）。閉じるものが無くても done: true で、面を呼ばない", async () => {
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/none.ts"] },
      deps({ surface: s }),
    );
    expect(s.closeTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, notOpen: ["src/none.ts"] });
  });

  it("開いていたものは閉じ、開いていなかったものだけ notOpen（混在）", async () => {
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/none.ts", "src/b.ts", "src/gone.ts"] },
      deps({ surface: s }),
    );
    expect(closedIds(s)).toEqual([["b"]]);
    expect(result).toEqual({ done: true, closed: 1, notOpen: ["src/none.ts", "src/gone.ts"] });
  });

  it("paths は関門の正準名で照合する（綴りではない）。同じ実体を2回指しても1回だけ", async () => {
    // `src/../src/b.ts` は関門が `src/b.ts` に直す。綴りで照合していると notOpen になる。
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/../src/b.ts", "src/b.ts"] },
      deps({ surface: s }),
    );
    expect(closedIds(s)).toEqual([["b"]]);
    expect(result).toEqual({ done: true, closed: 1 });
  });

  it("notOpen は正準名ではなく送った綴りで、同じ実体は最初の綴り1つだけ", async () => {
    // 開いていないファイルの正準名を返すと、リンクの先を読む口になる。
    const s = listed();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/../src/none.ts", "src/none.ts"] },
      deps({ surface: s }),
    );
    expect(result.notOpen).toEqual(["src/../src/none.ts"]);
  });

  it("関門が落とした path はその理由で呼び出し全体が落ちる（タブを見に行かない。1本でも）", async () => {
    // **パスごとに答えを割らない。** 「`.env` は excluded、他は閉じた」と返すと、
    // 秘匿ファイルの存在を1本ずつ確かめる口になる。`move-tab` と同じ倒し方。
    for (const [raw, code] of [
      ["src/secret.ts", "excluded-path"],
      ["src/missing.ts", "invalid-path"],
    ] as const) {
      const listTabs = vi.fn((): ArrangeTab[] => [...LISTED]);
      const s = listed({ listTabs });
      await expect(
        handleArrangeEditors(
          { action: "close-tabs", paths: ["src/b.ts", raw, "src/a.ts"] },
          deps({ surface: s }),
        ),
      ).rejects.toMatchObject({ name: "ToolError", code });
      expect(listTabs, raw).not.toHaveBeenCalled();
      expect(s.closeTabs, raw).not.toHaveBeenCalled();
    }
  });

  it("関門は全部のパスに、タブの一覧より先に当てる（落ちるのが最後の1本でも一覧を引かない）", async () => {
    const order: string[] = [];
    const listTabs = vi.fn((): ArrangeTab[] => {
      order.push("listTabs");
      return [...LISTED];
    });
    const gate = vi.fn((raw: string): WorkspacePathVerdict => {
      order.push(`gate:${raw}`);
      return acceptPath(raw);
    });
    await expect(
      handleArrangeEditors(
        { action: "close-tabs", paths: ["src/a.ts", "src/b.ts", "src/secret.ts"] },
        deps({ surface: listed({ listTabs }), acceptPath: gate }),
      ),
    ).rejects.toMatchObject({ code: "excluded-path" });
    expect(order).toEqual(["gate:src/a.ts", "gate:src/b.ts", "gate:src/secret.ts"]);
    // 対照: 全部通れば、関門の後に1回だけ一覧を引く。
    order.length = 0;
    await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts", "src/b.ts"] },
      deps({ surface: listed({ listTabs }), acceptPath: gate }),
    );
    expect(order).toEqual(["gate:src/a.ts", "gate:src/b.ts", "listTabs"]);
  });

  it("パスの無いタブ（端末・webview）は指せない ―― 指したパスがその題に見えても候補に入らない", async () => {
    // own のパネルは `close-own` の仕事。`close-tabs` は構造的に触れない。
    const s = listed({
      listTabs: () => [
        tab({ id: "p", kind: "webview", slot: 1, column: 2, own: true }),
        tab({ id: "term", kind: "other", column: 2, own: true }),
        // webview に `path` が付くことは無いが、付いていても kind で落ちる。
        { ...tab({ id: "wv", kind: "webview", column: 2, own: true }), path: "src/a.ts" },
        { ...tab({ id: "oth", kind: "other", column: 2, own: true }), path: "src/a.ts" },
      ],
    });
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts"] },
      deps({ surface: s }),
    );
    expect(s.closeTabs).not.toHaveBeenCalled();
    expect(result).toEqual({ done: true, closed: 0, notOpen: ["src/a.ts"] });
  });

  it("clearSpotlight は呼ばない（指差しの寿命を持つのは close-own だけ。D67）", async () => {
    const clearSpotlight = vi.fn();
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts", "src/b.ts"] },
      deps({ surface: listed(), clearSpotlight }),
    );
    expect(result.closed).toBe(2);
    expect(clearSpotlight).not.toHaveBeenCalled();
  });

  it("面が失敗したら done: false で closed は 0", async () => {
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts"] },
      deps({ surface: listed({ closeTabs: vi.fn(async () => false) }) }),
    );
    expect(result).toEqual({ done: false, closed: 0 });
  });

  it("listTabs は1回しか呼ばない", async () => {
    const listTabs = vi.fn((): ArrangeTab[] => [...LISTED]);
    await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts", "docs/h1.md", "src/none.ts"] },
      deps({ surface: listed({ listTabs }) }),
    );
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it("結果は線上のスキーマを通る（notOpen 込み）。断った枚数も名前も返さない", async () => {
    const result = await handleArrangeEditors(
      { action: "close-tabs", paths: ["docs/h1.md", "docs/h2.md", "docs/keep.md", "src/none.ts"] },
      deps({ surface: listed() }),
    );
    expect(arrangeEditorsResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["closed", "done", "notOpen", "withheld"]);
    expect(result.withheld).toEqual([
      "human-tabs-not-allowed",
      "dirty-tabs-not-allowed",
      "viewing-tab",
    ]);
    expect(result.notOpen).toEqual(["src/none.ts"]);
  });

  it("何をしたかを記録する", async () => {
    const info = vi.fn();
    await handleArrangeEditors(
      { action: "close-tabs", paths: ["src/a.ts", "src/none.ts"] },
      deps({ surface: listed(), log: { info } }),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("arrange_editors");
    expect(info.mock.calls[0]?.[1]).toMatchObject({ action: "close-tabs", closed: "1" });
  });
});

describe("handleArrangeEditors: 動かす語の結果も線上のスキーマを通る", () => {
  it("moved を含む結果がスキーマを通る。閉じる語には moved が付かない", async () => {
    const moved = await handleArrangeEditors(
      { action: "gather-own" },
      deps({
        surface: surface({
          listTabs: () => [tab({ id: "b", path: "src/b.ts", column: 3, own: true })],
          groupColumns: () => columns(3),
        }),
      }),
    );
    expect(arrangeEditorsResultSchema.safeParse(moved).success).toBe(true);
    expect(moved.moved).toBe(1);
    const closed = await handleArrangeEditors(
      { action: "close-own" },
      deps({ surface: surface({ listTabs: () => [...MIXED] }) }),
    );
    expect(Object.keys(closed)).not.toContain("moved");
  });

  it("ToolError の code は線上の語彙（invalid-request / not-found / invalid-path / excluded-path）", async () => {
    const error = await handleArrangeEditors(
      { action: "move-tab", path: "src/none.ts", toColumn: 2 },
      deps({ surface: surface({ groupColumns: () => columns(2) }) }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
  });
});
