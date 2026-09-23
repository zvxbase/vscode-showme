import type * as vscode from "vscode";

/** 吹き出しに**無い UI**の観測（増分6 D70）。統合テストの `inspectVisuals().annotationUi`。 */
export interface AnnotationUiSurface {
  /** スレッドごとの返信可否。全部 false であること。 */
  canReply: boolean[];
  /** 人間がファイルのどこにでもコメントを書ける口（新規作成）。無いこと。 */
  hasCommentingRangeProvider: boolean;
  /** リアクション（👍）の口。無いこと。 */
  hasReactionHandler: boolean;
}

/**
 * `Annotations.observeUi()` の材料から、無い UI の有無を1回で決める。
 *
 * 口の**名前**をここに置くのは、注釈の経路（`annotations.ts`）にその語を書かないため
 * （`test/annotation-body-is-plain-text.test.ts` の禁止語。設定する側に語が無ければ、
 * 次に足す人は赤くなる）。ここは読むだけで、controller に何も書かない。
 * controller が未作成（1件も出していない）なら両方 false。
 */
export function annotationUiSurface(observed: {
  canReply: boolean[];
  controller: Readonly<vscode.CommentController> | undefined;
}): AnnotationUiSurface {
  return {
    canReply: [...observed.canReply],
    hasCommentingRangeProvider: observed.controller?.commentingRangeProvider !== undefined,
    hasReactionHandler: observed.controller?.reactionHandler !== undefined,
  };
}
