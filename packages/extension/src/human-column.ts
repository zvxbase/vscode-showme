import type { EditorGroup } from "./config.js";

/**
 * 人間の列を舞台に使ってよいか（D93 / D94）。判断ロジックのみ、vscode 非依存。
 *
 * - `shared`: 常に使える。右に既存の列があればそちらが先なので、人間の列を使うのは
 *   「使わなければ列を増やすことになるとき」だけである（順序は `stage-column.ts` の
 *   `chooseStageColumns` が決める）
 * - `dedicated`: 人間の列に own でないタブ（人間のタブ）が1枚も無いときだけ使える。
 *   空の列だけでなく、エージェントのタブだけの列も含める ―― 空の列に1回開いた直後、
 *   その列はエージェントのタブだけの列になる。「空なら使う」だけにすると、2回目で結局
 *   列を増やす。own の判定は `isOwnTab`（呼び出し側が数えて渡す）
 *
 * `active` はこの判断を通らない（常に人間の列に開き、`layout` と枠を見ない）ので、引数の型が
 * 受けない。
 */
export type HumanColumnEditorGroup = Exclude<EditorGroup, "active">;

export function humanColumnUsable(
  editorGroup: HumanColumnEditorGroup,
  hasHumanTabs: boolean,
): boolean {
  return editorGroup === "shared" || !hasHumanTabs;
}

/**
 * 人間の列を使うか ―― **開く（`Stage.targetColumn`）も集める・動かす（`arrange_editors`）も
 * これ1つを呼ぶ**（不変条件14）。片方だけが D94 を知っていると、開けるのに動かせない
 * （あるいはその逆）列ができる。
 *
 * `active` は常に人間の列（列を分けない設定）なので真。それ以外は `humanColumnUsable`。
 * `hasHumanTabs` は人間の列に own でないタブがあるか（`editor-surface.ts` の
 * `humanColumnHasHumanTabs`。own の判定は `isOwnTab`）。
 */
export function useHumanColumnFor(editorGroup: EditorGroup, hasHumanTabs: boolean): boolean {
  if (editorGroup === "active") return true;
  return humanColumnUsable(editorGroup, hasHumanTabs);
}
