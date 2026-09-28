import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { currentUserSid, lockPrivateDir } from "@zvx/vscode-showme-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShowMeSocketServer } from "../src/server.js";

/**
 * **別のふつうの利用者から届かない**ことを、本物の Windows の上で本物の2人目の利用者で確かめる（D104）。
 *
 * CI の利用者は管理者なので、自分で読めることは何の証拠にもならない。テストの中で管理者でない
 * ローカルの利用者を作り、その利用者として node を起動して:
 *
 * - 実行時ディレクトリの一覧・登録ファイル（トークン入り）が読めない
 * - 拡張の名前付きパイプに繋げない（EPERM）
 * - 同じ名前のパイプを先回りして立てられない（EADDRINUSE）
 *
 * を確かめる。**対照**として、同じ親フォルダに置いた読み取りを許したファイルは読めること、
 * 起動した node が本当にその利用者であることも確かめる（読めないのが「別人だから」であって、
 * 「そもそも起動していない」「パスを間違えた」からではないことの証拠）。
 *
 * 別の利用者として起動するのは PowerShell から .NET の `ProcessStartInfo`（UserName / Password。
 * `SecureString` は1文字ずつ作る）。`PSModulePath` は外して起動する（PowerShell 7 から継いだものが
 * あると 5.1 のモジュールが読めない。増分11 設計書の調べ）。パスワードは 14 文字を超えると
 * `net user` が確認を求めるので 12 文字。利用者は afterAll で消す。
 *
 * 管理者でない・使い捨ての機械でない（下の `allowed`）なら、理由を出して飛ばす。
 */
const onWindows = process.platform === "win32";
const isAdmin =
  onWindows &&
  spawnSync("net.exe", ["session"], { windowsHide: true, stdio: "ignore" }).status === 0;
/**
 * OS のアカウントを作って消すので、**使い捨ての機械でだけ**走らせる。GitHub Actions の上か、明示の
 * 許可（`SHOWME_ALLOW_OS_USER_TEST=1`）があるときだけ。開発者の機械で管理者として `npm test` を
 * 走らせても、同じ名前の本物のアカウントを消したり、`C:\Users\showmetest` を残したりしない。
 */
const allowed =
  process.env.GITHUB_ACTIONS === "true" || process.env.SHOWME_ALLOW_OS_USER_TEST === "1";
const runs = isAdmin && allowed;
const execFileAsync = promisify(execFile);

const USER = "showmetest";
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

const PROBE = `
const fs = require("fs");
const net = require("net");
const os = require("os");
const cfg = JSON.parse(process.env.SHOWME_PROBE_CONFIG);
const code = (f) => { try { f(); return "ok"; } catch (e) { return (e && e.code) || String(e); } };
const withTimeout = (start) => new Promise((resolve) => {
  const t = setTimeout(() => resolve("timeout"), 5000);
  start((v) => { clearTimeout(t); resolve(v); });
});
(async () => {
  const out = {};
  out.user = os.userInfo().username;
  out.control = code(() => fs.readFileSync(cfg.control, "utf8"));
  out.readdir = code(() => fs.readdirSync(cfg.runtimeDir));
  out.registry = code(() => fs.readFileSync(cfg.registry, "utf8"));
  out.connect = await withTimeout((done) => {
    const s = net.connect(cfg.pipe);
    s.on("connect", () => { s.destroy(); done("ok"); });
    s.on("error", (e) => done(e.code || String(e)));
  });
  out.listen = await withTimeout((done) => {
    const srv = net.createServer();
    srv.on("listening", () => srv.close(() => done("ok")));
    srv.on("error", (e) => done(e.code || String(e)));
    srv.listen(cfg.pipe);
  });
  process.stdout.write(JSON.stringify(out));
})();
`;

/** PowerShell の本文。値はすべて環境変数から読む（引用の規則に頼らない）。 */
const RUN_AS = `
$ErrorActionPreference = 'Stop'
$pw = New-Object System.Security.SecureString
foreach ($c in $env:SHOWME_PROBE_PW.ToCharArray()) { $pw.AppendChar($c) }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:SHOWME_PROBE_NODE
$psi.Arguments = '-e "eval(process.env.SHOWME_PROBE_SCRIPT)"'
$psi.EnvironmentVariables['SHOWME_PROBE_SCRIPT'] = $env:SHOWME_PROBE_SCRIPT
$psi.EnvironmentVariables['SHOWME_PROBE_CONFIG'] = $env:SHOWME_PROBE_CONFIG
$psi.UserName = $env:SHOWME_PROBE_USER
$psi.Domain = $env:COMPUTERNAME
$psi.Password = $pw
$psi.LoadUserProfile = $true
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = $env:SHOWME_PROBE_CWD
$p = [System.Diagnostics.Process]::Start($psi)
$errTask = $p.StandardError.ReadToEndAsync()
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit()
[Console]::Out.Write($out)
[Console]::Error.Write($errTask.Result)
exit $p.ExitCode
`;

