import type { HighlightColor } from "./highlight-style.js";

/**
 * 注釈の色（D57）。**`HIGHLIGHT_COLORS` の部分集合**で、灰を除く。
 *
 * 色は作成者名（`ShowMe 🔴 R`）に出る。吹き出しにもコメント一覧にも
 * 出る面は作成者名だけである（実機観察: 一覧には `iconPath` のアイコンが載らない）。
 * 拡張側の `ANNOTATION_AUTHOR` がこの語彙 → 固定文字列の表を持つ。
 *
 * 灰を除いた理由: 作成者名に色の丸（🟡🟢🔴🔵🟣）を出すが、灰の丸（⚪/⚫）は
 * 白か黒にしか見えず、フォントで見え方も変わる。環境依存の強いものを語彙に置かない。
 * 灰の**ハイライト**は CSS の色なので環境依存が無く、そちらは残す。
 * 対応づけ（赤いハイライトと赤い注釈）は5色で成立する。
 *
 * ## なぜ自由文字列にしないか
 *
 * 作成者名にエージェント由来の文字列が届くと、人間の名前や「VS Code」を名乗る
 * 吹き出しが作れる（設計書 §5.4）。語彙 → 固定文字列の対応づけを拡張側の定数に
 * することで、**この経路が型で消える**。
 *
 * 部分集合であることは `wire.test.ts` が固定する。`HIGHLIGHT_COLORS` に無い色を
 * ここに足すと落ちる。
 */
export const ANNOTATION_COLORS = ["yellow", "green", "red", "blue", "purple"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/**
 * 無印（`color` 省略）の注釈を塗る色（増分6.1 D78）。
 *
 * 無印の塗りは**塗る側の既定**であって、エージェントが選ぶ色ではない ―― 注釈の語彙に
 * 灰は戻さない（灰の丸の問題は変わらない）。作者名は `ShowMe` のまま。
 * D65 の「無印は塗らない」は実機で目立たなすぎたので撤回した。
 *
 * `HighlightColor` であって `AnnotationColor` ではない（灰は語彙の外）。決めるのはここ1つで、
 * `annotations.ts` はこれを既定に倒すだけ（不変条件14）。
 */
export const UNMARKED_ANNOTATION_PAINT: HighlightColor = "grey";
