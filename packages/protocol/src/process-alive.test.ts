import { describe, expect, it } from "vitest";
import { processIsAlive } from "./process-alive.js";

describe("processIsAlive（拡張の掃除とブリッジの走査が同じ判定を通す）", () => {
  it("自分の pid は生きている", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("ESRCH のときだけ死んでいる。EPERM（他人のプロセス）は生きている側に倒す", () => {
    const kill = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(processIsAlive(4242, kill("ESRCH"))).toBe(false);
    expect(processIsAlive(4242, kill("EPERM"))).toBe(true);
    expect(processIsAlive(4242, () => true)).toBe(true);
  });

  it("0 以下・整数でない pid は kill に渡さず、死んでいるとする（kill(0) はプロセスグループに飛ぶ）", () => {
    const seen: number[] = [];
    const kill = (pid: number) => {
      seen.push(pid);
      return true;
    };
    expect(processIsAlive(0, kill)).toBe(false);
    expect(processIsAlive(-1, kill)).toBe(false);
    expect(processIsAlive(1.5, kill)).toBe(false);
    expect(seen).toEqual([]);
  });
});