function net(args: string[]): void {
  spawnSync(path.join(SYSTEM32, "net.exe"), args, { windowsHide: true, stdio: "ignore" });
}

describe.runIf(onWindows)("別のふつうの利用者から届かない（本物の2人目の利用者。D104）", () => {
  let base: string;
  let server: ShowMeSocketServer | undefined;
  let result: Record<string, string> | undefined;
  let failure: string | undefined;

  beforeAll(async () => {
    if (!runs) return;
    const password = `Sm7!${randomBytes(4).toString("hex")}`; // 12 文字（14 を超えると確認が出る）
    net(["user", USER, "/delete"]); // 前の回の残り（CI では無い）
    const add = spawnSync(path.join(SYSTEM32, "net.exe"), ["user", USER, password, "/add", "/y"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (add.status !== 0) {
      failure = `net user /add failed: ${add.status} ${add.stdout} ${add.stderr}`;
      return;
    }

    // 親は本人と SYSTEM だけに締めてから、Users に読み取りだけを許す（継承する）。親の判定は
    // 読み取りだけなら通る。実行時ディレクトリは作るときに継承を切るので、そこだけが Users を断る ――
    // 断っているのが実行時ディレクトリの DACL であって、親をたどれないからではないことの形にする。
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "su-")));
    await lockPrivateDir(base, await currentUserSid());
    spawnSync(path.join(SYSTEM32, "icacls.exe"), [base, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const control = path.join(base, "control.txt");
    fs.writeFileSync(control, "readable\n");

    const runtimeDir = path.join(base, "vscode-showme-0");
    server = new ShowMeSocketServer([runtimeDir], async () => ({}));
    const info = await server.start();
    const registry = String(info.registryPaths[0]);
    const config = JSON.stringify({ control, runtimeDir, registry, pipe: info.socketPath });

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.toLowerCase() === "psmodulepath") delete env[k];
    Object.assign(env, {
      SHOWME_PROBE_PW: password,
      SHOWME_PROBE_NODE: process.execPath,
      // 本文と設定は環境変数で渡す。ファイルから読ませると、node の読み込みが祖先（本人の
      // プロファイル）を lstat して EPERM になる（CI で実測）―― 確かめたいのは実行時ディレクトリの
      // DACL であって、プロファイルの DACL ではない。引数に載せると CreateProcessWithLogonW の
      // コマンドラインの上限（1024 文字）を超えて「パラメーターが間違っています」になる（同じく実測）。
      SHOWME_PROBE_SCRIPT: PROBE,
      SHOWME_PROBE_CONFIG: config,
      SHOWME_PROBE_USER: USER,
      SHOWME_PROBE_CWD: process.env.SystemRoot ?? "C:\\Windows",
    });
    try {
      // 非同期で待つ ―― このプロセスがパイプのサーバを持っているので、事象の輪を止めない。
      const { stdout, stderr } = await execFileAsync(
        path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(RUN_AS, "utf16le").toString("base64"),
        ],
        { env, windowsHide: true, timeout: 120_000 },
      );
      console.log(`second-user probe: ${stdout} ${stderr}`);
      result = JSON.parse(stdout) as Record<string, string>;
    } catch (e) {
      const err = e as { message?: string; stdout?: string; stderr?: string };
      failure = `probe failed: ${err.message} ${err.stdout ?? ""} ${err.stderr ?? ""}`;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
    if (runs) net(["user", USER, "/delete"]);
    if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  });

  it("使い捨ての機械の管理者でなければ飛ばす（理由を出す）", (ctx) => {
    if (runs) return;
    console.log(
      isAdmin
        ? "skipped: creates and deletes an OS account; runs only on GitHub Actions or with SHOWME_ALLOW_OS_USER_TEST=1"
        : "skipped: not an administrator, cannot create a second local user",
    );
    ctx.skip();
  });

  it.runIf(runs)("対照: 起動した node はその利用者で、読み取りを許したファイルは読める", () => {
    expect(failure).toBeUndefined();
    expect(result?.user.toLowerCase()).toBe(USER);
    expect(result?.control).toBe("ok");
  });

  it.runIf(runs)("実行時ディレクトリの一覧も登録ファイル（トークン）も読めない", () => {
    expect(failure).toBeUndefined();
    expect(["EPERM", "EACCES"]).toContain(result?.readdir);
    expect(["EPERM", "EACCES"]).toContain(result?.registry);
  });

  it.runIf(runs)(
    "拡張のパイプに繋げず（EPERM）、同じ名前で先回りして立てられない（EADDRINUSE）",
    () => {
      expect(failure).toBeUndefined();
      expect(result?.connect).toBe("EPERM");
      expect(result?.listen).toBe("EADDRINUSE");
    },
  );
});
