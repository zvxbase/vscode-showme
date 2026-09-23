import { MAX_FOUND_LOCATIONS } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { foldProviderResult } from "./language-lookup.js";

const TRUSTED = { isTrusted: true };
const RESTRICTED = { isTrusted: false };

describe("foldProviderResult", () => {
  it("引けたが0件なら none と not-found", () => {
    const out = foldProviderResult([], TRUSTED);
    expect(out.match).toBe("none");
    expect(out.reason).toBe("not-found");
    expect(out.locations).toEqual([]);
  });

  it("1件なら one", () => {
    const out = foldProviderResult([{ path: "a.ts", line: 3, column: 4 }], TRUSTED);
    expect(out.match).toBe("one");
    expect(out.locations).toEqual([{ path: "a.ts", line: 3, column: 4 }]);
    expect(out.reason).toBeUndefined();
  });

  it("複数なら many。上限で切る", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: "a.ts", line: i + 1, column: 0 }));
    const out = foldProviderResult(many, TRUSTED);
    expect(out.match).toBe("many");
    expect(out.locations).toHaveLength(MAX_FOUND_LOCATIONS);
  });

  it("正確な件数を返さない（無音のオラクルにしない）", () => {
    // 50件あることも、上限で切ったことも、切った数も言わない。
    const many = Array.from({ length: 50 }, (_, i) => ({ path: "a.ts", line: i + 1, column: 0 }));
    const serialized = JSON.stringify(foldProviderResult(many, TRUSTED));
    expect(serialized).not.toContain("50");
    expect(serialized).not.toContain("truncated");
    expect(serialized).not.toContain("total");
  });

  it("引けなかったとき、制限モードとプロバイダ不在を区別する", () => {
    // **どちらかでエージェントの次の手が変わる。** 制限モードなら人間に信頼を
    // 求めればよいが、プロバイダ不在なら待っても無駄である。
    expect(foldProviderResult(undefined, RESTRICTED).reason).toBe("restricted-mode");
    expect(foldProviderResult(undefined, TRUSTED).reason).toBe("no-provider");
  });

  it("入力の配列を持ち回らない（呼び出し側の配列を後から変えても結果が動かない）", () => {
    const source = [{ path: "a.ts", line: 1, column: 0 }];
    const out = foldProviderResult(source, TRUSTED);
    source[0] = { path: "b.ts", line: 9, column: 9 };
    expect(out.locations[0]?.path).toBe("a.ts");
  });
});

describe("上限は舞台の上限とは別の量である", () => {
  it("舞台（3）より大きい", () => {
    // 混ぜると「参照が3件しか返らない」か「舞台が20列になる」のどちらかになる。
    expect(MAX_FOUND_LOCATIONS).toBeGreaterThan(3);
  });
});
