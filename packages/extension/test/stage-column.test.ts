import { describe, expect, it } from "vitest";
import {
  MAX_STAGE_COLUMNS,
  MAX_VIEW_COLUMN,
  type StageColumn,
  type StageLayout,
  chooseStageColumns,
  clampStageColumn,
  placeStageColumn,
  resolveStageColumn,
  stageColumnForSlot,
} from "../src/stage-column.js";

/** 1..5 の空でない部分集合（飛び番を含む可視列）。 */
function subsets(of: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let mask = 0; mask < 1 << of.length; mask += 1) {
    out.push(of.filter((_, i) => mask & (1 << i)));
  }
  return out;
}
const NON_EMPTY = subsets([1, 2, 3, 4, 5]).filter((s) => s.length > 0);
const LAYOUTS: readonly StageLayout[] = ["single", "split"];

describe("chooseStageColumns", () => {
  it("layout=split なら舞台の列を2つ返す", () => {
    expect(chooseStageColumns([1], "split")).toEqual([2, 3]);
  });

  it("layout=single なら1つだけ", () => {
    expect(chooseStageColumns([1], "single")).toEqual([2]);
  });

  it("既に舞台の列があれば再利用する（増やさない）", () => {
    expect(chooseStageColumns([1, 2, 3], "split")).toEqual([2, 3]);
    expect(chooseStageColumns([1, 2, 3], "single")).toEqual([2]);
  });

  it("舞台の列が上限より多くても、使うのは上限まで", () => {
    expect(chooseStageColumns([1, 2, 3, 4, 5, 6], "split")).toEqual([2, 3]);
    expect(chooseStageColumns([1, 2, 3, 4, 5, 6], "single")).toEqual([2]);
  });

  it("何度呼んでも列は増えない", () => {
    let cols = [1];
    for (let i = 0; i < 8; i++) {
      const stage = chooseStageColumns(cols, "split");
      cols = [...new Set([...cols, ...stage])].sort((a, b) => a - b);
    }
    expect(cols).toEqual([1, 2, 3]); // 人間の1列＋舞台2列で頭打ち
  });

  it("人間が途中の列を閉じて可視列が飛んでも、繰り返しで増え続けない", () => {
    // ViewColumn は位置番号なので普段は 1..n で詰まっているが、飛んだ集合を
    // 渡されても頭打ちになることを確かめる（設計書 Y7 の再導出が前提）。
    let cols: (number | "beside")[] = [1, 3];
    for (let i = 0; i < 8; i++) {
      const stage = chooseStageColumns(
        cols.filter((c): c is number => typeof c === "number"),
        "split",
      );
      cols = [...new Set([...cols, ...stage])].sort((a, b) => Number(a) - Number(b));
    }
    expect(cols).toEqual([1, 3, 4]); // 人間の1列＋舞台2列。人間の列は増えも動きもしない
  });

  it("可視列が飛んでいても、既存の列を人間の側へ押し戻さない", () => {
    // 2 を新設すると 3 以降が右へ番号ずれし、人間の列との間に割り込むことになる。
    // 既に開いている右側の列を使い、足りない分だけ右端に足す。
    expect(chooseStageColumns([1, 3], "split")).toEqual([3, 4]);
    expect(chooseStageColumns([1, 3], "single")).toEqual([3]);
  });

  it("人間の列（最小の列）を舞台に含めない", () => {
    for (const layout of ["single", "split"] as const) {
      expect(chooseStageColumns([1, 2, 3], layout)).not.toContain(1);
      expect(chooseStageColumns([1], layout)).not.toContain(1);
      expect(chooseStageColumns([1, 3], layout)).not.toContain(1);
      // 人間が1列目以外にいる場合も、最小の列は侵さない
      expect(chooseStageColumns([2, 5], layout)).not.toContain(2);
    }
  });

  it("列が1つも無ければ隣に作る", () => {
    expect(chooseStageColumns([], "single")).toEqual(["beside"]);
    expect(chooseStageColumns([], "split")).toEqual(["beside", "beside"]);
  });

  it("渡す順や重複に依らない", () => {
    expect(chooseStageColumns([3, 1, 2], "split")).toEqual([2, 3]);
    expect(chooseStageColumns([1, 1, 2, 2], "split")).toEqual([2, 3]);
    expect(chooseStageColumns([2, 1], "single")).toEqual([2]);
  });

  it("上限は2で、返る列の数はそれを超えない", () => {
    expect(MAX_STAGE_COLUMNS).toBe(2);
    for (const visible of [[], [1], [1, 2], [1, 2, 3], [1, 3], [5, 1, 3], [1, 2, 3, 4, 5]]) {
      expect(chooseStageColumns(visible, "split").length).toBe(MAX_STAGE_COLUMNS);
      expect(chooseStageColumns(visible, "single").length).toBe(1);
    }
  });

  it("返る列に重複が無い（同じ列に2枚並べない）", () => {
    for (const visible of [[], [1], [1, 2], [1, 3], [5, 1, 3]]) {
      const stage = chooseStageColumns(visible, "split");
      const numbers = stage.filter((c): c is number => typeof c === "number");
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });
});

describe("chooseStageColumns の humanColumn", () => {
  it("渡さなければ従来どおり最小の列を人間のものとみなす", () => {
    expect(chooseStageColumns([1, 2, 3], "split")).toEqual(
      chooseStageColumns([1, 2, 3], "split", 1),
    );
  });

  it("人間が最小の列にいないときは、渡された列より右だけを使う", () => {
    // tabGroups.activeTabGroup を追えば人間の列は観測できる（設計書 §2A.7 の
    // 配線は後の増分）。引数だけ先に開けてある。
    expect(chooseStageColumns([1, 2, 3], "split", 2)).toEqual([3, 4]);
    expect(chooseStageColumns([1, 2, 3], "single", 3)).toEqual([4]);
  });

  it("人間の列は、渡された値であっても舞台に含めない", () => {
    for (const human of [1, 2, 3]) {
      for (const layout of ["single", "split"] as const) {
        expect(chooseStageColumns([1, 2, 3], layout, human)).not.toContain(human);
      }
    }
  });

  it("人間の列が可視列より右にあっても、そこへ重ねない", () => {
    // 可視列の右端から足すと 3,4 になり、人間の 5 を跨いで左に置くことになる。
    expect(chooseStageColumns([1, 2], "split", 5)).toEqual([6, 7]);
  });
});

describe("stageColumnForSlot", () => {
  it("split の枠0と枠1は別の列になる", () => {
    expect(stageColumnForSlot([1], "split", 0)).toBe(2);
    expect(stageColumnForSlot([1], "split", 1)).toBe(3);
  });

  it("3つ目は最後の列のタブになる（列は増やさない）", () => {
    // locations の上限は3、舞台の列の上限は2（設計書 §2A.7）。
    expect(stageColumnForSlot([1], "split", 2)).toBe(3);
    expect(stageColumnForSlot([1, 2, 3], "split", 2)).toBe(3);
  });

  it("single ではどの枠も同じ1列に落ちる", () => {
    for (const slot of [0, 1, 2]) expect(stageColumnForSlot([1], "single", slot)).toBe(2);
  });

  it("列が1つも無ければ隣に作る", () => {
    expect(stageColumnForSlot([], "split", 1)).toBe("beside");
  });

  it("負の枠や小数でも人間の列に落ちない", () => {
    expect(stageColumnForSlot([1], "split", -1)).toBe(2);
    expect(stageColumnForSlot([1], "split", 1.9)).toBe(3);
  });
});

describe("clampStageColumn", () => {
  it("存在する列＋1 を超える要求は丸める（VS Code は存在しない列を作る）", () => {
    // "Columns that do not exist will be created as needed up to ViewColumn.Nine"
    expect(clampStageColumn(3, 1)).toBe(2);
    expect(clampStageColumn(9, 2)).toBe(3);
  });

  it("いま作れる範囲の要求はそのまま通す", () => {
    expect(clampStageColumn(2, 1)).toBe(2);
    expect(clampStageColumn(3, 2)).toBe(3);
    expect(clampStageColumn(2, 3)).toBe(2);
  });

  it("列が1つも無ければ番号を決めない（丸めると人間の列を指す）", () => {
    expect(clampStageColumn(2, 0)).toBe("beside");
    expect(clampStageColumn("beside", 3)).toBe("beside");
  });

  it("要求する列は、いま存在する列＋1 を決して超えない", () => {
    // 丸めを外すと、開く順序を崩したときにここが落ちる（下のケース）。
    for (const groups of [1, 2, 3]) {
      const visible = Array.from({ length: groups }, (_, i) => i + 1);
      for (const slot of [0, 1, 2]) {
        for (const layout of ["single", "split"] as const) {
          const column = clampStageColumn(stageColumnForSlot(visible, layout, slot), groups);
          if (column !== "beside") expect(column).toBeLessThanOrEqual(groups + 1);
        }
      }
    }
  });

  it("丸めても人間の列（最小の列）には落ちない", () => {
    for (const groups of [1, 2, 3]) {
      for (const requested of [2, 3, 4, 9]) {
        expect(clampStageColumn(requested, groups)).not.toBe(1);
      }
    }
  });
});

describe("実際に開いたときの列の増え方", () => {
  /**
   * VS Code の挙動を写す: 存在しない列を要求されると必要な分だけ作る。
   * 実測（VS Code 1.136.2）では、可視列 [1] のときに列3を要求すると列2に落ちる。
   */
  function openIn(groups: number, requested: StageColumn): number {
    if (requested === "beside") return groups + 1;
    return Math.max(groups, Math.min(requested, groups + 1));
  }

  it("split を8回呼んでも、人間1列＋舞台2列で頭打ちになる", () => {
    let groups = 1; // 人間の列だけがある状態から始める
    for (let call = 0; call < 8; call += 1) {
      // **枠は昇順に開く。** 大きい番号を先に渡すと丸められて同じ列に落ちる。
      for (const slot of [0, 1]) {
        const visible = Array.from({ length: groups }, (_, i) => i + 1);
        const column = clampStageColumn(stageColumnForSlot(visible, "split", slot), groups);
        groups = openIn(groups, column);
      }
    }
    expect(groups).toBe(3);
  });

  it("単発の split でも、要求は2回とも作れる範囲に収まる", () => {
    let groups = 1;
    const requested: StageColumn[] = [];
    for (const slot of [0, 1]) {
      const visible = Array.from({ length: groups }, (_, i) => i + 1);
      const column = clampStageColumn(stageColumnForSlot(visible, "split", slot), groups);
      requested.push(column);
      groups = openIn(groups, column);
    }
    expect(requested).toEqual([2, 3]);
    expect(groups).toBe(3);
  });

  it("枠を降順に開くと2列にならない（順序が効くことの証拠）", () => {
    // 実装が枠1を先に開くと、丸めで列2に落ちて枠0と同じ列を使う。
    let groups = 1;
    const columns: StageColumn[] = [];
    for (const slot of [1, 0]) {
      const visible = Array.from({ length: groups }, (_, i) => i + 1);
      const column = clampStageColumn(stageColumnForSlot(visible, "split", slot), groups);
      columns.push(column);
      groups = openIn(groups, column);
    }
    expect(new Set(columns).size).toBe(1);
    expect(groups).toBe(2);
  });
});

/**
 * 以前の `chooseStageColumns` の写し（避ける列を持たない版）。避ける列が空のとき、
 * 答えがこれと1つも違わないことを生成した表で確かめる（後方互換の神託）。
 */
function previousChooseStageColumns(
  visibleColumns: readonly number[],
  layout: StageLayout,
  humanColumn?: number,
): StageColumn[] {
  const want = layout === "split" ? 2 : 1;
  const sorted = [...new Set(visibleColumns)].sort((a, b) => a - b);
  const human = humanColumn ?? sorted[0];
  if (sorted.length === 0 || human === undefined) {
    return Array.from({ length: want }, () => "beside" as const);
  }
  const chosen: StageColumn[] = sorted.filter((c) => c > human).slice(0, want);
  let next = Math.max(...sorted, human);
  while (chosen.length < want) chosen.push(++next);
  return chosen;
}

describe("chooseStageColumns の避ける列", () => {
  it("人間の列より右の既存の列のうち、避ける列でないものを使う", () => {
    expect(chooseStageColumns([1, 2, 3], "single", 1, new Set([2]))).toEqual([3]);
    expect(chooseStageColumns([1, 2, 3, 4], "split", 1, new Set([2, 4]))).toEqual([3, 5]);
    expect(chooseStageColumns([1, 2, 3, 4], "split", 1, new Set([3]))).toEqual([2, 4]);
  });

  it("足りなければ右端（避ける列を含めた右端）の外に足す。避ける列の間に割り込まない", () => {
    expect(chooseStageColumns([1, 2, 3], "single", 1, new Set([2, 3]))).toEqual([4]);
    expect(chooseStageColumns([1, 2, 3], "split", 1, new Set([2, 3]))).toEqual([4, 5]);
    expect(chooseStageColumns([1, 2, 3], "split", 1, new Set([3]))).toEqual([2, 4]);
    expect(chooseStageColumns([1, 2], "split", 1, new Set([2]))).toEqual([3, 4]);
  });

  it("避ける列が空なら、以前の答えと全組み合わせで等しい", () => {
    let evaluated = 0;
    for (const visible of [[], ...NON_EMPTY]) {
      for (const human of [undefined, ...visible, 6]) {
        for (const layout of LAYOUTS) {
          const label = `visible=[${visible.join(",")}] human=${human} ${layout}`;
          const expected = previousChooseStageColumns(visible, layout, human);
          expect(chooseStageColumns(visible, layout, human), label).toEqual(expected);
          expect(chooseStageColumns(visible, layout, human, new Set()), label).toEqual(expected);
          expect(
            chooseStageColumns([...visible].reverse(), layout, human, new Set()),
            label,
          ).toEqual(expected);
          evaluated += 1;
        }
      }
    }
    // (空集合の2通り + Σ over non-empty subsets of (|S| + 2)) * 2 layouts
    expect(evaluated).toBe((2 + 80 + 2 * 31) * 2);
  });

  it("避ける列も人間の列も返さず、数は layout どおりで重複が無い（全組み合わせ）", () => {
    let evaluated = 0;
    for (const visible of NON_EMPTY) {
      for (const human of visible) {
        for (const avoidList of subsets(visible)) {
          const avoid = new Set(avoidList);
          for (const layout of LAYOUTS) {
            const label = `visible=[${visible.join(",")}] human=${human} avoid=[${avoidList.join(",")}] ${layout}`;
            const stage = chooseStageColumns(visible, layout, human, avoid);
            expect(stage.length, label).toBe(layout === "split" ? MAX_STAGE_COLUMNS : 1);
            expect(new Set(stage).size, label).toBe(stage.length);
            for (const column of stage) {
              expect(column, label).not.toBe(human);
              expect(typeof column === "number" && avoid.has(column), label).toBe(false);
              expect(column, label).toBeGreaterThan(human);
            }
            evaluated += 1;
          }
        }
      }
    }
    expect(evaluated).toBe(810 * 2); // Σ_k C(5,k)·k·2^k = 5·2·3^4
  });

  it("stageColumnForSlot も同じ集合を受ける", () => {
    const avoid = new Set([2, 3]);
    expect(stageColumnForSlot([1, 2, 3], "split", 0, 1, avoid)).toBe(4);
    expect(stageColumnForSlot([1, 2, 3], "split", 1, 1, avoid)).toBe(5);
    expect(stageColumnForSlot([1, 2, 3], "split", 2, 1, avoid)).toBe(5);
    expect(stageColumnForSlot([1, 2, 3], "single", 1, 1, avoid)).toBe(4);
  });
});

describe("resolveStageColumn（VS Code に渡す列。作れなければ none）", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  /**
   * 実際の列は 1..n で詰まっている（ViewColumn は位置番号）ので、表は詰まった列で書く。
   * `existing` はいま存在する列の数（呼び出し側の `tabGroups.all.length`）。
   */
  const rows: {
    visible: number[];
    existing?: number;
    human: number;
    avoid: number[];
    layout: StageLayout;
    slot: number;
    expected: StageColumn | "none";
    why: string;
  }[] = [
    {
      visible: [1, 2, 3],
      human: 1,
      avoid: [],
      layout: "single",
      slot: 0,
      expected: 2,
      why: "unchanged without avoid",
    },
    {
      visible: [1, 2, 3],
      human: 1,
      avoid: [2],
      layout: "single",
      slot: 0,
      expected: 3,
      why: "skip the avoided column",
    },
    {
      visible: [1, 2, 3],
      human: 1,
      avoid: [2, 3],
      layout: "single",
      slot: 0,
      expected: 4,
      why: "append one new column (existing+1)",
    },
    {
      visible: [1, 2, 3],
      human: 1,
      avoid: [2, 3],
      layout: "split",
      slot: 0,
      expected: 4,
      why: "first split column is the new one",
    },
    // 枠1を枠0より先に（または枠0を開く前の数で）決めると、5 は丸められて 4 に落ちる。
    // 4 は枠0と同じ舞台の列で、人間の列でも避ける列でもない ―― 避ける列が無いときの
    // 「降順に開くと2列にならない」と同じ振る舞い。
    {
      visible: [1, 2, 3],
      human: 1,
      avoid: [2, 3],
      layout: "split",
      slot: 1,
      expected: 4,
      why: "stale count clamps onto slot 0's column",
    },
    {
      visible: [1, 2, 3, 4],
      human: 1,
      avoid: [2, 3],
      layout: "split",
      slot: 1,
      expected: 5,
      why: "after slot 0 opened column 4",
    },
    {
      visible: [1, 2, 3],
      human: 2,
      avoid: [3],
      layout: "single",
      slot: 0,
      expected: 4,
      why: "human in the middle",
    },
    {
      visible: range(9),
      human: 1,
      avoid: [2, 3, 4, 5, 6, 7, 8, 9],
      layout: "single",
      slot: 0,
      expected: "none",
      why: "no column beyond Nine",
    },
    {
      visible: range(9),
      human: 9,
      avoid: [],
      layout: "single",
      slot: 0,
      expected: "none",
      why: "no column beyond Nine",
    },
    {
      visible: range(8),
      human: 1,
      avoid: [2, 3, 4, 5, 6, 7, 8],
      layout: "split",
      slot: 0,
      expected: 9,
      why: "Nine can still be created",
    },
    {
      visible: range(9),
      human: 1,
      avoid: [2, 3, 4, 5, 6, 7, 8],
      layout: "split",
      slot: 1,
      expected: "none",
      why: "second column would be Ten",
    },
    // 飛び番（実際の VS Code には無い形）: 丸めが既存の列に落ちたら none。
    {
      visible: [1, 3],
      existing: 2,
      human: 1,
      avoid: [3],
      layout: "single",
      slot: 0,
      expected: "none",
      why: "clamp lands on an avoided column",
    },
    {
      visible: [1, 3],
      existing: 2,
      human: 3,
      avoid: [],
      layout: "single",
      slot: 0,
      expected: "none",
      why: "clamp lands on the human column",
    },
    {
      visible: [],
      existing: 0,
      human: 1,
      avoid: [],
      layout: "single",
      slot: 0,
      expected: "beside",
      why: "no groups at all",
    },
  ];

  it.each(rows)("$why: visible=$visible human=$human avoid=$avoid $layout slot=$slot", (row) => {
    const existing = row.existing ?? row.visible.length;
    expect(
      resolveStageColumn(
        row.visible,
        row.layout,
        row.slot,
        row.human,
        existing,
        new Set(row.avoid),
      ),
    ).toBe(row.expected);
  });

  it("MAX_VIEW_COLUMN は ViewColumn.Nine", () => {
    expect(MAX_VIEW_COLUMN).toBe(9);
  });

  it("返す列は人間の列でも避ける列でもなく、存在する列＋1 と Nine を超えない（全組み合わせ）", () => {
    let evaluated = 0;
    for (const visible of NON_EMPTY) {
      const existing = visible.length;
      for (const human of visible) {
        for (const avoidList of subsets(visible)) {
          const avoid = new Set(avoidList);
          for (const layout of LAYOUTS) {
            for (const slot of [0, 1, 2]) {
              const label = `visible=[${visible.join(",")}] human=${human} avoid=[${avoidList.join(",")}] ${layout} slot=${slot}`;
              const column = resolveStageColumn(visible, layout, slot, human, existing, avoid);
              expect(column, label).not.toBe("beside");
              if (column === "none" || column === "beside") continue;
              expect(column, label).not.toBe(human);
              expect(avoid.has(column), label).toBe(false);
              expect(column, label).toBeLessThanOrEqual(existing + 1);
              expect(column, label).toBeLessThanOrEqual(MAX_VIEW_COLUMN);
              evaluated += 1;
            }
          }
        }
      }
    }
    expect(evaluated).toBeGreaterThan(0);
  });

  it("詰まった列で Nine 未満なら、single は避ける列があっても必ず列を返す（足せる）", () => {
    for (let n = 1; n <= 8; n += 1) {
      const visible = range(n);
      for (const human of visible) {
        for (const avoidList of subsets(visible.filter((c) => c > human))) {
          const column = resolveStageColumn(visible, "single", 0, human, n, new Set(avoidList));
          expect(column, `n=${n} human=${human} avoid=[${avoidList.join(",")}]`).not.toBe("none");
        }
      }
    }
  });

  it("避ける列が空なら、詰まった列（Nine 未満）では clampStageColumn(stageColumnForSlot) と等しい", () => {
    let evaluated = 0;
    for (let n = 1; n <= 8; n += 1) {
      const visible = range(n);
      for (const human of visible) {
        for (const layout of LAYOUTS) {
          for (const slot of [0, 1, 2]) {
            const previous = clampStageColumn(stageColumnForSlot(visible, layout, slot, human), n);
            expect(
              resolveStageColumn(visible, layout, slot, human, n),
              `n=${n} human=${human}`,
            ).toBe(previous);
            expect(resolveStageColumn(visible, layout, slot, human, n, new Set())).toBe(previous);
            evaluated += 1;
          }
        }
      }
    }
    expect(evaluated).toBe(36 * 2 * 3);
  });

  it("避ける列が空で答えが変わるのは、以前の答えが人間の列か Nine の外だったときだけ（全組み合わせ）", () => {
    for (const visible of NON_EMPTY) {
      for (const human of visible) {
        for (const layout of LAYOUTS) {
          for (const slot of [0, 1, 2]) {
            const previous = clampStageColumn(
              stageColumnForSlot(visible, layout, slot, human),
              visible.length,
            );
            const now = resolveStageColumn(visible, layout, slot, human, visible.length);
            if (now === previous) continue;
            expect(now).toBe("none");
            expect(previous === human || (typeof previous === "number" && previous > 9)).toBe(true);
          }
        }
      }
    }
  });

  it("道具の列が2つあっても、split を昇順に何度開いても舞台は2列で頭打ち、避ける列には描かない", () => {
    function openIn(groups: number, requested: StageColumn | "none"): number {
      if (requested === "none") return groups;
      if (requested === "beside") return groups + 1;
      return Math.max(groups, Math.min(requested, groups + 1));
    }
    const avoid = new Set([2, 3]); // 列2・列3は道具（ターミナルなど）を表示している
    let groups = 3;
    const used = new Set<number>();
    for (let call = 0; call < 8; call += 1) {
      for (const slot of [0, 1]) {
        const column = resolveStageColumn(range(groups), "split", slot, 1, groups, avoid);
        expect(column).not.toBe("none");
        if (typeof column === "number") used.add(column);
        groups = openIn(groups, column);
      }
    }
    expect([...used].sort()).toEqual([4, 5]);
    expect(groups).toBe(5);
  });
});

