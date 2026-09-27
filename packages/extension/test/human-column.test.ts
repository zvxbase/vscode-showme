import { describe, expect, it } from "vitest";
import type { EditorGroup } from "../src/config.js";
import {
  type HumanColumnEditorGroup,
  humanColumnUsable,
  useHumanColumnFor,
} from "../src/human-column.js";

/**
 * 人間の列を舞台に使ってよいか（D93 / D94）。`shared` なら常に使える。`dedicated` でも、
 * 人間の列に own でないタブ（人間のタブ）が1枚も無ければ使える ―― 空の列と、エージェントの
 * タブだけの列。`active` はこの判断を通らない（常に人間の列に開く）ので、引数の型が受けない
 * （検査の対象は型の定義。テストは tsc を通らないので、ここで `active` を渡す行は書かない）。
 */
describe("humanColumnUsable（D93 / D94）", () => {
  const CASES: ReadonlyArray<readonly [HumanColumnEditorGroup, boolean, boolean]> = [
    ["shared", false, true], // 人間のタブが無い列
    ["shared", true, true], // 人間のタブがあっても shared は使う
    ["dedicated", false, true], // 空、またはエージェントのタブだけの列（D94）
    ["dedicated", true, false], // 人間のタブがある列は dedicated では使わない（以前どおり）
  ];
  let evaluated = 0;
  for (const [editorGroup, hasHumanTabs, expected] of CASES) {
    it(`${editorGroup} 人間のタブ=${hasHumanTabs} → ${expected}`, () => {
      evaluated += 1;
      expect(humanColumnUsable(editorGroup, hasHumanTabs)).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(4);
  });
});

/**
 * 開く（`Stage.targetColumn`）と集める・動かす（`arrange_editors`）が呼ぶ入口（不変条件14）。
 * `active` は常に人間の列（そもそも列を分けない）。それ以外は `humanColumnUsable` の答え。
 */
describe("useHumanColumnFor（D93 / D94）", () => {
  const CASES: ReadonlyArray<readonly [EditorGroup, boolean, boolean]> = [
    ["shared", false, true],
    ["shared", true, true],
    ["dedicated", false, true],
    ["dedicated", true, false],
    ["active", false, true],
    ["active", true, true],
  ];
  let evaluated = 0;
  for (const [editorGroup, hasHumanTabs, expected] of CASES) {
    it(`${editorGroup} 人間のタブ=${hasHumanTabs} → ${expected}`, () => {
      evaluated += 1;
      expect(useHumanColumnFor(editorGroup, hasHumanTabs)).toBe(expected);
    });
  }
  it("表の全行を評価した", () => {
    expect(evaluated).toBe(CASES.length);
    expect(CASES.length).toBe(6);
  });
});
