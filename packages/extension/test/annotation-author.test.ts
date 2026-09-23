import { ANNOTATION_COLORS } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_AUTHOR,
  ANNOTATION_AUTHOR_DEFAULT,
  annotationAuthor,
} from "../src/annotation-author.js";

/**
 * 番号つきの作者名（増分6 D69）。**整形は純関数1つ**。
 *
 * D57 の性質（作者名は表の値だけで、エージェントの文字列が入る経路が無い）は
 * 番号が付いても保たれる ―― 入るのは表の値と整数だけである。
 * 表そのものの検査（5色の値・網羅・無印）は `annotate.test.ts` にある。
 */
describe("annotationAuthor（D69）", () => {
  it("1件だけなら番号を出さない（D57 のまま）", () => {
    for (const color of ANNOTATION_COLORS) {
      expect(annotationAuthor(color, 1, 1)).toBe(ANNOTATION_AUTHOR[color]);
    }
    expect(annotationAuthor(undefined, 1, 1)).toBe(ANNOTATION_AUTHOR_DEFAULT);
  });

  it("2件以上なら `index/total ·` が先頭に付く（5色＋無印）", () => {
    expect(annotationAuthor("yellow", 1, 2)).toBe("1/2 · ShowMe 🟡 Y");
    expect(annotationAuthor("green", 2, 2)).toBe("2/2 · ShowMe 🟢 G");
    expect(annotationAuthor("red", 1, 2)).toBe("1/2 · ShowMe 🔴 R");
    expect(annotationAuthor("blue", 2, 2)).toBe("2/2 · ShowMe 🔵 B");
    expect(annotationAuthor("purple", 1, 2)).toBe("1/2 · ShowMe 🟣 P");
    expect(annotationAuthor(undefined, 2, 2)).toBe("2/2 · ShowMe");
  });

  it("途中の番号もそのまま（3/7）", () => {
    expect(annotationAuthor("red", 3, 7)).toBe("3/7 · ShowMe 🔴 R");
    expect(annotationAuthor(undefined, 3, 7)).toBe("3/7 · ShowMe");
  });

  it("2件以上でも名前の部分は表の値そのもの（値を組み立て直していない）", () => {
    for (const color of ANNOTATION_COLORS) {
      expect(annotationAuthor(color, 2, 3).endsWith(ANNOTATION_AUTHOR[color])).toBe(true);
    }
    expect(annotationAuthor(undefined, 2, 3).endsWith(ANNOTATION_AUTHOR_DEFAULT)).toBe(true);
  });

  /**
   * 番号はストアが決める量で、外から入る値ではない。矛盾した番号は入力の誤りではなく
   * **バグ**なので、黙って直さず投げる（`3/2` の作者名が画面に出てから気づくより早い）。
   */
  it("矛盾した番号は投げる（index > total、0、負、非整数）", () => {
    expect(() => annotationAuthor("red", 3, 2)).toThrow();
    expect(() => annotationAuthor("red", 0, 1)).toThrow();
    expect(() => annotationAuthor("red", 1, 0)).toThrow();
    expect(() => annotationAuthor("red", -1, 2)).toThrow();
    expect(() => annotationAuthor("red", 1.5, 2)).toThrow();
    expect(() => annotationAuthor("red", 1, 2.5)).toThrow();
    expect(() => annotationAuthor("red", Number.NaN, 2)).toThrow();
  });
});
