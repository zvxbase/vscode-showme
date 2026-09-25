/** 0始まりの行の範囲（両端を含む）。`vscode.Range` の行だけを写したもの。 */
export interface LineSpan {
  start: number;
  end: number;
}

/**
 * 「本物のファイルを開く」（D87）が映しから本物のファイルへ持っていく行。vscode に依存しない
 * 純関数にしてあるのは、規則を単体で固定するため。
 *
 * - **カーソルが見えている範囲にあれば、その行。** 見えているカーソルは人間がそこに置いたもの
 *   （か、少なくとも人間の画面の中にある）
 * - **そうでなければ、見えている最初の範囲の真ん中。** 映しのカーソルは、エージェントが
 *   開いただけなら先頭に置かれたまま（`show_code` は `selection` に触らない ―― 不変条件3）で、
 *   人間の読んでいる位置を表さない。開く側（`revealForHuman`）は `InCenterIfOutsideViewport`
 *   で中央に出すので、真ん中を渡すと本物のファイルの画面が映しとほぼ同じ位置になる
 *   （先頭の行を渡すと、それが中央に来て半画面ずれる）
 * - どちらも無ければ（見えている範囲が無い）カーソルの行、それも無ければ 0
 */
export function lineToCarry(view: {
  cursorLine: number | undefined;
  visible: readonly LineSpan[];
}): number {
  const { cursorLine, visible } = view;
  if (
    cursorLine !== undefined &&
    visible.some((span) => span.start <= cursorLine && cursorLine <= span.end)
  ) {
    return cursorLine;
  }
  const first = visible[0];
  if (first !== undefined) return Math.floor((first.start + first.end) / 2);
  return cursorLine ?? 0;
}