describe("placeStageColumn（設定のオン・オフで舞台の列を決める1箇所）", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const layouts: StageLayout[] = ["single", "split"];

  it("設定がオフ（避ける集合を渡さない）なら、以前の答え（枠の列を丸めただけ）と全部一致する", () => {
    // 端の場合も含めて以前の道のまま: 9列で人間が列9でも断らない（10 をそのまま渡していた）。
    let evaluated = 0;
    for (const visible of subsets([1, 2, 3, 4, 5]).concat([range(9)])) {
      for (const human of visible) {
        for (const layout of layouts) {
          for (const slot of [0, 1, 2]) {
            const before = clampStageColumn(
              stageColumnForSlot(visible, layout, slot, human),
              visible.length,
            );
            expect(
              placeStageColumn(visible, layout, slot, human, visible.length, undefined),
              JSON.stringify({ visible, human, layout, slot }),
            ).toBe(before);
            evaluated += 1;
          }
        }
      }
    }
    expect(evaluated).toBeGreaterThan(400);
    expect(placeStageColumn(range(9), "single", 0, 9, 9, undefined)).toBe(10);
  });

  it("設定がオンなら、枠0は resolveStageColumn と同じ答え", () => {
    for (const visible of subsets([1, 2, 3, 4, 5])) {
      for (const human of visible) {
        for (const avoid of subsets(visible.filter((c) => c !== human))) {
          for (const layout of layouts) {
            const set = new Set(avoid);
            expect(
              placeStageColumn(visible, layout, 0, human, visible.length, set),
              JSON.stringify({ visible, human, avoid, layout }),
            ).toBe(resolveStageColumn(visible, layout, 0, human, visible.length, set));
          }
        }
      }
    }
  });

  it("設定がオンで、人間の列にも避ける列にも描かない（none でなければ）", () => {
    for (const visible of subsets([1, 2, 3, 4, 5])) {
      for (const human of visible) {
        for (const avoid of subsets(visible.filter((c) => c !== human))) {
          for (const layout of layouts) {
            for (const slot of [0, 1, 2]) {
              const set = new Set(avoid);
              const got = placeStageColumn(visible, layout, slot, human, visible.length, set);
              const label = JSON.stringify({ visible, human, avoid, layout, slot });
              expect(got, label).not.toBe(human);
              if (typeof got === "number") expect(set.has(got), label).toBe(false);
            }
          }
        }
      }
    }
  });

  it("split の枠1が置けず枠0が置けるなら、枠0の列に重ねる（断らない）", () => {
    // 列1..9、人間は列1、列2..8 が道具。枠0を開いた後（列9がある）で、枠1は列10 ―― Nine の外。
    const avoid = new Set([2, 3, 4, 5, 6, 7, 8]);
    expect(resolveStageColumn(range(9), "split", 1, 1, 9, avoid)).toBe("none");
    expect(placeStageColumn(range(9), "split", 0, 1, 9, avoid)).toBe(9);
    expect(placeStageColumn(range(9), "split", 1, 1, 9, avoid)).toBe(9);
  });

  it("枠0が置けなければ none（呼び出し側が断る）", () => {
    const allTools = new Set([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(placeStageColumn(range(9), "single", 0, 1, 9, allTools)).toBe("none");
    expect(placeStageColumn(range(9), "split", 1, 1, 9, allTools)).toBe("none");
    // 設定がオンなら、避ける列が空でも Nine の外には置かない（オフの 10 と違う）。
    expect(placeStageColumn(range(9), "single", 0, 9, 9, new Set())).toBe("none");
  });

  it("可視列が無ければ beside（オン・オフとも）", () => {
    expect(placeStageColumn([], "single", 0, undefined, 0, undefined)).toBe("beside");
    expect(placeStageColumn([], "single", 0, undefined, 0, new Set())).toBe("beside");
  });
});
