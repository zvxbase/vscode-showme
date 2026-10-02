import { type HighlightColor, columnsOfUniqueMatch } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { HighlightRange } from "./decorations.js";
import { type LineRange, hasColumns } from "./line-range.js";

/**
 * 1始まりの行範囲を vscode の値に直す。**`vscode` を値として読む側の葉**。
 *
 * `editor-surface.ts`（`show_code` / `annotate` の `reveal` の位置合わせ）と `annotations.ts`
 * （吹き出しの位置と塗り。増分6 D65）の両方がここを通る。塗りの**種類**（行全体か文字だけか）を
 * 決める関数は `toHighlightRange` の1つだけで、位置合わせと塗りが別々に決めると同じ列指定が
 * 片方でだけ効く（不変条件14）。判定そのもの（`hasColumns`）は純関数のまま `line-range.ts` に置き、
 * ここは vscode の型に写すだけである。
 */

/**
 * 1始まりの行範囲を vscode の Range にする。行頭から行末まで。
 *
 * `Number.MAX_SAFE_INTEGER` を終端の桁に置くのは vscode の作法で、実際の
 * 行末に丸められる。
 */
export function toRange(range: LineRange): vscode.Range {
  if (hasColumns(range)) {
    // **列が両方そろったときだけ文字単位。** 片方だけなら行全体に倒す
    // （「開始だけ指定して終端は行末」を許すと、範囲の意味が呼び出しごとに変わる）。
    return new vscode.Range(
      Math.max(0, range.startLine - 1),
      Math.max(0, range.startColumn ?? 0),
      Math.max(0, range.endLine - 1),
      Math.max(0, range.endColumn ?? 0),
    );
  }
  return new vscode.Range(
    Math.max(0, range.startLine - 1),
    0,
    Math.max(0, range.endLine - 1),
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * 貼る範囲と種類。**種類を知っているのはここだけ**（`decorations.ts` に推測させない）。
 *
 * 色は必ず受け取る。塗るのは注釈だけで（増分13 D116）、無印の色（灰）は注釈ストアが
 * `UNMARKED_ANNOTATION_PAINT` に倒して渡す ―― ここに既定を持つと既定が2箇所になる（不変条件14）。
 */
export function toHighlightRange(
  range: LineRange,
  color: HighlightColor,
  matchText?: string,
): HighlightRange {
  const out: HighlightRange = {
    range: toRange(range),
    wholeLine: !hasColumns(range),
    color,
  };
  // 鍵ごと省く（`exactOptionalPropertyTypes`）。
  return matchText === undefined ? out : { ...out, matchText };
}

/**
 * 文書の上で貼る範囲と種類。**画家（`decorations.ts`）が貼るときと、観測面
 * （`highlightRanges`）が言うときの両方がこれを通る**（貼ったものと観測が別の量にならないように）。
 *
 * `matchText` が無い（`symbol` / `lines`）なら、登録された範囲と種類のまま。
 *
 * `matchText` がある（`text` で指した）なら、登録された範囲の開始行を**文書の行**で確かめ直す。
 * 範囲の列は解決（`resolveLocation`）がディスクの読みで決めたもので、人間が見る文書とは違いうる
 * （BOM は VS Code が外す・`realFile` の未保存の編集・読んだ後の編集）。文書のその行にちょうど
 * 1回あればその列、0回・2回以上・行が無いなら行全体。「1回なら列、それ以外は行全体」を決めるのは
 * 解決と同じ `columnsOfUniqueMatch` 1つ（不変条件14）。行そのものは動かさない ―― 行まで文書で
 * 探し直すと、吹き出し（ディスクの行に付く）と塗りが別の行に割れる。
 *
 * `document` が無い（開いていない）なら、登録された範囲のまま（観測面だけが通る経路）。
 */
export function paintedOn(
  item: HighlightRange,
  document: Pick<vscode.TextDocument, "lineCount" | "lineAt"> | undefined,
): HighlightRange {
  if (item.matchText === undefined || document === undefined) return item;
  const line = item.range.start.line;
  const columns =
    line < document.lineCount
      ? columnsOfUniqueMatch(document.lineAt(line).text, item.matchText)
      : undefined;
  // `text` の位置は常に1行に解決する（一致は行ごとに探す）ので、ここで1行の範囲に組み直してよい
  return {
    ...item,
    ...toHighlightRange(
      { startLine: line + 1, endLine: line + 1, ...columns },
      item.color,
      item.matchText,
    ),
  };
}
