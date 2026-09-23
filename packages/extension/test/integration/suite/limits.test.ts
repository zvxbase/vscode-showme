import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, lendWindow } from "./helpers.js";

/**
 * **宣言した上限が本当に使えるか**を実機で測る。
 *
 * これが無いと「スキーマにこう書いてある」だけで誰も一度も確かめていない状態が続く
 * ―― 現に続いていた。実地で `show_html` が約 3.9 KiB（宣言の 1/67）で
 * 無言死していたことに、実演の日まで誰も気づかなかった
 * 。
 *
 * **注意:** テスト用コマンドは**ソケットを通らない**ので、これはハンドシェイクの
 * 回帰にはならない。ここで測るのは上限そのもの（スキーマ・サニタイザ・描画）である。
 * ソケット経路の回帰は `test/server.test.ts` が持つ。**両方要る。**
 */
suite("宣言した上限が実際に使える（増分3A）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    // 統合テストは1プロセスで何十回も呼ぶ。予算が尽きたまま「上限が使えるか」を
    // 測ると、測っているのは制限であって上限ではない。
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  test("show_html は 90 KiB 相当の HTML を受け付ける", async () => {
    // 日本語は UTF-8 で 1 文字 3 バイト。30,000 文字で約 90 KiB。
    const html = `<p>${"あ".repeat(30_000)}</p>`;
    const result = (await vscode.commands.executeCommand("showme.test.showHtml", { html })) as {
      shown?: unknown;
    };
    assert.strictEqual(result.shown, true);
  });

  test("show_note は 30,000 文字を受け付ける", async () => {
    const text = "あ".repeat(30_000);
    const result = (await vscode.commands.executeCommand("showme.test.showNote", { text })) as {
      shown?: unknown;
    };
    assert.strictEqual(result.shown, true);
  });

  test("落とした宣言の件数が返る", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.showHtml", {
      html: '<p style="color:#111; position:fixed">a</p>',
    })) as { droppedDeclarations?: unknown };
    assert.strictEqual(result.droppedDeclarations, 1);
  });

  test("配色を指定しない HTML でも中身が届く（baseline があるので読める）", async () => {
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<h2>見出し</h2><p>本文</p><table><tr><th>A</th><td>1</td></tr></table>",
    });
    const state = (await vscode.commands.executeCommand("showme.test.panelState")) as {
      acknowledged?: unknown;
      length?: unknown;
    };
    assert.strictEqual(state.acknowledged, true);
    // baseline を前置しているので、届く文書は中身より必ず長い。
    assert.ok(typeof state.length === "number" && state.length > 500, String(state.length));
  });
});
