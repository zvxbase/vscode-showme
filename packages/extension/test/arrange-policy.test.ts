import {
  ARRANGE_ACTIONS,
  arrangeActionCloses,
  arrangeActionMoves,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  type ArrangePermissions,
  TARGET_GROUPS,
  type TouchCandidate,
  firstStageColumn,
  layoutReducesGroups,
  layoutVerdict,
  layoutWouldMergeHumanColumn,
  layoutWouldMergeToolColumn,
  mayClose,
  mayTouch,
  moveTargetVerdict,
  ownedUrisToRestore,
} from "../src/arrange-policy.js";
import type { ArrangeLayoutAction } from "../src/handlers/arrange-editors.js";
import { NO_AVOIDED_COLUMNS, stageColumnForSlot } from "../src/stage-column.js";

/**
 * **画面に触ってよいかの判断は、ここ1箇所にしかない**（設計 §C1 / D53' / 不変条件14）。
 *
 * 面（vscode 側）とハンドラが別々に判断すると、片方を直したときにもう片方が
 * 残る。この repo は「同じ量を2箇所で決める」欠陥を9回作っている。
 *
 * 検査は**真理値表そのもの**にする ―― own × dirty × 2設定 の16通りを、
 * close と move のそれぞれについて1行ずつ書き出す。「だいたいこうなる」で畳まない。
 * 畳んでよいのは「`viewing` なら全部 false」だけで、それは有限集合の全称なので
 * **評価した件数を主張したうえで**ループしている。
 */
const perms = (over: Partial<ArrangePermissions> = {}): ArrangePermissions => ({
  closeHumanTabs: false,
  closeDirtyTabs: false,
  ...over,
});
const tab = (over: Partial<TouchCandidate> = {}): TouchCandidate => ({
  own: false,
  isDirty: false,
  viewing: false,
  ...over,
});

describe("mayTouch — close の真理値表（viewing=false の16通り。C1 / D53'）", () => {
  // [own, isDirty, closeHumanTabs, closeDirtyTabs] → 閉じてよい
  const ROWS: ReadonlyArray<readonly [boolean, boolean, boolean, boolean, boolean]> = [
    // own=false（人間のもの）: reach は closeHumanTabs 次第、未保存は closeDirtyTabs 次第
    [false, false, false, false, false],
    [false, false, false, true, false],
    [false, false, true, false, true],
    [false, false, true, true, true],
    [false, true, false, false, false],
    [false, true, false, true, false],
    [false, true, true, false, false], // 強でも未保存は床
    [false, true, true, true, true],
    // own=true（自分のもの）: reach は常に真、**未保存は床**（D53'。4B の例外を消した）
    [true, false, false, false, true],
    [true, false, false, true, true],
    [true, false, true, false, true],
    [true, false, true, true, true],
    [true, true, false, false, false], // ← 4B では true だった
    [true, true, false, true, true],
    [true, true, true, false, false], // ← 4B では true だった
    [true, true, true, true, true],
  ];
  for (const [own, isDirty, closeHumanTabs, closeDirtyTabs, expected] of ROWS) {
    it(`own=${own} dirty=${isDirty} cHT=${closeHumanTabs} cDT=${closeDirtyTabs} → ${expected}`, () => {
      expect(
        mayTouch(tab({ own, isDirty }), "close", perms({ closeHumanTabs, closeDirtyTabs })),
      ).toBe(expected);
      // `mayClose` は `mayTouch(·, "close", ·)` の別名である。別の式を持たない。
      expect(mayClose(tab({ own, isDirty }), perms({ closeHumanTabs, closeDirtyTabs }))).toBe(
        expected,
      );
    });
  }
  it("表は16行ある（own × dirty × 2設定を1行も落としていない）", () => {
    expect(ROWS.length).toBe(16);
    expect(new Set(ROWS.map((r) => r.slice(0, 4).join())).size).toBe(16);
  });
});

