import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ブリッジが起動する子プロセスを固定する（増分12 D112）。
 *
 * ブリッジはエディタの実行ファイルに `ELECTRON_RUN_AS_NODE=1` を立てて起動される。この変数は
 * ブリッジの子にも継がれ、子が Electron のアプリ（VS Code 自身など）なら、そのアプリは画面を出さずに
 * Node として動いてしまう。だからブリッジが何を起動するかを、ソースの走査で固定する:
 *
 * - `packages/bridge/src` は子プロセスもワーカーも作らない
 * - ブリッジが束ねる `packages/protocol/src` で子プロセスを作るのは `windows-acl-io.ts` だけで、
 *   起動するのは `%SystemRoot%\System32` の `icacls.exe` と `whoami.exe` だけ（D104。Electron では
 *   ないので、変数を継いでも何も変わらない）
 * - 束ねたブリッジ（`packages/extension/bridge/index.js`）が `child_process` を読むのはその1箇所だけ
 *   （MCP SDK などの第三者のコードが子を作る口を持ち込んでいない）
 */
const ROOT = path.join(__dirname, "..");

/** 子プロセス・ワーカーを作れるモジュール（`node:` の有無を問わない）。 */
const SPAWNING =
  /\bfrom\s+["'](?:node:)?(child_process|worker_threads|cluster)["']|\brequire\(\s*["'](?:node:)?(child_process|worker_threads|cluster)["']\s*\)|\bimport\(\s*["'](?:node:)?(child_process|worker_threads|cluster)["']\s*\)/;

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mts|cts|js|mjs)$/.test(e.name))
    .filter((e) => !/\.test\.[cm]?[tj]s$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

function spawningFiles(dir: string): string[] {
  return sources(dir)
    .filter((f) => SPAWNING.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
}

describe("ブリッジが起動する子プロセス（D112）", () => {
  it("packages/bridge/src は child_process / worker_threads / cluster を読まない", () => {
    const files = sources(path.join(ROOT, "packages", "bridge", "src"));
    expect(files.length).toBeGreaterThan(3); // 走査が空振りしていない
    expect(spawningFiles(path.join(ROOT, "packages", "bridge", "src"))).toEqual([]);
  });

  it("検出の正規表現は、実際の import の書き方を拾う（空振りの対照）", () => {
    for (const line of [
      'import * as childProcess from "node:child_process";',
      'import { spawn } from "child_process";',
      'const w = require("node:worker_threads");',
      'await import("cluster")',
    ]) {
      expect(SPAWNING.test(line), line).toBe(true);
    }
    expect(SPAWNING.test('import * as net from "node:net";')).toBe(false);
  });

  it("protocol で子プロセスを作るのは windows-acl-io.ts だけで、System32 の icacls / whoami だけを起動する", () => {
    expect(spawningFiles(path.join(ROOT, "packages", "protocol", "src"))).toEqual([
      "packages/protocol/src/windows-acl-io.ts",
    ]);
    const io = fs.readFileSync(
      path.join(ROOT, "packages", "protocol", "src", "windows-acl-io.ts"),
      "utf8",
    );
    // 起動する実行ファイルの名前（コメントを除いたコードの中の `"….exe"`）
    const code = io.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const exes = [...code.matchAll(/"([^"]+\.exe)"/g)].map((m) => m[1]);
    expect(new Set(exes)).toEqual(new Set(["icacls.exe", "whoami.exe"]));
    // どれも System32 の絶対パスから作る（PATH から探さない）
    const joined = [
      ...code.matchAll(/path\.win32\.join\(system32Dir\(deps\.env\(\)\),\s*"([^"]+\.exe)"\)/g),
    ].map((m) => m[1]);
    expect(joined.length).toBe(exes.length);
    // 起動の口は注入された `deps.spawn` だけで、実物は `childProcess.spawn` の1箇所
    expect(code.match(/childProcess\.\w+\(/g)).toEqual(["childProcess.spawn("]);
    expect(code).not.toContain("process.execPath");
  });

  it("束ねたブリッジが child_process を読むのは1箇所だけで、worker_threads / cluster は読まない", () => {
    const ext = path.join(ROOT, "packages", "extension");
    const bundled = path.join(ext, "bridge", "index.js");
    if (!fs.existsSync(bundled)) execFileSync("node", ["esbuild.mjs"], { cwd: ext });
    const text = fs.readFileSync(bundled, "utf8");
    const requires = [
      ...text.matchAll(/require\(\s*"(?:node:)?(child_process|worker_threads|cluster)"\s*\)/g),
    ].map((m) => m[1]);
    expect(requires).toEqual(["child_process"]);
  });
});
