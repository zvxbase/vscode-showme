import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Windows の予約デバイス名（`CON`・`NUL`・`COM1`・`CONIN$`、拡張子つきの `con.txt`・`AUX.md`）を
 * エージェントの相対パスとして渡しても、関門（`acceptWorkspacePath`）と読み出し
 * （`readWorkspaceFile`）が**断り、止まらない**こと。
 *
 * Windows では、これらの名前はどのフォルダの下でもデバイスを指しうる。関門が通してしまうと、読み出しが
 * コンソールの入力（`CON`・`CONIN$`）を開いて待ち続け、拡張ごと止まる。止まる検査は同期の呼び出しの
 * 中で止まるので、vitest の時間の上限では切れない ―― **別のプロセスで走らせ、時間で切る**
 * （関門と読み出しを esbuild で1つにまとめて node で起動する）。
 *
 * 全 OS で走らせる（POSIX ではただの無いファイルの名前なので、断る側の答えは同じ）。
 */
const NAMES = [
  "CON",
  "NUL",
  "con.txt",
  "COM1",
  "LPT1",
  "CONIN$",
  "CONOUT$",
  "AUX.md",
  "src/CON",
  "src/nul.ts",
  // 末尾のドット・空白は Windows が剥がして `CON` になる。綴りの正規化が先に断る（下で確かめる）。
  "CON.",
  "CON ",
  // 上付きの 1（U+00B9）。Windows は `COM¹` も `COM1` と同じデバイスとして扱う。
  "COM\u00B9",
];

const PROBE = `
import { acceptWorkspacePath } from "../src/workspace-path-gate.js";
import { readWorkspaceFile } from "../src/read-workspace-file.js";
const [root, ...names] = process.argv.slice(2);
const policy = { patterns: [], blockLinksToRedacted: true };
const out: Record<string, unknown> = {};
for (const name of names) {
  const verdict = acceptWorkspacePath(root, name, policy);
  const read = readWorkspaceFile(root, name, policy);
  out[name] = { verdict, read: read === undefined ? null : read.length };
}
process.stdout.write(JSON.stringify(out));
`;

describe("予約デバイス名の相対パスは断り、止まらない", () => {
  let dir: string;
  let bundle: string;

  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-devnames-")));
    fs.mkdirSync(path.join(dir, "ws", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ws", "src", "a.ts"), "export const a = 1;\n");
    bundle = path.join(dir, "probe.cjs");
    buildSync({
      stdin: { contents: PROBE, loader: "ts", resolveDir: __dirname, sourcefile: "probe.ts" },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "silent",
    });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("関門は invalid-path で断り、読み出しは何も返さない（20 秒以内に終わる）", () => {
    const stdout = execFileSync(process.execPath, [bundle, path.join(dir, "ws"), ...NAMES], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      // 子がコンソールの入力を待つ形にならないよう、標準入力は閉じておく。
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = JSON.parse(stdout) as Record<string, unknown>;
    for (const name of NAMES) {
      expect(out[name], name).toEqual({
        verdict: { ok: false, reason: "invalid-path" },
        read: null,
      });
    }
  });

  it("末尾のドット・空白の形は、ファイルシステムに触る前の綴りの正規化で落ちる", () => {
    expect(normalizeWorkspaceRelative("CON.")).toBeUndefined();
    expect(normalizeWorkspaceRelative("CON ")).toBeUndefined();
  });

  it("対照: 同じ束ねた関門で、ふつうのファイルは通る（検査が空振りしていない）", () => {
    const stdout = execFileSync(process.execPath, [bundle, path.join(dir, "ws"), "src/a.ts"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = JSON.parse(stdout) as Record<string, { verdict: { ok: boolean }; read: number }>;
    expect(out["src/a.ts"]?.verdict.ok).toBe(true);
    expect(out["src/a.ts"]?.read).toBe("export const a = 1;\n".length);
  });
});
