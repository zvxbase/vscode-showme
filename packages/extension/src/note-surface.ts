import * as vscode from "vscode";
import type { NoteSurface } from "./handlers/show-note.js";
import type { LastWrite, ObservedDocument } from "./note-target.js";
import type { Stage, StageColumnSettings } from "./stage.js";

/**
 * メモを開く面。**`vscode` の値に触るのはここだけ**（判断は `note-target.ts`）。
 *
 * `openTextDocument({ content, language })` は `untitled:Untitled-N` を作り、
 * `associatedResource` が false なので**保存時に必ずパスを尋ねる**。
 * `untitled:<path>` 形式は使わない（設計書 §4.3）。
 */
export function createNoteSurface(
  stage: Stage,
  columnSettings: () => StageColumnSettings,
): NoteSurface {
  let document: vscode.TextDocument | undefined;

  const observe = (): ObservedDocument | undefined => {
    const current = document;
    if (current === undefined) return undefined;
    return {
      uri: current.uri.toString(),
      version: current.version,
      isClosed: current.isClosed,
    };
  };

  /**
   * メモを開く列。**書く前に決める** ―― 置ける列が無ければ `targetColumn` が `no-stage-column` で
   * 断る（D90）。書いてから断ると、見えない名前なしの文書が残り、次の呼び出しがそれを
   * 「人間が触っていない」と見て使い回す。設定は1回の要求につき1回だけ読む。
   */
  const column = (): vscode.ViewColumn =>
    stage.targetColumn({ layout: "single", slot: 0 }, columnSettings());

  const show = async (doc: vscode.TextDocument, viewColumn: vscode.ViewColumn): Promise<void> => {
    await vscode.window.showTextDocument(doc, {
      viewColumn,
      // 人間のタイピング先を取らない。
      preserveFocus: true,
      preview: false,
    });
  };

  return {
    observe,

    async openNew(text, language) {
      const viewColumn = column();
      const created = await vscode.workspace.openTextDocument({ content: text, language });
      document = created;
      await show(created, viewColumn);
      // **書き終えた直後の version を控える。** ここが「人間が触ったか」の基準点になる。
      return { uri: created.uri.toString(), version: created.version };
    },

    async replace(text) {
      const current = document;
      if (current === undefined) throw new Error("there is no note to replace");
      const viewColumn = column();
      const edit = new vscode.WorkspaceEdit();
      const whole = new vscode.Range(
        current.positionAt(0),
        current.positionAt(current.getText().length),
      );
      edit.replace(current.uri, whole, text);
      await vscode.workspace.applyEdit(edit);
      await show(current, viewColumn);
      return { uri: current.uri.toString(), version: current.version };
    },
  };
}
