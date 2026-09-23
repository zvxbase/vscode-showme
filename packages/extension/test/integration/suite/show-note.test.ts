import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, lendWindow } from "./helpers.js";

/**
 * `show_note` を実機で確かめる（設計書 §4.3 / §4.4 の完了条件）。
 *
 * 単体テストは判断（`chooseNoteTarget`）を見ているが、**実際に開いた
 * ドキュメントの URI がどうなるか**は実機でしか分からない。
 * `untitled:<path>` 形式を使っていないことは、そこを見て初めて言える。
 */

interface NoteResult {
  shown?: unknown;
  reusedDocument?: unknown;
}

async function showNote(text: string, language?: string): Promise<NoteResult> {
  const args = language === undefined ? { text } : { text, language };
  return (await vscode.commands.executeCommand("showme.test.showNote", args)) as NoteResult;
}

/** いま開いている名前なしドキュメントを探す。 */
function untitledDocuments(): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter((doc) => doc.isUntitled);
}

suite("show_note（2C Task 5）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  test("名前なしドキュメントが開き、URI は untitled:<path> 形式ではない", async () => {
    const before = new Set(untitledDocuments().map((doc) => doc.uri.toString()));
    const result = await showNote("# メモ\n\nこれは説明です。");
    assert.strictEqual(result.shown, true);
    assert.strictEqual(result.reusedDocument, false);

    const opened = untitledDocuments().filter((doc) => !before.has(doc.uri.toString()));
    assert.strictEqual(opened.length, 1, "新しい名前なしドキュメントが1つ開いていない");
    const doc = opened[0];
    assert.ok(doc !== undefined);

    assert.strictEqual(doc.uri.scheme, "untitled");
    assert.strictEqual(doc.isUntitled, true);
    // **`untitled:<path>` 形式ではない。** そちらは開いた後にその場所へ
    // 無確認で保存できる（設計書 §4.3）。`{content, language}` 版は
    // `Untitled-N` になり、保存時に必ずパスを尋ねる。
    assert.match(
      doc.uri.path,
      /^Untitled-\d+$/,
      `URI が untitled:<path> 形式に見える: ${doc.uri.toString()}`,
    );
    assert.ok(!doc.uri.path.includes("/"), "URI にパス区切りが入っている");
    assert.strictEqual(doc.getText(), "# メモ\n\nこれは説明です。");
    assert.strictEqual(doc.languageId, "markdown");
  });

  test("誰も触っていなければ同じドキュメントを使い回す（メモが増えない）", async () => {
    await showNote("1回目");
    const countAfterFirst = untitledDocuments().length;

    const second = await showNote("2回目");
    assert.strictEqual(second.reusedDocument, true, "使い回していない");
    assert.strictEqual(
      untitledDocuments().length,
      countAfterFirst,
      "呼ぶたびにドキュメントが増えている（isDirty で判定していないか）",
    );
  });

  test("人間が編集していたら上書きせず新しく開く", async () => {
    await showNote("元の本文");
    const target = untitledDocuments().find((doc) => doc.getText() === "元の本文");
    assert.ok(target !== undefined, "書いたメモが見つからない");
    const countBefore = untitledDocuments().length;

    // 人間の編集を模す。
    const edit = new vscode.WorkspaceEdit();
    edit.insert(target.uri, new vscode.Position(0, 0), "人間が書いた行\n");
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

    const result = await showNote("新しい本文");
    assert.strictEqual(result.reusedDocument, false, "人間の編集を上書きしている");
    assert.ok(target.getText().includes("人間が書いた行"), "人間が書いた行が消えている");
    assert.strictEqual(
      untitledDocuments().length,
      countBefore + 1,
      "新しいドキュメントが開かれていない",
    );
  });

  test("markdown のメモでは取得を起こすタグが無力化される", async () => {
    // VS Code の Markdown プレビューは**生の HTML を描画し、既定で https の画像を
    // 読み込む**。つまり我々の3枚構成も CSP も通らずに要求が出る経路である
    // （増分2C のレビューで判明）。実機の文書の中身で確かめる。
    await showNote("触った土台");
    const base = untitledDocuments().find((doc) => doc.getText() === "触った土台");
    assert.ok(base !== undefined);
    const touch = new vscode.WorkspaceEdit();
    touch.insert(base.uri, new vscode.Position(0, 0), "人間\n");
    assert.strictEqual(await vscode.workspace.applyEdit(touch), true);

    const before = new Set(untitledDocuments().map((doc) => doc.uri.toString()));
    await showNote('説明\n\n<img src="https://evil.example/leak">\n\nArray<string> はそのまま');
    const opened = untitledDocuments().filter((doc) => !before.has(doc.uri.toString()));
    const doc = opened[0];
    assert.ok(doc !== undefined, "新しいメモが開いていない");

    const text = doc.getText();
    assert.ok(text.includes("&lt;img"), `img が無力化されていない: ${text}`);
    assert.ok(!text.includes("<img"), `生の img が残っている: ${text}`);
    // **コードの説明を壊さない。** 総称型はそのまま。
    assert.ok(text.includes("Array<string>"), `総称型が壊れている: ${text}`);
  });

  test("言語 ID を指定できる", async () => {
    // 言語 ID は**新しく開くときにしか効かない**（使い回しは中身を差し替えるだけ）。
    // だから「人間が触った」状態を明示的に作ってから呼ぶ ―― 前の検査の副作用に
    // 頼ると、使い回しに倒れて markdown のままになり、この検査は何も測らない。
    await showNote("土台");
    const current = untitledDocuments().find((doc) => doc.getText() === "土台");
    assert.ok(current !== undefined, "土台のメモが見つからない");
    const touch = new vscode.WorkspaceEdit();
    touch.insert(current.uri, new vscode.Position(0, 0), "触った\n");
    assert.strictEqual(await vscode.workspace.applyEdit(touch), true);

    const before = new Set(untitledDocuments().map((doc) => doc.uri.toString()));
    const result = await showNote("const a = 1;", "typescript");
    assert.strictEqual(result.reusedDocument, false, "新しく開いていない（前提が崩れている）");
    const opened = untitledDocuments().filter((doc) => !before.has(doc.uri.toString()));
    const doc = opened[0];
    assert.ok(doc !== undefined, "新しいドキュメントが開いていない");
    assert.strictEqual(doc.languageId, "typescript");
  });
});
