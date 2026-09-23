import { defaultTreeAdapter, parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import {
  sanitizePresentationAttribute,
  sanitizeStyleAttributeWithReport,
  sanitizeStyleSheetWithReport,
} from "./sanitize-css.js";
import { sanitizeDisplayText } from "./sanitize.js";

type Node = DefaultTreeAdapterMap["node"];
/** 親を持ちうるノード。`Document` は親を持たないので `Node` では型が合わない。 */
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

/**
 * エージェント由来の HTML の無害化。**行き先は `sandbox=""` の表示フレーム。**
 *
 * ## なぜ CSP に任せないのか
 *
 * CSP は第二層であって第一層ではない。2C Task 0 の実測で、**CSP には塞げない経路が
 * 現に存在する**ことが分かっている（`webrtc 'block'` は no-op、`frame-src` は
 * `srcdoc` に効かない）。さらに `<link rel=dns-prefetch>` と `preconnect` は
 * **fetch を作らずに DNS と TCP を出す**ので、`default-src 'none'` の下でも
 * 落ちうる保証が無い。**ここで落とせなければ、後段に落とす層は無い。**
 *
 * ## なぜパーサを通すのか。そしてなぜ解析モードを行き先に合わせるのか
 *
 * 正規表現で HTML を削ると、削った側の解釈と描画側（Blink）の解釈がずれる。
 * ずれた瞬間、サニタイザから見て無害な文字列が、描画されると別の木になる
 * （mutation XSS）。だから**仕様準拠のパーサで木にして、木から直列化し直す**。
 *
 * そのうえで、**パーサの設定を行き先に合わせる**必要がある。`<noscript>` の中身の
 * 解析は、スクリプトが有効か無効かで変わる。表示フレームは `sandbox=""` なので
 * スクリプトは**無効**で、Blink は中身を**マークアップ**として解析する。parse5 の
 * 既定は `scriptingEnabled: true` で、その場合中身は**生テキスト**になる。
 *
 * だから解析モードは `DISPLAY_FRAME_SANDBOX` から**導出する**。この2つは
 * 同じ量（行き先でスクリプトが動くか）であり、2箇所で別々に決めてはならない
 * （不変条件14）。表示フレームの `sandbox` を変えれば、解析モードは自動で追随する。
 *
 * > **測っておく。** 変異検査では、`scriptingEnabled` を既定（`true`）に戻しても
 * > テストは緑のままだった ―― `<noscript>` は要素の許可制のほうで既に落ちているからである。
 * > つまり**この行は現時点では単独では効いていない**。それでも導出の形にしてあるのは、
 * > 許可制のほうを将来触ったときに、ここが黙って食い違わないようにするためである。
 * > 「効いている」と書いてしまうと、次に読む人が実際には無い層を数えることになる。
 *
 * ## 文字レベルの無害化はここでやらない
 *
 * 双方向オーバーライド・ゼロ幅・制御文字の可視化は `sanitize.ts` に委ねる
 * （不変条件7: サニタイザは1つ）。この層がやるのは**木の刈り込み**だけである。
 */

/**
 * 受け取る HTML の上限。
 *
 * 図1枚ぶんの SVG は数万文字になる（作図ツールの出力の実測で 11,441 文字）。余裕を見て
 * 256KiB とするが、**上限そのものより「上限がある」ことが重要**である ―― 無制限だと
 * パーサに任意サイズを食わせる面ができる。
 */
export const MAX_HTML_CHARS = 256 * 1024;

/**
 * 表示フレームの `sandbox` 属性の値。**空文字列＝すべての権限を落とす。**
 *
 * ここが唯一の決定元である。webview を組む側（拡張）も、無害化する側（この
 * モジュール）も、この定数を読む。**同じ量を2箇所で決めない**（不変条件14）。
 */
export const DISPLAY_FRAME_SANDBOX = "";

/**
 * その `sandbox` の下でスクリプトが動くか。**解析モードはここから導出する。**
 *
 * 直に `false` と書くと、`sandbox` を緩めたときに黙って食い違う。
 */
export function frameScriptingEnabled(sandbox: string): boolean {
  return sandbox.split(/\s+/).includes("allow-scripts");
}

/**
 * 残す HTML 要素。**許可制である。** 知らない要素は落ちる。
 *
 * ここに無いものを足すときは「その要素が単独でネットワークに出られないか」を先に見る。
 * 出られるなら足さない。
 */
const ALLOWED_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  // 文書構造
  "p",
  "div",
  "span",
  "br",
  "hr",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "figure",
  "figcaption",
  "details",
  "summary",
  // 一覧
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  // 表
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  // 文字レベル
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "abbr",
  "cite",
  "q",
  "code",
  "pre",
  // `<style>` は**中身を `sanitizeStyleSheet` に通してから**残す。
  // 作図した SVG は色を `<style>` に持つことがあるので、落とすと図の見た目が壊れる。
  "style",
  "kbd",
  "samp",
  "var",
  "del",
  "ins",
  "time",
  "ruby",
  "rt",
  "rp",
  "wbr",
  "bdi",
  // 画像（src は data: だけ。下の URL 判定を見よ）
  "img",
]);

