/**
 * ハイライトの見た目（設計 D35 ―― **D20 の一部を覆す**）。
 *
 * ## D20 との関係を、混ぜずに書く
 *
 * 設計書 D20 は「エージェントには範囲しか渡させない」と決めた。理由は
 * `decorations.ts` のコメントにある:
 *
 * > `contentText` を引数化すると、ファイルに存在しないテキストをエディタ内に
 * > 描けてしまい、「原典が隣に開いている」という唯一の緩和が無効になる。
 *
 * **この理由は `contentText` のものであって、色のものではない。** 色を変えても、
 * エディタに描かれる文字はファイルの中身のままである。混ざっていた2つを分ける:
 *
 * - **`contentText` は引き続き禁止**（D20 の本体はここ）
 * - **色は選ばせる**（D35）
 *
 * ## 意味づけは機構に持たせない
 *
 * 「定義／使用箇所／注意」で色を分ける、という意味づけまで機構に持たせるのは
 * **規律を機構に埋め込む**話で、この repo が最初に退けた形である
 * （「個人によってやり方が変わるので、ここは強く決めないほうがうまく行く」）。
 *
 * だから語彙は**見た目（色相）**であって、意味ではない。どの色が何を意味するかは
 * 使う側が毎回決める。
 *
 * ## 任意の色を受け取らない
 *
 * CSS の色文字列を受け取ると、webview と同じ検査を装飾の経路にも作ることになる。
 * それに、任意の色は**テーマに追随しない** ―― 人間がライトテーマなら白地に白を
 * 描ける。閉じた語彙にして、それぞれの見た目は実装が light / dark で固定する。
 */

/**
 * 選べる色。**色相の名前であって、意味の名前ではない。**
 *
 * 見た目は `HIGHLIGHT_RGBA` が light / dark の両方で持つので、人間のテーマを
 * 知らなくても描ける。
 */
export const HIGHLIGHT_COLORS = ["yellow", "green", "red", "blue", "purple", "grey"] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** 指定が無いときの色。今までの見た目（検索一致のハイライト）を変えない。 */
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "yellow";

/** ライト／ダークで別の値を持つ色。VS Code の装飾の `light` / `dark` にそのまま渡す。 */
export interface ThemedRgba {
  readonly light: string;
  readonly dark: string;
}

/**
 * 色 → 半透明の rgba（増分6.1 D78）。**色相は実装が固定する。**
 *
 * 以前は VS Code のテーマ色（検索一致・diff・merge）から借りていた。語彙は色相の名前
 * （D35）なのに、テーマ色は**意味**に付いた色で、色相はテーマ次第だった ―― 実機
 * （Dark Modern）では黄がオレンジに、紫（`merge.currentContentBackground`）が青緑に
 * 見えた。名前と見た目が食い違うなら語彙の意味が無い。だから rgba を直接持ち、
 * ライト／ダークで alpha だけを変える（色相は同じ）。
 *
 * 表は protocol のここ1つ。`decorations.ts` は背景・縁・スクロールバーの印の全部に
 * この表の値を使い、テーマ色を混ぜない（混ぜると縁だけテーマのオレンジに引かれる）。
 */
export const HIGHLIGHT_RGBA: Record<HighlightColor, ThemedRgba> = {
  yellow: { light: "rgba(255, 213, 0, 0.30)", dark: "rgba(255, 213, 0, 0.28)" },
  green: { light: "rgba(46, 204, 64, 0.28)", dark: "rgba(46, 204, 64, 0.30)" },
  red: { light: "rgba(255, 65, 54, 0.28)", dark: "rgba(255, 65, 54, 0.30)" },
  blue: { light: "rgba(0, 116, 217, 0.30)", dark: "rgba(0, 116, 217, 0.34)" },
  purple: { light: "rgba(177, 13, 201, 0.30)", dark: "rgba(177, 13, 201, 0.34)" },
  grey: { light: "rgba(128, 128, 128, 0.30)", dark: "rgba(128, 128, 128, 0.32)" },
};

/**
 * 縁（1px）の色。塗りと**同じ色相**で、alpha だけ濃い。
 *
 * 縁を `editor.findMatchBorder` から借りていたときは、どの色の塗りにも同じ
 * オレンジの縁が付き、色相を引っぱっていた。塗りと縁を同じ表から作る（不変条件14）。
 */
export const HIGHLIGHT_BORDER_RGBA: Record<HighlightColor, ThemedRgba> = Object.fromEntries(
  HIGHLIGHT_COLORS.map((color) => [
    color,
    {
      light: HIGHLIGHT_RGBA[color].light.replace(/0\.\d+\)$/, "0.6)"),
      dark: HIGHLIGHT_RGBA[color].dark.replace(/0\.\d+\)$/, "0.6)"),
    },
  ]),
) as Record<HighlightColor, ThemedRgba>;

/**
 * 知らない名前を既定に落とす。**拒否しない。**
 *
 * 色が違うことより、図やハイライトが出ないことのほうが体験を壊す。
 * スキーマでも弾いているので、ここに来るのは型が抜けた経路だけである
 * ―― それでも落ちる先を決めておく（`undefined` を装飾に渡すと何も描かれない）。
 */
export function toHighlightColor(value: unknown): HighlightColor {
  return HIGHLIGHT_COLORS.includes(value as HighlightColor)
    ? (value as HighlightColor)
    : DEFAULT_HIGHLIGHT_COLOR;
}
