import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_LIMIT,
  MAX_PANEL_SLOT,
  type PanelLimit,
  panelLimitSchema,
  panelSlotAllowed,
} from "./panel-limit.js";
import { panelSlotSchema } from "./wire.js";

/**
 * パネルの上限は人間の設定（増分6.2 D80）。
 *
 * 線上の `slot` は整数 1〜`MAX_PANEL_SLOT`（999）で、999 は線の健全性のための絶対上限であって
 * 「無制限」の定義ではない。**設定の上限との比較は `panelSlotAllowed` 1つ**が持ち、
 * 拡張の `show-html.ts` もここを通る（スキーマは上限を知らない ―― 知ると同じ量を2箇所で決める）。
 */
describe("panelSlotSchema（線上の slot は整数 1〜999）", () => {
  const ok = (v: unknown) => panelSlotSchema.safeParse(v).success;

  it("1 と 999 は通る。0 / 1000 / 1.5 / 文字列は落ちる", () => {
    expect(ok(1)).toBe(true);
    expect(ok(2)).toBe(true);
    expect(ok(3)).toBe(true);
    expect(ok(MAX_PANEL_SLOT)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(MAX_PANEL_SLOT + 1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(ok("1")).toBe(false);
    expect(ok(-1)).toBe(false);
  });

  it("絶対上限は 999", () => {
    expect(MAX_PANEL_SLOT).toBe(999);
  });
});

describe("panelLimitSchema（設定の値の線上の形）", () => {
  const ok = (v: unknown) => panelLimitSchema.safeParse(v).success;

  it('整数 1〜999 と "unlimited" だけが通る', () => {
    expect(ok(1)).toBe(true);
    expect(ok(2)).toBe(true);
    expect(ok(999)).toBe(true);
    expect(ok("unlimited")).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(1000)).toBe(false);
    expect(ok(2.5)).toBe(false);
    expect(ok("2")).toBe(false);
    expect(ok("Unlimited")).toBe(false);
    expect(ok("infinite")).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it("既定は 2（不変条件10 の「既定2」と同じ1つの値）", () => {
    expect(DEFAULT_PANEL_LIMIT).toBe(2);
    expect(ok(DEFAULT_PANEL_LIMIT)).toBe(true);
  });
});

describe("panelSlotAllowed（上限の判定はここ1つ）", () => {
  /** 表: 上限 × 枠。`true` は出せる。 */
  const table: Array<{ limit: PanelLimit; slot: number; allowed: boolean }> = [
    { limit: 1, slot: 1, allowed: true },
    { limit: 1, slot: 2, allowed: false },
    { limit: 1, slot: 999, allowed: false },
    { limit: 2, slot: 1, allowed: true },
    { limit: 2, slot: 2, allowed: true },
    { limit: 2, slot: 3, allowed: false },
    { limit: 2, slot: 999, allowed: false },
    { limit: 5, slot: 1, allowed: true },
    { limit: 5, slot: 5, allowed: true },
    { limit: 5, slot: 6, allowed: false },
    { limit: 5, slot: 999, allowed: false },
    { limit: "unlimited", slot: 1, allowed: true },
    { limit: "unlimited", slot: 2, allowed: true },
    { limit: "unlimited", slot: 10, allowed: true },
    { limit: "unlimited", slot: 999, allowed: true },
  ];
  for (const { limit, slot, allowed } of table) {
    it(`max ${String(limit)} × slot ${slot} → ${allowed ? "出せる" : "断る"}`, () => {
      expect(panelSlotAllowed(slot, limit)).toBe(allowed);
    });
  }

  it("unlimited は「設定の上限を当てない」であって、線の絶対上限を越えた値を許す意味ではない（そちらはスキーマが落とす）", () => {
    // `panelSlotAllowed` は上限の比較だけをする。線の健全性（1〜999）はスキーマの仕事で、
    // ここで二重に切らない（同じ量を2箇所で決めない）。
    expect(panelSlotAllowed(MAX_PANEL_SLOT, "unlimited")).toBe(true);
    expect(panelSlotSchema.safeParse(MAX_PANEL_SLOT + 1).success).toBe(false);
  });
});