describe("mayTouch — move の真理値表（viewing=false の16通り。未保存は動かせる）", () => {
  // move に床2 は掛からない。dirty の値で結果が変わらないことを、両方の行で確かめる。
  const ROWS: ReadonlyArray<readonly [boolean, boolean, boolean, boolean, boolean]> = [
    [false, false, false, false, false],
    [false, false, false, true, false],
    [false, false, true, false, true],
    [false, false, true, true, true],
    [false, true, false, false, false],
    [false, true, false, true, false],
    [false, true, true, false, true], // 未保存でも動く
    [false, true, true, true, true],
    [true, false, false, false, true],
    [true, false, false, true, true],
    [true, false, true, false, true],
    [true, false, true, true, true],
    [true, true, false, false, true], // 未保存でも動く
    [true, true, false, true, true],
    [true, true, true, false, true],
    [true, true, true, true, true],
  ];
  for (const [own, isDirty, closeHumanTabs, closeDirtyTabs, expected] of ROWS) {
    it(`own=${own} dirty=${isDirty} cHT=${closeHumanTabs} cDT=${closeDirtyTabs} → ${expected}`, () => {
      expect(
        mayTouch(tab({ own, isDirty }), "move", perms({ closeHumanTabs, closeDirtyTabs })),
      ).toBe(expected);
    });
  }
  it("表は16行ある（own × dirty × 2設定を1行も落としていない）", () => {
    expect(ROWS.length).toBe(16);
    expect(new Set(ROWS.map((r) => r.slice(0, 4).join())).size).toBe(16);
  });
});

describe("床1: 人間が見ているタブは、どの設定でも触らない（C1）", () => {
  it("viewing=true の全32通り（own×dirty×2設定×2op）が false", () => {
    let evaluated = 0;
    for (const own of [false, true]) {
      for (const isDirty of [false, true]) {
        for (const closeHumanTabs of [false, true]) {
          for (const closeDirtyTabs of [false, true]) {
            for (const op of ["close", "move"] as const) {
              expect(
                mayTouch(
                  tab({ own, isDirty, viewing: true }),
                  op,
                  perms({ closeHumanTabs, closeDirtyTabs }),
                ),
                `own=${own} dirty=${isDirty} cHT=${closeHumanTabs} cDT=${closeDirtyTabs} op=${op}`,
              ).toBe(false);
              evaluated += 1;
            }
          }
        }
      }
    }
    expect(evaluated).toBe(32); // 全称の主張は、評価した件数を言う
  });

  it("対照: 同じ候補も viewing=false なら閉じる（床1 だけで落ちている）", () => {
    // 上の32通りが「候補の作り方が壊れていて全部 false」でも緑になるのを防ぐ。
    // 設定を全部立てた own のタブは、viewing でさえなければ close も move も通る。
    const open = perms({ closeHumanTabs: true, closeDirtyTabs: true });
    expect(mayTouch(tab({ own: true, isDirty: true, viewing: false }), "close", open)).toBe(true);
    expect(mayTouch(tab({ own: true, isDirty: true, viewing: false }), "move", open)).toBe(true);
    expect(mayTouch(tab({ own: true, isDirty: true, viewing: true }), "close", open)).toBe(false);
    expect(mayTouch(tab({ own: true, isDirty: true, viewing: true }), "move", open)).toBe(false);
  });
});

describe("設定の意味", () => {
  it("closeDirtyTabs は closeHumanTabs を含意しない（直交）", () => {
    // 「未保存も消せる」を立てただけで人間のタブに届いたら、設定の意味が変わる。
    expect(mayClose(tab({ isDirty: false }), perms({ closeDirtyTabs: true }))).toBe(false);
  });

  it("closeDirtyTabs は床2 だけを外す。床1 は外さない", () => {
    expect(mayClose(tab({ own: true, isDirty: true }), perms({ closeDirtyTabs: true }))).toBe(true);
    expect(
      mayClose(tab({ own: true, isDirty: true, viewing: true }), perms({ closeDirtyTabs: true })),
    ).toBe(false);
  });
});

