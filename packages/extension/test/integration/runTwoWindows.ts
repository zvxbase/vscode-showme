import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { createFixtureWorkspace } from "./fixture.js";
import {
  COORD_ENV_VAR,
  RESULTS_FILE,
  type TwoWindowResults,
  readBetaStatuses,
  readJson,
} from "./two-window-coord.js";

/**
 * 同じフォルダを開いた**2つの窓**を立てて、役割で窓が選べることを確かめる
 * （増分2A Task 8 / 設計書 §2A.5）。
 *
 * 1窓の `runTest.ts` と別のスイートにしてある。**起動の仕方が違う**からで、
 * 混ぜると片方の都合（信頼モードの2周、実行時ディレクトリを隔離しない）が
 * もう片方の前提を壊す。
 *
 * スパイクで実測した罠を3つ踏まえている:
 *
 *   1. devcontainer のターミナルには `VSCODE_IPC_HOOK_CLI` があり、これが
 *      残っていると子プロセスがホスト側の VS Code に転送されうる。**`VSCODE_*` を
 *      env から落とす**
 *   2. `--extensionTestsPath` は新しく開いた窓にも受け継がれ、しかも**どれか1つの
 *      窓の `run()` が resolve するとアプリ全体が終了する**。役の分担は suite 側で
 *      行い（先着が測る側）、測られる側は永久に resolve しない
 *   3. 同じフォルダの2窓目は `workbench.action.duplicateWorkspaceInNewWindow` で
 *      開く。`vscode.openFolder` に `forceNewWindow` を渡しても、**同一フォルダでは
 *      例外も投げずに何も起きない**（実測: 45秒待って登録は1件のまま）
 *
 * `@vscode/test-electron` の `runTests()` は使わない（1窓側と同じ理由 ―― 引数列を
 * このファイルに全部見えたままにしておく）。ダウンロードだけ借りる。
 */

const HERE = __dirname;
const EXTENSION_ROOT = path.resolve(HERE, "..");

/** アプリが終わらなかったときに諦める時刻。窓2つ ＋ 起動待ちに余裕を見る。 */
const WALL_CLOCK_MS = 420_000;

function prepareUserDataDir(dir: string): void {
  const userDir = path.join(dir, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    `${JSON.stringify(
      {
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.banner": "never",
        "window.restoreWindows": "none",
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "extensions.autoCheckUpdates": false,
        "workbench.startupEditor": "none",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * 子プロセスに渡す env を組む。
 *
 * `XDG_RUNTIME_DIR` と `TMPDIR` の**両方**を実行ごとの新しい場所に向ける。
 * ブリッジは実行時ディレクトリの候補を2つ走査する（設計書 §2A.6）ので、
 * 片方だけ隔離すると、後退先の `<tmpdir>/vscode-showme-<uid>` に居る
 * **この実験と無関係の窓**（開発者自身の VS Code、1窓側の統合テストの残骸）が
 * 候補に混ざる。混ざると「預けた窓が複数ある」が実験の結論ではなく環境の事故で
 * 出てしまい、この検査は何も判別しなくなる。
 */
function childEnv(xdg: string, tmp: string, coord: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 落としてきた VS Code が「いまこのターミナルを開いている VS Code」に
  // 転送してしまうのを止める（スパイクで実測）。
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_")) delete env[key];
  }
  env.XDG_RUNTIME_DIR = xdg;
  env.TMPDIR = tmp;
  env[COORD_ENV_VAR] = coord;
  return env;
}

function warnIfHeadless(): void {
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY !== undefined && process.env.DISPLAY !== "") return;
  console.error(
    "$DISPLAY が無い。VS Code は起動できない。仮想画面の下で走らせること:\n" +
      "  npm run -w packages/extension test:integration:two-windows:xvfb",
  );
}

function launch(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { env });
    const killer = setTimeout(() => {
      console.error(`!!! ${WALL_CLOCK_MS}ms 経っても VS Code が終わらないので殺す`);
      child.kill("SIGKILL");
    }, WALL_CLOCK_MS);
    child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  warnIfHeadless();

  // ソケットのパスには長さの上限（約107バイト）がある。実行時ディレクトリの下に
  // `<16進16文字>.sock` が付くので、根を短く保つ。
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-2win-"));
  const xdg = path.join(runDir, "x");
  const tmp = path.join(runDir, "t");
  const coord = path.join(runDir, "c");
  const userDataDir = path.join(runDir, "u");
  const extensionsDir = path.join(runDir, "e");
  // mkdir のモードは umask で減算されるので、作った直後に締め直す。
  // 拡張もブリッジも「他人が書ける場所の登録は使わない」ので、緩いと黙って
  // 1件も読めなくなる。
  for (const dir of [xdg, tmp, coord, userDataDir, extensionsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  prepareUserDataDir(userDataDir);

  const workspace = createFixtureWorkspace("two-windows");
  const extensionTestsPath = path.resolve(HERE, "./suite/two-windows-index");
  const executable = await downloadAndUnzipVSCode();

  const args = [
    workspace.root,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-updates",
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    // この検査は信頼モードでよい（役割は信頼状態と独立である）。制限モードの
    // 縮退は1窓側の `restricted.test.ts` が見ている。
    "--disable-workspace-trust",
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];

  console.log("=== 2窓の受け入れテスト ===");
  console.log(`workspace: ${workspace.root}`);
  console.log(`run dir:   ${runDir}`);
  console.log(`XDG_RUNTIME_DIR: ${xdg}`);
  console.log(`TMPDIR:          ${tmp}`);

  const code = await launch(executable, args, childEnv(xdg, tmp, coord));
  console.log(`\nVS Code は exit ${code} で終わった`);

  const betas = readBetaStatuses(coord);
  console.log(`測られる側の窓: ${betas.length} 個`);
  for (const beta of betas) {
    console.log(
      `  pid=${beta.pid} ready=${beta.ready} role=${String(beta.role)}` +
        `${beta.failure === undefined ? "" : ` failure=${beta.failure}`}`,
    );
  }

  // **終了コードだけで合否を決めない。** 何も走らないまま VS Code が 0 で
  // 終わったときに「通った」と読めてしまう。測る側が書いた結果を要求する。
  const results = readJson<TwoWindowResults>(path.join(coord, RESULTS_FILE));
  if (results === undefined) {
    console.error(`=== FAIL: 測る側が ${RESULTS_FILE} を残していない（run dir: ${runDir}）`);
    process.exit(1);
  }
  for (const note of results.notes) console.log(`  ${note}`);

  if (!results.ok) {
    console.error(`=== FAIL: ${results.failures} 件のテストが落ちた（run dir: ${runDir}）`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(
      `=== FAIL: テストは全部通ったが VS Code が exit ${code} で終わった（run dir: ${runDir}）`,
    );
    process.exit(1);
  }
  console.log("=== PASS ===");
}

main().catch((e) => {
  console.error("2窓のテストを起動できませんでした:", e);
  process.exit(1);
});
