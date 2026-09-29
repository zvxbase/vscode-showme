import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentConfigDocument } from "../src/agent-config-doc.js";

/**
 * 設定の案内の `claude mcp add` の行（D109）を、**本物の cmd と PowerShell に打たせて**確かめる。Windows だけ。
 *
 * 文字列の形の検査（`agent-config-doc.test.ts`）は「二重引用符で包んだ `/` 区切りのパス」を固定するが、
 * それがシェルを通って `claude` に1引数のまま届くかは、シェルに打たせないと分からない。`claude` は
 * 本物と同じく `claude.cmd`（npm が作る形の shim。受けた引数を `%*` で node に渡す）で、node の
 * 記録係が受け取った argv をファイルに書く。ホームには空白を入れる（`C:\Users\Jane Doe` の形）。
 *
 * 増分12（D114）で行は `-e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- "<実行ファイル>" "<ブリッジ>"` になった。実行ファイルも
 * 空白入りの場所（`…\Microsoft VS Code\Code.exe` の形）に置いた本物の node.exe の写しで、記録した argv を
 * そのまま起動して、`/` 区切りのパスで実際に起動できることまで確かめる。
 *
 * D114 の改訂で、各スコープに `node` の形の行（`--transport stdio showme -- node "<ブリッジ>"`）も並ぶ。
 * こちらも3つのシェルに打たせ、届いた argv の `node` を `PATH` から（シェル無しで）起動して、
 * 本物の node として動くことまで確かめる。`ELECTRON_RUN_AS_NODE` は外して起動する（node の形は要らない）。
 */
const onWindows = process.platform === "win32";
const execFileAsync = promisify(execFile);
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

