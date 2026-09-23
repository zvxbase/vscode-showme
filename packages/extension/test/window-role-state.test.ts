import { describe, expect, it } from "vitest";
import { WindowRoleState } from "../src/window-role-state.js";

describe("WindowRoleState", () => {
  it("既定は idle（預けていない）", () => {
    expect(new WindowRoleState().current()).toBe("idle");
  });

  it("toggle で stage と idle を往復する", () => {
    const s = new WindowRoleState();
    expect(s.toggle()).toBe("stage");
    expect(s.current()).toBe("stage");
    expect(s.toggle()).toBe("idle");
    expect(s.current()).toBe("idle");
  });

  it("変化したときだけ購読者を呼ぶ", () => {
    const s = new WindowRoleState();
    const seen: string[] = [];
    s.onChange((r) => seen.push(r));
    s.toggle(); // idle -> stage
    s.set("stage"); // 変化なし
    s.set("idle"); // stage -> idle
    expect(seen).toEqual(["stage", "idle"]);
  });

  it("購読を解くと以後は呼ばれない", () => {
    const s = new WindowRoleState();
    const seen: string[] = [];
    const sub = s.onChange((r) => seen.push(r));
    s.toggle();
    sub.dispose();
    s.toggle();
    expect(seen).toEqual(["stage"]);
  });

  it("購読者が複数いれば全員が呼ばれる", () => {
    const s = new WindowRoleState();
    const a: string[] = [];
    const b: string[] = [];
    s.onChange((r) => a.push(r));
    s.onChange((r) => b.push(r));
    s.toggle();
    expect(a).toEqual(["stage"]);
    expect(b).toEqual(["stage"]);
  });

  it("dispose 後は購読者を呼ばない", () => {
    const s = new WindowRoleState();
    const seen: string[] = [];
    s.onChange((r) => seen.push(r));
    s.dispose();
    s.toggle();
    expect(seen).toEqual([]);
  });

  it("dispose 後は役割が動かない（idle のまま）", () => {
    const s = new WindowRoleState();
    s.dispose();
    expect(s.toggle()).toBe("idle");
    s.set("stage");
    expect(s.current()).toBe("idle");
  });

  it("dispose 後に onChange を足しても呼ばれない", () => {
    const s = new WindowRoleState();
    const seen: string[] = [];
    s.dispose();
    s.onChange((r) => seen.push(r));
    s.toggle();
    expect(seen).toEqual([]);
  });

  it("dispose は繰り返し呼んでも安全", () => {
    const s = new WindowRoleState();
    s.dispose();
    expect(() => s.dispose()).not.toThrow();
  });

  it("通知中に購読を解いても、その回の他の購読者は呼ばれる", () => {
    const s = new WindowRoleState();
    const seen: string[] = [];
    const first = s.onChange(() => first.dispose());
    s.onChange((r) => seen.push(r));
    expect(() => s.toggle()).not.toThrow();
    expect(seen).toEqual(["stage"]);
  });

  it("窓の識別子は生成され、変わらない", () => {
    const s = new WindowRoleState();
    const id = s.windowId;
    s.toggle();
    s.toggle();
    expect(s.windowId).toBe(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("別のインスタンスは別の識別子を持つ", () => {
    expect(new WindowRoleState().windowId).not.toBe(new WindowRoleState().windowId);
  });
});
