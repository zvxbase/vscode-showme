import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 拡張 ID（publisher.name）を決めている場所は package.json ただ1つ。統合テストの
 * helpers が持つ定数はその写しであり、ずれると「自分自身が在庫に無い」で全統合が落ちる。
 * ずれを単体で捕まえる。
 */
describe("extension id", () => {
  it("helpers.EXTENSION_ID === package.json の publisher.name", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const helpers = fs.readFileSync(
      path.join(__dirname, "integration", "suite", "helpers.ts"),
      "utf8",
    );
    const m = /export const EXTENSION_ID = "([^"]+)"/.exec(helpers);
    expect(m?.[1]).toBe(`${pkg.publisher}.${pkg.name}`);
    expect(pkg.publisher).toBe("zvxbase");
  });
});
