import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ENV_REL,
  HARDLINK_PLAIN_MARKER,
  HARDLINK_PLAIN_ORIGINAL_REL,
  HARDLINK_PLAIN_REL,
  HARDLINK_TO_ENV_REL,
  SYMLINK_TO_ENV_REL,
} from "../fixture.js";
import {
  STAGE_SCHEME_READONLY,
  activateExtension,
  getEditorState,
  lendWindow,
  showOne,
  stageUri,
  visibleEditorFor,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 秘匿ファイルへのハードリンク（D91）を実機で確かめる。**両方の回で走らせる。**
 *
 * `docs/env-alias.txt` は `.env` と同じ実体で、名前は秘匿のパターンに当たらず、realpath も
 * 何も変えない。エージェントの入口（`show_code`・映し）でも、人間が開いたタブの観測
 * （`get_editor_state`）でも、`.env` と同じく中身に当たるものが出ないことを見る。
 * 設定 `showme.blockLinksToRedactedFiles` を切れば今までどおり名前だけで判定すること、
 * 普通のファイル同士のハードリンクは既定でも開けること（全部落とす実装が緑にならない）も見る。
 */

function diskPath(rel: string): string {
  return path.join(workspaceRoot().fsPath, rel);
}

async function reset(): Promise<void> {
  await vscode.commands.executeCommand("showme.test.resetRateLimits");
}

/** 人間が `file:` で開いて、1行目の先頭から選ぶ。 */
async function humanSelects(rel: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspaceRoot(), rel));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(0, 0, 0, 6);
}

async function rejectionCode(p: Thenable<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { code?: unknown }).code ?? "");
  }
  assert.fail("開けてしまった");
}

suite("秘匿ファイルへのハードリンク（D91）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(reset);

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("前提: 別名は .env と同じ実体で、普通のファイル同士のリンクも張られている", () => {
    const env = fs.statSync(diskPath(ENV_REL), { bigint: true });
    const alias = fs.statSync(diskPath(HARDLINK_TO_ENV_REL), { bigint: true });
    assert.ok(alias.nlink >= 2n, "ハードリンクが張られていない（この検査の前提が崩れている）");
    assert.strictEqual(alias.ino, env.ino, "別名が .env と同じ実体でない");
    assert.strictEqual(fs.lstatSync(diskPath(HARDLINK_TO_ENV_REL)).isSymbolicLink(), false);
    const original = fs.statSync(diskPath(HARDLINK_PLAIN_ORIGINAL_REL), { bigint: true });
    const plain = fs.statSync(diskPath(HARDLINK_PLAIN_REL), { bigint: true });
    assert.strictEqual(plain.ino, original.ino, "普通のファイル同士のリンクが張られていない");
    assert.ok(plain.nlink >= 2n);
  });

  test("show_code は別名を解決せず、何も開かない（シンボリックリンク経由の .env と同じ答え）", async () => {
    const viaHardLink = await showOne({ path: HARDLINK_TO_ENV_REL, text: "SECRET" });
    assert.strictEqual(viaHardLink.match, "none", JSON.stringify(viaHardLink));
    assert.strictEqual(viaHardLink.range, undefined, "拒否したのに range を返している");
    assert.strictEqual(viaHardLink.candidates, undefined, "拒否したのに candidates を返している");
    // 理由は秘匿ファイルへのシンボリックリンクと同じ形（どの名前が秘匿の実体かを割らない）。
    await reset();
    const viaSymlink = await showOne({ path: SYMLINK_TO_ENV_REL, text: "SECRET" });
    assert.strictEqual(viaHardLink.reason, viaSymlink.reason, JSON.stringify(viaSymlink));
    assert.ok(
      viaHardLink.reason === "excluded-path" || viaHardLink.reason === "not-found",
      JSON.stringify(viaHardLink),
    );
    for (const uri of [
      await stageUri(HARDLINK_TO_ENV_REL),
      vscode.Uri.joinPath(workspaceRoot(), HARDLINK_TO_ENV_REL),
    ]) {
      assert.strictEqual(visibleEditorFor(uri), undefined, `別名が開かれている: ${uri.toString()}`);
    }
  });

  test("映し showme-ro:/<別名> は開けない（FileNotFound）", async () => {
    const uri = await stageUri(HARDLINK_TO_ENV_REL, STAGE_SCHEME_READONLY);
    assert.strictEqual(await rejectionCode(vscode.workspace.fs.readFile(uri)), "FileNotFound");
    assert.strictEqual(await rejectionCode(vscode.workspace.fs.stat(uri)), "FileNotFound");
    await rejectionCode(vscode.workspace.openTextDocument(uri));
  });

  test("人間が file: で開いて選んでも、選択も位置も返らない", async () => {
    await humanSelects(HARDLINK_TO_ENV_REL);
    const state = await getEditorState();
    // 開いていることまでは伝える（秘匿の名前と同じ規則。設計書 §3.1）。
    assert.strictEqual(state.activePath, HARDLINK_TO_ENV_REL, JSON.stringify(state));
    assert.strictEqual(state.selectionWithheld, "redacted", JSON.stringify(state));
    assert.strictEqual(state.selectedText, undefined);
    assert.strictEqual(state.selection, undefined);
    assert.strictEqual(state.cursor, undefined);
    assert.strictEqual(state.visibleLines, undefined);
  });

  test("設定を切ると、今までどおり名前だけで判定して開ける", async () => {
    await withSettings({ blockLinksToRedactedFiles: false }, async () => {
      const resolution = await showOne({ path: HARDLINK_TO_ENV_REL, text: "SECRET" });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));

      const bytes = await vscode.workspace.fs.readFile(
        await stageUri(HARDLINK_TO_ENV_REL, STAGE_SCHEME_READONLY),
      );
      assert.ok(Buffer.from(bytes).toString("utf8").includes("SECRET"));

      await humanSelects(HARDLINK_TO_ENV_REL);
      const state = await getEditorState();
      assert.strictEqual(state.activePath, HARDLINK_TO_ENV_REL, JSON.stringify(state));
      assert.notStrictEqual(state.selectionWithheld, "redacted", JSON.stringify(state));
      assert.ok(state.cursor !== undefined, JSON.stringify(state));
    });
  });

  test("普通のファイル同士のハードリンクは既定でも開ける", async () => {
    const resolution = await showOne({ path: HARDLINK_PLAIN_REL, text: HARDLINK_PLAIN_MARKER });
    assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));

    const bytes = await vscode.workspace.fs.readFile(
      await stageUri(HARDLINK_PLAIN_REL, STAGE_SCHEME_READONLY),
    );
    assert.ok(Buffer.from(bytes).toString("utf8").includes(HARDLINK_PLAIN_MARKER));

    await humanSelects(HARDLINK_PLAIN_REL);
    const state = await getEditorState();
    assert.strictEqual(state.activePath, HARDLINK_PLAIN_REL, JSON.stringify(state));
    assert.notStrictEqual(state.selectionWithheld, "redacted", JSON.stringify(state));
    assert.ok(state.cursor !== undefined, JSON.stringify(state));
  });
});
