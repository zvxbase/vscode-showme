import * as vscode from "vscode";
import { toRange } from "./line-range-vscode.js";

/**
 * **人間の命令で**ファイルの行を出す（増分6.1 D79 / §C5）。吹き出しの ‹ › が使う。
 *
 * `show_code` の `Stage.open`（`stage.ts`）とは**別の関数**である。舞台の規則 ――
 * 人間の列を避けて列を選ぶ・焦点を奪わない（`preserveFocus`）・own の記録 ―― は**エージェントのため**の
 * 規則で、人間が押した命令には逆に働く（実機: 同じファイルが人間の列に見えていても舞台に
 * もう1枚開いてそちらを動かすので、人間の目には何も起きない。D73 の撤回理由）。
 * 人間の命令は**人間の規則**で開く:
 *
 * - 飛び先の文書が**既に見えているエディタ**があればそこで行を出す（同じ文書を別の列に
 *   もう1枚開かない）
 * - 無ければ**人間の今の列**（`ViewColumn.Active`）に開く
 * - **フォーカスも移す**（人間が押したのだから。`preserveFocus: false`）
 * - **ここは何も記録しない**（`OpenedByAgent` を知らない）。開いたタブの own は URI で決まる:
 *   映し（`showme-ro:` / `showme-rw:`）ならスキームで own（D85。人間が見ている間は床1 が守る）、
 *   `file:` なら own ではない（`close-own` の対象にならず、`get_editor_state` にも `own` は付かない）
 *
 * `selection` には触らない（不変条件3）。人間の命令であっても、`selection` を書けば
 * `get_editor_state` の選択テキストがその範囲になる ―― 位置合わせは `revealRange` だけ。
 * 「見えている」の照合は `uri.toString()`（VS Code の `Uri` は同じ綴りでも別オブジェクト）。
 */
export async function revealForHuman(uri: vscode.Uri, line: number): Promise<void> {
  const key = uri.toString();
  const seen = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  const options: vscode.TextDocumentShowOptions = {
    // グループの外のエディタ（列を持たない）は、人間の今の列に倒す。
    viewColumn: seen?.viewColumn ?? vscode.ViewColumn.Active,
    preserveFocus: false,
    preview: false,
  };
  const editor =
    seen === undefined
      ? await vscode.window.showTextDocument(uri, options)
      : await vscode.window.showTextDocument(seen.document, options);
  editor.revealRange(
    toRange({ startLine: line, endLine: line }),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}
