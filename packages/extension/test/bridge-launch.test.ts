import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeLaunchArgs, shellQuote } from "../src/agent-config-doc.js";

/**
 * 外部エージェントに貼る設定は、**拡張を更新しても貼り直さなくてよい**形でなければならない。
 *
 * インストール先は `…/extensions/zvxbase.vscode-showme-0.1.0/` のように版番号入りの
 * フォルダで、固定のパスを貼ると 0.1.1 に上がった時点で古いフォルダを指す（VS Code は
 * 古い版を後で消す）。だから設定は「このフォルダの中で一番新しい ShowMe を探して起動する」
 * 1行にする。ここでは文字列の形ではなく、**実際に node とシェルで起動して**確かめる。
 */

/** 拡張フォルダの偽物を作る。各版の bridge/index.js は自分の版を stdout に書くだけ。 */
function fakeExtensionsDir(
  versions: string[],
  extraDirs: string[] = [],
  base = os.tmpdir(),
): string {
  const dir = fs.mkdtempSync(path.join(base, "exts-"));
  for (const v of versions) {
    const b = path.join(dir, `zvxbase.vscode-showme-${v}`, "bridge");
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, "index.js"), `process.stdout.write(${JSON.stringify(v)});\n`);
  }
  for (const d of extraDirs) {
    const b = path.join(dir, d, "bridge");
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(
      path.join(b, "index.js"),
      `process.stdout.write(${JSON.stringify(`WRONG:${d}`)});\n`,
    );
  }
  return dir;
}

const bridgeOf = (dir: string, v: string): string =>
  path.join(dir, `zvxbase.vscode-showme-${v}`, "bridge", "index.js");

describe("bridgeLaunchArgs: 更新しても貼り直さなくてよい起動の仕方", () => {
  it("版番号入りのインストール先なら、いちばん新しい版を**数値で**選んで起動する", () => {
    const dir = fakeExtensionsDir(["0.2.0", "0.9.0", "0.10.0"]);
    const out = execFileSync("node", bridgeLaunchArgs(bridgeOf(dir, "0.2.0")), {
      encoding: "utf8",
    });
    expect(out).toBe("0.10.0"); // 文字列で比べると 0.9.0 を選んでしまう
  });

  it("名前が似ているだけの別の拡張は拾わない", () => {
    const dir = fakeExtensionsDir(
      ["0.1.0"],
      ["zvxbase.vscode-showme-extra-9.9.9", "other.vscode-showme-9.9.9"],
    );
    const out = execFileSync("node", bridgeLaunchArgs(bridgeOf(dir, "0.1.0")), {
      encoding: "utf8",
    });
    expect(out).toBe("0.1.0");
  });

  it("ShowMe が1つも無くなっていたら、理由を stderr に書いて失敗する（黙って別物を起動しない）", () => {
    const dir = fakeExtensionsDir(["0.1.0"]);
    const args = bridgeLaunchArgs(bridgeOf(dir, "0.1.0"));
    fs.rmSync(path.join(dir, "zvxbase.vscode-showme-0.1.0"), { recursive: true });
    const r = spawnSync("node", args, { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("ShowMe");
  });

  it("空白と引用符を含むインストール先でも、シェルに貼った1行がそのまま動く", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "Application Support 'x' "));
    const dir = fakeExtensionsDir(["0.1.0", "0.1.1"], [], base);
    const line = ["node", ...bridgeLaunchArgs(bridgeOf(dir, "0.1.0")).map(shellQuote)].join(" ");
    const out = execFileSync("sh", ["-c", line], { encoding: "utf8" });
    expect(out).toBe("0.1.1");
  });

  it("開発中（拡張フォルダの外・版番号の無い置き場）は、そのパスを直接起動する", () => {
    const dev = "/work/vscode-showme/packages/extension/bridge/index.js";
    expect(bridgeLaunchArgs(dev)).toEqual([dev]);
  });

  it("起動の1行に `<` を含めない（文書の検査が「埋め残しのプレースホルダ」とみなす記号）", () => {
    const args = bridgeLaunchArgs(
      "/home/me/.vscode/extensions/zvxbase.vscode-showme-0.1.0/bridge/index.js",
    );
    expect(args.join(" ")).not.toContain("<");
  });
});

describe("ブリッジが名乗る版", () => {
  it("束ねたブリッジを起動すると、拡張の package.json の版を名乗る（別の場所に数字を書かない）", async () => {
    const ext = path.join(__dirname, "..");
    const { version } = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8")) as {
      version: string;
    };
    const bundled = path.join(ext, "bridge", "index.js");
    if (!fs.existsSync(bundled)) execFileSync("node", ["esbuild.mjs"], { cwd: ext });
    const child = spawn("node", [bundled], { stdio: ["pipe", "pipe", "pipe"] });
    const line = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("initialize に応答しない")), 10_000);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        const nl = out.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(out.slice(0, nl));
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        })}\n`,
      );
    }).finally(() => child.kill());
    const res = JSON.parse(line) as { result: { serverInfo: { name: string; version: string } } };
    expect(res.result.serverInfo).toEqual({ name: "vscode-showme", version });
  });
});