/**
 * 残す SVG 要素。
 *
 * **落としているものに理由がある**:
 * `a`（遷移）/ `use`・`image`（外部参照）/ `foreignObject`（HTML の面が復活する）/
 * `script` / `animate`・`set`（属性を後から書き換えられる）/ `filter`・`feImage`（外部参照）/
 * `font-face`（外部参照）。
 */
const ALLOWED_SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "symbol",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "style",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
]);

/**
 * 中身ごと消す要素。**刈るだけでは足りないもの。**
 *
 * 普通の禁止要素は「その要素を外して子を繰り上げる」で足りる（`<div>` を落としても
 * 中の段落は残したい）。だがここに挙げたものは、**中身がそのまま危険**か、
 * **中身がテキストとして書かれていて繰り上げると意味が変わる**。
 *
 * > **この表は重ねである。** 変異検査で `link` / `noscript` / `template` を
 * > この表から外してもテストは緑だった ―― どれも要素の許可制に無いので繰り上げになり、
 * > 繰り上がった子は先に属性の許可制を通っているからである。**実際に落としているのは
 * > 許可制**であり、この表はその手前で早く落とすためのものである。
 * > ここに足したことを「塞いだ」と読まないこと。
 */
const DROP_WITH_CONTENTS: ReadonlySet<string> = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "label",
  "fieldset",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "map",
  "area",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "portal",
  "applet",
  "frame",
  "frameset",
]);

/** どの要素にも許す属性。 */
const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "alt",
]);

/** HTML 要素ごとに許す属性。 */
const HTML_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["img", new Set(["src", "width", "height"])],
  ["td", new Set(["colspan", "rowspan", "headers"])],
  ["th", new Set(["colspan", "rowspan", "headers", "scope"])],
  ["col", new Set(["span"])],
  ["colgroup", new Set(["span"])],
  ["ol", new Set(["start", "reversed", "type"])],
  ["li", new Set(["value"])],
  ["time", new Set(["datetime"])],
  ["details", new Set(["open"])],
]);

/**
 * SVG に許す描画属性。**参照を作れるものは入れない。**
 *
 * `href` / `xlink:href` / `filter` / `mask` はここに無い。`clip-path` と
 * `marker-*` は `url(#id)` で**同じ文書の中**を指すためのもので、外部参照は
 * 下の `isSafeCssUrlReference` が落とす。
 */
const SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  "d",
  "x",
  "y",
  "dx",
  "dy",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "transform",
  "transform-origin",
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
  "opacity",
  "color",
  "visibility",
  "display",
  "overflow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "letter-spacing",
  "word-spacing",
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "clip-rule",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "clipPathUnits",
  "patternUnits",
  "xml:space",
]);

/**
 * `src` に許すのは data: の画像だけ。
 *
 * **`svg+xml` は入れない。** `<img>` 文脈の SVG では外部参照もスクリプトも動かないので
 * 直ちに危険ではないが、許して得られるものが無い（図は SVG をそのまま書ける）。
 * 一方で「SVG を data: で通す口」は、文脈が1つ変わっただけで危険になる形である。
 */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]*$/i;