describe.runIf(onWindows)(
  "claude mcp add の行が cmd と PowerShell で1引数のまま届く（D109）",
  () => {
    let base: string;
    let bin: string;
    let bridge: string;
    let runtime: string;
    let lines: string[];

    beforeAll(() => {
      base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cm-")));
      const home = path.join(base, "Jane Doe");
      bridge = path.join(
        home,
        ".vscode",
        "extensions",
        "zvxbase.vscode-showme-0.1.5",
        "bridge",
        "index.js",
      );
      // ブリッジの偽物は、自分が Node として動いたことを書くだけ
      fs.mkdirSync(path.dirname(bridge), { recursive: true });
      fs.writeFileSync(
        bridge,
        'process.stdout.write("bridge ran as node " + (process.env.ELECTRON_RUN_AS_NODE ?? "-"));\n',
      );
      // 実行ファイルは空白を含む場所に置いた node.exe の写し（VS Code のユーザー インストールの形）
      runtime = path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe");
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      fs.copyFileSync(process.execPath, runtime);
      bin = path.join(base, "bin");
      fs.mkdirSync(bin);
      const recorder = path.join(bin, "record.js");
      fs.writeFileSync(
        recorder,
        'require("fs").writeFileSync(process.env.SHOWME_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n',
      );
      // npm の shim と同じ渡し方（`%*`）。node は絶対パスで呼ぶ（PATH の順に頼らない）。
      fs.writeFileSync(
        path.join(bin, "claude.cmd"),
        `@ECHO off\r\n"${process.execPath}" "${recorder}" %*\r\n`,
      );
      const doc = buildAgentConfigDocument(bridge, "en", home, "win32", {
        executable: runtime,
        remote: false,
      });
      lines = doc.split("\n").filter((l) => l.startsWith("claude mcp add"));
    });
    afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

    const isNodeForm = (line: string): boolean => line.includes(" -- node ");
    const expected = (line: string): string[] => {
      const scope = /--scope (\w+)/.exec(line)?.[1];
      return [
        "mcp",
        "add",
        ...(scope === undefined ? [] : ["--scope", scope]),
        ...(isNodeForm(line) ? [] : ["-e", "ELECTRON_RUN_AS_NODE=1"]),
        "--transport",
        "stdio",
        "showme",
        "--",
        isNodeForm(line) ? "node" : runtime.replace(/\\/g, "/"),
        bridge.replace(/\\/g, "/"),
      ];
    };
    /** 起動したブリッジの偽物が書く1行。node の形は ELECTRON_RUN_AS_NODE 無しで動く */
    const ran = (line: string): string => `bridge ran as node ${isNodeForm(line) ? "-" : "1"}`;

    /**
     * 記録した argv の `--` の後ろ（実行ファイルと引数）を、`-e` の環境変数を立てて実際に起動する。
     * Claude Code が後でする起動と同じく、シェルを通さない。
     */
    async function runRecorded(argv: string[]): Promise<string> {
      const dash = argv.indexOf("--");
      const [command, ...args] = argv.slice(dash + 1);
      // `-e KEY=VALUE` は `--` より前にあるときだけ（node の形には無い）
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[k];
      }
      const e = argv.indexOf("-e");
      if (e !== -1 && e < dash) {
        const [key = "", value = ""] = (argv[e + 1] ?? "").split("=");
        env[key] = value;
      }
      // node の形の `node` は、エージェントと同じく PATH から探す（シェルは通さない）
      const { stdout } = await execFileAsync(command ?? "", args, {
        env,
        windowsHide: true,
        timeout: 30_000,
      });
      return stdout;
    }

    function envFor(out: string): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env };
      let pathKey = "PATH";
      for (const k of Object.keys(env)) {
        if (k.toLowerCase() === "psmodulepath") delete env[k];
        if (k.toLowerCase() === "path") pathKey = k;
      }
      env[pathKey] = `${bin};${env[pathKey] ?? ""}`;
      env.SHOWME_ARGV_OUT = out;
      return env;
    }

    it("文書に claude mcp add の行が6つある（2つの形 × 3つのスコープ。空白を含むホームの下）", () => {
      expect(lines).toHaveLength(6);
      expect(lines.filter(isNodeForm)).toHaveLength(3);
      for (const l of lines) {
        expect(l).toContain("Jane Doe");
        if (!isNodeForm(l)) expect(l).toContain("Microsoft VS Code/Code.exe");
      }
    });

    it("コマンド プロンプト（cmd.exe /d /s /c）", async () => {
      for (const [i, line] of lines.entries()) {
        const out = path.join(base, `cmd-${i}.json`);
        // `/s /c "<行>"` は外側の引用符を1組だけ剥がして、行をそのまま打ったのと同じに読む。
        await execFileAsync(path.join(SYSTEM32, "cmd.exe"), ["/d", "/s", "/c", `"${line}"`], {
          env: envFor(out),
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 30_000,
        });
        const argv = JSON.parse(fs.readFileSync(out, "utf8")) as string[];
        expect(argv, line).toEqual(expected(line));
        expect(await runRecorded(argv), line).toBe(ran(line));
      }
    });

    it("Windows PowerShell 5.1（powershell -NoProfile -NonInteractive -Command）", async () => {
      for (const [i, line] of lines.entries()) {
        const out = path.join(base, `ps-${i}.json`);
        await execFileAsync(
          path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(line, "utf16le").toString("base64"),
          ],
          { env: envFor(out), windowsHide: true, timeout: 60_000 },
        );
        const argv = JSON.parse(fs.readFileSync(out, "utf8")) as string[];
        expect(argv, line).toEqual(expected(line));
        expect(await runRecorded(argv), line).toBe(ran(line));
      }
    });

    it("PowerShell 7（pwsh。入っていれば）", async (ctx) => {
      const pwsh = (process.env.PATH ?? "")
        .split(";")
        .map((d) => path.join(d, "pwsh.exe"))
        .find((p) => fs.existsSync(p));
      if (pwsh === undefined) {
        console.log("skipped: pwsh.exe is not on PATH");
        ctx.skip();
        return;
      }
      for (const [i, line] of lines.entries()) {
        const out = path.join(base, `pwsh-${i}.json`);
        await execFileAsync(
          pwsh,
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(line, "utf16le").toString("base64"),
          ],
          { env: envFor(out), windowsHide: true, timeout: 60_000 },
        );
        const argv = JSON.parse(fs.readFileSync(out, "utf8")) as string[];
        expect(argv, line).toEqual(expected(line));
        expect(await runRecorded(argv), line).toBe(ran(line));
      }
    });
  },
);
