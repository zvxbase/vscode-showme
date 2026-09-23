import { type ViewAction, viewActionNeedsPath } from "@zvx/vscode-showme-protocol";
import { ToolError } from "../tool-error.js";

/**
 * `show_view`（設計 D36）。
 *
 * 人間が隣で説明するときにやること ―― エクスプローラでその場所を示す、
 * 集中させるために閉じる、構造を見せるために開く、パネルを畳む。
 * **見せるための画面操作であって、編集ではない。**
 *
 * ## 任意のコマンド名を受け取らない
 *
 * VS Code のコマンドを名前で受け取ると `executeCommand` を線の向こうに開くことになり、
 * **この道具の境界そのものが消える**（ファイルの作成も削除も設定の変更も、全部コマンド）。
 * 語彙は `VIEW_ACTIONS` に閉じてあり、そこから実際のコマンド名への対応づけは
 * **この層だけが持つ**。
 */

/** 画面に触る面。`vscode` に触る実装は `view-surface.ts` にある。 */
export interface ViewSurface {
  revealInExplorer(relPath: string): Promise<boolean>;
  /**
   * パスの要らない操作を1つ行う。
   *
   * **操作ごとにメソッドを生やさない。** 生やすと語彙を足すたびに
   * インタフェース・実装・ハンドラの switch の3箇所を直すことになり、
   * どれか1つを忘れると**黙って何もしない**操作ができる。
   * 対応表1つに寄せれば、足し忘れは `Record` の網羅で型が落とす。
   *
   * `reveal-in-explorer` だけは別のまま ―― パスを取り、共通の関門
   * （`workspace-path-gate.ts`）を通さなければならないからである。
   */
  perform(action: Exclude<ViewAction, "reveal-in-explorer">): Promise<boolean>;
}

export interface ShowViewArgs {
  action: ViewAction;
  path?: string;
}

export interface ShowViewDeps {
  view: ViewSurface;
  allowCall?: () => boolean;
  log: { info: (message: string, fields?: Record<string, string>) => void };
}

export async function handleShowView(
  args: ShowViewArgs,
  deps: ShowViewDeps,
): Promise<{ done: boolean }> {
  if (deps.allowCall !== undefined && !deps.allowCall()) {
    throw new ToolError("rate-limited", "Too many show_view calls");
  }

  if (viewActionNeedsPath(args.action)) {
    if (args.path === undefined) {
      throw new ToolError("invalid-request", `${args.action} requires path`);
    }
    // **パスの判断は面が持つ**（`workspace-path-gate.ts` の共通の関門）。
    //
    // 以前ここには「他のツールと同じ関数で正規化する（不変条件14）」と書いてあったが、
    // **実際には部分集合（綴りの正規化）しか通していなかった** ―― realpath も
    // 除外判定も無く、`.env` をツリーに出せた。コメントが事実と違っていた。
    // 面がまとめて判断する形にして、ここでは何も決めない。
    const done = await deps.view.revealInExplorer(args.path);
    deps.log.info("show_view", { action: args.action, done: String(done) });
    return { done };
  }

  const done = await runWithoutPath(args.action, deps.view);
  deps.log.info("show_view", { action: args.action, done: String(done) });
  return { done };
}

function runWithoutPath(action: ViewAction, view: ViewSurface): Promise<boolean> {
  // `reveal-in-explorer` は上で処理済み。ここで弾いておくと、残りは
  // **対応表が網羅している型**になる ―― 語彙を足したら対応表が型で落ちる。
  if (action === "reveal-in-explorer") return Promise.resolve(false);
  return view.perform(action);
}
