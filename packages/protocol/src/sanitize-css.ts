/**
 * CSS の無害化。**行き先は表示フレームの `style` 属性と `<style>` 要素。**
 *
 * ## なぜ CSS を別に扱うのか
 *
 * CSS はスクリプトが無くても**単独でネットワークに出られる**。`@import` は別の
 * スタイルシートを取りに行き、`url()` は画像・フォント・カーソルを取りに行く。
 * 表示フレームにスクリプトが無いことは、ここでは何の保証にもならない。
 *
 * ## 許可制の文法にする（禁止語の照合をしない）
 *
 * 「`url(` を含んでいたら落とす」は禁止制であり、**CSS のエスケープで回避できる**。
 * `\75 rl(…)` は `url(…)` として解釈される。`/**\/` を挟んでトークンを割ることもできる。
 * 禁止語を並べるやり方は、書き方の数だけ穴が開く。
 *
 * だから逆にする ―― **書ける形を先に決めて、それ以外を全部落とす**。
 *
 * - プロパティは許可表にあるものだけ
 * - 値は「キーワード / 数値＋単位 / 16進色 / `rgb()` 系 / 引用符つき文字列 /
 *   `url(#局所参照)`」の並びだけ
 * - **バックスラッシュはどこにも要らない。**1つでもあれば、その宣言を落とす
 * - コメントは値の中でトークンをつなげるので、解析の前に落とす
 *
 * ## パーサではなく文法検査である理由
 *
 * HTML は「解析結果の木が描画側と一致すること」が要るのでパーサを通す。CSS は
 * 木を作らない ―― **通す形を列挙して、合わないものを落とす**だけである。だから
 * 完全な CSS パーサは要らないし、持ち込むと「パーサが受け入れるが我々の想定に
 * 無い形」という新しい面が増える。
 *
 * 落とす単位は**宣言1つ**である。危ないものが1つあったら全部捨てる、にはしない
 * ―― 図の見た目が理由なく壊れて、人間が「この道具は図を出せない」と学習する。
 */

/**
 * 値を書いてよいプロパティ。
 *
 * 描画に要るものだけ。**位置と重なりを動かすもの（`position` / `z-index`）は入れない** ――
 * 表示フレームの中とはいえ、なりすましの面を広げる理由が無い。
 */
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  // 色と塗り
  "color",
  "background-color",
  "opacity",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stop-color",
  "stop-opacity",
  // 文字
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-anchor",
  "text-decoration",
  "text-transform",
  "white-space",
  "word-break",
  "direction",
  "dominant-baseline",
  "alignment-baseline",
  "vertical-align",
  // 箱
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  // 個別の辺の色。無いと `border-left-color` が落ちて、`droppedDeclarations: 1` で
  // 戻ってくる（実地で観測。戻り値だけから原因に到達できたので、件数を返す設計は効いている）。
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "width",
  "height",
  "max-width",
  "max-height",
  "min-width",
  "min-height",
  "display",
  "visibility",
  "overflow",
  "overflow-x",
  "overflow-y",
  "box-sizing",
  // 略記。**人も LLM も略記のほうを書く**ので、これが無いと「たまに踏む」ではなく
  // 「既定で踏む」経路になる。実地で `background: #fbfbfa` が落ちて
  // 前景だけ残り、ダークテーマで黒地に黒になった。
  "background",
  "list-style",
  "list-style-type",
  "list-style-position",
  // 表。無いとセル間に既定の 2px が残り、罫線が途切れて見える。
  "border-collapse",
  "border-spacing",
  "table-layout",
  "caption-side",
  "vertical-align",
  // テーマ追随。UA に「この面はどちらの地か」を伝える。
  // これがあると `Canvas` / `CanvasText` のシステム色が正しい側に転ぶ。
  "color-scheme",
  "accent-color",
  // 並べ方。表と図の説明を組むのに要る。
  "gap",
  "row-gap",
  "column-gap",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "flex",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  // 文字の細部。
  "text-indent",
  "overflow-wrap",
  "word-wrap",
  "tab-size",
  "hyphens",
  "text-overflow",
  "text-wrap",
  // SVG の局所参照
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "clip-rule",
  // 変換。**構成図の SVG が多用する**（`translate` / `matrix`）。
  // 許可関数（translate/scale/rotate/matrix）の引数は数値だけなので、
  // ここを通しても取得の口にはならない。通さないと図が崩れる。
  "transform",
  "transform-origin",
]);

