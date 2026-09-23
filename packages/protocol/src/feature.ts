import { TOOL_NAMES, type ToolName } from "./tools.js";

/**
 * 人間が切れる機能（増分6 §C4 / D74）。
 *
 * 人間が思うのは「レイアウトは触るな」であって「`arrange_editors` と `show_view` を
 * 切る」ではない。設定はこの3つの粒度で、ツール名の配列は持たない
 * （`showme.tools.disabled` は消した。同じ量を2つの設定で決めない）。
 *
 * - `stage`: タブを開く・スクロールする・列を割る（`show_code` の開く部分、`show_note`）
 * - `html`: webview を出す（`show_html`）
 * - `layout`: 画面を組み替える・タブを閉じる・眺めを切り替える（`arrange_editors`、`show_view`）
 *
 * 核（注釈・読み取り・`show_code` の印）は切れない。
 */
export const FEATURES = ["stage", "html", "layout"] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * 機能→ツールの表。**この1つだけ**（D75）。
 *
 * 関門（拡張の `tool-gate.ts`）が「呼ばれたツールは切られているか」を、
 * `list_workspaces` が「切られているツールを列挙する」を、どちらもこの表から
 * 読む。2つの面が別々に表を持つと、片方だけ更新されたときに「一覧には載って
 * いないのに断られる」（あるいはその逆）が起きる（不変条件14）。
 *
 * `show_code` は core: 印（`spotlight` への登録）は常に出せる。開く・スクロールする
 * 部分だけを `stage` が縛る（D76）。
 */
export const FEATURE_OF_TOOL: Record<ToolName, Feature | "core"> = {
  annotate: "core",
  get_editor_state: "core",
  list_workspaces: "core",
  find_definition: "core",
  find_references: "core",
  show_code: "core",
  show_note: "stage",
  show_html: "html",
  arrange_editors: "layout",
  show_view: "layout",
};

/**
 * 切られている機能に属するツール（`TOOL_NAMES` の順）。
 *
 * `list_workspaces.disabledTools` はこれを写すだけ。設定の値を直接読んで
 * 並べ直さない ―― 語彙の順に揃うので、設定ファイルの並びも綴りも線に出ない。
 */
export function disabledToolsFor(features: Readonly<Record<Feature, boolean>>): ToolName[] {
  return TOOL_NAMES.filter((tool) => {
    const feature = FEATURE_OF_TOOL[tool];
    return feature !== "core" && !features[feature];
  });
}
