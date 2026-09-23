import { describe, expect, it } from "vitest";
import { sanitizeStyleAttribute, sanitizeStyleSheet } from "./sanitize-css.js";

/**
 * CSS の無害化。
 *
 * CSS はスクリプトが無くても**単独でネットワークに出られる**。`@import` は
 * 別のスタイルシートを取りに行き、`url()` は画像・フォント・カーソルを取りに行く。
 * `sandbox=""` の表示フレームにスクリプトが無いことは、ここでは何の保証にもならない。
 *
 * ## 許可制の文法にする理由
 *
 * 「`url(` を含んでいたら落とす」は**禁止制**であり、CSS のエスケープで回避できる
 * （`\75 rl(` は `url(` として解釈される）。だから**書ける形を先に決めて、
 * それ以外を全部落とす**。バックスラッシュはどこにも要らないので、1つでもあれば落とす。
 */

describe("sanitizeStyleAttribute: 落とすもの", () => {
  it("url() は落ちる（リモートも相対も）", () => {
    expect(sanitizeStyleAttribute('background-image: url("https://evil.example/x.png")')).toBe("");
    expect(sanitizeStyleAttribute("background: url(x.png)")).toBe("");
    expect(sanitizeStyleAttribute("cursor: url(https://evil.example/c.cur), auto")).toBe("");
  });

  it("バックスラッシュを含む値は落ちる（CSS エスケープで url を作れる）", () => {
    // `\75 rl(...)` は `url(...)` になる。禁止語の照合をすり抜ける形。
    expect(sanitizeStyleAttribute("background: \\75 rl(https://evil.example/x)")).toBe("");
    expect(sanitizeStyleAttribute("color: \\72 ed")).toBe("");
  });

  it("image-set / -webkit-image-set / element も落ちる", () => {
    expect(sanitizeStyleAttribute("background: image-set('a.png' 1x)")).toBe("");
    expect(sanitizeStyleAttribute("background: -webkit-image-set(url(a.png) 1x)")).toBe("");
    expect(sanitizeStyleAttribute("background: element(#x)")).toBe("");
  });

  it("expression() と behavior は落ちる", () => {
    expect(sanitizeStyleAttribute("width: expression(alert(1))")).toBe("");
    expect(sanitizeStyleAttribute("behavior: url(#default#time2)")).toBe("");
  });

  it("var() は落ちる（別の場所で定義された値を持ち込める）", () => {
    expect(sanitizeStyleAttribute("color: var(--x)")).toBe("");
  });

  it("許可表に無いプロパティは落ちる", () => {
    expect(sanitizeStyleAttribute("position: fixed")).toBe("");
    expect(sanitizeStyleAttribute("content: 'x'")).toBe("");
  });

  it("危ない宣言だけが落ちて、同じ属性の安全な宣言は残る", () => {
    // 1つ危ないものがあったら全部捨てる、にはしない ―― 図の見た目が理由なく壊れる。
    const out = sanitizeStyleAttribute(
      "color: #333; background-image: url(https://evil.example/x)",
    );
    expect(out).toContain("color");
    expect(out).toContain("#333");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("url");
  });

  it("コメントは落ちる（トークンをつなぐのに使える）", () => {
    expect(sanitizeStyleAttribute("color: red /* x */")).toBe("color: red");
    expect(sanitizeStyleAttribute("background: u/**/rl(x)")).toBe("");
  });
});

