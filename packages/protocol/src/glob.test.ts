import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.js";

describe("matchGlob", () => {
  it("リテラルは完全一致で当たる", () => {
    expect(matchGlob(".env", ".env")).toBe(true);
    expect(matchGlob(".envx", ".env")).toBe(false);
  });

  it("* はセパレータを跨がない", () => {
    expect(matchGlob("b.pem", "*.pem")).toBe(true);
    expect(matchGlob("a/b.pem", "*.pem")).toBe(false);
  });

  it("** はセパレータを跨ぐ", () => {
    expect(matchGlob("a/b/c.pem", "secrets/**")).toBe(false);
    expect(matchGlob("secrets/a/b.txt", "secrets/**")).toBe(true);
    expect(matchGlob("secrets/x.txt", "secrets/**")).toBe(true);
  });

  it("? は1文字に当たる（セパレータは除く）", () => {
    expect(matchGlob("ab", "a?")).toBe(true);
    expect(matchGlob("a/b", "a?b")).toBe(false);
  });

  it("大文字小文字を区別しない", () => {
    expect(matchGlob(".ENV", ".env")).toBe(true);
    expect(matchGlob("KEYS/ID_RSA", "id_rsa*")).toBe(false);
    expect(matchGlob("keys/ID_RSA", "keys/id_rsa*")).toBe(true);
  });

  it("正規表現のメタ文字はリテラルとして扱う", () => {
    expect(matchGlob("a.b", "a.b")).toBe(true);
    expect(matchGlob("axb", "a.b")).toBe(false);
    expect(matchGlob("a+b", "a+b")).toBe(true);
    expect(matchGlob("(x)", "(x)")).toBe(true);
  });

  it("破滅的バックトラックを起こさない（本質のテスト）", () => {
    // 正規表現版はこの形で 95 秒かかった。後戻りしない照合器なら線形に近い。
    const evil = `${"*a".repeat(30)}Z`;
    const subject = "a".repeat(1024);
    const started = Date.now();
    expect(matchGlob(subject, evil)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("連続するグロブスターでも遅くならない", () => {
    const started = Date.now();
    expect(matchGlob(`${"a/".repeat(40)}x.txt`, `${"**/".repeat(30)}*.pem`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
