import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  currentUserSid,
  noForeignCreateVerdict,
  privateDirVerdict,
  processUid,
  readSddl,
  runtimeDirCandidates,
} from "@zvx/vscode-showme-protocol";
import { activateExtension } from "./helpers.js";

/**
 * ネイティブの Windows の信頼の回の最初に走る（suite/index.ts が win32 のときだけ足す）。
 *
 * Windows では実行時ディレクトリを DACL で確かめて立つ（D104）。ここでは**実 VS Code の上で
 * 本当に立ち、トークンを置くディレクトリが本人と trusted（SYSTEM・Administrators）だけのもの
 * であること**を確かめる。立たなかったときは、拡張の出した理由がそのまま失敗の文言になる
 * （`TEMP` の ACL で断られたのか、別の理由かが CI のログで分かるように）。
 */
suite("実 VS Code / ネイティブの Windows で立つ", () => {
  test("実行時ディレクトリが本人と trusted だけのもので、ShowMe の名前付きパイプが立っている", async () => {
    assert.strictEqual(process.platform, "win32", "この検査は Windows でだけ走らせる");
    await activateExtension();

    const [first] = runtimeDirCandidates(process.env, os.tmpdir(), processUid(process));
    assert.ok(first !== undefined, "実行時ディレクトリの候補が無い");
    // 立つまで待つ（activate はサーバの起動を待って返るが、念のため）。
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(first) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!fs.existsSync(first)) {
      // 立たなかった理由の多くは親（TEMP）の DACL。拡張と同じ判定で、親の SDDL ごと失敗に載せる。
      const parent = path.dirname(first);
      const parentSddl = await readSddl(parent).catch((e: unknown) => `(unreadable: ${String(e)})`);
      const parentVerdict = noForeignCreateVerdict(parentSddl, await currentUserSid());
      assert.fail(
        `実行時ディレクトリが作られていない: ${first}\n親 ${parent} の SDDL: ${parentSddl}\n判定: ${JSON.stringify(parentVerdict)}`,
      );
    }

    const verdict = privateDirVerdict(await readSddl(first), await currentUserSid());
    assert.deepStrictEqual(verdict, { ok: true }, `実行時ディレクトリが私的でない: ${first}`);

    const registrations = fs.readdirSync(first).filter((name) => /^[0-9a-f]{16}\.json$/.test(name));
    assert.strictEqual(registrations.length, 1, `登録ファイルが1つでない: ${registrations}`);

    // 名前付きパイプの一覧は `\\.\pipe\` で読める。拡張が立てるパイプの名前は `vscode-showme-…`
    // （server.ts）。
    const pipes = fs.readdirSync("\\\\.\\pipe\\");
    const ours = pipes.filter((name) => /^vscode-showme-[0-9a-f]{16}$/.test(name));
    assert.strictEqual(ours.length, 1, `ShowMe の名前付きパイプが1本でない: ${ours}`);
  });
});
