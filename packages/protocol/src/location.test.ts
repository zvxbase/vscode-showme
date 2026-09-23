import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { locationSchema, markerLocationSchema } from "./location.js";

/**
 * strict な object が知らない鍵で落ちたとき、鍵の名前は `issue.keys` に入る
 * （`issue.path` は object 自身を指す）。「color が落ちた」を鍵の名前で言う。
 */
const namesColor = (error: z.ZodError): boolean =>
  error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("color"));

const ok = (v: unknown) => locationSchema.safeParse(v).success;

describe("locationSchema の境界", () => {
  it("path は1〜1024字", () => {
    expect(ok({ path: "", text: "x" })).toBe(false);
    expect(ok({ path: "a".repeat(1024), text: "x" })).toBe(true);
    expect(ok({ path: "a".repeat(1025), text: "x" })).toBe(false);
  });

  it("text は1〜200字", () => {
    expect(ok({ path: "a.ts", text: "" })).toBe(false);
    expect(ok({ path: "a.ts", text: "x".repeat(200) })).toBe(true);
    expect(ok({ path: "a.ts", text: "x".repeat(201) })).toBe(false);
  });

  it("text に改行は使えない", () => {
    // 照合は行単位なので、複数行にまたがる文字列は永久に当たらない。
    // 黙って 0 件になるより、スキーマで名指しで落とすほうがよい。
    expect(ok({ path: "a.ts", text: "a\nb" })).toBe(false);
    expect(ok({ path: "a.ts", text: "a\rb" })).toBe(false);
    expect(ok({ path: "a.ts", text: "a\r\nb" })).toBe(false);
    expect(ok({ path: "a.ts", text: "a b" })).toBe(true);
  });

  it("symbol は1〜200字", () => {
    expect(ok({ path: "a.ts", symbol: "" })).toBe(false);
    expect(ok({ path: "a.ts", symbol: "s".repeat(200) })).toBe(true);
    expect(ok({ path: "a.ts", symbol: "s".repeat(201) })).toBe(false);
  });

  it("occurrence は1〜50の整数", () => {
    expect(ok({ path: "a.ts", text: "x", occurrence: 0 })).toBe(false);
    expect(ok({ path: "a.ts", text: "x", occurrence: 1 })).toBe(true);
    expect(ok({ path: "a.ts", text: "x", occurrence: 50 })).toBe(true);
    expect(ok({ path: "a.ts", text: "x", occurrence: 51 })).toBe(false);
    expect(ok({ path: "a.ts", text: "x", occurrence: 1.5 })).toBe(false);
  });

  it("lines は1始まりの整数", () => {
    expect(ok({ path: "a.ts", lines: { start: 0, end: 3 } })).toBe(false);
    expect(ok({ path: "a.ts", lines: { start: 1, end: 0 } })).toBe(false);
    expect(ok({ path: "a.ts", lines: { start: 1, end: 3 } })).toBe(true);
    expect(ok({ path: "a.ts", lines: { start: 1.5, end: 3 } })).toBe(false);
    expect(ok({ path: "a.ts", lines: { start: 1 } })).toBe(false);
  });

  it("未知のキーを落とさず拒否する（strict）", () => {
    expect(ok({ path: "a.ts", text: "x", pattern: "AKIA[A-Z0-9]{16}" })).toBe(false);
    expect(ok({ path: "a.ts", text: "x", lines: { start: 1, end: 2, step: 2 } })).toBe(false);
  });

  it("セレクタが1つも無い形はスキーマとしては通る", () => {
    // セレクタの有無はスキーマではなく解決器の責務（resolveLocation が no-selector を返す）。
    // ここで落とさないことを固定しておかないと、どちらの層が持つ責務か黙って動く。
    expect(ok({ path: "a.ts" })).toBe(true);
  });

  it("path を欠いた形は通らない", () => {
    expect(ok({ text: "x" })).toBe(false);
  });
});

/**
 * 色を持つのは `show_code` だけ（増分6 D65'）。塗らないツール（`annotate` / `find_*`）の
 * `location` は `markerLocationSchema` で、`color` を**スキーマで**落とす。
 * 効かない摘みを広告しない ―― 受けて黙って捨てると、エージェントは効いていると思い込む。
 */
describe("markerLocationSchema（D65'）", () => {
  const okMarker = (v: unknown) => markerLocationSchema.safeParse(v).success;

  it("color を渡すと落ちる（issue の path が color を指す）", () => {
    const parsed = markerLocationSchema.safeParse({ path: "a.ts", text: "x", color: "red" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(namesColor(parsed.error)).toBe(true);
    }
  });

  it("肯定対照: color 以外は locationSchema と同じものを受ける", () => {
    expect(okMarker({ path: "a.ts", text: "x" })).toBe(true);
    expect(okMarker({ path: "a.ts", symbol: "s", occurrence: 2 })).toBe(true);
    expect(
      okMarker({ path: "a.ts", lines: { start: 1, end: 2, startColumn: 0, endColumn: 3 } }),
    ).toBe(true);
    // 元の境界も引き継いでいる（omit で別物になっていない）。
    expect(okMarker({ path: "", text: "x" })).toBe(false);
    expect(okMarker({ path: "a.ts", text: "a\nb" })).toBe(false);
  });

  it("strict のまま（omit で緩んでいない）", () => {
    expect(okMarker({ path: "a.ts", text: "x", pattern: ".*" })).toBe(false);
    expect(ok({ path: "a.ts", text: "x", pattern: ".*" })).toBe(false);
  });

  it("対照: locationSchema は color を受ける（show_code の摘みは残る）", () => {
    expect(ok({ path: "a.ts", text: "x", color: "red" })).toBe(true);
  });
});
