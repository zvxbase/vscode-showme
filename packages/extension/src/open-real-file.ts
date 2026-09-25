import * as vscode from "vscode";
import { readConfig } from "./config.js";
import { revealForHuman } from "./human-reveal.js";
import { lineToCarry } from "./real-file-line.js";
import { relOfStageUri, stageUriFor } from "./stage-uri-vscode.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/**
 * 人間のボタン「本物のファイルを開く」（D87。コマンド `showme.openRealFile`）。
 *
 * 映しのタブ（`showme-ro:` / `showme-rw:`）の編集器タイトルから、同じファイルを `file:` で、
 * 今見ている位置の行（`lineToCarry`）のまま開く。
 *
 * - **どの編集器か**: `editor/title` のボタンは、その編集器の資源の URI を引数に渡す。
 *   パレットやキーバインドからは引数が無いので、前面の編集器（`activeTextEditor`）。
 *   引数の URI は見えている編集器から探す（前面の編集器を優先する ―― 同じ映しが2つの列に
 *   見えているときは、人間が今いる方の位置を持っていく）
 * - **関門**: rel は `acceptWorkspacePath` を通す（秘匿・外・不在なら何もしない）
 * - **映しでなければ何もしない**（`relOfStageUri` が undefined）。`executeCommand` は誰でも
 *   任意の値で呼べるので、形の違う引数も黙って無視する（投げない: ボタン経由では起きない）
 * - **開くのは人間の規則**（`revealForHuman`、D79）。見えていればそこ、無ければ人間の今の列、
 *   フォーカスも移す。**何も記録しない**ので、開いた `file:` のタブは own にならない（人間の
 *   タブ）。映しの own はスキームで決まる（D82）ので、映しは own のまま
 * - **役割・`showme.enabled`・舞台の設定には縛られない**（§C5: 設定が縛るのはエージェントで
 *   あって人間ではない。Clear highlights と同じ）。制限モードでも同じ
 *
 * URI は `relOfStageUri` / `stageUriFor` だけで組む（不変条件14）。
 */
export async function openRealFile(arg: unknown): Promise<void> {
  const source = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (source === undefined) return;
  const rel = relOfStageUri(source);
  if (rel === undefined) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root === undefined) return;
  // 多重の守り: 映しの URI は `executeCommand` で誰でも組めるので（例えば `showme-ro:/.env`）、
  // 映しの読み出しと同じ1つの関門（`acceptWorkspacePath`。秘匿・外への脱出・不在）を通す。
  // 落ちたら理由を問わず何もしない。開くのは綴りの rel のまま（映しと同じ綴り。canonical に
  // 直さない ―― 人間が映しで見ていたのと同じ URI の file: を開く）。
  if (!acceptWorkspacePath(root.fsPath, rel, readConfig().redactedPathPatterns).ok) return;

  const key = source.toString();
  const active = vscode.window.activeTextEditor;
  const editor =
    active?.document.uri.toString() === key
      ? active
      : vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  const line =
    editor === undefined
      ? 0
      : lineToCarry({
          cursorLine: editor.selection.active.line,
          visible: editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line })),
        });
  await revealForHuman(stageUriFor(root, rel, "file"), line);
}
