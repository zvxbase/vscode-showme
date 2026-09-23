import { describe, expect, it } from "vitest";
import { hasColumns } from "./line-range.js";

/**
 * 範囲が**文字単位か行全体か**の判定。
 *
 * この判定を1箇所に持つことが要点である。装飾の型は `isWholeLine` を焼き込むので、
 * 貼る側（`decorations.ts`）に範囲の形から推測させると必ず外れる ――
 * `toRange` は行全体のとき終端の列に `Number.MAX_SAFE_INTEGER` を置くので、
 * 「終端が 0 なら行全体」のような推測は成立しない（不変条件14）。
 */
describe("hasColumns", () => {
  it("両方そろったときだけ文字単位", () => {
    expect(hasColumns({ startLine: 1, endLine: 1, startColumn: 2, endColumn: 8 })).toBe(true);
  });

  it("行だけの指定は行全体（今までどおり通る）", () => {
    expect(hasColumns({ startLine: 1, endLine: 3 })).toBe(false);
  });

  it("片方だけなら行全体に倒す", () => {
    // 「開始だけ指定して終端は行末」を許すと、範囲の意味が呼び出しごとに変わる。
    expect(hasColumns({ startLine: 1, endLine: 1, startColumn: 2 })).toBe(false);
    expect(hasColumns({ startLine: 1, endLine: 1, endColumn: 8 })).toBe(false);
  });

  it("列 0 は「指定なし」ではない", () => {
    // `startColumn: 0` を falsy として扱うと、行頭から始まる指定が黙って
    // 行全体になる。`undefined` かどうかで見ること。
    expect(hasColumns({ startLine: 1, endLine: 1, startColumn: 0, endColumn: 4 })).toBe(true);
  });
});
