/**
 * 画面の表現（設計 D36）。
 *
 * 人間が隣で説明するときに実際にやること ―― エクスプローラでその場所を開く、
 * 集中させるために閉じる、構造を見せるために開く、パネルを畳む。
 * これは「見せる」の一部であって編集ではないので、リング②に素直に収まる。
 *
 * ## 任意のコマンド名を受け取ってはならない
 *
 * VS Code のコマンドを名前で受け取ると、それは `executeCommand` を線の向こうに
 * 開くことであり、**この道具の境界そのものが消える**（ファイルの作成も削除も
 * 設定の変更も、全部コマンドである）。閉じた語彙だけを受け取る。
 *
 * ## 端末を起こす道具は入らない（設計 D45）
 *
 * `workbench.action.terminal.*` の新規作成・破棄はこの一覧に**無い**。
 * 入れた時点でリング②（見せる）を出る ―― コマンドを実行できる面を
 * エージェントが能動的に作れるということである。
 *
 * 一方 `toggle-panel` で端末 UI が手前に出て VS Code が自動でシェルを
 * 起こすのは**許容する**。そこに何があるかは人間の設定の結果であり、
 * エージェントが選んだのはパネルの可視性だけである。
 * **この2つを「同じことだ」と読まないこと** ―― 攻撃者が制御できる量が違う。
 */

/**
 * 受け付ける画面操作。**この一覧が境界である。**
 *
 * 足すときは「それは見せるための操作か、それとも別のことができるようになるか」を
 * 先に問うこと。`workbench.action.terminal.*` や `workbench.action.files.*` は
 * ここに入らない ―― 入れた時点でリング②を出る。
 *
 * **語彙とコマンド名は別物である。** ここに書くのは「何をしたいか」であって、
 * VS Code のコマンド名ではない。対応づけは拡張の面（`view-surface.ts`）だけが持つ。
 * そしてその対応表は**実機にそのコマンドが在ることを統合テストで確かめている**
 * （設計 D44）―― 無い名前を置くと `run()` が例外を飲んで `done: false` になり、
 * エージェントからは「そのビューが無い」と区別がつかない**黙った死に操作**になる。
 */
export const VIEW_ACTIONS = [
  /** エクスプローラを開き、指定したパスをツリー上で示す（`path` が要る） */
  "reveal-in-explorer",
  /** サイドバーにエクスプローラを出す */
  "show-explorer",
  /** サイドバーに検索を出す */
  "show-search",
  /** サイドバーにソース管理を出す */
  "show-scm",
  /** サイドバーにデバッグを出す */
  "show-debug",
  /** サイドバーに拡張機能を出す */
  "show-extensions",
  /** サイドバーを閉じる（コードに集中させる） */
  "hide-sidebar",
  /** サイドバーの開閉を切り替える */
  "toggle-sidebar",
  /** 下のパネルを開く */
  "show-panel",
  /** 下のパネルを閉じる（同上） */
  "hide-panel",
  /** 下のパネルの開閉を切り替える */
  "toggle-panel",
  /** 下のパネルを最大化する／戻す */
  "toggle-maximized-panel",
  /** PROBLEMS に焦点を移す */
  "show-problems",
  /** OUTPUT に焦点を移す */
  "show-output",
  /** COMMENTS に焦点を移す（注釈の一覧） */
  "show-comments",
  /** 右のサイドバー（補助バー）の開閉を切り替える */
  "toggle-auxiliary-bar",
  /** Zen モードの開閉を切り替える */
  "toggle-zen-mode",
  /** アクティビティバーの表示を切り替える */
  "toggle-activity-bar",
  /** ステータスバーの表示を切り替える */
  "toggle-status-bar",
] as const;

export type ViewAction = (typeof VIEW_ACTIONS)[number];

/** その操作がパスを要るか。 */
export function viewActionNeedsPath(action: ViewAction): boolean {
  return action === "reveal-in-explorer";
}
