/**
 * 道具の列（D90。`showme.stage.avoidToolColumns`）。判断ロジックのみ、vscode 非依存。
 *
 * 列の**表示中のタブ**の入力の型で決める。vscode の型を読む薄い層は `tool-column-vscode.ts`。
 *
 * **「own でない」では決めない。** 人間の `file:` タブは own でないが、人間が読み書きしている
 * 文書であって道具ではない ―― 「本物のファイルを開く」（D87）も人間の `file:` タブを舞台の列に
 * 置く。避けたいのは、ターミナルや他の拡張のパネル（Claude Code・Copilot などのエージェントの
 * 画面を含む）に被せて開くこと。
 *
 * **エージェントの拡張の ID を列挙しない**（列挙すると新しいものが漏れる。設計 D90）。
 * 「ShowMe のものでない webview」と「型の分からない入力」をまとめて道具とみなす。
 */

/** 表示中のタブの入力の種類。`tool-column-vscode.ts` の `activeTabInput` が `Tab.input` から付ける。 */
export type ActiveTabInput =
  | "text"
  | "text-diff"
  | "notebook"
  | "notebook-diff"
  | "custom"
  /** ShowMe 自身の `show_html` のパネル（`ownPanelSlot` がある webview）。 */
  | "own-panel"
  /** ShowMe のものでない webview（他の拡張のパネル）。 */
  | "foreign-panel"
  | "terminal"
  /** 型の分からない入力（チャットの編集器など、VS Code が型を公開していないもの）。 */
  | "unknown";

/**
 * その入力を表示している列は道具の列か。
 *
 * 文書（テキスト・差分・ノートブック・カスタム編集器）と ShowMe 自身のパネルは道具でない。
 * 型の分からない入力は道具の側に倒す ―― 分からないものに被せて開くより、1列右に開くほうが
 * 取り返しがつく。
 */
export function isToolInput(input: ActiveTabInput): boolean {
  switch (input) {
    case "terminal":
    case "foreign-panel":
    case "unknown":
      return true;
    case "text":
    case "text-diff":
    case "notebook":
    case "notebook-diff":
    case "custom":
    case "own-panel":
      return false;
  }
}

/** 1列分の観測。`column` は読めた列番号、`active` は表示中のタブの入力（空の列は `undefined`）。 */
export interface ObservedColumn {
  column: number | undefined;
  active: ActiveTabInput | undefined;
}

/** 避ける列の集合。表示中のタブが道具である列の番号。 */
export function toolColumnsOf(columns: readonly ObservedColumn[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const { column, active } of columns) {
    if (column === undefined || active === undefined) continue;
    if (isToolInput(active)) out.add(column);
  }
  return out;
}
