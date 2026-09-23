/**
 * メモを書き込む先を決める（設計書 §4.3.1）。**vscode 非依存の純関数。**
 *
 * ## `isDirty` では判別できない（2C Task 0 の実測）
 *
 * 以前の設計は「`isDirty` かつ最後の書き込み以降に変更があれば新しいドキュメントに
 * 逃がす」だった。ところが `openTextDocument({content, language})` が作る名前なし
 * ドキュメントは**生まれた瞬間から `isDirty === true`** である（エディタに出す前から）。
 * 連言の片側が常に真なので、この条件は**何も絞っていなかった** ―― `show_note` を
 * 呼ぶたびに新しいドキュメントが増えることになる。
 *
 * ## `version` で判別する
 *
 * 実測（同じく Task 0）:
 *
 * - 初期値は 1（0 ではない）
 * - 編集のたびに +1
 * - **内容が変わらない差し替えでは増えない**
 *
 * 最後の性質があるので、我々自身の冪等な書き直し（同じ本文をもう一度渡す）が
 * 「人間が編集した」に化けることはない。
 *
 * ## 同じ量を2箇所で決めない（不変条件14）
 *
 * 「人間が触ったか」を決めるのはこの関数だけである。呼び出し側は
 * **書いた直後の version を控えて、次にそのまま渡す**。呼び出し側にもう一度
 * 判断を書くと、片方が推測・片方が観測になる。
 */

/** 前回 `show_note` が書いたときの状態。 */
export interface LastWrite {
  /** そのときのドキュメントの識別子（`uri.toString()`）。 */
  uri: string;
  /** **書き終えた直後**の `document.version`。 */
  version: number;
}

/** いま開いているドキュメントの観測値。閉じられていれば `undefined`。 */
export interface ObservedDocument {
  uri: string;
  version: number;
  isClosed: boolean;
}

export type NoteTarget =
  | { kind: "reuse"; reason: "unchanged-since-last-write" }
  | { kind: "new"; reason: "no-previous-note" | "document-gone" | "human-edited" };

/**
 * 使い回してよいか。**判断は「人間が触っていない」ときだけ肯定に倒れる。**
 *
 * 迷ったら新しく開く側に倒す ―― 誤って使い回すと人間が書いたものが消えるが、
 * 誤って新しく開いても増えるだけである。**失うほうを避ける。**
 */
export function chooseNoteTarget(
  last: LastWrite | undefined,
  observed: ObservedDocument | undefined,
): NoteTarget {
  if (last === undefined) return { kind: "new", reason: "no-previous-note" };
  if (observed === undefined || observed.isClosed || observed.uri !== last.uri) {
    return { kind: "new", reason: "document-gone" };
  }
  // **`!==` で見る。** `>` にすると、版が巻き戻る経路（取り消し）で使い回しに倒れる。
  if (observed.version !== last.version) return { kind: "new", reason: "human-edited" };
  return { kind: "reuse", reason: "unchanged-since-last-write" };
}
