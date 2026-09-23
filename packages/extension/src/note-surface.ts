import * as vscode from "vscode";
import type { NoteSurface } from "./handlers/show-note.js";
import type { LastWrite, ObservedDocument } from "./note-target.js";
import type { Stage } from "./stage.js";

/**
 * メモを開く面。**`vscode` の値に触るのはここだけ**（判断は `note-target.ts`）。
 *
 * `openTextDocument({ content, language })` は `untitled:Untitled-N` を作り、
 * `associatedResource` が false なので**保存時に必ずパスを尋ねる**。
 * `untitled:<path>` 形式は使わない（設計書 §4.3）。
 */
export function createNoteSurface(stage: Stage): NoteSurface {
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

  const show = async (doc: vscode.TextDocument): Promise<void> => {
    await vscode.window.showTextDocument(doc, {
      viewColumn: stage.targetColumn({ layout: "single", slot: 0 }),
      // 人間のタイピング先を取らない。
      preserveFocus: true,
      preview: false,
    });
  };

  return {
    observe,

    async openNew(text, language) {
      const created = await vscode.workspace.openTextDocument({ content: text, language });
      document = created;
      await show(created);
      // **書き終えた直後の version を控える。** ここが「人間が触ったか」の基準点になる。
      return { uri: created.uri.toString(), version: created.version };
    },

    async replace(text) {
      const current = document;
      if (current === undefined) throw new Error("there is no note to replace");
      const edit = new vscode.WorkspaceEdit();
      const whole = new vscode.Range(
        current.positionAt(0),
        current.positionAt(current.getText().length),
      );
      edit.replace(current.uri, whole, text);
      await vscode.workspace.applyEdit(edit);
      await show(current);
      return { uri: current.uri.toString(), version: current.version };
    },
  };
}
