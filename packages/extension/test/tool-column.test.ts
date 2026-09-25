import { describe, expect, it } from "vitest";
import { type ActiveTabInput, isToolInput, toolColumnsOf } from "../src/tool-column.js";

/**
 * 道具の列（D90）。判断は**表示中のタブの入力の型**だけで決める。「own でない」では決めない ――
 * 人間の `file:` タブは own でないが道具ではない（`showme.stage.avoidToolColumns` の対象外）。
 */
describe("isToolInput（入力の型 → 道具か）", () => {
  const table: [ActiveTabInput, boolean, string][] = [
    ["terminal", true, "terminal in the editor area"],
    ["foreign-panel", true, "another extension's webview (Claude Code, Copilot, ...)"],
    ["unknown", true, "an input type we do not recognise (chat editors, ...)"],
    ["text", false, "a text tab (the human's file: tab and the agent's mirror alike)"],
    ["text-diff", false, "a diff"],
    ["notebook", false, "a notebook"],
    ["notebook-diff", false, "a notebook diff"],
    ["custom", false, "a custom editor (it edits a document)"],
    ["own-panel", false, "ShowMe's own show_html panel"],
  ];

  for (const [input, expected, why] of table) {
    it(`${input} → ${String(expected)} (${why})`, () => {
      expect(isToolInput(input)).toBe(expected);
    });
  }
});

describe("toolColumnsOf（列ごとの表示中のタブ → 避ける列の集合）", () => {
  it("表示中のタブが道具の列だけを集める", () => {
    const set = toolColumnsOf([
      { column: 1, active: "text" },
      { column: 2, active: "terminal" },
      { column: 3, active: "own-panel" },
      { column: 4, active: "foreign-panel" },
      { column: 5, active: "custom" },
      { column: 6, active: "unknown" },
    ]);
    expect([...set].sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  it("空の列（表示中のタブが無い）と列番号が読めない列は入れない", () => {
    const set = toolColumnsOf([
      { column: 2, active: undefined },
      { column: undefined, active: "terminal" },
    ]);
    expect(set.size).toBe(0);
  });
});
