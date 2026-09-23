import { describe, expect, it } from "vitest";
import { watchablePattern } from "./watch-pattern.js";

describe("watchablePattern（show_html の path の見張り）", () => {
  it("普通の綴りはそのまま。関門と同じ正規化を通す", () => {
    expect(watchablePattern("docs/a.html")).toBe("docs/a.html");
    expect(watchablePattern("./docs/a.html")).toBe("docs/a.html");
    expect(watchablePattern("docs//a.html")).toBe("docs/a.html");
    expect(watchablePattern("docs\\a.html")).toBe("docs/a.html");
  });

  it("glob の記号を含む名前は見張らない（1ファイルより広い集合を見張らない）", () => {
    for (const rel of [
      "docs/*.html",
      "**",
      "docs/a?.html",
      "docs/a[1].html",
      "docs/a{b,c}.html",
      "docs/{a}.html",
    ]) {
      expect(watchablePattern(rel), rel).toBeUndefined();
    }
  });

  it("関門が落とす綴りも見張らない", () => {
    expect(watchablePattern("../a.html")).toBeUndefined();
    expect(watchablePattern("/etc/a.html")).toBeUndefined();
    expect(watchablePattern("")).toBeUndefined();
  });
});
