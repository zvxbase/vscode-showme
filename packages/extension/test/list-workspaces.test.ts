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
    redaction: { patterns: [], blockLinksToRedacted: true },
    maxSelectionChars: 4000,
    injectTerminalEnv: true,
    listAllWorkspaces: false,
    layout: { closeHumanTabs: false, closeDirtyTabs: false, protectViewingTab: false },
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

  /** `showme.stage.editorGroup`（D93。3値）もそのまま写す。 */
  for (const editorGroup of ["shared", "dedicated", "active"] as const) {
    it(`showme.stage.editorGroup = ${editorGroup} → editorGroup = ${editorGroup}`, () => {
      const result = handleListWorkspaces(config({ editorGroup }));
      const parsed = listWorkspacesResultSchema.safeParse(result);
      expect(parsed.success, JSON.stringify(result)).toBe(true);
      if (parsed.success) expect(parsed.data.editorGroup).toBe(editorGroup);
    });
  }

  /**
   * `showme.layout.*` の3つの許可もそのまま写す（D56 / D92）。`arrange_editors` が判断に使うのと
   * 同じ `config.layout` から写すので、申告と実際の判断がずれない。1つずつ立てて、
   * 他の2つに漏れないことも見る（写し間違いで別の欄に載るのを捕まえる）。
   */
  for (const key of ["closeHumanTabs", "closeDirtyTabs", "protectViewingTab"] as const) {
    it(`showme.layout.${key} = true → permissions.${key} = true（他は false のまま）`, () => {
      const layout = { closeHumanTabs: false, closeDirtyTabs: false, protectViewingTab: false };
      const result = handleListWorkspaces(config({ layout: { ...layout, [key]: true } }));
      const parsed = listWorkspacesResultSchema.safeParse(result);
      expect(parsed.success, JSON.stringify(result)).toBe(true);
      if (parsed.success) expect(parsed.data.permissions).toEqual({ ...layout, [key]: true });
    });
  }

  it("panels は max だけを持つ（開いている枚数などの観測は載せない ―― 観測は get_editor_state の仕事）", () => {
    const result = handleListWorkspaces(config());
    expect(Object.keys(result.panels as object)).toEqual(["max"]);
  });
});

describe("outsideWorkspace（D101）", () => {
  it("関門が見るのと同じ config.redaction.allowOutsideWorkspace を写す（省略は false）", () => {
    expect(handleListWorkspaces(config()).outsideWorkspace).toBe(false);
    const on = handleListWorkspaces(
      config({
        redaction: { patterns: [], blockLinksToRedacted: true, allowOutsideWorkspace: true },
      }),
    );
    expect(on.outsideWorkspace).toBe(true);
    expect(listWorkspacesResultSchema.safeParse(on).success).toBe(true);
  });
});