/**
 * URL 属性の値を**正規化しつつ検証する**。通らなければ `null`。
 *
 * 返すのは**検証した当の文字列**である。以前は正規形で検証して**生の値を出力**して
 * いた ―― それは「同じ量を2箇所で別々に決める」形（不変条件14）そのもので、
 * 正規化とブラウザの解釈がずれた瞬間に抜け道になる。**検証した値を出す。**
 *
 * 制御文字による分断（`java` + 改行 + `script:` のような形）は、ブラウザ側で
 * 詰められてから解釈される。ここで自前に文字を削らず、**`sanitize.ts` に可視化させる**
 * （不変条件7）。可視化された時点で data: の形には合わなくなるので、分断は落ちる。
 */
function normalizeUrlValue(value: string): string | null {
  const visible = sanitizeDisplayText(value, { maxChars: MAX_HTML_CHARS, maxLines: 1 });
  const normalized = visible.replace(/\s/g, "");
  return SAFE_DATA_IMAGE.test(normalized) ? normalized : null;
}

/** 属性名が URL を取るものか。 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "href",
  "xlink:href",
  "srcset",
  "imagesrcset",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "cite",
  "longdesc",
  "ping",
  "usemap",
  "profile",
  "manifest",
]);

/**
 * 値が **CSS の値として**解釈される SVG の表示属性。
 *
 * `url()` を書けるので、`sanitize-css.ts` の宣言検査を通す。ここに新しい属性を
 * 足すときは、それが `ALLOWED_PROPERTIES` にもあることを確かめること
 * （無ければ `sanitizePresentationAttribute` が必ず `null` を返して、黙って落ちる）。
 */
const CSS_URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "fill",
  "stroke",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  // `transform` / `transform-origin` / `gradientTransform` は**以前は素通しだった**
  // （`SVG_ATTRIBUTES` にあるので名前は通り、値は `rewriteAttributeValue` の
  // 最後の `return value` でそのまま出ていた）。SVG の変換リストの文法に
  // `url()` は無いので直ちに危険ではなかったが、**検査していない値の経路**が
  // 1つ残っていた。同じ関数を通す。
  "transform",
  "transform-origin",
  "gradientTransform",
]);

/**
 * 表示属性の名前を、対応する **CSS のプロパティ名**に読み替える。
 *
 * `gradientTransform` は SVG の属性名で、CSS のプロパティとしては存在しない。
 * 値の文法は `transform` と同じ（変換リスト）なので、そちらとして検査する。
 * 読み替えないと `ALLOWED_PROPERTIES` に無いので必ず落ち、SVG の
 * グラデーションが黙って壊れる。
 */
function cssPropertyFor(attributeName: string): string {
  return attributeName === "gradientTransform" || attributeName === "gradienttransform"
    ? "transform"
    : attributeName;
}

function isElement(node: Node): node is Element {
  return defaultTreeAdapter.isElementNode(node);
}

function childrenOf(node: Node): ChildNode[] {
  const parent = node as ParentNode;
  return Array.isArray(parent.childNodes) ? [...parent.childNodes] : [];
}

/**
 * 要素の名前空間つきの判定。
 *
 * **`<svg>` の中の `<a>` と HTML の `<a>` を同じ名前で扱わない。** SVG の
 * 名前空間では要素名が大文字小文字を区別する（`clipPath` / `linearGradient`）ので、
 * 小文字化してから比べると取りこぼす。
 */
function isAllowedElement(el: Element): boolean {
  const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";
  if (isSvg) return ALLOWED_SVG_ELEMENTS.has(el.tagName);
  return ALLOWED_HTML_ELEMENTS.has(el.tagName.toLowerCase());
}

function isDroppedWithContents(el: Element): boolean {
  // SVG の `<title>` / `<desc>` は読み上げ用の文字であって、HTML の `<title>` とは別物。
  // 名前で一括に落とすと、名前空間の違う無害な要素まで巻き込む。
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    return (
      !ALLOWED_SVG_ELEMENTS.has(el.tagName) && DROP_WITH_CONTENTS.has(el.tagName.toLowerCase())
    );
  }
  return DROP_WITH_CONTENTS.has(el.tagName.toLowerCase());
}

