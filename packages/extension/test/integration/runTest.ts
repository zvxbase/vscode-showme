import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { createFixtureWorkspace } from "./fixture.js";

/**
 * 実 VS Code を落として統合テストを走らせる（Task 13）。
 *
 * 2回起動する。信頼モードと制限モードで**別のウィンドウ**が要るからで、
 * 1回の起動の中で信頼状態を切り替えると、その時点で拡張ホストが再起動して
 * 走っているテストごと落ちる。
 *
 * `@vscode/test-electron` の `runTests()` は使わない。あれは引数列に
 * `--disable-workspace-trust` を**常に**足す（out/runTest.js）ので、
 * 制限モードの回が黙って信頼モードになる。実測でそうなった: 制限モードの
 * はずの回で `workspace.isTrusted === true` が返った。`launchArgs` は
 * 先頭に連結されるだけなので、後から打ち消せない。だからダウンロードだけ
 * 借りて、起動は自分で行う（引数列がこのファイルに全部見えている状態を保つ）。
 *
 *   1回目: `--disable-workspace-trust` を付ける → `isTrusted === true`
 *   2回目: 付けない・まっさらな user-data-dir → 未知のフォルダなので制限モード
 *
 * 2回目に信頼ダイアログを出させない（出すとヘッドレスで人間が答えられない）。
 * `security.workspace.trust.startupPrompt: "never"` は**信頼させる設定ではない**
 * ―― 訊かないだけで、答えていないフォルダは制限モードのままである。制限モードで
 * あることは suite 側が `isTrusted === false` を assert して確かめる。
 */

const HERE = __dirname;
/** out-test/runTest.js から見た拡張のルート（packages/extension）。 */
const EXTENSION_ROOT = path.resolve(HERE, "..");

interface Pass {
  readonly label: string;
  readonly mode: "trusted" | "restricted";
  readonly disableWorkspaceTrust: boolean;
}

const PASSES: readonly Pass[] = [
  { label: "信頼モード", mode: "trusted", disableWorkspaceTrust: true },
  { label: "制限モード", mode: "restricted", disableWorkspaceTrust: false },
];

/** ユーザ設定を書く。更新確認・テレメトリ・ウィンドウ復元・信頼ダイアログを止める。 */
function prepareUserDataDir(mode: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `showme-udd-${mode}-`));
  const userDir = path.join(dir, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    `${JSON.stringify(
      {
        // 訊かないだけ。答えていないフォルダは制限モードのまま。
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
  return dir;
}

/** VS Code を起動してテストランナーの終了コードを待つ。 */
function launch(executable: string, args: string[], mode: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, {
      env: { ...process.env, SHOWME_TEST_MODE: mode },
    });
    child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * 画面が無いと Electron はそもそも起動しない（実測: "Missing X server or
 * $DISPLAY" で即 exit 1）。落ちてから原因を探させない。
 */
function warnIfHeadless(): void {
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY !== undefined && process.env.DISPLAY !== "") return;
  console.error(
    "$DISPLAY が無い。VS Code は起動できない。仮想画面の下で走らせること:\n" +
      "  npm run -w packages/extension test:integration:xvfb",
  );
}

async function main(): Promise<void> {
  warnIfHeadless();
  const extensionTestsPath = path.resolve(HERE, "./suite/index");
  const executable = await downloadAndUnzipVSCode();
  let failed = false;

  for (const pass of PASSES) {
    const workspace = createFixtureWorkspace(pass.mode);
    const userDataDir = prepareUserDataDir(pass.mode);
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), `showme-ext-${pass.mode}-`));

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
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      `--extensionTestsPath=${extensionTestsPath}`,
    ];
    if (pass.disableWorkspaceTrust) args.push("--disable-workspace-trust");

    // 標準出力に残す。落ちたときにどの木を見ればよいかが分からないと、
    // ヘッドレスの失敗は「なんとなく駄目だった」で終わる。
    console.log(`\n=== ${pass.label} (${pass.mode}) ===`);
    console.log(`workspace: ${workspace.root}`);
    console.log(`outside:   ${workspace.outsideDir}`);
    console.log(
      `trust:     ${pass.disableWorkspaceTrust ? "--disable-workspace-trust あり" : "なし"}`,
    );

    const code = await launch(executable, args, pass.mode);
    if (code === 0) {
      console.log(`=== ${pass.label}: PASS ===`);
    } else {
      failed = true;
      console.error(`=== ${pass.label}: FAIL (exit ${code}) ===`);
    }
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("統合テストを起動できませんでした:", e);
  process.exit(1);
});
