import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * VS Code 内蔵のエージェント向けの定義（D112）が、起動の形を決める関数を通っていることの検査。
 *
 * `extension.ts` は vscode に依存するので単体では動かせない。形そのもの（command / args / env /
 * version）は `builtInServerDefinition` の単体（agent-config-doc.test.ts）と統合（trusted.test.ts の
 * 実際の起動）が見る。ここでは「提供者がその関数の値を**そのまま**渡している」ことを源で固定する ――
 * 提供者の側で `"node"` や別の env を書き直すと、単体は緑のまま実機だけが `spawn node ENOENT` に戻る。
 */
const SRC = path.join(__dirname, "..", "src");

describe("MCP 提供者の配線（D112）", () => {
  const text = fs.readFileSync(path.join(SRC, "extension.ts"), "utf8");

  it("McpStdioServerDefinition を作るのは1箇所で、builtInServerDefinition の値を5つとも渡す", () => {
    const calls = [...text.matchAll(/new vscode\.McpStdioServerDefinition\(([^)]*)\)/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, ""),
    );
    expect(calls).toEqual([
      "builtIn.label,builtIn.command,builtIn.args,builtIn.env,builtIn.version,",
    ]);
    expect(text).toMatch(
      /const builtIn = builtInServerDefinition\(\s*process\.execPath,\s*bridgePath,/,
    );
  });

  it("拡張の源のどこにも node を起動する綴りが無い", () => {
    for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      // 共有の形（他の人の機械でも動く形）は node で起動する ―― それは文書の断片で、定義ではない
      if (f === "agent-config-doc.ts") continue;
      expect(src, f).not.toMatch(/["']node["']/);
    }
  });

  it("文書にも同じ実行環境を渡す（process.execPath と remoteName、入れ方を見分ける環境変数）", () => {
    expect(text).toMatch(
      /buildAgentConfigDocument\([^;]*executable:\s*process\.execPath,\s*remote:\s*vscode\.env\.remoteName !== undefined/,
    );
    const call = /buildAgentConfigDocument\([^;]*;/.exec(text)?.[0] ?? "";
    for (const k of ["FLATPAK_ID", "APPIMAGE", "SNAP"]) {
      expect(call, k).toContain(`${k}: process.env.${k}`);
    }
  });
});
