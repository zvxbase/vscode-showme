/**
 * Get Started の walkthrough（増分14 D120 / D121）。
 *
 * 中身は `package.json` の `contributes.walkthroughs` の宣言だけで、拡張は何も覚えない
 * （開いたか・どの手順を終えたかは VS Code 自身が持つ。不変条件13）。入れたセッションで
 * 自動で開くのも VS Code の既定の振る舞い（`workbench.welcomePage.walkthroughs.openOnInstall`）。
 * ここにあるのは **ShowMe: Get started** が開き直すための id だけ。
 */

/** `contributes.walkthroughs[0].id`（単体が package.json と一致することを確かめる） */
export const WALKTHROUGH_ID = "getStarted";

/**
 * `executeCommand` に渡す引数。拡張 ID は実行時の `context.extension.id` を渡す
 * （publisher と name を2箇所に書かない。不変条件14）。
 */
export function openWalkthroughArgs(extensionId: string): [string, string] {
  return ["workbench.action.openWalkthrough", `${extensionId}#${WALKTHROUGH_ID}`];
}
