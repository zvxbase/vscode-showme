import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { createFixtureWorkspace } from "./fixture.js";

/**
 * 表示言語 `ja` で VS Code を起こし、人間向けの文字列が日本語になることを実機で見る
 * （D58）。走らせる節は `suite/locale-ja.test.ts` だけ。
 *
 * **`--locale=ja` だけでは足りない**（実測）。VS Code は `--locale` を `userLocale` に
 * 入れるが、`vscode.env.language`（＝ `resolvedLanguage`）は**言語パックが入っている
 * ときだけ** `ja` になり、無ければ `en` に戻る。`l10n/bundle.l10n.ja.json` を読むかどうかは
 * `env.language` で決まるので、束の検査には言語パックが要る。
 *
 * だから日本語の言語パック（MS-CEINTL.vscode-language-pack-ja）を Open VSX から
 * 1度だけ落として `.vscode-test/` に置き、この回専用の拡張ディレクトリに CLI で入れてから
 * 起動する。既に落としてあれば再利用する。`SHOWME_JA_LANGUAGE_PACK_VSIX` で手元の
 * VSIX を指せば、ダウンロードしない。
 *
 * **起動は2回**。人間が言語パックを入れたときの「再起動して適用」と同じで、
 * `languagepacks.json` は1回目の起動で共有プロセスが書き、2回目の起動がそれを読む
 * （CLI の `--install-extension` は書かない。実測）。1回目は
 * `suite/wait-language-pack.ts` を入口にして、ファイルに `ja` が現れるのを待つだけ。
 *
 * `runTest.ts` と同じく `runTests()` は使わず、引数列をこのファイルに全部見せる。
 * trusted / restricted の回とは**別の npm script**（`test:integration:locale-ja`）に
 * してある ―― 通常の回をネットワークに依存させないため。
 */

const HERE = __dirname;
const EXTENSION_ROOT = path.resolve(HERE, "..");

/** Open VSX の固定版。VS Code 本体は最新を落とすので、`engines.vscode` が下限で合えばよい。 */
const LANGUAGE_PACK_VERSION = "1.131.0";
const LANGUAGE_PACK_ID = "MS-CEINTL.vscode-language-pack-ja";
const LANGUAGE_PACK_URL = `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-ja/${LANGUAGE_PACK_VERSION}/file/${LANGUAGE_PACK_ID}-${LANGUAGE_PACK_VERSION}.vsix`;

async function ensureLanguagePack(): Promise<string> {
  const given = process.env.SHOWME_JA_LANGUAGE_PACK_VSIX;
  if (given !== undefined && given !== "") {
    if (!fs.existsSync(given)) throw new Error(`SHOWME_JA_LANGUAGE_PACK_VSIX が無い: ${given}`);
    return given;
  }
  const dir = path.join(EXTENSION_ROOT, ".vscode-test", "language-pack-ja");
  const vsix = path.join(dir, `${LANGUAGE_PACK_ID}-${LANGUAGE_PACK_VERSION}.vsix`);
  if (fs.existsSync(vsix) && fs.statSync(vsix).size > 0) return vsix;
  fs.mkdirSync(dir, { recursive: true });
  console.log(`言語パックを落とす: ${LANGUAGE_PACK_URL}`);
  const res = await fetch(LANGUAGE_PACK_URL);
  if (!res.ok) throw new Error(`言語パックを落とせない: HTTP ${res.status}`);
  const tmp = `${vsix}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, vsix);
  return vsix;
}

/** ユーザ設定を書く（runTest.ts と同じ）。信頼ダイアログ等を止める。 */
function prepareUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-udd-locale-ja-"));
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
  return dir;
}

/** 言語パックを、この回専用の拡張ディレクトリに入れる（VS Code の CLI で）。 */
function installLanguagePack(
  executable: string,
  vsix: string,
  extensionsDir: string,
  userDataDir: string,
): void {
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);
  const args = [
    "--install-extension",
    vsix,
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`,
    "--force",
  ];
  // 端末が VS Code のものだと `VSCODE_IPC_HOOK_CLI` が継承され、CLI は落とした
  // VS Code ではなく**その端末を出している VS Code** に繋ごうとして失敗する（実測:
  // `Unable to connect to VS Code server` → exit 1）。外して素の CLI として走らせる。
  const { VSCODE_IPC_HOOK_CLI: _ignored, ...env } = process.env;
  const result = cp.spawnSync(cli, args, { encoding: "utf8", env });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`言語パックを入れられない (exit ${String(result.status)})`);
  }
}

function launch(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { env: { ...process.env, ...env } });
    child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function warnIfHeadless(): void {
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY !== undefined && process.env.DISPLAY !== "") return;
  console.error(
    "$DISPLAY が無い。VS Code は起動できない。仮想画面の下で走らせること:\n" +
      "  npm run -w packages/extension test:integration:locale-ja:xvfb",
  );
}

async function main(): Promise<void> {
  warnIfHeadless();
  const extensionTestsPath = path.resolve(HERE, "./suite/index");
  const warmUpPath = path.resolve(HERE, "./suite/wait-language-pack");
  const executable = await downloadAndUnzipVSCode();
  const vsix = await ensureLanguagePack();
  const workspace = createFixtureWorkspace("trusted");
  const userDataDir = prepareUserDataDir();
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-ext-locale-ja-"));
  installLanguagePack(executable, vsix, extensionsDir, userDataDir);

  // `--disable-extensions` は付けない。言語パックは拡張であり、無効にすると
  // `resolvedLanguage` が `en` に戻る。この拡張ディレクトリには言語パックしか無い。
  const baseArgs = [
    workspace.root,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--locale=ja",
    "--disable-workspace-trust",
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
  ];

  console.log("\n=== 日本語 (--locale=ja) 1回目: languagepacks.json を書かせる ===");
  console.log(`workspace:     ${workspace.root}`);
  console.log(`language pack: ${vsix}`);
  const warm = await launch(executable, [...baseArgs, `--extensionTestsPath=${warmUpPath}`], {
    SHOWME_TEST_MODE: "locale-ja",
    SHOWME_USER_DATA_DIR: userDataDir,
  });
  if (warm !== 0) {
    console.error(`=== 日本語: 1回目で失敗 (exit ${warm}) ===`);
    process.exit(1);
  }

  console.log("\n=== 日本語 (--locale=ja) 2回目: 検査 ===");
  const code = await launch(
    executable,
    [...baseArgs, `--extensionTestsPath=${extensionTestsPath}`],
    {
      SHOWME_TEST_MODE: "locale-ja",
    },
  );
  if (code === 0) {
    console.log("=== 日本語: PASS ===");
  } else {
    console.error(`=== 日本語: FAIL (exit ${code}) ===`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("統合テスト（--locale=ja）を起動できませんでした:", e);
  process.exit(1);
});