describe("sanitizeStyleAttribute: 通すもの", () => {
  it("色は通る（名前・16進・rgb・rgba・hsl）", () => {
    expect(sanitizeStyleAttribute("color: red")).toBe("color: red");
    expect(sanitizeStyleAttribute("color: #ff0000")).toBe("color: #ff0000");
    expect(sanitizeStyleAttribute("color: #ff0000aa")).toBe("color: #ff0000aa");
    expect(sanitizeStyleAttribute("color: rgb(255, 0, 0)")).toBe("color: rgb(255, 0, 0)");
    expect(sanitizeStyleAttribute("color: rgba(255, 0, 0, 0.5)")).toBe(
      "color: rgba(255, 0, 0, 0.5)",
    );
    expect(sanitizeStyleAttribute("color: hsl(120, 50%, 50%)")).toBe("color: hsl(120, 50%, 50%)");
  });

  it("寸法と線は通る", () => {
    expect(sanitizeStyleAttribute("stroke-width: 2px")).toBe("stroke-width: 2px");
    expect(sanitizeStyleAttribute("margin: 0 auto")).toBe("margin: 0 auto");
    expect(sanitizeStyleAttribute("border: 1px solid #ccc")).toBe("border: 1px solid #ccc");
    expect(sanitizeStyleAttribute("stroke-dasharray: 4 2")).toBe("stroke-dasharray: 4 2");
  });

  it("文字の指定は通る（引用符つきのフォント名も）", () => {
    expect(sanitizeStyleAttribute("font-size: 12px")).toBe("font-size: 12px");
    expect(sanitizeStyleAttribute('font-family: "Noto Sans JP", sans-serif')).toBe(
      'font-family: "Noto Sans JP", sans-serif',
    );
  });

  it("url(#local) は SVG の参照として通る", () => {
    expect(sanitizeStyleAttribute("marker-end: url(#arrow)")).toBe("marker-end: url(#arrow)");
    expect(sanitizeStyleAttribute("fill: url(#grad1)")).toBe("fill: url(#grad1)");
  });

  it("空の入力は空を返す（投げない）", () => {
    expect(sanitizeStyleAttribute("")).toBe("");
    expect(sanitizeStyleAttribute("   ")).toBe("");
  });
});

describe("sanitizeStyleSheet: <style> の中身", () => {
  it("@import は落ちる", () => {
    const out = sanitizeStyleSheet('@import url("https://evil.example/x.css"); .a { color: red }');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
    expect(out).toContain("color: red");
  });

  it("すべての @ 規則が落ちる（font-face / media / supports）", () => {
    for (const at of [
      '@font-face { font-family: x; src: url("https://evil.example/f.woff") }',
      "@media screen { .a { color: red } }",
      "@supports (display: grid) { .a { color: red } }",
      "@namespace url(https://evil.example/ns);",
    ]) {
      const out = sanitizeStyleSheet(at);
      expect(out, at).not.toContain("evil.example");
      expect(out, at).not.toContain("@");
    }
  });

  it("普通の規則は残り、危ない宣言だけが落ちる", () => {
    const out = sanitizeStyleSheet(
      ".node rect { fill: #eee; stroke: #333 } .edge { background-image: url(https://evil.example/x) }",
    );
    expect(out).toContain(".node rect");
    expect(out).toContain("fill: #eee");
    expect(out).toContain("stroke: #333");
    expect(out).not.toContain("evil.example");
  });

  it("セレクタに括弧やバックスラッシュがあれば規則ごと落ちる", () => {
    expect(sanitizeStyleSheet(".a:not(.b) { color: red }")).toBe("");
    expect(sanitizeStyleSheet(".\\61 { color: red }")).toBe("");
  });

  it("閉じられていない規則で後続が巻き込まれない", () => {
    // `{` を閉じない入力でパーサが飲み込み続けると、後ろの安全な規則まで消える／
    // 逆に危ない宣言が生き残る。どちらに転んでも困るので形を固定する。
    const out = sanitizeStyleSheet(".a { color: red");
    expect(out).toBe("");
  });

  it("空の入力は空を返す", () => {
    expect(sanitizeStyleSheet("")).toBe("");
  });
});

