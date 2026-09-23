import * as fs from "node:fs";
import * as path from "node:path";
import {
  SELECTION_WITHHELD_REASONS,
  type SelectionWithheldReason,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  MIN_MS_SINCE_OWN_TOOL_CALL,
  OwnToolCallClock,
  SELECTION_CHECK_ORDER,
  SelectionMemory,
  type SelectionObservation,
  judgeSelection,
  selectionKey,
} from "../src/human-selection.js";

/**
 * 人間由来の選択の判定（設計書 §3.1）。
 *
 * ## なぜ `TextEditorSelectionChangeKind` を使わないのか
 *
 * 素朴には「変更の出所が Mouse / Keyboard なら人間由来」としたくなる。
 * **実機（VS Code 1.136.2）の検証で、これは両方向に誤ることが分かっている。**
 *
 * - **偽陽性**: 出所が未設定のときの既定値が `"keyboard"` である
 *   （`CursorsController._emitStateChangedIfNecessary`）。したがって
 *   `executeCommand("editor.action.selectAll")` などの core カーソルコマンドは
 *   **すべて Keyboard を名乗れる**。「キーボード起源」は名乗りであって由来ではない。
 * - **偽陰性**: 人間の操作の多くが Mouse / Keyboard に落ちない。
 *   Ctrl+D（次の一致を選択）と Shift+Alt+右（選択を広げる）は `"api"` → Command、
 *   定義へ移動は `"code.jump"` → Command、検索結果のクリックは `"code.navigation"` → Command、
 *   **Undo/Redo と表示状態の復元は undefined**。
 *
 * つまり `undefined` は「人間由来でない」の印ではなく、Command は「エージェント由来」の
 * 印でもない。しかも偽陰性が多いことが「効かないから緩めよう」という圧力を生み、
 * 緩めた先に偽陽性が待つ。**だから観測量から人間由来を組み立てる。**
 */

/** すべての条件を満たす観測。各テストはここから1つだけ崩す。 */
function shareable(): SelectionObservation {
  return {
    outsideWorkspace: false,
    redacted: false,
    empty: false,
    coversWholeDocument: false,
    windowFocused: true,
    isActiveEditor: true,
    msSinceOwnToolCall: Number.POSITIVE_INFINITY,
    alreadyReturned: false,
  };
}

/** すべての条件を外した観測。順序を確かめるために使う。 */
function allWithheld(): SelectionObservation {
  return {
    outsideWorkspace: true,
    redacted: true,
    empty: true,
    coversWholeDocument: true,
    windowFocused: false,
    isActiveEditor: false,
    msSinceOwnToolCall: 0,
    alreadyReturned: true,
  };
}

/** 理由ごとの「その条件だけを満たす」直し方。順序の検査で1段ずつ外していく。 */
const SATISFY: Record<SelectionWithheldReason, (o: SelectionObservation) => void> = {
  "outside-workspace": (o) => {
    o.outsideWorkspace = false;
  },
  redacted: (o) => {
    o.redacted = false;
  },
  empty: (o) => {
    o.empty = false;
  },
  "whole-document": (o) => {
    o.coversWholeDocument = false;
  },
  "not-focused": (o) => {
    o.windowFocused = true;
  },
  "not-active": (o) => {
    o.isActiveEditor = true;
  },
  "too-soon-after-tool": (o) => {
    o.msSinceOwnToolCall = Number.POSITIVE_INFINITY;
  },
  "already-returned": (o) => {
    o.alreadyReturned = false;
  },
};

describe("judgeSelection", () => {
  it("すべての条件を満たしたときだけ共有する", () => {
    expect(judgeSelection(shareable())).toEqual({ share: true });
  });

  it("ワークスペースの外の文書は共有しない", () => {
    const o = shareable();
    o.outsideWorkspace = true;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "outside-workspace" });
  });

  it("除外パスの選択は共有しない", () => {
    const o = shareable();
    o.redacted = true;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "redacted" });
  });

  it("空の選択は共有しない", () => {
    const o = shareable();
    o.empty = true;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "empty" });
  });

  it("文書全体を覆う選択は共有しない（selectAll 系の形を弾く）", () => {
    const o = shareable();
    o.coversWholeDocument = true;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "whole-document" });
  });

  it("窓が前面に無いときは共有しない", () => {
    const o = shareable();
    o.windowFocused = false;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "not-focused" });
  });

  it("人間が使っているエディタでなければ共有しない", () => {
    const o = shareable();
    o.isActiveEditor = false;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "not-active" });
  });

  it("自ツールがエディタに触った直後は共有しない", () => {
    const o = shareable();
    o.msSinceOwnToolCall = 0;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "too-soon-after-tool" });
  });

  it("同じ範囲を二度返さない", () => {
    const o = shareable();
    o.alreadyReturned = true;
    expect(judgeSelection(o)).toEqual({ share: false, reason: "already-returned" });
  });

  it("待ち時間の境界は「経過した分だけ」で判定する（ちょうど上限なら共有する）", () => {
    const justUnder = shareable();
    justUnder.msSinceOwnToolCall = MIN_MS_SINCE_OWN_TOOL_CALL - 1;
    expect(judgeSelection(justUnder)).toEqual({
      share: false,
      reason: "too-soon-after-tool",
    });

    const justOver = shareable();
    justOver.msSinceOwnToolCall = MIN_MS_SINCE_OWN_TOOL_CALL;
    expect(judgeSelection(justOver)).toEqual({ share: true });
  });
});