/**
 * 値として書いてよい関数。**すべて引数が数値・パーセント・キーワードに限られるもの。**
 *
 * `url` はここに無い。局所参照 `url(#id)` だけを別に扱う（下の `isLocalUrl`）。
 * `var()` は入れない ―― 別の場所で定義された値を持ち込める以上、この検査の
 * 対象外の値がここを通ってしまう。
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "calc",
  "translate",
  "scale",
  "rotate",
  "matrix",
]);

/** 数値＋単位。 */
const NUMBER =
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|ex|ch|%|pt|pc|cm|mm|in|vw|vh|vmin|vmax|deg|rad|turn|s|ms|fr)?$/;
/** 16進色（3/4/6/8桁）。 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** キーワード（`sans-serif` / `solid` / `-webkit-foo` のような形）。 */
const KEYWORD = /^-?[A-Za-z][A-Za-z0-9-]*$/;
/**
 * 引用符つき文字列（フォント名）。
 *
 * **`<` と `>` を許さない。** `<style>` の中身は生テキストとして直列化されるので、
 * `font-family: "a</style><img src=…>"` のような値が通ると、**そこで要素を閉じて
 * 外に出られる**。括弧・バックスラッシュ・引用符・波括弧も同じ理由で許さない。
 */
const QUOTED = /^(?:"[^"'()\\;{}<>]*"|'[^"'()\\;{}<>]*')$/;
/** `url(#id)` の局所参照だけ。 */
const LOCAL_URL = /^url\(\s*(?:"#[A-Za-z0-9_:.-]+"|'#[A-Za-z0-9_:.-]+'|#[A-Za-z0-9_:.-]+)\s*\)$/;
/** 許可関数の呼び出し。引数は数値・パーセント・キーワード・カンマ・空白・演算子だけ。 */
const SAFE_CALL = /^([A-Za-z-]+)\(\s*([A-Za-z0-9 ,.%+\-*/]*)\s*\)$/;

/** コメントを落とす。**解析の前に落とす** —— 値の中でトークンをつなげるため。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * 値を空白とカンマで切る。**括弧の中では切らない。**
 *
 * `rgb(255, 0, 0)` を切ってしまうと、関数呼び出しが3つの断片になって、
 * どの断片も文法に合わなくなる。
 */
function splitValueTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (const ch of value) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",")) {
      if (current !== "") tokens.push(current);
      if (ch === ",") tokens.push(",");
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** 値のトークン1つが、書いてよい形か。 */
function isAllowedToken(token: string): boolean {
  if (token === ",") return true;
  if (NUMBER.test(token)) return true;
  if (HEX_COLOR.test(token)) return true;
  if (KEYWORD.test(token)) return true;
  if (QUOTED.test(token)) return true;
  if (LOCAL_URL.test(token)) return true;

  const call = SAFE_CALL.exec(token);
  if (call) {
    const name = (call[1] ?? "").toLowerCase();
    return ALLOWED_FUNCTIONS.has(name);
  }
  return false;
}

/**
 * 宣言1つ（`property: value`）を検査する。通るならそのまま返し、通らなければ `null`。
 */
function sanitizeDeclaration(declaration: string): string | null {
  // **バックスラッシュはどこにも要らない。** 1つでもあれば落とす。
  //
  // ただし**この行は単独では効いていない**（変異検査で外しても緑のまま）。実際に
  // 落としているのは下のトークン文法のほうで、`KEYWORD` も `QUOTED` も `LOCAL_URL` も
  // `\\` を含まない形しか受け付けない。ここに残すのは、将来どれかの文法を広げたときに
  // エスケープが同時に通ってしまわないようにするためである。**層として数えない。**
  if (declaration.includes("\\")) return null;

  const colon = declaration.indexOf(":");
  if (colon < 0) return null;

  const property = declaration.slice(0, colon).trim().toLowerCase();
  const value = declaration.slice(colon + 1).trim();
  if (property === "" || value === "") return null;
  if (!ALLOWED_PROPERTIES.has(property)) return null;

  // `!important` は形としては無害だが、通す理由も無い（重なりの操作である）。
  if (/!\s*important/i.test(value)) return null;

  const tokens = splitValueTokens(value);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (!isAllowedToken(token)) return null;
  }

  // 元の綴りではなく、**切り直したトークンから組み直す**。
  // 入力の空白の入れ方に出力が引きずられない（同じ意味は同じ文字列になる）。
  let out = "";
  for (const token of tokens) {
    if (token === ",") out += ",";
    else out += out === "" || out.endsWith(",") ? (out === "" ? token : ` ${token}`) : ` ${token}`;
  }
  return `${property}: ${out}`;
}

/**
 * `style` 属性の値を無害化する。**通った宣言だけを組み直して返す。**
 *
 * 1つも通らなければ空文字列。呼び出し側は空なら属性ごと落とす。
 */
export function sanitizeStyleAttribute(raw: string): string {
  return sanitizeStyleAttributeWithReport(raw).css;
}

/**
 * `sanitizeStyleAttribute` と同じことをして、**落とした宣言の件数も返す**。
 *
 * 件数をエージェントに返せるようにするため（設計 D31）。実地では
 * `background` が落ちたことに気づく手段が無く、`{ shown: true }` だけが返っていた。
 *
 * **件数だけにする。** プロパティ名まで返すと、許可リストの形状を問い合わせる口になる
 * ―― S1「正確な件数は無音のオラクル」と同じ形の議論を繰り返さない。
 */
export function sanitizeStyleAttributeWithReport(raw: string): {
  css: string;
  dropped: number;
} {
  const kept: string[] = [];
  let dropped = 0;
  for (const declaration of stripComments(raw).split(";")) {
    if (declaration.trim() === "") continue;
    const safe = sanitizeDeclaration(declaration);
    if (safe === null) dropped += 1;
    else kept.push(safe);
  }
  return { css: kept.join("; "), dropped };
}

/**
 * SVG の**表示属性**の値を検査する（`fill` / `stroke` / `clip-path` / `marker-*`）。
 *
 * これらは属性の形をしているが、値は **CSS の値**として解釈される ―― `fill="url(#g)"`
 * も `fill="url\\28 https://…\\29"` も、Blink は CSS のトークナイザで読む。
 *
 * **だから宣言と同じ関数を通す。** 以前は `sanitize-html.ts` に「`url(` を含むか」を
 * 見る別の実装があり、そちらは CSS のエスケープ（`\\28` ＝ `(`）を見落として
 * **素通しだった**（`fill="url\\28 https://evil\\29"` がそのまま出ていた）。
 * 同じ量を2箇所で別々に決めていた形であり（不変条件14）、片方だけが厳しかった。
 *
 * 通れば**値の部分**を返す。通らなければ `null`。
 */
export function sanitizePresentationAttribute(property: string, value: string): string | null {
  const safe = sanitizeDeclaration(`${property}: ${value}`);
  if (safe === null) return null;
  const colon = safe.indexOf(":");
  return colon < 0 ? null : safe.slice(colon + 1).trim();
}

/** セレクタに書いてよい形。**括弧もバックスラッシュも `@` も許さない。** */
const SAFE_SELECTOR = /^[A-Za-z0-9_\-.#:>+~*\s[\]="',^$|]+$/;

/**
 * `<style>` の中身を無害化する。
 *
 * **`@` 規則はすべて落とす。** `@import` は取りに行くし、`@font-face` の `src` も
 * 取りに行く。`@media` / `@supports` は入れ子の規則を持つので、平たい走査では
 * 中身の宣言を取りこぼす ―― 落とすほうが正しい。図の見た目に `@media` は要らない。
 *
 * 閉じられていない `{` は**そこで打ち切る**。飲み込み続けると、後ろの安全な規則が
 * 消えるか、危ない宣言が生き残るかのどちらかになる。どちらも困る。
 */
export function sanitizeStyleSheet(raw: string): string {
  return sanitizeStyleSheetWithReport(raw).css;
}

/** `sanitizeStyleSheet` と同じことをして、落とした宣言の件数も返す（設計 D31）。 */
export function sanitizeStyleSheetWithReport(raw: string): { css: string; dropped: number } {
  const css = stripComments(raw);
  const rules: string[] = [];
  let dropped = 0;
  let index = 0;

  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open < 0) break;
    const close = css.indexOf("}", open);
    // 閉じられていない規則。ここで終わる。
    if (close < 0) break;

    // `@import …;` のような**塊を持たない規則**は、次のセレクタの手前に居座る。
    // `;` で切って後ろだけをセレクタとして見る ―― こうしないと `@import` の巻き添えで
    // その直後の正当な規則まで落ちる（前は落ちていた）。
    const beforeBrace = css.slice(index, open);
    const lastSemicolon = beforeBrace.lastIndexOf(";");
    const selector = (
      lastSemicolon >= 0 ? beforeBrace.slice(lastSemicolon + 1) : beforeBrace
    ).trim();
    const body = css.slice(open + 1, close);
    index = close + 1;

    if (selector === "") continue;
    // `@` で始まるものは落とす。**これも単独では効いていない**（変異検査で外しても緑）――
    // 下の `SAFE_SELECTOR` が `@` を許していないので、そちらが先に落としている。
    // 意図を読める形で残しているだけで、層として数えない。
    if (selector.includes("@")) continue;
    if (!SAFE_SELECTOR.test(selector)) continue;

    const declarations: string[] = [];
    for (const declaration of body.split(";")) {
      if (declaration.trim() === "") continue;
      const safe = sanitizeDeclaration(declaration);
      if (safe === null) dropped += 1;
      else declarations.push(safe);
    }
    if (declarations.length === 0) continue;
    rules.push(`${selector} { ${declarations.join("; ")} }`);
  }

  return { css: rules.join("\n"), dropped };
}
