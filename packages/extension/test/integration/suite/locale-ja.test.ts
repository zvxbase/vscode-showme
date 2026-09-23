import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { EXTENSION_ID, activateExtension, inspectVisuals, setRole } from "./helpers.js";

/**
 * 表示言語が `ja` の窓で、人間向けの文字列が実際に日本語に差し替わる（D58）。
 *
 * この回は `runLocaleJa.ts` が起こす: 日本語の言語パックを入れた拡張ディレクトリと
 * `--locale=ja` で VS Code を起動する。**言語パック無しの `--locale=ja` では
 * `vscode.env.language` は `en` のまま**（実測。VS Code は `resolvedLanguage` を
 * 言語パックが見つかったときだけ `ja` にする）。だから最初に `env.language` を主張する
 * ―― これが無いと、言語パックの導入に失敗した回が「英語の原文 === 英語の原文」で
 * 緑になる。
 *
 * 主張は**値で**する: 束（`l10n/bundle.l10n.ja.json`）の値そのものと一致すること。
 * 束の値が原文と違うことも主張する（同じなら「差し替わった」は何も言っていない）。
 */
suite("実 VS Code / --locale=ja / 人間向けの文字列が日本語になる（D58）", () => {
  let extensionPath: string;

  suiteSetup(async () => {
    const ext = await activateExtension();
    extensionPath = ext.extensionPath;
  });

  function readJson(rel: string): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(extensionPath, rel), "utf8")) as Record<
      string,
      string
    >;
  }

  test("この回の表示言語は ja である（前提。言語パックが効いていなければここで落ちる）", () => {
    assert.ok(
      vscode.env.language.toLowerCase().startsWith("ja"),
      `vscode.env.language が ja でない: ${vscode.env.language}`,
    );
  });

  test("ステータスバーの文字列が bundle.l10n.ja.json の値と一致する", async () => {
    const bundle = readJson("l10n/bundle.l10n.ja.json");
    const key = "ShowMe: Off";
    const ja = bundle[key];
    assert.ok(ja, `束に鍵が無い: ${key}`);
    assert.notStrictEqual(ja, key, "束の値が原文と同じ（差し替わったかどうかを判別できない）");

    await setRole("idle");
    const view = (await inspectVisuals()).statusBar;
    // codicon は鍵の外（status-bar.ts）。全体を値で比べる。
    assert.strictEqual(view.text, `$(shield) ${ja}`);
    assert.ok(!view.text.includes("ShowMe: Off"), `英語の原文が残っている: ${view.text}`);
  });

  test("package.json の %key% が package.nls.ja.json で解決されている", () => {
    const nlsJa = readJson("package.nls.ja.json");
    const nlsEn = readJson("package.nls.json");
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    // 英語以外の表示言語では、VS Code は `%key%` を `{ original, value }` に展開して
    // `packageJSON` に入れる（実測: `original` が package.nls.json、`value` が
    // package.nls.ja.json の値）。両方の nls が読まれたことが1つの値で分かる。
    const manifest = ext.packageJSON as {
      contributes: { commands: { command: string; title: { original: string; value: string } }[] };
    };
    const toggle = manifest.contributes.commands.find((c) => c.command === "showme.toggle");
    assert.ok(toggle, "showme.toggle が contributes.commands に無い");
    assert.notStrictEqual(nlsJa["showme.command.toggle"], nlsEn["showme.command.toggle"]);
    assert.deepStrictEqual(toggle.title, {
      original: nlsEn["showme.command.toggle"],
      value: nlsJa["showme.command.toggle"],
    });
  });
});
