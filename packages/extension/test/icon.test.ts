import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketplace のアイコンの条件（公式）: PNG、128x128 以上（256x256 推奨）、SVG は不可。
 * 元絵は `media/icon.svg`（文字もフォントも使わない基本図形だけの自作）で、`.vscodeignore` で VSIX から外す。
 */
const ext = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8")) as {
  icon?: string;
};

describe("extension icon", () => {
  it("package.json の icon は PNG で、128x128 以上の正方形", () => {
    expect(pkg.icon).toBe("media/icon.png");
    const png = fs.readFileSync(path.join(ext, pkg.icon as string));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);
  });

  it("元絵の SVG は VSIX に入れない（Marketplace は利用者の SVG 画像を受け付けない）", () => {
    const ignore = fs.readFileSync(path.join(ext, ".vscodeignore"), "utf8");
    expect(ignore).toMatch(/^media\/\*\.svg$/m);
    expect(fs.existsSync(path.join(ext, "media", "icon.svg"))).toBe(true);
  });
});
