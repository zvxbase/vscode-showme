import { describe, expect, it } from "vitest";
import { ShowMeLog } from "../src/log.js";

/**
 * 出力チャネルの検査。
 *
 * 無害化そのものは `packages/protocol/src/sanitize.test.ts` にある（サニタイザは
 * 1つ）。ここで確かめるのは**ログの経路が実際にそれを通って
 * いるか**である ―― 関数を再輸出しただけの検査は、`ShowMeLog` が生の文字列を
 * `appendLine` に渡す実装でも通ってしまう。
 *
 * 不可視文字はエスケープ列で書く（生の文字を書かない）。
 */

/** `OutputChannel` の代わり。書かれた行をそのまま溜める。 */
function fakeChannel(): { lines: string[]; channel: { appendLine(line: string): void } } {
  const lines: string[] = [];
  return { lines, channel: { appendLine: (line: string) => void lines.push(line) } };
}

function logOnce(message: string, fields: Record<string, string> = {}): string {
  const { lines, channel } = fakeChannel();
  // `ShowMeLog` が要るのは `appendLine` と `show` だけ。型だけ合わせて渡す。
  new ShowMeLog(channel as unknown as ConstructorParameters<typeof ShowMeLog>[0]).info(
    message,
    fields,
  );
  expect(lines.length).toBe(1);
  return lines[0] as string;
}

describe("ShowMeLog", () => {
  it("本文を無害化して書く（改行で行を偽装させない）", () => {
    expect(logOnce("a\nb")).toContain("a\\nb");
    expect(logOnce("a\r\nb")).toContain("a\\r\\nb");
  });

  it("フィールドの値も無害化する（鍵と値の対を偽装させない）", () => {
    expect(logOnce("ok", { path: "a\nb" })).toContain("path=a\\nb");
  });

  it("ANSI 制御シーケンスを無害化する", () => {
    const line = logOnce("\u001b[31mred\u001b[0m", { path: "\u001b[2J" });
    expect(line).not.toContain("\u001b");
    expect(line).toContain("\\u001b");
  });

  it("双方向オーバーライド文字を可視化する", () => {
    expect(logOnce("a\u202eb")).toContain("\\u202e");
  });

  it("ゼロ幅文字を可視化する", () => {
    expect(logOnce("a\u200bb")).toContain("\\u200b");
  });

  it("普通の文字列はそのまま通す", () => {
    expect(logOnce("show_code", { path: "src/index.ts" })).toContain("path=src/index.ts");
  });

  it("長すぎる値を切り詰める", () => {
    // 前置き（時刻と鍵）の分があるので、行全体ではなく値の側の長さで見る。
    const line = logOnce("ok", { path: "x".repeat(1000) });
    const value = line.slice(line.indexOf("path=") + "path=".length);
    expect(value.length).toBeLessThanOrEqual(300);
  });

  it("偽の成功行を注入しても1行に収まる（監査ログ行偽装の防止）", () => {
    const forged = "ok.ts\n[INFO] tool=show_code result=success actor=owner\n[AUDIT] approved";
    const line = logOnce("show_code", { path: forged });
    expect(line.split("\n").length).toBe(1);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
  });

  it("上限超のサロゲートペア文字列でもローンサロゲートを作らない", () => {
    const line = logOnce("ok", { path: "\u{1F600}".repeat(400) });
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = line.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = line.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });

  it("フィールドが無ければ余計な区切りを足さない", () => {
    expect(logOnce("started")).toMatch(/] started$/);
  });
});
