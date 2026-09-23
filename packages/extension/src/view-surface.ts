import type { ViewAction } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { ViewSurface } from "./handlers/show-view.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/**
 * 操作名 → VS Code のコマンド名（設計 D36/D44）。
 *
 * **コマンド名はここにしか現れない。** エージェントが渡すのは閉じた語彙の
 * 操作名であって、コマンド名ではない。対応づけをこの層に閉じ込めることで、
 * 「任意のコマンドを実行できる」経路が構造的に存在しなくなる。
 *
 * `Record<Exclude<ViewAction, "reveal-in-explorer">, string>` にしてあるので、
 * 語彙に操作を足すとここが型で落ちる（**足し忘れが黙って何もしないのを防ぐ**）。
 *
 * **`workbench.action.terminal.*` の新規作成・破棄はここに無い**（設計 D45）。
 * 端末を起こす・殺す道具は語彙にも対応表にも入らない。パネルを開いた結果
 * 端末 UI が手前に出るのは許容する ―― そこに何があるかは人間の設定の結果である。
 *
 * **当てずっぽうの名前を置かないこと。** コマンド ID は VS Code の版で変わる。
 * 無い名前を置くと `run()` が例外を飲んで `done: false` を返し、エージェントには
 * 「そのビューが無い」と区別がつかない。実測で `workbench.panel.comments.focus`
 * は**実機に無く**（`workbench.action.focusCommentsPanel` が本物だった）、
 * 統合テストの「対応表のコマンドが実機に存在する」がそれを捕まえている。
 */
const COMMAND_BY_ACTION: Record<Exclude<ViewAction, "reveal-in-explorer">, string> = {
  "show-explorer": "workbench.view.explorer",
  "show-search": "workbench.view.search",
  "show-scm": "workbench.view.scm",
  "show-debug": "workbench.view.debug",
  "show-extensions": "workbench.view.extensions",
  "hide-sidebar": "workbench.action.closeSidebar",
  "toggle-sidebar": "workbench.action.toggleSidebarVisibility",
  "show-panel": "workbench.action.focusPanel",
  "hide-panel": "workbench.action.closePanel",
  "toggle-panel": "workbench.action.togglePanel",
  "toggle-maximized-panel": "workbench.action.toggleMaximizedPanel",
  "show-problems": "workbench.panel.markers.view.focus",
  // **`toggleOutput` ではない。** 語彙は `show-output`（出す）であって
  // 切り替えではない ―― toggle を割り当てると2回目で OUTPUT が消える。
  // `show-problems` / `show-comments` と同じく焦点を移すコマンドを使う。
  "show-output": "workbench.panel.output.focus",
  "show-comments": "workbench.action.focusCommentsPanel",
  "toggle-auxiliary-bar": "workbench.action.toggleAuxiliaryBar",
  "toggle-zen-mode": "workbench.action.toggleZenMode",
  "toggle-activity-bar": "workbench.action.toggleActivityBarVisibility",
  "toggle-status-bar": "workbench.action.toggleStatusbarVisibility",
};

/** 対応表の値。**統合テストが実機に存在することを確かめる**（設計 D44）。 */
export const VIEW_COMMANDS: readonly string[] = Object.values(COMMAND_BY_ACTION);

/**
 * 画面に触る面。**`vscode` の値に触るのはここだけ**（判断は `handlers/show-view.ts`）。
 */
export function createViewSurface(
  workspaceRoot: vscode.Uri | undefined,
  extraRedactedPatterns: () => readonly string[],
): ViewSurface {
  const run = async (command: string, ...args: unknown[]): Promise<boolean> => {
    try {
      await vscode.commands.executeCommand(command, ...args);
      return true;
    } catch {
      // 画面の操作は失敗しても本質的な障害ではない（そのビューが無いだけのことがある）。
      // **理由は返さない** ―― 画面の状態をエージェントに教える必要が無い。
      return false;
    }
  };

  return {
    async revealInExplorer(relPath) {
      // **共通の関門を通す。** ここは以前、綴りの正規化しか通していなかった
      // （呼び出し側が `normalizeWorkspaceRelative` だけを当てていた）ので、
      // `.env` をツリーに出せたし、ワークスペースの中に置かれた外向きの
      // シンボリックリンクも通った。**同じ境界を別の方法で決めていた**
      // ―― 不変条件14 の、この repo で4箇所目である。
      //
      // 実体パスで示す。正準名をルートに再結合すると、その綴りのリンクを
      // 辿り直すことになる。
      const accepted = acceptWorkspacePath(workspaceRoot?.fsPath, relPath, extraRedactedPatterns());
      if (!accepted.ok) return false;
      return run("revealInExplorer", vscode.Uri.file(accepted.realPath));
    },
    perform(action) {
      return run(COMMAND_BY_ACTION[action]);
    },
  };
}
