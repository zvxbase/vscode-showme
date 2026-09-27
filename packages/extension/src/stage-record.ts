/**
 * 開いたタブを「自分が開いた」として記録するか（D53 / D95）。判断のみ、vscode 非依存。
 *
 * 従来の窓（`agentTabs: false`）で人間の列に開くと（D93 / D94）、`showTextDocument` は行き先の列に
 * 人間が既に開いている同じファイルのタブを**使い回す**。それを記録すると、窓にその文書のタブが
 * 1枚だけなので `isOwnTab` が own と読み、`close-own` / `move-tab` が人間のタブを動かす・閉じる
 * （「人間のタブは閉じない」に反する）。だから開く**前に**行き先の列を観測し、同じ URI のタブが
 * あれば記録しない。
 *
 * 行き先が既存の列でない（新しい列を足す・`ViewColumn.Beside` の -2）なら使い回す相手が無い。
 * 別の列にある同じ URI は見ない ―― `showTextDocument` は行き先の列にしか開かない（2枚になった
 * 場合の own は `isOwnTab` の「窓に1枚」の規則が決める）。
 *
 * **照らすのは開いた後の文書の URI**（`editor.document.uri`）。渡した綴りと VS Code が開いた文書の
 * URI は正規化で違いうる（`%20` など）ので、渡した綴りで照らすと使い回しを見落としうる。集合は
 * **開く前に**取る（開いた後では自分の1枚も入ってしまう）。
 *
 * @param record 呼び出し側が決めた「記録する経路か」（`stageOpenTarget` の `record`）。
 * @param targetUrisBefore 開く直前の行き先の列のテキストタブの URI（`urisInColumn`）。
 * @param openedUri 開いた編集器の文書の URI。
 */
export function recordsOpenedTab(
  record: boolean,
  targetUrisBefore: ReadonlySet<string>,
  openedUri: string,
): boolean {
  if (!record) return false;
  return !targetUrisBefore.has(openedUri);
}

/**
 * 行き先の列のテキストタブの URI（**開く前に**観測する）。存在しない列（新しい列を足す・
 * `ViewColumn.Beside` の -2）は空。
 */
export function urisInColumn(
  groups: ReadonlyArray<{ viewColumn: number | undefined; uris: readonly string[] }>,
  targetColumn: number,
): ReadonlySet<string> {
  return new Set(groups.filter((g) => g.viewColumn === targetColumn).flatMap((g) => g.uris));
}
