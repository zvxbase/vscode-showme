import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { locationSchema } from "./location.js";

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
 * 色を持つ位置は無い（増分13 D116。`show_code` も塗らなくなった）。以前は `show_code` だけが
 * `color` を持ち、塗らないツールは `color` を外した別のスキーマを使っていた（増分6 D65'）。
 * 効かない摘みを広告しない ―― 受けて黙って捨てると、エージェントは効いていると思い込む。
 */
describe("locationSchema は color を持たない（D116 / D65'）", () => {
  it("color を渡すと落ちる（issue が color を名指す）", () => {
    const parsed = locationSchema.safeParse({ path: "a.ts", text: "x", color: "red" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(namesColor(parsed.error)).toBe(true);
    }
  });

  it("肯定対照: color 以外の位置の指定はそのまま受ける", () => {
    expect(ok({ path: "a.ts", text: "x" })).toBe(true);
    expect(ok({ path: "a.ts", symbol: "s", occurrence: 2 })).toBe(true);
    expect(ok({ path: "a.ts", lines: { start: 1, end: 2, startColumn: 0, endColumn: 3 } })).toBe(
      true,
    );
  });
});

describe("occurrence と text の説明（増分13 D118 のレビュー）", () => {
  it("occurrence は行を数え、1行に2回あれば行全体、1つに絞るのは lines の列、と言う", () => {
    const occ = locationSchema.shape.occurrence.description ?? "";
    expect(occ).toContain("counts lines");
    const text = locationSchema.shape.text.description ?? "";
    expect(text).toContain("only the matched text");
    expect(text).toContain("more than once");
    expect(text).toContain("whole line");
    expect(text).toContain("startColumn and endColumn");
  });
});
