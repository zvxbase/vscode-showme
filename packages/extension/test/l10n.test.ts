import { describe, expect, it } from "vitest";
import { format, t, uiLanguage } from "../src/l10n.js";

/**
 * vitest には "vscode" が無い。この状態で `t()` が**原文（英語）**を返すことが、
 * status-bar など人間向け文字列の単体テストが英語を主張できる根拠である（D58）。
 */
describe("l10n.t（vscode が無いとき）", () => {
  it("原文をそのまま返す", () => {
    expect(t("ShowMe: Off")).toBe("ShowMe: Off");
  });

  it("{0} {1} を引数で埋める（vscode.l10n.t と同じ記法）", () => {
    expect(t("looked for {1} in {0}", "a.ts", "needle")).toBe("looked for needle in a.ts");
    expect(t("pid {0}", 42)).toBe("pid 42");
  });

  it("対応する引数が無いプレースホルダは残す（本物と同じ）", () => {
    expect(format("{0} and {1}", ["x"])).toBe("x and {1}");
  });

  it("引数の中の {0} を再展開しない（1回きりの置換）", () => {
    // 攻撃者が決めうるパスに `{1}` が入っていても、別の引数が流れ込まない。
    expect(t("{0}|{1}", "{1}", "secret")).toBe("{1}|secret");
  });

  it("言語は英語（vscode が無いので既定）", () => {
    expect(uiLanguage()).toBe("en");
  });
});