/** 属性1つを残すか。 */
function keepAttribute(el: Element, rawName: string, value: string): boolean {
  const name = rawName.toLowerCase();

  // `on*` は行き先にスクリプトが無くても落とす。**変異検査ではこの行を消しても
  // テストは緑だった** ―― 下の許可制が先に落としているからである。効いているのは
  // 許可制のほうで、この行は「許可表に `onclick` のような名前を足してしまった」
  // ときのための重ねであって、層として数えるものではない。
  if (name.startsWith("on")) return false;
  // `data-*` は描画に影響しないが、CSS の属性セレクタ経由で参照を作れる面がある。
  // 通す理由が無いので落とす。
  if (name.startsWith("data-")) return false;
  // `style` は値を `sanitizeStyleAttribute` が組み直す（下の `rewriteAttribute`）。
  // ここでは名前として通し、値の可否は組み直しの結果（空かどうか）で決まる。
  if (name === "style") return true;
  if (name === "xmlns" || name.startsWith("xmlns:")) return false;

  if (URL_ATTRIBUTES.has(name)) {
    // `src` だけは data: の画像を通す。ほかの URL 属性は通す理由が無い。
    if (name !== "src") return false;
    // 値は `rewriteAttributeValue` が正規形に置き換える。ここでは可否だけ。
    return normalizeUrlValue(value) !== null;
  }

  // 表示属性の値は **CSS の値**なので、宣言と同じ関数を通す（不変条件14）。
  // 値は `rewriteAttributeValue` が検査済みの形に置き換える。
  if (
    CSS_URL_ATTRIBUTES.has(name) &&
    sanitizePresentationAttribute(cssPropertyFor(name), value) === null
  ) {
    return false;
  }

  const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";
  if (isSvg) {
    // SVG は属性名の大文字小文字が意味を持つ（`viewBox`）ので、生の名前で見る。
    return SVG_ATTRIBUTES.has(rawName) || GLOBAL_ATTRIBUTES.has(name);
  }

  if (GLOBAL_ATTRIBUTES.has(name)) return true;
  return HTML_ATTRIBUTES.get(el.tagName.toLowerCase())?.has(name) === true;
}

/**
 * 属性の**値**を組み直す。組み直した結果が空なら、その属性は落とす。
 *
 * `style` と `src` がこれを要る。`style` は**宣言ごとに可否が変わる**
 * （`color` は通して `background-image: url(…)` は落とす）。`src` は
 * **検証した正規形をそのまま出す**ためにここを通る。
 */
function rewriteAttributeValue(
  name: string,
  value: string,
  report: { dropped: number },
): string | null {
  const lower = name.toLowerCase();
  if (lower === "style") {
    const safe = sanitizeStyleAttributeWithReport(value);
    report.dropped += safe.dropped;
    return safe.css === "" ? null : safe.css;
  }
  // **検証した値をそのまま出す。** 検証と出力で別の文字列を使わない（不変条件14）。
  if (lower === "src") return normalizeUrlValue(value);
  if (CSS_URL_ATTRIBUTES.has(lower))
    return sanitizePresentationAttribute(cssPropertyFor(lower), value);
  return value;
}

/**
 * 木を刈る。**深さ優先で、子を先に片づけてから親を判断する。**
 *
 * 許可されていない要素は「外して子を繰り上げる」。中身ごと消すものだけは
 * 子ごと落とす。繰り上げにすることで、`<div>` のような無害だが一覧に無い
 * 器を落としても、中の文章が消えない。
 */
