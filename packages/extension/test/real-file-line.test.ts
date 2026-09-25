import { describe, expect, it } from "vitest";
import { lineToCarry } from "../src/real-file-line.js";

/**
 * 「本物のファイルを開く」（D87）が本物のファイルへ持っていく行。
 *
 * 映しのカーソルは、エージェントが開いただけなら 0 行目に置かれたまま（`show_code` は
 * `selection` に触らない ―― 不変条件3）なので、見えていないカーソルは人間の読んでいる
 * 位置ではない。見えているカーソルは人間がそこに置いたもの（か、画面の中にある）なので
 * それを持っていく。そうでなければ今見えている範囲の真ん中 ―― 開く側が
 * `InCenterIfOutsideViewport` で中央に出すので、真ん中を渡すと画面がほぼ同じ位置になる。
 */
describe("lineToCarry（映しから本物のファイルへ持っていく行）", () => {
  it("カーソルが見えている範囲にあれば、その行", () => {
    expect(lineToCarry({ cursorLine: 120, visible: [{ start: 100, end: 140 }] })).toBe(120);
    // 端も含む。
    expect(lineToCarry({ cursorLine: 100, visible: [{ start: 100, end: 140 }] })).toBe(100);
    expect(lineToCarry({ cursorLine: 140, visible: [{ start: 100, end: 140 }] })).toBe(140);
  });

  it("カーソルが見えていなければ、見えている最初の範囲の真ん中", () => {
    expect(lineToCarry({ cursorLine: 0, visible: [{ start: 280, end: 320 }] })).toBe(300);
    expect(lineToCarry({ cursorLine: 0, visible: [{ start: 281, end: 320 }] })).toBe(300);
  });

  it("折りたたみで範囲が割れていても、どれかに入っていればカーソルの行", () => {
    const visible = [
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ];
    expect(lineToCarry({ cursorLine: 55, visible })).toBe(55);
    expect(lineToCarry({ cursorLine: 30, visible })).toBe(15);
  });

  it("見えている範囲が無ければカーソルの行、それも無ければ 0", () => {
    expect(lineToCarry({ cursorLine: 7, visible: [] })).toBe(7);
    expect(lineToCarry({ cursorLine: undefined, visible: [] })).toBe(0);
    expect(lineToCarry({ cursorLine: undefined, visible: [{ start: 4, end: 8 }] })).toBe(6);
  });
});
