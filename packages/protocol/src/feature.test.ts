import { describe, expect, it } from "vitest";
import { FEATURES, FEATURE_OF_TOOL, disabledToolsFor } from "./feature.js";
import { TOOL_NAMES } from "./tools.js";

const allOn = { stage: true, html: true, layout: true } as const;

describe("FEATURE_OF_TOOL（増分6 D75: 機能→ツールの表は1つ）", () => {
  it("機能は stage / html / layout の3つ", () => {
    expect([...FEATURES]).toEqual(["stage", "html", "layout"]);
  });

  it("TOOL_NAMES の全部に行があり、余分な行が無い（型だけでなく値で言う）", () => {
    // `Record<ToolName, …>` は型で閉じているが、ツールを足した人が `as` で
    // 逃げると値の側で穴が開く。語彙と突き合わせる。
    expect(Object.keys(FEATURE_OF_TOOL).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("行の値は core か FEATURES のどれか", () => {
    for (const [tool, feature] of Object.entries(FEATURE_OF_TOOL)) {
      expect(
        feature === "core" || (FEATURES as readonly string[]).includes(feature),
        `${tool} の機能 ${String(feature)} が語彙に無い`,
      ).toBe(true);
    }
  });

  it("核（切れないもの）: 注釈・読み取り4つ・show_code", () => {
    // `show_code` は core: 印は常に出せる。開く部分だけを stage が縛る（D76）。
    for (const tool of [
      "annotate",
      "get_editor_state",
      "list_workspaces",
      "find_definition",
      "find_references",
      "show_code",
    ] as const) {
      expect(FEATURE_OF_TOOL[tool], tool).toBe("core");
    }
  });

  it("stage は show_note、html は show_html、layout は arrange_editors と show_view", () => {
    expect(FEATURE_OF_TOOL.show_note).toBe("stage");
    expect(FEATURE_OF_TOOL.show_html).toBe("html");
    expect(FEATURE_OF_TOOL.arrange_editors).toBe("layout");
    expect(FEATURE_OF_TOOL.show_view).toBe("layout");
  });
});

describe("disabledToolsFor（list_workspaces.disabledTools の導出元）", () => {
  it("全部 on なら空", () => {
    expect(disabledToolsFor(allOn)).toEqual([]);
  });

  it("stage を切ると show_note だけ", () => {
    expect(disabledToolsFor({ ...allOn, stage: false })).toEqual(["show_note"]);
  });

  it("html を切ると show_html だけ", () => {
    expect(disabledToolsFor({ ...allOn, html: false })).toEqual(["show_html"]);
  });

  it("layout を切ると arrange_editors と show_view（TOOL_NAMES の順）", () => {
    expect(disabledToolsFor({ ...allOn, layout: false })).toEqual(["show_view", "arrange_editors"]);
    expect(TOOL_NAMES.indexOf("show_view")).toBeLessThan(TOOL_NAMES.indexOf("arrange_editors"));
  });

  it("全部切っても核の6つは残る（切れない）", () => {
    const off = disabledToolsFor({ stage: false, html: false, layout: false });
    expect(off).toEqual(["show_html", "show_note", "show_view", "arrange_editors"]);
    for (const tool of TOOL_NAMES) {
      expect(off.includes(tool), tool).toBe(FEATURE_OF_TOOL[tool] !== "core");
    }
  });

  it("表の全組み合わせ: 切った機能のツールだけが、TOOL_NAMES の順で並ぶ", () => {
    for (const stage of [true, false]) {
      for (const html of [true, false]) {
        for (const layout of [true, false]) {
          const features = { stage, html, layout };
          const want = TOOL_NAMES.filter((t) => {
            const f = FEATURE_OF_TOOL[t];
            return f !== "core" && !features[f];
          });
          expect(disabledToolsFor(features), JSON.stringify(features)).toEqual(want);
        }
      }
    }
  });
});
