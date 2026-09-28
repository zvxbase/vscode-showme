import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import { processUid, runtimeDirCandidates } from "@zvx/vscode-showme-protocol";
import { activateExtension } from "./helpers.js";

/**
 * ネイティブの Windows の回（runTest.ts が win32 のときだけ走らせる）。
 *
 * Windows では拡張がソケットサーバを立てない（`prepareRuntimeDir` が閉じる側に倒す。
 * Node は ACL を読めないので、接続のトークンを置くディレクトリを誰が読めるかを確かめられない。
 * 設計書 §3.5 の Windows の行）。だから信頼モード・制限モードの回（どちらも最初に登録ファイルと
 * ソケットの実在を確かめ、ツールを呼ぶ）はここでは走らせない ―― 走らせても、全部が同じ1つの
 * 理由で落ちるだけである。代わりに、**実 VS Code の上で本当に立たないこと**を確かめる:
 * 拡張は有効になる（ログとコマンドは使える）が、実行時ディレクトリも名前付きパイプも作らない。
 */
suite("実 VS Code / ネイティブの Windows では起動を断る", () => {
  test("拡張は有効になるが、実行時ディレクトリを作らず、名前付きパイプも立てない", async () => {
    assert.strictEqual(process.platform, "win32", "この回は Windows でだけ走らせる");
    await activateExtension();
    // activate はサーバの起動を待ってから返る（失敗しても例外にしない）。念のため少し待って、
    // 遅れて作られるものが無いことも確かめる。
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    for (const dir of runtimeDirCandidates(process.env, os.tmpdir(), processUid(process))) {
      assert.strictEqual(fs.existsSync(dir), false, `実行時ディレクトリが作られた: ${dir}`);
    }
    // 名前付きパイプの一覧は `\\.\pipe\` で読める。拡張が立てるパイプの名前は `vscode-showme-…`
    // （server.ts）。一覧が読めること自体も確かめる（読めずに空なら、空振りの緑になる）。
    const pipes = fs.readdirSync("\\\\.\\pipe\\");
    assert.ok(pipes.length > 0, "名前付きパイプの一覧が読めない（空振りの緑を防ぐ）");
    const ours = pipes.filter((name) => name.startsWith("vscode-showme-"));
    assert.deepStrictEqual(ours, [], "ShowMe の名前付きパイプが立っている");
  });
});
