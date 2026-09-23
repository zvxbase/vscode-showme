import { DEFAULT_HIGHLIGHT_COLOR } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { HighlightRange } from "./decorations.js";
import { type LineRange, hasColumns } from "./line-range.js";

/**
 * 1始まりの行範囲を vscode の値に直す。**`vscode` を値として読む側の葉**。
 *
 * `editor-surface.ts`（`show_code` の塗りと位置合わせ）と `annotations.ts`（注釈の塗り。
 * 増分6 D65）の両方がここを通る。塗りの**種類**（行全体か文字だけか）と既定色を決める
 * 関数は `toHighlightRange` の1つだけで、`show_code` の塗りと注釈の塗りが別々に決めると
 * 同じ列指定が片方でだけ効く（不変条件14）。判定そのもの（`hasColumns`）は純関数のまま
 * `line-range.ts` に置き、ここは vscode の型に写すだけである。
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

/** 貼る範囲と種類。**種類を知っているのはここだけ**（`decorations.ts` に推測させない）。 */
export function toHighlightRange(range: LineRange): HighlightRange {
  // **色はここで既定に落とす。** 貼る側に `undefined` を渡すと、そちらでも
  // 既定を決めることになり、既定が2箇所になる（不変条件14）。
  return {
    range: toRange(range),
    wholeLine: !hasColumns(range),
    color: range.color ?? DEFAULT_HIGHLIGHT_COLOR,
  };
}