/**
 * **プリセットが人間の列を巻き込むか**（設計 §C3 / D55-2。所見4b・4c）。
 *
 * VS Code の `editorLayout*` は枠を作るだけで、目標より多いグループは**最後の枠に
 * 合流**する。合流は一方通行なので、判定は**呼ぶ前**にしか意味が無い。
 * ここも真理値表で書く ―― 「だいたい h >= t」で畳むと、境界（h == t）が
 * どちらに倒れているかを検査が指さない。`>=` を `>` に変えると `[2,3,2,true]` が落ちる。
 */
describe("layoutWouldMergeHumanColumn（D55-2）", () => {
  // [目標の枠数, いまのグループ数, 人間の列] → 人間の列が合流するか
  const CASES: ReadonlyArray<readonly [number, number, number | undefined, boolean]> = [
    [2, 3, 1, false], // 人間が列1。列3が列2に合流。人間は無事
    [2, 3, 2, true], // 人間が列2（最後の枠）。列3が人間の列に流れ込む
    [2, 3, 3, true], // 人間が列3。人間の列そのものが列2に流れ込む
    [2, 2, 2, false], // 減らない
    [2, 1, 1, false], // 増える
    [3, 4, 3, true],
    [3, 4, 2, false],
    [3, 4, 4, true],
    [4, 4, 4, false],
    [1, 3, 1, true], // target 1（かつての single-column）: 人間が列1でも列2・3が流れ込む。語彙から消した根拠
    [1, 1, 1, false], // target 1 で既に1列 → no-op
    [0, 5, 3, false], // 0 = 減らさない印（even-widths）
    // 人間の列が**観測できない**とき: 減らす操作は断る（観測できないものを 1 と
    // 推測すると、`>=` の最も緩い値になって一方通行の合流を許す）。減らさない操作は通る。
    [2, 3, undefined, true],
    [2, 2, undefined, false],
    [0, 5, undefined, false],
  ];
  let evaluated = 0;
  for (const [t, c, h, expected] of CASES) {
    it(`target=${t} current=${c} human=${String(h)} → ${expected}`, () => {
      evaluated += 1;
      expect(layoutWouldMergeHumanColumn(t, c, h)).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(15);
  });

  it("TARGET_GROUPS は閉じない語を網羅し、値は 0 か 1 以上の整数", () => {
    const layoutActions = ARRANGE_ACTIONS.filter(
      (x) => !arrangeActionCloses(x) && !arrangeActionMoves(x),
    );
    expect(layoutActions.length, "枠の語が1つも無いなら何も見ていない").toBe(5);
    for (const a of layoutActions) {
      const target = TARGET_GROUPS[a as ArrangeLayoutAction];
      expect(Number.isInteger(target), a).toBe(true);
      expect(target, a).toBeGreaterThanOrEqual(0);
    }
    // 表に閉じる語が混ざっていない（`Record<ArrangeLayoutAction, _>` は余分な鍵を型で落とすが、
    // 値の側からも見ておく）。
    expect(Object.keys(TARGET_GROUPS).sort()).toEqual([...layoutActions].sort());
  });

  it("even-widths だけが「減らさない」（0）。single-column は表に無い", () => {
    // 0 は「減らさない」の印である。減らす操作に 0 を書くと、判定が黙って通る。
    expect(TARGET_GROUPS["even-widths"]).toBe(0);
    expect(Object.keys(TARGET_GROUPS)).not.toContain("single-column");
    expect(TARGET_GROUPS["two-columns"]).toBe(2);
    expect(TARGET_GROUPS["three-columns"]).toBe(3);
    expect(TARGET_GROUPS["two-rows"]).toBe(2);
    expect(TARGET_GROUPS.grid).toBe(4);
  });
});

/**
 * **プリセットが道具の列を巻き込むか**（D90。`showme.stage.avoidToolColumns`）。
 *
 * 人間の列（D55-2）と**同じ形**: 減らす操作で、道具の列が最後の枠かそれより後ろに居れば
 * 合流する（最後の枠に居れば、後ろの列のタブが道具の上に流れ込む。後ろに居れば道具そのものが
 * 動く）。境界 `c == t` は合流する側。
 */
describe("layoutWouldMergeToolColumn（D90）", () => {
  // [目標の枠数, いまのグループ数, 道具の列] → 道具の列が合流するか
  const CASES: ReadonlyArray<readonly [number, number, readonly number[], boolean]> = [
    [2, 3, [], false], // 道具の列なし
    [2, 3, [1], false], // 最初の枠に居る。列3は列2に合流し、道具は無事
    [2, 3, [2], true], // 最後の枠。列3が道具の上に流れ込む
    [2, 3, [3], true], // 道具そのものが列2に流れ込む
    [2, 3, [1, 3], true],
    [3, 4, [2], false],
    [3, 4, [3], true],
    [2, 2, [2], false], // 減らない
    [4, 3, [3], false], // 増える（grid）
    [0, 5, [5], false], // 0 = 減らさない印（even-widths）
  ];
  let evaluated = 0;
  for (const [t, c, tools, expected] of CASES) {
    it(`target=${t} current=${c} tools=[${tools.join(",")}] → ${expected}`, () => {
      evaluated += 1;
      expect(layoutWouldMergeToolColumn(t, c, new Set(tools))).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(10);
  });
});

/**
 * プリセットの判定を1つにまとめたもの（D55-2 + D90）。人間の列が先 ―― 人間の列の合流は
 * どの設定でも外れないので、道具の理由を並べると、エージェントは設定を変えれば通ると読む。
 */
describe("layoutVerdict（D55-2 / D90）", () => {
  const layoutActions = ARRANGE_ACTIONS.filter(
    (x) => !arrangeActionCloses(x) && !arrangeActionMoves(x),
  ) as ArrangeLayoutAction[];

  it("避ける列が空なら、全組み合わせで人間の列だけの判定と同じ（設定オフは以前の答え）", () => {
    let evaluated = 0;
    for (const action of layoutActions) {
      const t = TARGET_GROUPS[action];
      for (const c of [1, 2, 3, 4, 5]) {
        for (const h of [...Array.from({ length: c }, (_, i) => i + 1), undefined]) {
          const expected = layoutWouldMergeHumanColumn(t, c, h)
            ? { ok: false, reason: "human-column-would-merge" }
            : { ok: true };
          const label = `${action} c=${c} h=${String(h)}`;
          expect(layoutVerdict(t, c, h, NO_AVOIDED_COLUMNS), label).toEqual(expected);
          expect(layoutVerdict(t, c, h), label).toEqual(expected);
          evaluated += 1;
        }
      }
    }
    expect(evaluated).toBe(5 * (2 + 3 + 4 + 5 + 6));
  });

  it("全組み合わせで: 人間の列が合流するなら人間の理由、そうでなく道具の列が合流するなら道具の理由", () => {
    let evaluated = 0;
    let toolRefusals = 0;
    for (const action of layoutActions) {
      const t = TARGET_GROUPS[action];
      for (const c of [1, 2, 3, 4, 5]) {
        for (let h = 1; h <= c; h += 1) {
          for (let mask = 0; mask < 1 << c; mask += 1) {
            const tools = new Set(
              Array.from({ length: c }, (_, i) => i + 1).filter((x) => mask & (1 << (x - 1))),
            );
            const label = `${action} c=${c} h=${h} tools=[${[...tools].join(",")}]`;
            const verdict = layoutVerdict(t, c, h, tools);
            if (layoutWouldMergeHumanColumn(t, c, h)) {
              expect(verdict, label).toEqual({ ok: false, reason: "human-column-would-merge" });
            } else if (layoutWouldMergeToolColumn(t, c, tools)) {
              expect(verdict, label).toEqual({ ok: false, reason: "tool-column-would-merge" });
              toolRefusals += 1;
            } else {
              expect(verdict, label).toEqual({ ok: true });
            }
            evaluated += 1;
          }
        }
      }
    }
    expect(evaluated).toBe(5 * (1 * 2 + 2 * 4 + 3 * 8 + 4 * 16 + 5 * 32));
    // 道具の枝が1度も通らないなら、この検査は何も見ていない。
    expect(toolRefusals).toBeGreaterThan(0);
  });

  it("人間が列1・道具が列2で3列 → two-columns は道具の理由で断る。道具が列1なら通る", () => {
    expect(layoutVerdict(2, 3, 1, new Set([2]))).toEqual({
      ok: false,
      reason: "tool-column-would-merge",
    });
    expect(layoutVerdict(2, 3, 2, new Set([1]))).toEqual({
      ok: false,
      reason: "human-column-would-merge",
    });
    expect(layoutVerdict(2, 3, 1, new Set([1]))).toEqual({ ok: true });
    expect(layoutVerdict(0, 3, 1, new Set([1, 2, 3]))).toEqual({ ok: true }); // even-widths
  });
});

/**
 * **プリセットが列を減らすか**。`layoutWouldMergeHumanColumn` の前半と、面が
 * 「合流が終わった」を観測する述語（`arrange-surface.ts` の `applyLayout`）が
 * **同じ1つの関数**である ―― 呼ぶ前の「減るか」と、呼んだ後の「減り終わったか」は
 * 同じ量の否定なので、別々に書くと不変条件14 の11件目になる。
 */
describe("layoutReducesGroups", () => {
  const CASES: ReadonlyArray<readonly [number, number, boolean]> = [
    [2, 3, true], // 3列 → 2枠。列3が合流する
    [2, 2, false], // 減らない
    [2, 1, false], // 増える
    [4, 3, false], // grid は増える側
    [3, 4, true],
    [0, 5, false], // even-widths（0 = 減らさない印）
    [0, 1, false],
  ];
  let evaluated = 0;
  for (const [t, c, expected] of CASES) {
    it(`target=${t} current=${c} → ${expected}`, () => {
      evaluated += 1;
      expect(layoutReducesGroups(t, c)).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(7);
  });
  it("layoutWouldMergeHumanColumn は「減らない」を同じ述語で決める（人間の列を見ずに false）", () => {
    for (const [t, c, reduces] of CASES) {
      if (reduces) continue;
      // 減らないなら、人間の列がどこでも（観測できなくても）合流しない。
      for (const h of [1, 2, 3, 4, 5, undefined]) {
        expect(layoutWouldMergeHumanColumn(t, c, h), `t=${t} c=${c} h=${String(h)}`).toBe(false);
      }
    }
  });
});

/**
 * **自分の操作のあとで own を記録し直す URI**（設計 §C2 / D59）。
 *
 * VS Code はレイアウトの合流もタブの移動も close+open として扱い、`OpenedByAgent` は
 * どの close でも忘れる。人間のドラッグと区別はつかないが、**自分が呼んだ移動／
 * プリセットの中で起きた close は自分の仕業**なので、そのあとで記録し直す。
 * 決めるのはここ1つで、`move-tab` / `gather-own`（D59）とプリセットの両方が通る。
 *
 * ```
 * 記録し直す = 前に own だった && 後に同じ URI のタブがちょうど1枚
 * ```
 *
 * 「ちょうど1枚」は `isOwnTab` の規則と同じ量（2枚以上なら人間が関わっている）。
 * 前に own でなかったものは**決して**記録しない ―― 同じ合流で動いた人間のタブは
 * 人間のもののまま。
 */
describe("ownedUrisToRestore", () => {
  const A = "file:///w/a.ts";
  const B = "file:///w/b.ts";
  const H = "file:///w/human.ts";

  it("前に own で、後に1枚 → 記録し直す", () => {
    expect(ownedUrisToRestore([{ uri: A, own: true }], [{ uri: A }])).toEqual([A]);
  });

  it("前に own で、後に2枚（人間も同じ文書を開いている）→ 記録しない", () => {
    expect(ownedUrisToRestore([{ uri: A, own: true }], [{ uri: A }, { uri: A }])).toEqual([]);
  });

  it("前に own でない → 後に1枚でも記録しない（同じ合流で動いた人間のタブは人間のもの）", () => {
    expect(ownedUrisToRestore([{ uri: H, own: false }], [{ uri: H }])).toEqual([]);
  });

  it("前に own で、後に無い（閉じられた）→ 記録しない", () => {
    expect(ownedUrisToRestore([{ uri: A, own: true }], [])).toEqual([]);
  });

  it("混在: own の2枚は戻り、人間の1枚は戻らない。順序は before の順", () => {
    expect(
      ownedUrisToRestore(
        [
          { uri: B, own: true },
          { uri: H, own: false },
          { uri: A, own: true },
        ],
        [{ uri: H }, { uri: A }, { uri: B }],
      ),
    ).toEqual([B, A]);
  });

  it("前に同じ URI が own で2回並んでも（観測の重複）、返すのは1回", () => {
    expect(
      ownedUrisToRestore(
        [
          { uri: A, own: true },
          { uri: A, own: true },
        ],
        [{ uri: A }],
      ),
    ).toEqual([A]);
  });

  it("後の一覧に前に無かった URI があっても触らない", () => {
    expect(ownedUrisToRestore([], [{ uri: A }])).toEqual([]);
  });
});

/**
 * **移動先の判定**（設計 D59）。`toColumn` は `1..groupCount+1`（それより大きいと VS Code が
 * 飛び番の枠を作る）。人間の列への移動は `closeHumanTabs` が無ければ断る ――
 * `single-column` が起こしたこと（人間の列にタブを流し込む）と同じだから。
 *
 * 真理値表で書く。境界（`groupCount+1` は通り、`groupCount+2` は落ちる。`0` は落ちる）を
 * 1行ずつ持つ ―― 「だいたい範囲内」で畳むと、どちらに倒れているかを検査が指さない。
 */
describe("moveTargetVerdict（D59）", () => {
  // [toColumn, groupCount, humanColumn, closeHumanTabs] → verdict
  const CASES: ReadonlyArray<
    readonly [number, number, number | undefined, boolean, ReturnType<typeof moveTargetVerdict>]
  > = [
    [2, 3, 1, false, { ok: true }], // 既存の舞台の列
    [3, 3, 1, false, { ok: true }], // 右端の列
    [4, 3, 1, false, { ok: true }], // groupCount+1 = 新しい列（VS Code が右端に作る）
    [5, 3, 1, false, { ok: false, reason: "invalid-request" }], // 飛び番 → 飛び番の枠ができる
    [0, 3, 1, false, { ok: false, reason: "invalid-request" }],
    [-1, 3, 1, false, { ok: false, reason: "invalid-request" }],
    [1.5, 3, 1, false, { ok: false, reason: "invalid-request" }], // 整数でない
    [1, 3, 1, false, { ok: false, reason: "human-column-target" }], // 人間の列 → 既定で断る
    [2, 3, 2, false, { ok: false, reason: "human-column-target" }], // 人間が列2なら列2が人間の列
    [1, 3, 1, true, { ok: true }], // closeHumanTabs なら人間の列にも動かせる
    [2, 3, 2, true, { ok: true }],
    [2, 1, 1, false, { ok: true }], // 1列だけ → 隣（新しい列）は通る
    [1, 1, 1, false, { ok: false, reason: "human-column-target" }],
    // 人間の列が観測できない → 断る（どの列が人間か言えないのに流し込めない。同じ倒し方）。
    // 範囲外はそれより先に落ちる（列番号の検査は人間の列と無関係）。
    [2, 3, undefined, false, { ok: false, reason: "human-column-target" }],
    [2, 3, undefined, true, { ok: false, reason: "human-column-target" }], // 設定でも外れない
    [9, 3, undefined, false, { ok: false, reason: "invalid-request" }],
  ];
  let evaluated = 0;
  for (const [toColumn, groupCount, humanColumn, closeHumanTabs, expected] of CASES) {
    it(`to=${toColumn} groups=${groupCount} human=${String(humanColumn)} cHT=${closeHumanTabs} → ${JSON.stringify(expected)}`, () => {
      evaluated += 1;
      expect(
        moveTargetVerdict(toColumn, groupCount, humanColumn, perms({ closeHumanTabs })),
      ).toEqual(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(16);
  });

  it("避ける列が空なら、全組み合わせで以前の答えと同じ（設定オフは以前の答え。D90）", () => {
    let evaluated = 0;
    for (const groupCount of [1, 2, 3, 4]) {
      for (const human of [...Array.from({ length: groupCount }, (_, i) => i + 1), undefined]) {
        for (const toColumn of [0, 1, 2, 3, 4, 5, 6, 1.5]) {
          for (const closeHumanTabs of [false, true]) {
            const p = perms({ closeHumanTabs });
            const label = `to=${toColumn} groups=${groupCount} human=${String(human)} cHT=${closeHumanTabs}`;
            expect(
              moveTargetVerdict(toColumn, groupCount, human, p, NO_AVOIDED_COLUMNS),
              label,
            ).toEqual(moveTargetVerdict(toColumn, groupCount, human, p));
            evaluated += 1;
          }
        }
      }
    }
    expect(evaluated).toBe((2 + 3 + 4 + 5) * 8 * 2);
  });

  // [toColumn, groupCount, humanColumn, closeHumanTabs, 避ける列] → verdict（D90）
  const AVOID_CASES: ReadonlyArray<
    readonly [
      number,
      number,
      number | undefined,
      boolean,
      readonly number[],
      ReturnType<typeof moveTargetVerdict>,
    ]
  > = [
    [2, 3, 1, false, [2], { ok: false, reason: "tool-column-target" }], // 道具の列へ流し込まない
    [3, 3, 1, false, [2], { ok: true }], // 道具の列の外へは動かせる（道具の列から出すのもこれ）
    [4, 3, 1, false, [2, 3], { ok: true }], // 右端の外の新しい列は道具の列でない
    [1, 3, 1, false, [1], { ok: false, reason: "human-column-target" }], // 人間の列が先
    [1, 3, 1, true, [1], { ok: false, reason: "tool-column-target" }], // closeHumanTabs でも道具は守る
    [5, 3, 1, false, [2], { ok: false, reason: "invalid-request" }], // 範囲外は先に落ちる
    [2, 3, undefined, false, [2], { ok: false, reason: "human-column-target" }],
  ];
  let avoidEvaluated = 0;
  for (const [toColumn, groupCount, humanColumn, closeHumanTabs, tools, expected] of AVOID_CASES) {
    it(`to=${toColumn} groups=${groupCount} human=${String(humanColumn)} cHT=${closeHumanTabs} tools=[${tools.join(",")}] → ${JSON.stringify(expected)}`, () => {
      avoidEvaluated += 1;
      expect(
        moveTargetVerdict(
          toColumn,
          groupCount,
          humanColumn,
          perms({ closeHumanTabs }),
          new Set(tools),
        ),
      ).toEqual(expected);
    });
  }
  it("避ける列の表の全行を評価した", () => {
    expect(avoidEvaluated).toBe(AVOID_CASES.length);
    expect(AVOID_CASES.length).toBe(7);
  });

  it("closeDirtyTabs は移動先の判定に関係しない（未保存の床は move に掛からない）", () => {
    expect(moveTargetVerdict(1, 3, 1, perms({ closeDirtyTabs: true }))).toEqual({
      ok: false,
      reason: "human-column-target",
    });
  });
});

/**
 * **`gather-own` の集め先**（設計 D55-1）: 人間の列より右で最小の列。無ければ人間の隣
 * （新しい列）。人間の列そのものは**決して**返さない ―― 返せば `single-column` の再来。
 */
describe("firstStageColumn（gather-own の集め先）", () => {
  it("人間の列より右で最小の列", () => {
    expect(firstStageColumn([1, 2, 3], 1)).toBe(2);
    expect(firstStageColumn([1, 2, 3], 2)).toBe(3);
    // 並び順に依らない（`tabGroups.all` の順序を仮定しない）。
    expect(firstStageColumn([3, 1, 2], 1)).toBe(2);
    // 飛び番があっても「右で最小」。
    expect(firstStageColumn([1, 3], 1)).toBe(3);
  });

  it("右に無ければ人間の列の隣（新しい列）", () => {
    expect(firstStageColumn([1], 1)).toBe(2);
    expect(firstStageColumn([1, 2], 2)).toBe(3);
    expect(firstStageColumn([1, 2, 3], 3)).toBe(4);
  });

  it("人間の列が観測できなければ undefined（推測で集め先を決めない）", () => {
    expect(firstStageColumn([1, 2, 3], undefined)).toBeUndefined();
    expect(firstStageColumn([], undefined)).toBeUndefined();
    // 可視列が無く番号が決まらないときも undefined（"beside" を数に化けさせない）。
    expect(firstStageColumn([], 1)).toBeUndefined();
  });

  it("show_code が single で開く列（stageColumnForSlot）と、生成した表の全組み合わせで等しい", () => {
    // **同じ量を2箇所で決めない**（不変条件14。レビュー I2）。集め先は
    // `chooseStageColumns` が決める「舞台の最初の列」そのもの。ここで式を写さず、
    // 可視列の部分集合 × 人間の列 の全組み合わせで突き合わせる（飛び番も含む）。
    let evaluated = 0;
    for (let mask = 1; mask < 1 << 5; mask += 1) {
      const columns = [1, 2, 3, 4, 5].filter((c) => mask & (1 << (c - 1)));
      for (const human of columns) {
        const label = `columns=[${columns.join(",")}] human=${human}`;
        const expected = stageColumnForSlot(columns, "single", 0, human);
        expect(firstStageColumn(columns, human), label).toBe(expected);
        expect(firstStageColumn([...columns].reverse(), human), label).toBe(expected);
        evaluated += 1;
      }
    }
    expect(evaluated).toBe(80); // Σ over non-empty subsets of |subset| = 5 * 2^4
  });

  it("避ける列を受けても、show_code が single で開く列（stageColumnForSlot）と全組み合わせで等しい", () => {
    // 可視列の部分集合 × 人間の列 × 避ける列（可視列の部分集合）。空集合の行が
    // 上の検査と同じ答えになることも含む。
    let evaluated = 0;
    for (let mask = 1; mask < 1 << 5; mask += 1) {
      const columns = [1, 2, 3, 4, 5].filter((c) => mask & (1 << (c - 1)));
      for (const human of columns) {
        for (let avoidMask = 0; avoidMask < 1 << columns.length; avoidMask += 1) {
          const avoid = new Set(columns.filter((_, i) => avoidMask & (1 << i)));
          const label = `columns=[${columns.join(",")}] human=${human} avoid=[${[...avoid].join(",")}]`;
          const expected = stageColumnForSlot(columns, "single", 0, human, avoid);
          const target = firstStageColumn(columns, human, avoid);
          expect(target, label).toBe(expected);
          expect(firstStageColumn([...columns].reverse(), human, avoid), label).toBe(expected);
          expect(target, label).not.toBe(human);
          expect(target !== undefined && avoid.has(target), label).toBe(false);
          evaluated += 1;
        }
      }
    }
    expect(evaluated).toBe(810); // Σ_k C(5,k)·k·2^k = 5·2·3^4
  });

  it("避ける列を飛ばし、右に使える列が無ければ右端の外（避ける列の間に割り込まない）", () => {
    expect(firstStageColumn([1, 2, 3], 1, new Set([2]))).toBe(3);
    expect(firstStageColumn([1, 2, 3], 1, new Set([2, 3]))).toBe(4);
    expect(firstStageColumn([1, 2, 3], 2, new Set([3]))).toBe(4);
    expect(firstStageColumn([1, 2, 3], 1, new Set())).toBe(2);
  });

  it("人間の列そのものは決して返さない（全組み合わせ）", () => {
    let evaluated = 0;
    for (const groupCount of [1, 2, 3, 4]) {
      const columns = Array.from({ length: groupCount }, (_, i) => i + 1);
      for (const human of columns) {
        const target = firstStageColumn(columns, human);
        expect(target, `groups=${groupCount} human=${human}`).not.toBe(human);
        expect(target, `groups=${groupCount} human=${human}`).toBeGreaterThan(human);
        evaluated += 1;
      }
    }
    expect(evaluated).toBe(10);
  });
});
