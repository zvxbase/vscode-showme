import { describe, expect, it } from "vitest";
import { recordsOpenedTab, urisInColumn } from "../src/stage-record.js";

/**
 * 開いたタブを「自分が開いた」として記録するか（D53 / D95）。従来の窓（`agentTabs: false`）で
 * 人間の列に開くと、`showTextDocument` は人間が既に開いている同じファイルのタブを使い回す。それを
 * 記録すると、窓にそのタブが1枚だけなので own になり、`close-own` が人間のタブを閉じる。
 *
 * 行き先の列の URI の集合は**開く前に**取り、照らすのは**開いた後の**文書の URI（VS Code が実際に
 * 開いたほう。渡した綴りと正規化で違いうる）。
 */
describe("urisInColumn", () => {
  const groups = [
    { viewColumn: 1, uris: ["file:///ws/human.md", "file:///ws/a.ts"] },
    { viewColumn: 2, uris: ["file:///ws/other.ts"] },
  ];
  it("その列のテキストタブの URI だけ", () => {
    expect([...urisInColumn(groups, 1)].sort()).toEqual(["file:///ws/a.ts", "file:///ws/human.md"]);
    expect([...urisInColumn(groups, 2)]).toEqual(["file:///ws/other.ts"]);
  });
  it("存在しない列（新しい列を足す・Beside の -2）は空", () => {
    expect(urisInColumn(groups, 3).size).toBe(0);
    expect(urisInColumn(groups, -2).size).toBe(0);
  });
});

describe("recordsOpenedTab", () => {
  const before = new Set(["file:///ws/human.md", "file:///ws/a%20b.ts"]);

  const CASES: ReadonlyArray<readonly [string, boolean, string, boolean]> = [
    ["記録しない経路（映し・realFile）はそのまま記録しない", false, "file:///ws/new.ts", false],
    ["開く前の列に無かった文書なら記録する", true, "file:///ws/new.ts", true],
    [
      "開く前の列にあった文書（人間のタブの使い回し）なら記録しない",
      true,
      "file:///ws/human.md",
      false,
    ],
    // 渡した綴りは `a b.ts`（空白のまま）でも、VS Code が開いた文書の URI は正規化された
    // `a%20b.ts`。照らすのは開いた後の URI なので、正規化の違いで使い回しを見落とさない。
    [
      "渡した綴りと開いた文書の URI が正規化で違っても、開いた文書の URI で照らす",
      true,
      "file:///ws/a%20b.ts",
      false,
    ],
  ];
  let evaluated = 0;
  for (const [label, record, openedUri, expected] of CASES) {
    it(label, () => {
      evaluated += 1;
      expect(recordsOpenedTab(record, before, openedUri)).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
  });
});
