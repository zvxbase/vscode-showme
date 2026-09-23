import { sanitizeDisplayText } from "./sanitize.js";

/**
 * メモの本文の無害化（`show_note`）。**不変条件7 の3経路目。**
 *
 * 「webview・comment thread・**メモ**の3経路すべてが
 * `protocol` の同じ関数を通る」という約束がある。増分2C の初版はメモだけ素通しにして
 * いた ―― 文書がそう書いてあるだけでは、次に足す人にも書いた本人にも届かない。
 *
 * ## 2つのことをする
 *
 * **1. 文字レベルの可視化。** `sanitizeDisplayText` に委ねる（実装は1つ）。
 * メモは人間が読む文書なので、双方向オーバーライドで読む内容と実際が食い違う
 * ことを許さない（Trojan Source）。改行は本文なので通す。
 *
 * **2. markdown のときだけ、取得を起こす HTML タグを無力化する。**
 *
 * ここが本増分のレビューで見つかった穴である。メモの既定の言語は `markdown` で、
 * VS Code には組み込みの Markdown プレビューがある。プレビューは**生の HTML を
 * 描画し、既定で https の画像を読み込む**。つまりエージェントが
 * `<img src="https://…/?leak=…">` を書いたメモを人間がプレビューした瞬間、
 * **我々が組んだ3枚構成も CSP もまったく通らずに**要求が出る。
 *
 * ## なぜ許可制ではなく、取得を起こすタグの一覧なのか
 *
 * メモの中身は散文とコードであって HTML ではない。「許してよい文字」を数え上げる
 * ことはできないので、ここだけは**取得を起こすタグ名の一覧**で書く。
 * 一覧に無いタグ（`<div>` や `<T>` のような総称型）はそのまま通る ――
 * `Array<string>` や `a < b` を壊さないことが、この道具の主用途
 * （コードの説明を書く）にとって重要だからである。
 *
 * **一覧に漏れがあれば穴になる。** だから「描画されると何かを取りに行く要素」を
 * 広めに取り、テストで一覧そのものを固定する。判断に迷う要素は**入れる**。
 */

/**
 * 描画されると何かを取りに行く（あるいは遷移する）要素の名前。
 *
 * `svg` と `math` が入っているのは、中に `<image>` や外部参照を持てるからで、
 * 開始タグを無力化すれば、中身は生きたマークアップにならない。
 */
const FETCHING_TAGS: readonly string[] = [
  "img",
  "image",
  "picture",
  "source",
  "iframe",
  "frame",
  "frameset",
  "portal",
  "object",
  "embed",
  "applet",
  "video",
  "audio",
  "track",
  "link",
  "script",
  "style",
  "base",
  "meta",
  "form",
  "input",
  "button",
  "svg",
  "math",
  "use",
  "marquee",
  "body",
  "html",
  "head",
  "a",
];

/** 一覧をテストから読めるようにする（一覧そのものを固定するため）。 */
export const NOTE_NEUTRALIZED_TAGS: readonly string[] = FETCHING_TAGS;

/** 言語 ID が「生の HTML を描画するプレビューを持つ」ものか。 */
export function noteLanguageRendersHtml(language: string): boolean {
  return language.toLowerCase() === "markdown";
}

const TAG_PATTERN = new RegExp(`<(/?)(${FETCHING_TAGS.join("|")})\\b`, "gi");

/**
 * メモの本文を、その言語の行き先に合わせて無害化する。
 *
 * `markdown` 以外の言語（`typescript` / `json` / `plaintext` など）は、VS Code に
 * 生の HTML を描画する組み込みプレビューが無いので、タグの無力化はしない ――
 * コードのメモを `&lt;` だらけにしない。文字レベルの可視化は言語によらず行う。
 */
export function sanitizeNoteText(raw: string, language: string, maxChars: number): string {
  const visible = sanitizeDisplayText(raw, { maxChars, maxLines: maxChars });
  if (!noteLanguageRendersHtml(language)) return visible;
  // 開始の `<` だけを実体参照にする。閉じタグも同じ扱いにしておくと、
  // 対にならない `</img>` のようなものが残って読みにくくなるのを避けられる。
  return visible.replace(TAG_PATTERN, (_match, slash: string, tag: string) => `&lt;${slash}${tag}`);
}