function pruneChildren(parent: ParentNode, report: { dropped: number }): void {
  const kept: ChildNode[] = [];

  for (const child of childrenOf(parent)) {
    if (defaultTreeAdapter.isTextNode(child)) {
      // 文字レベルの無害化は1箇所（不変条件7）。改行は本文なので通す。
      child.value = sanitizeDisplayText(child.value, {
        maxChars: MAX_HTML_CHARS,
        maxLines: MAX_HTML_CHARS,
      });
      kept.push(child);
      continue;
    }
    if (defaultTreeAdapter.isCommentNode(child)) {
      // コメントは残す理由が無い。条件付きコメントのような解析差の面も消える。
      continue;
    }
    if (!isElement(child)) continue;

    if (isDroppedWithContents(child)) continue;

    // `<style>` の中身は**文章ではなく CSS** である。汎用のテキスト処理を通すと
    // エスケープ列（`\\n` など）が CSS に混ざって規則が壊れる。CSS の文法検査に回す。
    // 直列化のとき `<style>` の中身は**エスケープされない**ので、通す形の側で
    // `<` を許していないことが効いている（`sanitize-css.ts` の `QUOTED`）。
    if (child.tagName.toLowerCase() === "style") {
      const source = childrenOf(child)
        .map((node) => (defaultTreeAdapter.isTextNode(node) ? node.value : ""))
        .join("");
      const sheet = sanitizeStyleSheetWithReport(source);
      report.dropped += sheet.dropped;
      const safeCss = sheet.css;
      if (safeCss === "") continue;
      child.attrs = [];
      const textNode = childrenOf(child).find((node) => defaultTreeAdapter.isTextNode(node));
      if (textNode !== undefined && defaultTreeAdapter.isTextNode(textNode)) {
        textNode.value = safeCss;
        textNode.parentNode = child;
        child.childNodes = [textNode];
      } else {
        continue;
      }
      kept.push(child);
      continue;
    }

    pruneChildren(child, report);

    if (isAllowedElement(child)) {
      const rewritten: typeof child.attrs = [];
      for (const attr of child.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (!keepAttribute(child, name, attr.value)) continue;
        const value = rewriteAttributeValue(name, attr.value, report);
        if (value === null) continue;
        rewritten.push({ ...attr, value });
      }
      child.attrs = rewritten;
      kept.push(child);
    } else {
      // 器だけ外して中身を繰り上げる。
      for (const grandchild of childrenOf(child)) {
        grandchild.parentNode = parent;
        kept.push(grandchild);
      }
    }
  }

  for (const node of kept) node.parentNode = parent;
  parent.childNodes = kept as ParentNode["childNodes"];
}

/**
 * エージェント由来の HTML を、表示フレームに入れてよい形にする。
 *
 * 上限を超える入力は**投げる**。黙って切り詰めると、切った位置で木の形が変わり、
 * 「サニタイザが見た木」と「描画される木」がずれる ―― それはこの層が
 * 防ごうとしているものそのものである。
 */
export function sanitizeHtml(raw: string): string {
  return sanitizeHtmlInternal(raw, { dropped: 0 });
}

function sanitizeHtmlInternal(raw: string, report: { dropped: number }): string {
  if (raw.length > MAX_HTML_CHARS) {
    throw new Error(`HTML is too long (${raw.length} characters; the limit is ${MAX_HTML_CHARS})`);
  }
  // 解析モードは行き先の `sandbox` から導出する（冒頭の説明を読むこと）。
  const fragment = parseFragment(raw, {
    scriptingEnabled: frameScriptingEnabled(DISPLAY_FRAME_SANDBOX),
  });
  pruneChildren(fragment, report);
  return serialize(fragment);
}

/**
 * `sanitizeHtml` と同じことをして、**落とした CSS 宣言の件数も返す**（設計 D31）。
 *
 * 実地では `background` が落ちたことに気づく手段が無く、`{ shown: true }` だけが
 * 返っていた。件数が返れば1回目で気づける。
 *
 * **これは不変条件2 に抵触しない。** 落としたのはエージェント自身が書いた文字列で
 * あって、ワークスペースの中身ではない。**件数だけ**にすること ―― プロパティ名まで
 * 返すと許可リストの形状を問い合わせる口になる。
 */
export function sanitizeHtmlWithReport(raw: string): { html: string; droppedDeclarations: number } {
  const report = { dropped: 0 };
  const html = sanitizeHtmlInternal(raw, report);
  return { html, droppedDeclarations: report.dropped };
}
