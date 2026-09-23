import type { HighlightColor } from "@zvx/vscode-showme-protocol";

/**
 * 1始まりの行範囲。`Resolution.range` と同じ数え方。
 *
 * `handlers/show-code.ts` から切り出してある。シンボル解決の判断ロジック
 * （`symbol-lookup.ts`）がこの型を要るのに、ハンドラから import すると
 * 「判断ロジック → ハンドラ → 判断ロジック」の輪ができる。型は葉に置く。
 */
export interface LineRange {
  startLine: number;
  endLine: number;
  /**
   * 0始まりの列。**任意**。省いたら行全体を指す。
   *
   * 「この引数」を指せるようにするために足した。行だけの指定は今までどおり通す
   * ―― 列は絞り込みであって、必須にしない（設計 D34）。
   */
  startColumn?: number;
  endColumn?: number;
  /**
   * ハイライトの色。**任意**。省いたら既定（設計 D35）。
   *
   * 色は見た目であって意味ではない ―― 意味づけは呼ぶ側がする。
   */
  color?: HighlightColor;
}

/** 列を持つ範囲か。ハイライトの種類（行全体か文字だけか）を決めるのに使う。 */
export function hasColumns(range: LineRange): boolean {
  return range.startColumn !== undefined && range.endColumn !== undefined;
}
