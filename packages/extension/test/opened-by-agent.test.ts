import { describe, expect, it } from "vitest";
import { OpenedByAgent } from "../src/opened-by-agent.js";

/**
 * `show_code` が開いた文書の記録（設計 増分5 D53 / §C2）。
 *
 * **記録はメモリだけ**（不変条件13）で、vscode に触らない ―― だから vitest で
 * 全部確かめられる。ここが正しくないと、`close-own` が人間のタブを閉じる
 * （覚えすぎ）か、自分のタブを片づけられない（忘れすぎ）かのどちらかになる。
 */
describe("OpenedByAgent（D53）", () => {
  it("開いたら覚え、閉じたら忘れる", () => {
    const r = new OpenedByAgent();
    r.opened("file:///a.ts");
    expect(r.has("file:///a.ts")).toBe(true);
    r.closed("file:///a.ts");
    expect(r.has("file:///a.ts")).toBe(false);
  });

  it("知らないものは own でない（空の記録は何も所有しない）", () => {
    expect(new OpenedByAgent().has("file:///a.ts")).toBe(false);
  });

  it("知らないものを閉じても投げない", () => {
    expect(() => new OpenedByAgent().closed("x")).not.toThrow();
  });

  it("鍵は完全一致（綴り違いは別の文書）", () => {
    const r = new OpenedByAgent();
    r.opened("file:///a.ts");
    expect(r.has("file:///a.ts/")).toBe(false);
    expect(r.has("file:///A.ts")).toBe(false);
    expect(r.has("a.ts")).toBe(false);
  });

  it("同じものを2回開いても1つ", () => {
    const r = new OpenedByAgent();
    r.opened("a");
    r.opened("a");
    expect(r.size).toBe(1);
  });

  it("上限を超えたら古いものから忘れる（際限なく溜めない）", () => {
    const r = new OpenedByAgent(3);
    r.opened("a");
    r.opened("b");
    r.opened("c");
    r.opened("d");
    expect(r.has("a")).toBe(false);
    expect(r.has("b")).toBe(true);
    expect(r.has("d")).toBe(true);
    expect(r.size).toBe(3);
  });

  it("開き直したものは新しい側に回る（上限で先に忘れるのは触っていない古いもの）", () => {
    const r = new OpenedByAgent(2);
    r.opened("a");
    r.opened("b");
    r.opened("a"); // a を開き直す → b が最古
    r.opened("c");
    expect(r.has("b")).toBe(false);
    expect(r.has("a")).toBe(true);
    expect(r.has("c")).toBe(true);
  });

  it("既定の上限は 256", () => {
    const r = new OpenedByAgent();
    for (let i = 0; i < 300; i += 1) r.opened(`k${i}`);
    expect(r.size).toBe(256);
    expect(r.has("k0")).toBe(false);
    expect(r.has("k43")).toBe(false);
    expect(r.has("k44")).toBe(true);
    expect(r.has("k299")).toBe(true);
  });

  it("clear で全部忘れる", () => {
    const r = new OpenedByAgent();
    r.opened("a");
    r.opened("b");
    r.clear();
    expect(r.size).toBe(0);
    expect(r.has("a")).toBe(false);
  });
});
