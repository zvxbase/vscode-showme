import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 言語パックの「再起動して適用」の前半（`runLocaleJa.ts` の1回目の起動）。
 *
 * VS Code は `languagepacks.json`（user-data-dir 直下）を**共有プロセスが起動後に**
 * 書き、次の起動でそれを読んで `resolvedLanguage` を決める。CLI の
 * `--install-extension` はこのファイルを書かない（実測: 入れた直後の user-data-dir に無い。
 * 1回目の起動でも、テストが 75ms で終わると書かれる前に VS Code が終了した）。
 *
 * だからこの入口は**テストを1件も走らせず**、`languagepacks.json` に `ja` が現れるまで
 * 待ってから終わる。現れなければ落とす ―― 黙って進むと2回目が英語のまま走る。
 */
export function run(): Promise<void> {
  const userDataDir = process.env.SHOWME_USER_DATA_DIR;
  if (userDataDir === undefined || userDataDir === "") {
    return Promise.reject(new Error("SHOWME_USER_DATA_DIR が無い"));
  }
  const file = path.join(userDataDir, "languagepacks.json");
  const deadline = Date.now() + 90_000;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (parsed.ja !== undefined) {
          console.log(`languagepacks.json に ja が書かれた: ${file}`);
          resolve();
          return;
        }
      } catch {
        // まだ無い、または書きかけ。
      }
      if (Date.now() > deadline) {
        reject(new Error(`languagepacks.json に ja が現れない: ${file}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}
