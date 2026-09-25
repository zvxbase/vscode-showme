import * as vscode from "vscode";
import { observedViewColumn } from "./editor-observation.js";
import { ownPanelSlot } from "./editor-surface.js";
import { type ActiveTabInput, toolColumnsOf } from "./tool-column.js";

/**
 * タブの入力の**型**を `ActiveTabInput` に写す（vscode に触る薄い層。判断は `tool-column.ts`）。
 *
 * 映しのタブ（`showme-ro:` / `showme-rw:`）も人間の `file:` タブも `TabInputText` なので `"text"`
 * ―― スキームは見ない。ShowMe のパネルかどうかは `ownPanelSlot`（所有と枠の判定と同じ1つの表）で
 * 決め、ここで `viewType` を読み直さない（不変条件14）。
 */
export function activeTabInput(tab: vscode.Tab): ActiveTabInput {
  const input: unknown = tab.input;
  if (input instanceof vscode.TabInputText) return "text";
  if (input instanceof vscode.TabInputTextDiff) return "text-diff";
  if (input instanceof vscode.TabInputNotebook) return "notebook";
  if (input instanceof vscode.TabInputNotebookDiff) return "notebook-diff";
  if (input instanceof vscode.TabInputCustom) return "custom";
  if (input instanceof vscode.TabInputWebview) {
    return ownPanelSlot(tab) === undefined ? "foreign-panel" : "own-panel";
  }
  if (input instanceof vscode.TabInputTerminal) return "terminal";
  return "unknown";
}

/**
 * いまの窓の道具の列（D90）。**呼ばれるたびに観測する**（列は位置番号で、人間がグループを
 * 閉じるとずれる。設計書 Y7）。列番号の読み方は `observedViewColumn`（`get_editor_state` の
 * `groups` と同じ）。
 */
export function observeToolColumns(
  groups: readonly vscode.TabGroup[] = vscode.window.tabGroups.all,
): ReadonlySet<number> {
  return toolColumnsOf(
    groups.map((group) => ({
      column: observedViewColumn(group.viewColumn),
      active: group.activeTab === undefined ? undefined : activeTabInput(group.activeTab),
    })),
  );
}
