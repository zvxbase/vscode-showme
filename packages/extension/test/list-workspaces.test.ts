import {
  DEFAULT_PANEL_LIMIT,
  type PanelLimit,
  listWorkspacesResultSchema,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it, vi } from "vitest";
import type { ShowMeConfig } from "../src/config.js";
import { handleListWorkspaces } from "../src/handlers/list-workspaces.js";

/**
 * `list_workspaces` は設定を**写すだけ**（D56 / D74 / 増分6.2 D80）。ここでは `vscode` を偽物にして、
 * `config` から結果への写しを見る。値は `readConfig()`（`trusted()` 経由）から来るので、
 * ワークスペース値が載らないことは `config.test.ts` の `pickTrustedValue` が持つ。
 */
vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ name: "alpha", uri: { fsPath: "/w/alpha" } }],
    isTrusted: true,
  },
}));

function config(over: Partial<ShowMeConfig> = {}): ShowMeConfig {
  return {
    enabled: true,
    features: { stage: true, html: true, layout: true },
    editorGroup: "dedicated",
    avoidToolColumns: false,
    html: { maxPanels: DEFAULT_PANEL_LIMIT },
    redactedPathPatterns: [],
    maxSelectionChars: 4000,
    injectTerminalEnv: true,
    listAllWorkspaces: false,
    layout: { closeHumanTabs: false, closeDirtyTabs: false },
    ...over,
  };
}

describe("handleListWorkspaces", () => {
  it("結果は線上のスキーマを通り、panels.max に設定の既定（2）が写る（D80）", () => {
    const result = handleListWorkspaces(config());
    const parsed = listWorkspacesResultSchema.safeParse(result);
    expect(parsed.success, JSON.stringify(result)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.panels).toEqual({ max: 2 });
    expect(parsed.data.boundWorkspace).toEqual({ name: "alpha", path: "/w/alpha" });
  });

  /** 表: 設定の値がそのまま `panels.max` になる（丸めない・変換しない）。 */
  for (const max of [1, 3, 5, 999, "unlimited"] as PanelLimit[]) {
    it(`showme.html.maxPanels = ${String(max)} → panels.max = ${String(max)}`, () => {
      const result = handleListWorkspaces(config({ html: { maxPanels: max } }));
      expect(result.panels).toEqual({ max });
      expect(listWorkspacesResultSchema.safeParse(result).success).toBe(true);
    });
  }

  /** `showme.stage.avoidToolColumns`（D90）もそのまま写す。 */
  for (const avoidToolColumns of [false, true]) {
    it(`showme.stage.avoidToolColumns = ${String(avoidToolColumns)} → avoidToolColumns = ${String(avoidToolColumns)}`, () => {
      const result = handleListWorkspaces(config({ avoidToolColumns }));
      const parsed = listWorkspacesResultSchema.safeParse(result);
      expect(parsed.success, JSON.stringify(result)).toBe(true);
      if (parsed.success) expect(parsed.data.avoidToolColumns).toBe(avoidToolColumns);
    });
  }

  it("panels は max だけを持つ（開いている枚数などの観測は載せない ―― 観測は get_editor_state の仕事）", () => {
    const result = handleListWorkspaces(config());
    expect(Object.keys(result.panels as object)).toEqual(["max"]);
  });
});
