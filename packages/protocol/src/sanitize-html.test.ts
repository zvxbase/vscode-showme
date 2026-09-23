import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
import {
  DISPLAY_FRAME_SANDBOX,
  MAX_HTML_CHARS,
  frameScriptingEnabled,
  sanitizeHtml,
  sanitizeHtmlWithReport,
} from "./sanitize-html.js";

/**
 * エージェント由来の HTML の無害化。
 *
 * 行き先は `sandbox=""` の表示フレーム（スクリプトが動かない）である。だから
 * 「スクリプトが実行される」ことは直接の脅威ではない。**脅威は egress である** ――
 * スクリプト無しでも、`<link rel=dns-prefetch>` は DNS を出し、`<meta http-equiv=refresh>`
 * は遷移し、`<img src>` は取りに行く。CSP は第二層であって第一層ではない。
 *
 * ## 落とす方向だけを見ない
 *
 * 「危ないものが落ちる」テストだけを書くと、**全部落とす実装が緑になる**。
 * 通すべきものが通ることを同じ数だけ見る（下の「通す」節）。
 */

/** 素の HTML 断片を1つの答えにする（前後の空白を無視して比べたいとき用）。 */
function clean(html: string): string {
  return sanitizeHtml(html).trim();
}

describe("sanitizeHtml: 落とすもの", () => {
  it("script 要素は中身ごと消える", () => {
    const out = clean('<p>a</p><script>fetch("https://evil.example")</script><p>b</p>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("link 要素は落ちる（rel を問わない）", () => {
    // `dns-prefetch` と `preconnect` は **CSP の管轄外**で DNS/TCP を出す。
    // ここで落とせなければ、後段に落とす層は無い。
    for (const rel of [
      "dns-prefetch",
      "preconnect",
      "prefetch",
      "preload",
      "modulepreload",
      "stylesheet",
    ]) {
      const out = clean(`<link rel="${rel}" href="https://evil.example/x">`);
      expect(out, `rel=${rel} が残っている`).not.toContain("evil.example");
      expect(out, `rel=${rel} が残っている`).not.toContain("<link");
    }
  });

  it("meta http-equiv=refresh は落ちる", () => {
    const out = clean('<meta http-equiv="refresh" content="0;url=https://evil.example">');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<meta");
  });

  it("base 要素は落ちる（相対 URL の解決先を変えられる）", () => {
    const out = clean('<base href="https://evil.example/">');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<base");
  });

  it("iframe / object / embed は落ちる", () => {
    for (const tag of ["iframe", "object", "embed"]) {
      const out = clean(`<${tag} src="https://evil.example/x" data="https://evil.example/y">`);
      expect(out, `${tag} が残っている`).not.toContain("evil.example");
      expect(out, `${tag} が残っている`).not.toContain(`<${tag}`);
    }
  });

  it("form / input / button は落ちる（送信の面を作らない）", () => {
    const out = clean(
      '<form action="https://evil.example" method="post"><input name="a"><button>go</button></form>',
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
  });

  it("on* 属性はすべて落ちる", () => {
    const out = clean('<p onclick="x()" onerror="y()" ONMOUSEOVER="z()" onfocus="w()">text</p>');
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("onmouseover");
    expect(out.toLowerCase()).not.toContain("onfocus");
    expect(out).toContain("text");
  });

  it("data: 以外のスキームの src / href は落ちる", () => {
    const cases = [
      '<img src="https://evil.example/x.png">',
      '<img src="http://evil.example/x.png">',
      '<img src="//evil.example/x.png">',
      '<img src="javascript:alert(1)">',
      '<img src="vscode-resource://evil">',
      '<img src="file:///etc/passwd">',
    ];
    for (const html of cases) {
      const out = clean(html);
      expect(out, `${html} が残っている`).not.toContain("evil");
      expect(out, `${html} が残っている`).not.toContain("passwd");
      expect(out, `${html} が残っている`).not.toContain("javascript:");
    }
  });

  it("srcset / imagesrcset も落ちる（src だけ見ると抜けられる）", () => {
    const out = clean(
      '<img srcset="https://evil.example/1x.png 1x" src="data:image/gif;base64,R0lGOD">',
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("srcset");
  });

  it("SVG の a / use / foreignObject / image / script は落ちる", () => {
    const out = clean(
      '<svg><a href="https://evil.example"><rect width="1" height="1"/></a>' +
        '<use href="https://evil.example/x#y"/>' +
        "<foreignObject><div>x</div></foreignObject>" +
        '<image href="https://evil.example/i.png"/>' +
        "<script>fetch(1)</script></svg>",
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("<use");
    expect(out).not.toContain("<script");
  });

  it("xlink:href も落ちる（href だけ見ると抜けられる）", () => {
    const out = clean('<svg><image xlink:href="https://evil.example/i.png"/></svg>');
    expect(out).not.toContain("evil.example");
  });

  it("孫 iframe は作れない", () => {
    const out = clean('<div><iframe srcdoc="<img src=https://evil.example/x>"></iframe></div>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("iframe");
  });

  it("video / audio / source / track は落ちる", () => {
    const out = clean(
      '<video src="https://evil.example/v.mp4"><source src="https://evil.example/s.mp4">' +
        '<track src="https://evil.example/t.vtt"></video>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("speculation rules の script は落ちる", () => {
    const out = clean(
      '<script type="speculationrules">{"prefetch":[{"urls":["https://evil.example/"]}]}</script>',
    );
    expect(out).not.toContain("evil.example");
  });

  /**
   * **パーサ差の本命。**
   *
   * 表示フレームは `sandbox=""` ＝**スクリプトが無効**である。HTML の仕様では
   * `<noscript>` の中身の解析はスクリプトの有効・無効で変わり、無効なら
   * **マークアップとして**解析される。ところが parse5 の既定は
   * `scriptingEnabled: true` で、その場合中身は**生テキスト**になる。
   *
   * 既定のまま使うと、サニタイザからは `<img>` が **0個**に見えて素通りし、
   * 描画側の Blink では**生きた画像**になる。落とす対象が見えていない緑である。
   */
  it("noscript の中身も落ちる（表示フレームはスクリプト無効で解析される）", () => {
    const out = clean('<noscript><img src="https://evil.example/x.png"></noscript>');
    expect(out).not.toContain("evil.example");
  });

  it("template の中身も落ちる", () => {
    const out = clean('<template><img src="https://evil.example/x.png"></template>');
    expect(out).not.toContain("evil.example");
  });

  it("双方向オーバーライド文字は可視化される（Trojan Source）", () => {
    const raw = "<p>abc\u202Edef</p>";
    const out = clean(raw);
    expect(out).not.toContain("\u202E");
    expect(out).toContain("u202e");
  });

  it("ゼロ幅文字も可視化される", () => {
    const out = clean("<p>a\u200Bb</p>");
    expect(out).not.toContain("\u200B");
    expect(out).toContain("u200b");
  });

  it("上限を超える入力は拒否される", () => {
    expect(() => sanitizeHtml("a".repeat(MAX_HTML_CHARS + 1))).toThrow();
  });
});

describe("sanitizeHtml: 通すもの（落とす方向だけでは全部落とす実装が緑になる）", () => {
  it("表と見出しと段落は残る", () => {
    const out = clean(
      "<h2>題</h2><p>本文</p><table><thead><tr><th>A</th></tr></thead>" +
        "<tbody><tr><td>1</td></tr></tbody></table>",
    );
    expect(out).toContain("<h2>");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>");
    expect(out).toContain("<td>");
    expect(out).toContain("題");
    expect(out).toContain("本文");
  });

  it("pre / code は残る", () => {
    const out = clean("<pre><code>const a = 1;</code></pre>");
    expect(out).toContain("<pre>");
    expect(out).toContain("<code>");
    expect(out).toContain("const a = 1;");
  });

  it("リストと強調は残る", () => {
    const out = clean("<ul><li><strong>a</strong></li><li><em>b</em></li></ul>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
  });

  it("SVG の基本図形と描画属性は残る", () => {
    const out = clean(
      '<svg viewBox="0 0 10 10" width="10" height="10">' +
        '<rect x="1" y="1" width="8" height="8" fill="#eee" stroke="#333" stroke-width="2"/>' +
        '<circle cx="5" cy="5" r="3"/>' +
        '<path d="M0 0 L10 10"/>' +
        '<text x="1" y="9" font-size="3" text-anchor="middle">ラベル</text>' +
        "</svg>",
    );
    expect(out).toContain("<svg");
    expect(out).toContain("viewBox");
    expect(out).toContain("<rect");
    expect(out).toContain('d="M0 0 L10 10"');
    expect(out).toContain("stroke-width");
    expect(out).toContain("ラベル");
  });

  it("data: の画像は残る（図を埋め込む唯一の手段）", () => {
    const src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const out = clean(`<img src="${src}" alt="点">`);
    expect(out).toContain("data:image/gif;base64,");
    expect(out).toContain('alt="点"');
  });

  it("id と class は残る（SVG の url(#id) 参照に要る）", () => {
    const out = clean(
      '<svg><linearGradient id="g1"><stop offset="0" stop-color="#fff"/></linearGradient></svg>',
    );
    expect(out).toContain('id="g1"');
    expect(out).toContain("stop-color");
  });

  it("日本語と全角記号はそのまま通る", () => {
    const out = clean("<p>これは　図の説明です（重要）。</p>");
    expect(out).toContain("これは　図の説明です（重要）。");
  });

  it("HTML の特殊文字はエスケープされて残る（消えない）", () => {
    const out = clean("<p>a &lt; b &amp;&amp; c &gt; d</p>");
    expect(out).toContain("&lt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&gt;");
  });
});

describe("sanitizeHtml: 出力を食べ直しても変わらない（冪等）", () => {
  it("2回通しても1回と同じ", () => {
    // 出力がもう一度パーサを通ったときに別の木にならないこと。
    // ここがずれる入力は、描画側の Blink でも別の木になりうる。
    const inputs = [
      "<p>a</p><script>x</script>",
      '<svg><a href="https://evil.example"><rect/></a></svg>',
      '<noscript><img src="https://evil.example/x"></noscript>',
      "<p>abc\u202Edef</p>",
      '<img src="data:image/gif;base64,R0lGOD" alt="x">',
      "<table><tr><td>1</td></tr></table>",
    ];
    for (const input of inputs) {
      const once = sanitizeHtml(input);
      const twice = sanitizeHtml(once);
      expect(twice, `冪等でない: ${input}`).toBe(once);
    }
  });
});

describe("解析モードは行き先の sandbox から導出される（同じ量を2箇所で決めない）", () => {
  it("表示フレームの sandbox は空（すべての権限を落とす）", () => {
    expect(DISPLAY_FRAME_SANDBOX).toBe("");
  });

  it("allow-scripts が無ければスクリプトは無効、あれば有効", () => {
    expect(frameScriptingEnabled("")).toBe(false);
    expect(frameScriptingEnabled("allow-popups")).toBe(false);
    expect(frameScriptingEnabled("allow-scripts")).toBe(true);
    expect(frameScriptingEnabled("allow-popups allow-scripts")).toBe(true);
    expect(frameScriptingEnabled("allow-scripts allow-same-origin")).toBe(true);
  });

  it("現行の表示フレームではスクリプトが無効に導出される", () => {
    // ここが true になる変更を入れたなら、それは表示フレームに allow-scripts を
    // 与えたということである。**その変更は 2C の完了条件を1つ壊している。**
    expect(frameScriptingEnabled(DISPLAY_FRAME_SANDBOX)).toBe(false);
  });
});

describe("sanitizeHtml × CSS: style 属性と <style> 要素", () => {
  it("style 属性の安全な宣言は残り、url() だけが落ちる", () => {
    const out = clean(
      '<p style="color: #333; background-image: url(https://evil.example/x)">a</p>',
    );
    expect(out).toContain("color: #333");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("url");
  });

  it("style 属性が全部落ちたら属性ごと消える（空の style を残さない）", () => {
    const out = clean('<p style="background-image: url(https://evil.example/x)">a</p>');
    expect(out).not.toContain("style");
    expect(out).toContain("a");
  });

  it("<style> の中身は CSS として検査され、@import は落ちる", () => {
    const out = clean(
      "<svg><style>@import url(https://evil.example/x.css); .node rect { fill: #eee }</style>" +
        '<rect class="node"/></svg>',
    );
    expect(out).toContain("<style>");
    expect(out).toContain("fill: #eee");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
  });

  it("<style> の中身が全部落ちたら要素ごと消える", () => {
    const out = clean('<style>@import url("https://evil.example/x.css");</style><p>a</p>');
    expect(out).not.toContain("<style");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("a");
  });

  it("<style> の中身から要素を閉じて抜けられない", () => {
    // `<style>` の中身は直列化でエスケープされない。値の側で `<` を許していないことが
    // ここを閉じている（`sanitize-css.ts` の `QUOTED`）。
    const out = clean(
      '<style>.a { font-family: "x</style><img src=https://evil.example/y>" }</style>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("作図ツールが出す形の SVG が壊れずに通る", () => {
    const out = clean(
      '<svg id="m1" viewBox="0 0 100 50">' +
        "<style>.node rect { fill: #ECECFF; stroke: #9370DB; stroke-width: 1px }" +
        ".edgePath path { stroke: #333 }</style>" +
        '<g class="node"><rect x="0" y="0" width="40" height="20" rx="3"/>' +
        '<text x="20" y="14" text-anchor="middle" style="font-size: 12px">A</text></g>' +
        '<g class="edgePath"><path d="M40 10 L70 10" marker-end="url(#arrow)"/></g>' +
        '<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">' +
        '<path d="M0 0 L6 3 L0 6 z" fill="#333"/></marker></defs></svg>',
    );
    expect(out).toContain("<svg");
    expect(out).toContain("viewBox");
    expect(out).toContain("fill: #ECECFF");
    expect(out).toContain("stroke-width: 1px");
    expect(out).toContain("font-size: 12px");
    expect(out).toContain('marker-end="url(#arrow)"');
    expect(out).toContain('id="arrow"');
    expect(out).toContain("markerWidth");
    expect(out).toContain("<text");
  });
});

/**
 * **出力をもう一度解析して**、禁止されたものが復活していないことを見る。
 *
 * 「落ちた」を出力文字列の部分一致で見ると、属性値の中に無害な文字列として
 * 残っているだけのものまで告発してしまう（逆に、直列化の往復で**要素として
 * 復活する**入力は部分一致では見えない）。だから**木の水準で**見る。
 *
 * ここが mutation XSS の検出器である ―― サニタイザが見た木と、描画側が
 * 出力を解析して得る木がずれたら、ここが赤くなる。
 */
describe("出力を再解析しても禁止要素・禁止属性が現れない（mutation XSS）", () => {
  const FORBIDDEN_TAGS = new Set([
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "link",
    "meta",
    "base",
    "use",
    "foreignobject",
    "image",
    "video",
    "audio",
    "source",
    "track",
    "noscript",
    "template",
    "canvas",
  ]);
  const URL_ATTRS = new Set(["src", "href", "xlink:href", "srcset", "action", "data", "poster"]);

  /** 解析器の切り替わり目・生テキスト・直列化の往復を狙った入力。 */
  const payloads: readonly string[] = [
    '<svg><desc><img src="https://evil.example/1"></desc></svg>',
    '<svg><title><img src="https://evil.example/2"></title></svg>',
    '<svg><foreignObject><img src="https://evil.example/3"></foreignObject></svg>',
    '<math><mtext><img src="https://evil.example/4"></mtext></math>',
    '<math><annotation-xml encoding="text/html"><img src="https://evil.example/5"></annotation-xml></math>',
    '<svg><style><img src="https://evil.example/6"></style></svg>',
    '<style>a{}</style><img src="https://evil.example/7">',
    '<svg><FOREIGNOBJECT><img src="https://evil.example/8"></FOREIGNOBJECT></svg>',
    '<SVG><IMAGE HREF="https://evil.example/9"/></SVG>',
    '<p title="&quot;><img src=https://evil.example/10>">x</p>',
    '<p class="a&gt;&lt;img src=https://evil.example/11&gt;">x</p>',
    '<svg><rect d="M0 0&quot;/><image href=https://evil.example/12"/></svg>',
    '<table><svg><td><img src="https://evil.example/13">',
    '<select><svg><option><img src="https://evil.example/14">',
    '<p><svg></p><img src="https://evil.example/15">',
    '<textarea><img src="https://evil.example/16"></textarea>',
    '<title><img src="https://evil.example/17"></title>',
    '<xmp><img src="https://evil.example/18"></xmp>',
    '<iframe><img src="https://evil.example/19"></iframe>',
    '<!--><img src="https://evil.example/20">-->',
    '<!--[if]><img src="https://evil.example/21"><![endif]-->',
    '<p style="fill: url(https://evil.example/22)">x</p>',
    '<svg><rect fill="url(https://evil.example/23)"/></svg>',
    '<svg><rect clip-path="url( &quot;https://evil.example/24&quot; )"/></svg>',
    '<noscript><style><img src="https://evil.example/25"></style></noscript>',
    '<svg><a xlink:href="https://evil.example/26"><text>x</text></a></svg>',
  ];

  it("検出器が空振りしていない（入力が実際に解析されている）", () => {
    // 出力が全部空文字列でも「禁止要素は無い」と言えてしまう。
    // 通すべきものが通っていることを先に確かめる。
    const kept = sanitizeHtml('<p class="a">残る</p>');
    expect(kept).toContain("残る");
    expect(payloads.length).toBeGreaterThan(20);
  });

  for (const payload of payloads) {
    it(`再解析で復活しない: ${payload.slice(0, 48)}`, () => {
      const out = sanitizeHtml(sanitizeHtml(payload));
      const found: string[] = [];
      const walk = (node: unknown): void => {
        const element = node as {
          tagName?: string;
          attrs?: Array<{ name: string; prefix?: string; value: string }>;
          childNodes?: unknown[];
        };
        if (typeof element.tagName === "string") {
          if (FORBIDDEN_TAGS.has(element.tagName.toLowerCase())) {
            found.push(`要素 ${element.tagName}`);
          }
          for (const attr of element.attrs ?? []) {
            const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
            if (/^on/i.test(name)) found.push(`属性 ${name}`);
            if (URL_ATTRS.has(name.toLowerCase()) && !attr.value.startsWith("data:image/")) {
              found.push(`URL属性 ${name}=${attr.value.slice(0, 60)}`);
            }
          }
        }
        for (const child of element.childNodes ?? []) walk(child);
      };
      walk(reparse(out));
      expect(found, `出力: ${out}`).toEqual([]);
    });
  }
});

/** 出力を **HTML として**解析し直す（行き先と同じ解析モードで）。 */
function reparse(html: string): unknown {
  // 表示フレームはスクリプト無効。行き先と同じモードで解析しないと、
  // ここでの「復活していない」が行き先での事実と食い違う。
  return parseFragment(html, { scriptingEnabled: frameScriptingEnabled(DISPLAY_FRAME_SANDBOX) });
}

describe("src は検証した値をそのまま出す（不変条件14）", () => {
  it("前後の空白は正規形として落ちる", () => {
    const out = sanitizeHtml('<img src=" data:image/png;base64,QQ== ">');
    expect(out).toContain('src="data:image/png;base64,QQ=="');
    expect(out).not.toContain('src=" data:');
  });

  it("data:image/svg+xml は通さない", () => {
    const out = sanitizeHtml('<img src="data:image/svg+xml;base64,QQ==">');
    expect(out).not.toContain("svg+xml");
  });

  it("png / jpeg / gif / webp は通る", () => {
    for (const type of ["png", "jpeg", "gif", "webp"]) {
      const out = sanitizeHtml(`<img src="data:image/${type};base64,QQ==">`);
      expect(out, type).toContain(`data:image/${type};base64,QQ==`);
    }
  });
});

describe("SVG の表示属性は CSS の宣言と同じ関数を通る（不変条件14）", () => {
  const attributes = ["fill", "stroke", "clip-path", "marker-end", "marker-start", "marker-mid"];

  it("CSS のエスケープで url() を作れない", () => {
    // **これが実際に素通しだった。** `url(` の literal を探す別実装が
    // `sanitize-html.ts` にあり、`\28` ＝ `(` を見落としていた。
    for (const attr of attributes) {
      const out = sanitizeHtml(`<svg><rect ${attr}="url\\28 https://evil.example/x\\29"/></svg>`);
      expect(out, attr).not.toContain("evil.example");
    }
  });

  it("素直な url(https://…) も落ちる", () => {
    for (const attr of attributes) {
      const out = sanitizeHtml(`<svg><rect ${attr}="url(https://evil.example/x)"/></svg>`);
      expect(out, attr).not.toContain("evil.example");
    }
  });

  it("局所参照と色は通る（全部落とす実装が緑にならないように）", () => {
    expect(sanitizeHtml('<svg><rect fill="url(#grad1)"/></svg>')).toContain("url(#grad1)");
    expect(sanitizeHtml('<svg><path marker-end="url(#arrow)"/></svg>')).toContain("url(#arrow)");
    expect(sanitizeHtml('<svg><rect fill="#eee" stroke="rgb(51, 51, 51)"/></svg>')).toContain(
      "#eee",
    );
    expect(sanitizeHtml('<svg><rect stroke="rgb(51, 51, 51)"/></svg>')).toContain(
      "rgb(51, 51, 51)",
    );
  });

  it("バックスラッシュを含む値は落ちる（宣言と同じ規則）", () => {
    expect(sanitizeHtml('<svg><rect fill="\\72 ed"/></svg>')).not.toContain("\\72");
  });
});

describe("落とした宣言の件数を返す（設計 D31）", () => {
  it("落とした数を数える", () => {
    const result = sanitizeHtmlWithReport(
      '<p style="color:#111; position:fixed; background-image:url(https://evil.example/x)">a</p>',
    );
    expect(result.droppedDeclarations).toBe(2);
    expect(result.html).toContain("color: #111");
  });

  it("<style> の中で落ちた分も数える", () => {
    const result = sanitizeHtmlWithReport(
      "<style>p { color: red; position: fixed; z-index: 9 }</style>",
    );
    expect(result.droppedDeclarations).toBe(2);
  });

  it("プロパティ名は返さない（許可リストの形状を問い合わせる口にしない）", () => {
    const result = sanitizeHtmlWithReport('<p style="position:fixed">a</p>');
    expect(JSON.stringify(result)).not.toContain("position");
  });

  it("何も落ちなければ 0", () => {
    const result = sanitizeHtmlWithReport('<p style="color:#111">a</p>');
    expect(result.droppedDeclarations).toBe(0);
  });

  it("sanitizeHtml と同じ HTML を返す（2つの実装に分かれていない）", () => {
    const input = '<p style="color:#111; position:fixed">a</p><script>x</script>';
    expect(sanitizeHtmlWithReport(input).html).toBe(sanitizeHtml(input));
  });
});

describe("変換の属性も同じ関数を通る（素通しだった経路）", () => {
  it("SVG の transform は通る", () => {
    // 通さないと図が崩れる。構成図は translate と matrix を多用する。
    const out = sanitizeHtml(
      '<svg><g transform="translate(12, 34)"><rect/></g>' +
        '<g transform="matrix(1,0,0,1,5,5)"><rect/></g>' +
        '<g transform="translate(1,2) rotate(-45)"><rect/></g>' +
        '<linearGradient gradientTransform="rotate(90)"><stop offset="0"/></linearGradient></svg>',
    );
    expect(out).toContain("translate(12, 34)");
    expect(out).toContain("matrix(1,0,0,1,5,5)");
    expect(out).toContain("rotate(-45)");
    expect(out).toContain('gradientTransform="rotate(90)"');
  });

  it("変換に見せかけた任意の値は落ちる", () => {
    for (const value of [
      "url(https://evil.example/x)",
      "translate(10) url(https://evil.example/x)",
      "\\74 ranslate(1)",
      "expression(alert(1))",
    ]) {
      const out = sanitizeHtml(`<svg><g transform="${value}"><rect/></g></svg>`);
      expect(out, value).not.toContain("evil.example");
      expect(out, value).not.toContain("expression");
    }
  });
});

/**
 * **作図ツールを消す前提の検査**（設計 D50 / §6.2）。
 *
 * 「作図ツールは要らない、SVG を直接書けば済む」が成り立つのは、サニタイザが
 * 手書きの構成図を**そのまま通す**ときだけである。通らなければ、削除は
 * 機能の後退になる。増分2C で「攻撃の集合が層の想定より狭いと、外した層の
 * 欠落が見えない」と書いたのと同じ構図で、**削除の前提も測る対象である**。
 *
 * この検査は作図ツールを消したあとも残す ―― サニタイザの許可リストから
 * SVG の要素や属性がうっかり外れたとき、ここが赤くなる。
 */
describe("手書き SVG で構成図が描ける（作図ツール削除の前提）", () => {
  const DIAGRAM = `<h2>呼び出しの流れ</h2>
<svg viewBox="0 0 600 240" width="600" height="240">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/>
    </marker>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#eef"/>
      <stop offset="100%" stop-color="#dde"/>
    </linearGradient>
    <clipPath id="c1"><rect x="0" y="0" width="600" height="240"/></clipPath>
  </defs>
  <style>.box { fill: url(#g1); stroke: #445; stroke-width: 1.5 }
.lbl { font-family: sans-serif; font-size: 13px; fill: #1c1b1a }
.edge { stroke: #555; stroke-width: 1.5; fill: none }</style>
  <g class="node" transform="translate(0,0)" opacity="0.95" clip-path="url(#c1)">
    <rect class="box" x="20" y="40" width="160" height="52" rx="6" ry="6"/>
    <text class="lbl" x="100" y="72" text-anchor="middle" dominant-baseline="middle">Agent</text>
  </g>
  <path class="edge" d="M 180 66 L 236 66" marker-end="url(#arrow)"/>
  <polyline class="edge" points="320,92 320,176 436,176" marker-end="url(#arrow)"/>
  <line class="edge" x1="20" y1="220" x2="580" y2="220" stroke-dasharray="4 3" stroke-linecap="round"/>
  <circle cx="30" cy="220" r="4" fill="#555" fill-opacity="0.8"/>
  <ellipse cx="560" cy="220" rx="6" ry="4" fill="#555"/>
  <polygon points="100,110 120,130 80,130" fill="#889" fill-rule="evenodd"/>
  <text class="lbl" x="300" y="232">stdio<tspan dx="4" fill="#889">(1 hop)</tspan></text>
  <title>構成図</title>
  <desc>エージェント→ブリッジ→拡張</desc>
</svg>`;

  it("宣言を1つも落とさない", () => {
    expect(sanitizeHtmlWithReport(DIAGRAM).droppedDeclarations).toBe(0);
  });

  it("図を組み立てる要素がすべて残る", () => {
    const { html } = sanitizeHtmlWithReport(DIAGRAM);
    for (const tag of [
      "svg",
      "defs",
      "marker",
      "linearGradient",
      "stop",
      "clipPath",
      "style",
      "g",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "path",
      "text",
      "tspan",
      "title",
      "desc",
    ]) {
      // `<line` は `<linearGradient` の頭にも当たる。末尾の空白まで見ないと、
      // line が許可リストから外れても linearGradient の方で緑になり、
      // 赤くなるのは別の主張（stroke-dasharray など）――失敗の理由が嘘になる。
      const needle = tag === "line" ? "<line " : `<${tag}`;
      expect(html, `要素 ${tag} が落ちた`).toContain(needle);
    }
  });

  it("図を組み立てる属性がすべて残る", () => {
    const { html } = sanitizeHtmlWithReport(DIAGRAM);
    for (const attr of [
      "viewBox",
      "transform",
      "marker-end",
      "clip-path",
      "stroke-dasharray",
      "stroke-linecap",
      "dominant-baseline",
      "text-anchor",
      "refX",
      "markerWidth",
      "orient",
      "offset",
      "stop-color",
      "fill-rule",
      "fill-opacity",
      "rx",
      "points",
    ]) {
      expect(html, `属性 ${attr} が落ちた`).toContain(attr);
    }

    // 綴りが他の属性に埋もれるものは、**値そのもの**で主張する。
    // 部分文字列で見ていた間、次の2つは許可リストから外しても緑だった ――
    // 変異検査 38 件中、逃げた 2 件がこれである。
    //
    // `d=` は `id="arrow"` `id="g1"` `id="c1"` `marker-end="url(#arrow)"` にも
    // 含まれる（図の中に7回、うち本物の幾何は2回だけ）。SVG_ATTRIBUTES から
    // "d" を外すと**図の線がすべて消える**のに、`id=` の方で緑のままだった。
    expect(html, "path の d（辺の幾何そのもの）が落ちた").toContain('d="M 180 66 L 236 66"');
    expect(html, "marker の path の d（矢尻）が落ちた").toContain('d="M 0 0 L 10 5 L 0 10 z"');
    // `opacity` は `fill-opacity` に含まれる。g の opacity が落ちても、
    // circle の fill-opacity が残っていれば部分文字列は当たってしまう。
    expect(html, "g の opacity が落ちた").toContain('opacity="0.95"');
  });

  it("局所参照は残り、遠隔の取得は増えない", () => {
    const { html } = sanitizeHtmlWithReport(DIAGRAM);
    expect(html).toContain("url(#arrow)");
    expect(html).toContain("url(#g1)");
    // 同じ図に外向きの参照を混ぜたら、そちらだけが落ちる。
    const withRemote = DIAGRAM.replace(
      '<circle cx="30" cy="220" r="4" fill="#555" fill-opacity="0.8"/>',
      '<image href="https://evil.example/x.png" x="0" y="0" width="10" height="10"/>',
    );
    // `String.replace` は外れても黙って元の文字列を返す。DIAGRAM の綴りが
    // 変わった日に、**攻撃を1つも混ぜないまま**下の2つが真になる。
    // 食わせたことを先に確かめる（「0 件でも egress ゼロは真」と同じ穴）。
    expect(withRemote, "差し込む先の綴りが DIAGRAM から消えている").not.toBe(DIAGRAM);
    const out = sanitizeHtmlWithReport(withRemote).html;
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<image");
  });
});