describe("sanitizeStyleSheet: <style> の中身は生テキストとして直列化される", () => {
  it("引用符つきの値で要素を閉じられない", () => {
    // `<style>` の中身はエスケープされずに出るので、値の中に `</style>` が通ると
    // そこで要素が閉じて、後ろが**マークアップとして**解釈される。
    const out = sanitizeStyleSheet(
      '.a { font-family: "x</style><img src=https://evil.example/y>" }',
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("</style");
    expect(out).not.toContain("<");
  });

  it("style 属性でも同じ値が落ちる", () => {
    const out = sanitizeStyleAttribute('font-family: "x</style><img src=https://evil.example/y>"');
    expect(out).toBe("");
  });
});

/**
 * **落とす方向のテストしか無かったので、通るべきものが落ちていた。**
 *
 * 実地で `<style>body{background:#fbfbfa;color:#1c1b1a}</style>` を出したところ、
 * `background` が許可リストに無くて落ち、`color` だけが残り、表示フレームの地が
 * `transparent` なのでダークテーマで**黒地に黒**になった
 * 。
 *
 * 増分2C では「攻撃の集合が層の想定より狭いと、外した層の欠落が見えない」と書いた。
 * 今回はその逆で、**良性の集合を測っていなかったので、通るべきものが落ちていた**。
 * 検査は両方向に要る。
 */
describe("よくある書き方が落ちない（良性の回帰）", () => {
  const benign: ReadonlyArray<readonly [string, string]> = [
    ["background 略記", "background: #fbfbfa"],
    ["background と前景の対", "background: #fbfbfa; color: #1c1b1a"],
    ["border-collapse", "border-collapse: collapse"],
    ["border-spacing", "border-spacing: 0"],
    ["color-scheme", "color-scheme: light dark"],
    ["font 略記", "font: 13px sans-serif"],
    ["border-radius", "border-radius: 4px"],
    ["padding 4値", "padding: 4px 8px 4px 8px"],
    ["margin 2値", "margin: 0 auto"],
    ["line-height", "line-height: 1.5"],
    ["text-align", "text-align: left"],
    ["gap", "gap: 8px"],
    ["list-style-type", "list-style-type: disc"],
    ["overflow-wrap", "overflow-wrap: anywhere"],
    ["tab-size", "tab-size: 2"],
    ["background-color と color", "background-color: #fff; color: #000"],
  ];
  for (const [label, css] of benign) {
    it(`落ちない: ${label}`, () => {
      expect(sanitizeStyleAttribute(css), css).not.toBe("");
    });
  }
});

describe("配色は対で扱う（片方だけ残さない）", () => {
  it("前景が残るなら背景も残る", () => {
    // 配色は前景と背景の**差**でしか意味を持たない量である。片方だけ通すのは
    // 「安全側に倒れた」ではなく、0 でも 1 でもない第三の状態（不可読）を作る。
    const out = sanitizeStyleAttribute("color: #1c1b1a; background: #fbfbfa");
    expect(out).toContain("color: #1c1b1a");
    expect(out, `前景だけ残った: ${out}`).toContain("background");
  });

  it("<style> の中でも同じ", () => {
    const out = sanitizeStyleSheet("body { background: #fbfbfa; color: #1c1b1a }");
    expect(out).toContain("background");
    expect(out).toContain("color: #1c1b1a");
  });
});

describe("略記を足しても遠隔の取得は増えない", () => {
  it("background 略記の url() は落ちる", () => {
    expect(sanitizeStyleAttribute("background: url(https://evil.example/x.png)")).toBe("");
    expect(
      sanitizeStyleAttribute("background: #fff url(https://evil.example/x.png) no-repeat"),
    ).toBe("");
  });

  it("list-style の url() も落ちる", () => {
    expect(sanitizeStyleAttribute("list-style: url(https://evil.example/b.png)")).toBe("");
  });

  it("CSS エスケープを使った略記も落ちる", () => {
    expect(sanitizeStyleAttribute("background: url\\28 https://evil.example/x\\29")).toBe("");
  });

  it("局所参照は通る（SVG の中で使う）", () => {
    expect(sanitizeStyleAttribute("background: url(#pattern1)")).toContain("url(#pattern1)");
  });
});

describe("個別の辺の色（実地で droppedDeclarations: 1 として観測）", () => {
  it("border-left-color などが通る", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      const css = `border-${side}-color: #333`;
      expect(sanitizeStyleAttribute(css), css).toBe(css);
    }
  });
});