describe("拒否の順序", () => {
  /**
   * 複数の条件が同時に外れているとき、**どれを返すかが決まっている**こと。
   *
   * 順序は「その理由がどれだけ長く真であり続けるか」の降順である。永続的な
   * 理由（パス）を一時的な理由（時間・重複）で覆うと、エージェントは
   * 「もう一度呼べば取れる」と読んで呼び続ける。
   */
  it("全部外れているとき、宣言された順序の先頭から返る", () => {
    const o = allWithheld();
    for (const reason of SELECTION_CHECK_ORDER) {
      expect(judgeSelection(o), `残りの先頭は ${reason} のはず`).toEqual({
        share: false,
        reason,
      });
      SATISFY[reason](o);
    }
    // 全部満たしたので共有する。取りこぼした条件があればここで落ちる。
    expect(judgeSelection(o)).toEqual({ share: true });
  });

  it("判定の順序は線上の語彙の並びと一致している（順序の定義元は1つ）", () => {
    expect(SELECTION_CHECK_ORDER).toEqual([...SELECTION_WITHHELD_REASONS]);
  });

  it("8つの理由すべてが実際に返りうる（語彙に死んだ値が無い）", () => {
    const seen = new Set<SelectionWithheldReason>();
    const o = allWithheld();
    for (const _ of SELECTION_CHECK_ORDER) {
      const verdict = judgeSelection(o);
      if (verdict.share) break;
      seen.add(verdict.reason);
      SATISFY[verdict.reason](o);
    }
    expect([...seen].sort()).toEqual([...SELECTION_WITHHELD_REASONS].sort());
  });
});

describe("判定は変更の出所（VS Code が名乗る種別）に依存しない", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "human-selection.ts"),
    "utf8",
  );

  it("観測量に出所が現れない", () => {
    // 型は実行時に読めないので、観測量の鍵の集合で固定する。増やしたら落ちる。
    expect(Object.keys(shareable()).sort()).toEqual([
      "alreadyReturned",
      "coversWholeDocument",
      "empty",
      "isActiveEditor",
      "msSinceOwnToolCall",
      "outsideWorkspace",
      "redacted",
      "windowFocused",
    ]);
  });

  it("実装のソースに出所を表す語が一度も現れない", () => {
    // `TextEditorSelectionChangeKind` / `SelectionChangeKind` / `.kind` のいずれも。
    // 判定に使ってよい値ではないので、コメントで言及することも許さない
    // （理由はこのテストのファイル先頭に書いてある）。
    expect(source.toLowerCase()).not.toContain("kind");
  });

  it("検査器が実際に語を捕まえられる", () => {
    // 「1件も無い」を信用する前に、判定が本当に当たることを確かめる。
    expect("if (e.kind === Mouse)".toLowerCase()).toContain("kind");
  });
});

describe("SelectionMemory", () => {
  it("一度返した範囲は、人間が動かすまで返さない", () => {
    const memory = new SelectionMemory();
    const key = selectionKey("src/a.ts", {
      startLine: 3,
      startCharacter: 0,
      endLine: 3,
      endCharacter: 10,
    });
    expect(memory.wasReturned(key)).toBe(false);
    memory.remember(key);
    expect(memory.wasReturned(key)).toBe(true);
  });

  it("人間が別の範囲へ動かせば、また返せるようになる（覚えるのは直前の1つだけ）", () => {
    const memory = new SelectionMemory();
    const first = selectionKey("src/a.ts", {
      startLine: 3,
      startCharacter: 0,
      endLine: 3,
      endCharacter: 10,
    });
    const second = selectionKey("src/a.ts", {
      startLine: 9,
      startCharacter: 0,
      endLine: 9,
      endCharacter: 4,
    });
    memory.remember(first);
    memory.remember(second);
    // 直前の1つだけを覚える。集合にすると、一度見た範囲を永久に返さなくなる。
    expect(memory.wasReturned(second)).toBe(true);
    expect(memory.wasReturned(first)).toBe(false);
  });

  it("パスが違えば同じ範囲でも別の鍵になる", () => {
    const range = { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 };
    expect(selectionKey("src/a.ts", range)).not.toBe(selectionKey("src/b.ts", range));
  });

  it("行と桁の区切りが曖昧でない（別の範囲が同じ鍵にならない）", () => {
    // "1,2-3,4" のような組み立ては、区切りが弱いと別の範囲で衝突する。
    const a = selectionKey("a", { startLine: 1, startCharacter: 2, endLine: 3, endCharacter: 4 });
    const b = selectionKey("a", { startLine: 1, startCharacter: 23, endLine: 0, endCharacter: 4 });
    expect(a).not.toBe(b);
  });
});

describe("OwnToolCallClock", () => {
  it("一度も呼んでいなければ無限大（＝いつでも共有してよい）", () => {
    expect(new OwnToolCallClock().msSince(1000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("印を付けた時刻からの経過を返す", () => {
    const clock = new OwnToolCallClock();
    clock.mark(1000);
    expect(clock.msSince(1000)).toBe(0);
    expect(clock.msSince(1500)).toBe(500);
  });

  it("時計が巻き戻っても負を返さない（負は無条件に上限未満で、危険な側に倒れる）", () => {
    const clock = new OwnToolCallClock();
    clock.mark(2000);
    expect(clock.msSince(1000)).toBe(0);
  });
});
