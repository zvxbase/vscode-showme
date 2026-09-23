import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * **画家が1つ**であることの構文レベルの検出（増分6 §C2）。
 *
 * `setDecorations(type, ranges)` は「その型の全範囲」を置き換える。`show_code` と注釈が
 * 同じ型を別々に書けば互いを消し合う。だから貼るのは `decorations.ts` の `Highlights`
 * だけで、他は層（`HighlightLayers`）に登録するだけである。次に足された面が自分で
 * `setDecorations` を呼んだら、ここで落ちる（`workspace-path-gate.test.ts` の走査と同じ形）。
 *
 * 見るのは**出荷される側**（`packages/extension/src`）である。
 */
describe("setDecorations を呼ぶのは decorations.ts だけ（増分6 §C2）", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");
  const PAINTER = "decorations.ts";
  /**
   * 呼び出しの綴りに当てる。`editor.setDecorations(` でも `.setDecorations(` の
   * 別名経由でも拾う。コメントでの言及は禁じない（理由を書けなくなる）が、
   * コメントでも `(` を付けて書けば引っかかる ―― それは書き方で避ける。
   */
  const CALLS_SET_DECORATIONS = /setDecorations\s*\(/;

  const walk = (dir: string, into: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, into);
        continue;
      }
      if (full.endsWith(".ts") && !full.endsWith(".test.ts")) into.push(full);
    }
  };

  /** 走査は1回。全検査が同じ一覧を見る。 */
  const files: string[] = [];

  /**
   * **食わせた件数を先に主張する。** `it` の1つに置くと、それが落ちても他の検査は
   * 空の一覧で緑になる（0件でも「違反は無い」は真）。`beforeAll` で落とせば、
   * 下の検査はどれも走らない。
   */
  beforeAll(() => {
    expect(fs.existsSync(SRC_ROOT), `${SRC_ROOT} が無い。検査は何も読まない`).toBe(true);
    walk(SRC_ROOT, files);
    const painter = files.find((f) => path.basename(f) === PAINTER);
    expect(painter, `${PAINTER} が走査に無い`).toBeDefined();
    if (painter === undefined) return;
    // 画家以外のファイルも読んでいる（許可リストだけを見て緑になっていない）。
    expect(files.filter((f) => path.basename(f) !== PAINTER).length).toBeGreaterThan(10);
    // 画家は実際に呼んでいる（検出器が本物の呼び出しに当たる）。
    expect(CALLS_SET_DECORATIONS.test(fs.readFileSync(painter, "utf8"))).toBe(true);
  });

  it("src/ に画家以外で setDecorations を呼ぶファイルが無い", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (path.basename(file) === PAINTER) continue;
      if (CALLS_SET_DECORATIONS.test(fs.readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("塗りの色はテーマ色から借りず、protocol の rgba の表を使う（増分6.1 D78）", () => {
    // テーマ色は意味に付いた色で、色相がテーマで変わる（実機: 黄がオレンジ、紫が青緑）。
    // 表の名前が src/ のどこかに残っていれば誰かが戻したということである。
    const offenders = files.filter((file) =>
      /HIGHLIGHT_THEME_COLORS/.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
    const painter = files.find((f) => path.basename(f) === PAINTER);
    if (painter === undefined) throw new Error(`${PAINTER} が走査に無い`);
    const source = fs.readFileSync(painter, "utf8");
    expect(source).toContain("HIGHLIGHT_RGBA");
    expect(source).toContain("HIGHLIGHT_BORDER_RGBA");
    // 画家が `ThemeColor` を作っていない（コメントでの言及は禁じない。`(` 付きの綴りを見る）。
    expect(source).not.toMatch(/ThemeColor\s*\(/);
  });

  it("ファイルごとの LRU（MAX_HIGHLIGHTED_URIS / highlight-lru）が src/ に無い（D67）", () => {
    // スポットライトは窓ごとで、ファイルごとに残す機構は要らない。名前が残っていれば
    // 誰かが戻したということである。
    const offenders = files.filter((file) =>
      /MAX_HIGHLIGHTED_URIS|highlight-lru/.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
