import { describe, expect, it } from "vitest";
import {
  MAX_STAGE_COLUMNS,
  type StageColumn,
  chooseStageColumns,
  clampStageColumn,
  stageColumnForSlot,
} from "../src/stage-column.js";

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
