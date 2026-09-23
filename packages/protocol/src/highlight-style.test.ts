import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as highlightStyle from "./highlight-style.js";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_BORDER_RGBA,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_RGBA,
  toHighlightColor,
} from "./highlight-style.js";

/** 半透明の rgba だけを許す。`0.` で始まる alpha が無いと、不透明で文字が読めなくなる。 */
const TRANSLUCENT_RGBA = /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/;

describe("ハイライトの色（設計 D35）", () => {
  it("語彙は見た目であって意味ではない", () => {
    // **意味の名前を入れない。** 「definition」「warning」のような名前を入れると、
    // 意味づけが機構に染み出す ―― この repo が最初に退けた形である。
    for (const color of HIGHLIGHT_COLORS) {
      expect(color, `意味の名前が混ざっている: ${color}`).toMatch(
        /^(yellow|green|red|blue|purple|grey)$/,
      );
    }
  });

  it("すべての色に light / dark の半透明 rgba が対応している（増分6.1 D78）", () => {
    for (const color of HIGHLIGHT_COLORS) {
      expect(HIGHLIGHT_RGBA[color]?.light, `${color}.light`).toMatch(TRANSLUCENT_RGBA);
      expect(HIGHLIGHT_RGBA[color]?.dark, `${color}.dark`).toMatch(TRANSLUCENT_RGBA);
      expect(HIGHLIGHT_BORDER_RGBA[color]?.light, `border ${color}.light`).toMatch(
        TRANSLUCENT_RGBA,
      );
      expect(HIGHLIGHT_BORDER_RGBA[color]?.dark, `border ${color}.dark`).toMatch(TRANSLUCENT_RGBA);
    }
    expect(Object.keys(HIGHLIGHT_RGBA).sort()).toEqual([...HIGHLIGHT_COLORS].sort());
    expect(Object.keys(HIGHLIGHT_BORDER_RGBA).sort()).toEqual([...HIGHLIGHT_COLORS].sort());
  });

  it("塗りと縁は同じ色相（rgb が一致し、縁のほうが濃い）", () => {
    // 縁だけテーマ色から借りると、縁がテーマのオレンジに引かれて色相が濁る（実機所見）。
    const rgb = (s: string): string => s.replace(/, 0\.\d+\)$/, ")");
    const alpha = (s: string): number => Number(/, (0\.\d+)\)$/.exec(s)?.[1]);
    for (const color of HIGHLIGHT_COLORS) {
      for (const theme of ["light", "dark"] as const) {
        expect(rgb(HIGHLIGHT_BORDER_RGBA[color][theme]), `${color}.${theme}`).toBe(
          rgb(HIGHLIGHT_RGBA[color][theme]),
        );
        expect(alpha(HIGHLIGHT_BORDER_RGBA[color][theme])).toBeGreaterThan(
          alpha(HIGHLIGHT_RGBA[color][theme]),
        );
      }
    }
  });

  it("色相が名前どおり（rgb の最大成分が名前の色相に対応する）", () => {
    // テーマ色から借りていたときは、黄がオレンジに、紫が青緑に見えた。名前と色相を
    // 実装が固定する（D78）。ここは粗い検査で、細かい見え方は実機の行が持つ。
    const parse = (s: string): [number, number, number] => {
      const m = /^rgba\((\d+), (\d+), (\d+), /.exec(s);
      if (m === null) throw new Error(`rgba ではない: ${s}`);
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    for (const theme of ["light", "dark"] as const) {
      const [yr, yg, yb] = parse(HIGHLIGHT_RGBA.yellow[theme]);
      expect(yr).toBeGreaterThan(200);
      expect(yg).toBeGreaterThan(180);
      expect(yb).toBeLessThan(100);
      const [gr, gg, gb] = parse(HIGHLIGHT_RGBA.green[theme]);
      expect(gg).toBeGreaterThan(gr);
      expect(gg).toBeGreaterThan(gb);
      const [rr, rg, rb] = parse(HIGHLIGHT_RGBA.red[theme]);
      expect(rr).toBeGreaterThan(rg);
      expect(rr).toBeGreaterThan(rb);
      const [br, bg, bb] = parse(HIGHLIGHT_RGBA.blue[theme]);
      // 「青が最大」だけでは紫（赤も青も大きい）でも真になる。赤が青の半分未満で青。
      expect(bb).toBeGreaterThan(2 * br);
      expect(bb).toBeGreaterThan(bg);
      const [pr, pg, pb] = parse(HIGHLIGHT_RGBA.purple[theme]);
      expect(pr).toBeGreaterThan(pg);
      expect(pb).toBeGreaterThan(pg);
      // 紫は青の述語を満たさない（2色が同じ色相に倒れていない）。
      expect(pb).not.toBeGreaterThan(2 * pr);
      const [er, eg, eb] = parse(HIGHLIGHT_RGBA.grey[theme]);
      expect(er).toBe(eg);
      expect(eg).toBe(eb);
    }
  });

  it("テーマ色の表（HIGHLIGHT_THEME_COLORS）は無い（D78）", () => {
    // 名前が残っていれば誰かが戻したということである。モジュールの鍵と綴りの両方を見る。
    expect(Object.keys(highlightStyle)).not.toContain("HIGHLIGHT_THEME_COLORS");
    const source = fs.readFileSync(path.join(__dirname, "highlight-style.ts"), "utf8");
    expect(source).not.toContain("HIGHLIGHT_THEME_COLORS");
    expect(source).not.toContain("ThemeColor");
  });

  it("知らない名前は既定に落ちる（拒否しない）", () => {
    // 色が違うことより、ハイライトが出ないことのほうが体験を壊す。
    expect(toHighlightColor("chartreuse")).toBe(DEFAULT_HIGHLIGHT_COLOR);
    expect(toHighlightColor(undefined)).toBe(DEFAULT_HIGHLIGHT_COLOR);
    expect(toHighlightColor(42)).toBe(DEFAULT_HIGHLIGHT_COLOR);
    expect(toHighlightColor("editor.background")).toBe(DEFAULT_HIGHLIGHT_COLOR);
  });

  it("知っている名前はそのまま通る", () => {
    for (const color of HIGHLIGHT_COLORS) {
      expect(toHighlightColor(color)).toBe(color);
    }
  });
});
