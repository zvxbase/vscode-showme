import type { ToolName } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { observeActiveTab, observeFrontEditor } from "./editor-surface.js";
import { type FrontObserver, runRecordingFront } from "./tool-call-recorder.js";
import {
  type FrontEditor,
  type ToolCallWindow,
  type ToolShownSelection,
  frontEditorRecord,
} from "./tool-shown-selection.js";
import type { RedactionPolicy } from "./workspace-path-gate.js";

/**
 * ツールが見せた選択（D95）の vscode に触る側。判断は `tool-shown-selection.ts`、包みの手順は
 * `tool-call-recorder.ts` にあり、ここは観測と事象の購読だけを持つ。
 */

/** 前面の観測の実体。ルートは呼ぶたびに読む（多ルートで並びが変わっても食い違わない）。 */
export function vscodeFrontObserver(
  root: () => vscode.Uri | undefined,
  // 外のタブ（D102）の名前の方針。`get_editor_state` が照らす鍵と同じ読み方にする（D95）。
  redaction: () => RedactionPolicy,
): FrontObserver {
  return {
    front: () => observeFrontEditor(root(), redaction()),
    activeTab: observeActiveTab,
    waitForSettled: waitForFrontSettled,
  };
}

/** `runRecordingFront` を vscode の観測で呼ぶ（`extension.ts` の `handle` の包み）。 */
export function recordFrontChanges<T>(
  tool: ToolName,
  dispatch: () => Promise<T>,
  deps: {
    root: () => vscode.Uri | undefined;
    redaction: () => RedactionPolicy;
    toolWindow: ToolCallWindow;
    shown: ToolShownSelection;
    onRecordError(error: unknown): void;
  },
): Promise<T> {
  return runRecordingFront(tool, dispatch, {
    observer: vscodeFrontObserver(deps.root, deps.redaction),
    toolWindow: deps.toolWindow,
    shown: deps.shown,
    onRecordError: deps.onRecordError,
  });
}

/**
 * 前面の変化と選択の変化を購読して、ツールの仕業の前面の選択を記録する（D95）。`activate` で1回だけ
 * 登録し、返した購読は `disposables` に入れる。
 *
 * - 前面の変化（`onDidChangeActiveTextEditor`）: ツールの仕業のもの（`ToolCallWindow.frontChanged`:
 *   呼び出しの最中、または落ち着かないまま終わった呼び出しの後の最初の1回）だけを記録する。それ以外の
 *   窓の尾の変化は人間のクリックで、その時点の選択は復元前の既定値（1:0）である ―― 記録すると
 *   パスごとの正しい記録（呼び出しの後の観測）を復元前の値で上書きし、古い選択が返る（実測: Y を
 *   見せ、Z を見せ、人間がクリックで Y に戻る）
 * - 選択の変化（`onDidChangeTextEditorSelection`）: 最中に前に出た編集器の選択が窓の間に変わったら
 *   記録する（前に出た瞬間の選択は復元前で、復元は後から選択の変化として届く。実測）。窓の外なら
 *   観測もしない
 */
export function registerFrontObservers(
  root: () => vscode.Uri | undefined,
  redaction: () => RedactionPolicy,
  toolWindow: ToolCallWindow,
  shown: ToolShownSelection,
): vscode.Disposable[] {
  const remember = (front: FrontEditor | undefined, byTool: boolean): void => {
    const record = frontEditorRecord(byTool, front);
    if (record !== undefined) shown.remember(record.relPath, record.key);
  };
  return [
    vscode.window.onDidChangeActiveTextEditor(() => {
      const front = observeFrontEditor(root(), redaction());
      remember(front, toolWindow.frontChanged(front?.identity));
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!toolWindow.inWindow()) return;
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      const front = observeFrontEditor(root(), redaction());
      remember(front, front !== undefined && toolWindow.wasFronted(front.identity));
    }),
  ];
}

/**
 * 前面が落ち着く（`settled()` が真になる）のを待つ。前面の編集器・タブ・列の変化の事象のたびに
 * 確かめる。上限までに落ち着けば true、上限で最後にもう一度確かめる。
 *
 * **間隔を置いた見回りはしない。** 落ち着く遷移（`activeTextEditor` が表示中のタブに追いつく）は
 * `onDidChangeActiveTextEditor` を発火し、表示中のタブの変化は `onDidChangeTabs` /
 * `onDidChangeTabGroups` を発火する。どれも発火しない遷移で落ち着くことは無い（実測で待ちは
 * 1〜4 ms で、どれも事象で終わった）。
 */
function waitForFrontSettled(settled: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const subscriptions: vscode.Disposable[] = [];
    let finished = false;
    // 上限は先に仕掛ける（`finish` が触るものは全部この時点で初期化済み。`finish` と `check` は
    // 関数宣言なので巻き上がる）。
    const timer = setTimeout(() => finish(settled()), timeoutMs);
    function finish(value: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const d of subscriptions) d.dispose();
      resolve(value);
    }
    function check(): void {
      if (settled()) finish(true);
    }
    subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(check),
      vscode.window.tabGroups.onDidChangeTabs(check),
      vscode.window.tabGroups.onDidChangeTabGroups(check),
    );
  });
}
