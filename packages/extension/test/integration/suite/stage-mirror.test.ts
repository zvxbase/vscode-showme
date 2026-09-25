import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ENV_REL,
  MIRROR_CLOSE_REL,
  MIRROR_CONFLICT_REL,
  MIRROR_DISK_REL,
  MIRROR_EDITABLE_BUMP_REL,
  MIRROR_EDITABLE_REL,
  MIRROR_FOLLOW_REL,
  MIRROR_ORIGINAL_TEXT,
  MIRROR_OTHER_REL,
  MIRROR_READONLY_DISK_REL,
  MIRROR_UNSAVED_REL,
  SAMPLE_REL,
  SYMLINK_TO_ENV_REL,
} from "../fixture.js";
import {
  STAGE_SCHEME_EDITABLE,
  STAGE_SCHEME_READONLY,
  activateExtension,
  stageUri,
  waitFor,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 映しの FileSystemProvider（設計 D81）を実機で確かめる。
 *
 * 映しのタブを舞台として開く側は stage-tabs.test.ts が見る。ここでは**登録されていること**と、
 * 登録された口が関門を通すこと（秘匿・脱出・リンク・不在が同じ形で落ちる）、
 * 人間の未保存の編集が `showme-ro:` に映ること、`showme-rw:` の保存が本物の
 * ファイルに書かれることを見る。窓を預けるかどうかに依らず登録される（D81）ので、
 * `lendWindow` は呼ばない。
 */

function diskPath(rel: string): string {
  return path.join(workspaceRoot().fsPath, rel);
}

/**
 * 開いた文書を revert してから閉じる。後続の節にタブも未保存も残さない。
 *
 * `tabGroups.close` で捨てない ―― 未保存のタブを閉じると保存の確認が出うる（teardown の
 * `closeAllEditors` が固まる。restricted.test.ts と同じ理由）。前面に出して
 * `revertAndCloseActiveEditor` で閉じる。タブも未保存も無い URI は何もしない。
 */
async function revertAndClose(uris: readonly vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    const key = uri.toString();
    const hasTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key);
    const dirty = vscode.workspace.textDocuments.some(
      (doc) => doc.uri.toString() === key && doc.isDirty,
    );
    if (!hasTab && !dirty) continue;
    await vscode.window.showTextDocument(uri, { preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
}

/**
 * 失敗の形。メッセージは URI の綴りを含むので、それを伏せてから比べる ――
 * 残った部分が同じなら、理由（秘匿・脱出・不在）を語っていない。
 *
 * 伏せるのは渡した綴りではなく**メッセージに現れた映しの URI 全部**。
 * `openTextDocument` は path の ".." を畳んでから provider に渡す（実測: "/../x" は
 * "showme-ro:/x" としてメッセージに現れる）ので、渡した綴りで伏せると割れて見える。
 */
function failureShape(error: unknown): { name: string; code: string; message: string } {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  const message = String(e.message ?? "").replace(/showme-r[ow]:\/[^'"\s]*/g, "<uri>");
  return { name: String(e.name ?? ""), code: String(e.code ?? ""), message };
}

/** `MIRROR_UNSAVED_REL`（"mirror/unsaved.md"）の別名の綴り。 */
const MIRROR_ALIASES = [
  "mirror//unsaved.md",
  "mirror/./unsaved.md",
  "./mirror/unsaved.md",
  "mirror\\unsaved.md",
  "mirror/x/../unsaved.md",
] as const;

/**
 * 文書の中身をまるごと置き換える（未保存にする）。編集器ではなく文書に当てる ――
 * 同じ組に2枚目を開くと1枚目の編集器は閉じたものになり、`TextEditor.edit` が使えない。
 */
async function replaceAll(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    text,
  );
  assert.strictEqual(
    await vscode.workspace.applyEdit(edit),
    true,
    `${doc.uri.toString()} を編集できない`,
  );
}

async function settle(
  p: Thenable<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

async function rejection(p: Thenable<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail("開けてしまった");
}

suite("映しの FileSystemProvider（D81）", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("showme-ro:/<SAMPLE_REL> はディスクの中身と同じ", async () => {
    const doc = await vscode.workspace.openTextDocument(
      await stageUri(SAMPLE_REL, STAGE_SCHEME_READONLY),
    );
    assert.strictEqual(doc.getText(), fs.readFileSync(diskPath(SAMPLE_REL), "utf8"));
    assert.strictEqual(doc.isDirty, false);
  });

  test("秘匿・脱出・リンク・不在はすべて開けず、失敗の形が同じ", async () => {
    assert.ok(
      fs.lstatSync(diskPath(SYMLINK_TO_ENV_REL)).isSymbolicLink(),
      "リンクが作られていない（前提）",
    );
    const rels = [ENV_REL, "../x", SYMLINK_TO_ENV_REL, ".env.nope-7a1f"];
    // `Uri.from` は path の ".." を畳まない。ただし `openTextDocument` は provider に
    // 渡す前に畳む（実測。"/x" の不在として落ちる）。`workspace.fs` の経路でどちらが
    // 届くかは問わない ―― 畳まれなければ `relOfStagePath` の脱出の拒否に、畳まれれば
    // 不在に当たり、どちらも同じ形で落ちることを下で見る。
    // `stageUri` の前提（正規化済みの rel）の外をわざと渡している ―― 映しの URI の組み方
    // （`Uri.from`）が ".." を畳まないことを確かめ、下で provider に別綴りを食わせるため。
    assert.strictEqual((await stageUri("../x", STAGE_SCHEME_READONLY)).path, "/../x");

    const aliasOutcomes: string[] = [];
    for (const api of ["openTextDocument", "fs.readFile", "fs.stat"] as const) {
      const shapes: string[] = [];
      for (const rel of rels) {
        for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
          const uri = await stageUri(rel, scheme);
          const call =
            api === "openTextDocument"
              ? vscode.workspace.openTextDocument(uri)
              : api === "fs.readFile"
                ? vscode.workspace.fs.readFile(uri)
                : vscode.workspace.fs.stat(uri);
          const shape = failureShape(await rejection(call));
          assert.doesNotMatch(
            shape.message,
            /exclud|redact|secret|escape|symlink|outside|denied|forbidden/i,
            `${api} ${uri.toString()} の失敗が理由を語っている: ${shape.message}`,
          );
          if (api !== "openTextDocument") {
            assert.strictEqual(shape.code, "FileNotFound", `${api} ${uri.toString()}`);
          }
          shapes.push(JSON.stringify(shape));
        }
      }
      // 別名の綴り（実在して関門も通るファイルを、正準形でない綴りで指す）。正規化すれば
      // 同じ rel になるが URI は別物で、受け入れると同じ実体が2つの URI で開ける（D82）。
      // provider に届けば、上と同じ形で落ちる。VS Code が provider の手前で正準形に畳んだ
      // ものは別名にならない（開けてよいが、開いた文書の URI は正準形のはず）。
      // 実測（VS Code 1.136）: openTextDocument は "//"・"./"・".." を畳んで正準形で開き、
      // "\" は畳まずに provider へ届けて落ちる。workspace.fs はどれも畳まずに届け、全部落ちる。
      for (const alias of MIRROR_ALIASES) {
        for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
          const uri = vscode.Uri.from({ scheme, path: `/${alias}` });
          const outcome = await settle(
            api === "openTextDocument"
              ? vscode.workspace.openTextDocument(uri)
              : api === "fs.readFile"
                ? vscode.workspace.fs.readFile(uri)
                : vscode.workspace.fs.stat(uri),
          );
          aliasOutcomes.push(`${api} ${uri.path} -> ${outcome.ok ? "opened" : "rejected"}`);
          if (outcome.ok) {
            // 開けたのは openTextDocument が畳んだときだけ許す（fs.* は provider の答えそのもの）。
            assert.strictEqual(api, "openTextDocument", `${api} ${uri.path} が別名で開けた`);
            const doc = outcome.value as vscode.TextDocument;
            assert.strictEqual(
              doc.uri.path,
              `/${MIRROR_UNSAVED_REL}`,
              `${uri.path} が別名で開けた`,
            );
            continue;
          }
          shapes.push(JSON.stringify(failureShape(outcome.error)));
        }
      }
      assert.strictEqual(
        new Set(shapes).size,
        1,
        `${api} の失敗の形が割れている:\n${[...new Set(shapes)].join("\n")}`,
      );
    }
    // 実測の記録（どの別名が provider に届き、どれを VS Code が手前で畳んだか）。
    console.log(`[測定/D81] 別名の綴り\n${aliasOutcomes.join("\n")}`);
  });

  test("列挙は空、作成・削除・改名は断る", async () => {
    for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
      const dir = vscode.Uri.from({ scheme, path: "/src" });
      assert.deepStrictEqual(await vscode.workspace.fs.readDirectory(dir), []);
      await rejection(vscode.workspace.fs.createDirectory(await stageUri("newdir-7a1", scheme)));
      await rejection(vscode.workspace.fs.delete(await stageUri(MIRROR_EDITABLE_REL, scheme)));
      await rejection(
        vscode.workspace.fs.rename(
          await stageUri(MIRROR_EDITABLE_REL, scheme),
          await stageUri("mirror/renamed.md", scheme),
        ),
      );
      // 新しいファイルは作らない（showme-rw でも）。
      await rejection(
        vscode.workspace.fs.writeFile(
          await stageUri("mirror/new-7a1.md", scheme),
          new Uint8Array([1]),
        ),
      );
      assert.strictEqual(fs.existsSync(diskPath("mirror/new-7a1.md")), false);
      assert.strictEqual(fs.existsSync(diskPath("newdir-7a1")), false);
      assert.strictEqual(
        fs.readFileSync(diskPath(MIRROR_EDITABLE_REL), "utf8"),
        MIRROR_ORIGINAL_TEXT,
      );
    }
    // 読み取り専用の映しからは書けない。秘匿パスへも書けない（中身は変わらない）。
    const envBefore = fs.readFileSync(diskPath(ENV_REL), "utf8");
    await rejection(
      vscode.workspace.fs.writeFile(
        await stageUri(MIRROR_EDITABLE_REL, STAGE_SCHEME_READONLY),
        new TextEncoder().encode("x"),
      ),
    );
    await rejection(
      vscode.workspace.fs.writeFile(
        await stageUri(ENV_REL, STAGE_SCHEME_EDITABLE),
        new TextEncoder().encode("x"),
      ),
    );
    assert.strictEqual(
      fs.readFileSync(diskPath(MIRROR_EDITABLE_REL), "utf8"),
      MIRROR_ORIGINAL_TEXT,
    );
    assert.strictEqual(fs.readFileSync(diskPath(ENV_REL), "utf8"), envBefore);
  });

  test("人間の未保存の変更が showme-ro: に映り、revert で戻る", async () => {
    const fileUri = vscode.Uri.joinPath(workspaceRoot(), MIRROR_UNSAVED_REL);
    const roUri = await stageUri(MIRROR_UNSAVED_REL, STAGE_SCHEME_READONLY);
    const mirror = await vscode.workspace.openTextDocument(roUri);
    try {
      assert.strictEqual(mirror.getText(), MIRROR_ORIGINAL_TEXT);
      const editor = await vscode.window.showTextDocument(fileUri, { preview: false });
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "unsaved human line\n"));
      assert.strictEqual(editor.document.isDirty, true, "未保存にできていない（前提）");

      await waitFor(
        "映しの1行目が人間の未保存の行になる",
        () => mirror.lineAt(0).text === "unsaved human line",
      );
      // ディスクは変わっていない（映しは未保存の中身を見せているだけ）。
      assert.strictEqual(
        fs.readFileSync(diskPath(MIRROR_UNSAVED_REL), "utf8"),
        MIRROR_ORIGINAL_TEXT,
      );

      await vscode.window.showTextDocument(editor.document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
      assert.strictEqual(editor.document.isDirty, false, "revert できていない（前提）");
      await waitFor("映しがディスクの中身に戻る", () => mirror.getText() === MIRROR_ORIGINAL_TEXT);
    } finally {
      await revertAndClose([fileUri, roUri]);
    }
  });

  test("showme-ro: の文書は編集しても isDirty にならない", async () => {
    const roUri = await stageUri(MIRROR_UNSAVED_REL, STAGE_SCHEME_READONLY);
    try {
      const editor = await vscode.window.showTextDocument(roUri, { preview: false });
      // `edit` の戻り値は見ない（実測 M1': 読み取り専用でも true を返す）。
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "should not apply\n"));
      assert.strictEqual(editor.document.isDirty, false);
      assert.strictEqual(
        fs.readFileSync(diskPath(MIRROR_UNSAVED_REL), "utf8"),
        MIRROR_ORIGINAL_TEXT,
      );
    } finally {
      await revertAndClose([roUri]);
    }
  });

  test("showme-rw: の mtime は版で動かず、未保存中に版が上がっても保存が通る", async () => {
    // 版（mirror.bump）は showme-ro を読み直させるためだけのもの。rw はディスクの素通しで、
    // mtime に版を足すと人間が別のファイルを打鍵するたびに rw の mtime が動く。
    //
    // **保存の成否だけでは判別しない**（実測: 版を足していた実装でも save() は true だった。
    // VS Code の書き込み前の衝突判定は mtime だけでなく size も比べるとみられ、版は size を
    // 変えないため）。だから stat の mtime が動かないことを直接見る。保存の検査は回帰の見張り。
    const rwUri = await stageUri(MIRROR_EDITABLE_BUMP_REL, STAGE_SCHEME_EDITABLE);
    const otherFile = vscode.Uri.joinPath(workspaceRoot(), MIRROR_OTHER_REL);
    const roOther = await stageUri(MIRROR_OTHER_REL, STAGE_SCHEME_READONLY);
    const written = "# mirror\n\nsaved after an unrelated bump\n";
    try {
      const rwEditor = await vscode.window.showTextDocument(rwUri, { preview: false });
      const doc = rwEditor.document;
      await rwEditor.edit((b) =>
        b.replace(
          new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
          written,
        ),
      );
      assert.strictEqual(doc.isDirty, true, "未保存にできていない（前提）");
      const mtimeBefore = (await vscode.workspace.fs.stat(rwUri)).mtime;

      // 無関係な file: 文書を人間が編集する → 版が上がる。上がったことは ro の映しが
      // 読み直されたことで確かめる（上がっていなければ、この検査は何も見ていない）。
      const mirrorOther = await vscode.workspace.openTextDocument(roOther);
      const otherEditor = await vscode.window.showTextDocument(otherFile, { preview: false });
      await otherEditor.edit((b) => b.insert(new vscode.Position(0, 0), "unrelated edit\n"));
      await waitFor(
        "版が上がり ro の映しが読み直される",
        () => mirrorOther.lineAt(0).text === "unrelated edit",
      );

      assert.strictEqual(
        (await vscode.workspace.fs.stat(rwUri)).mtime,
        mtimeBefore,
        "showme-rw の mtime が版で動いた",
      );
      assert.strictEqual(await doc.save(), true, "保存が失敗した");
      assert.strictEqual(doc.isDirty, false);
      assert.strictEqual(fs.readFileSync(diskPath(MIRROR_EDITABLE_BUMP_REL), "utf8"), written);
    } finally {
      await revertAndClose([rwUri, otherFile, roOther]);
      fs.writeFileSync(diskPath(MIRROR_EDITABLE_BUMP_REL), MIRROR_ORIGINAL_TEXT, "utf8");
    }
  });

  test("showme-rw: で編集して保存すると本物のファイルに書かれる", async () => {
    const rwUri = await stageUri(MIRROR_EDITABLE_REL, STAGE_SCHEME_EDITABLE);
    const written = "# mirror\n\nwritten through showme-rw\n";
    try {
      const editor = await vscode.window.showTextDocument(rwUri, { preview: false });
      assert.strictEqual(editor.document.getText(), MIRROR_ORIGINAL_TEXT);
      const doc = editor.document;
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
          written,
        ),
      );
      assert.strictEqual(doc.isDirty, true, "未保存にできていない（前提）");
      assert.strictEqual(await doc.save(), true, "保存が失敗した");
      assert.strictEqual(doc.isDirty, false);
      assert.strictEqual(fs.readFileSync(diskPath(MIRROR_EDITABLE_REL), "utf8"), written);
    } finally {
      await revertAndClose([rwUri]);
      fs.writeFileSync(diskPath(MIRROR_EDITABLE_REL), MIRROR_ORIGINAL_TEXT, "utf8");
    }
  });

  test("ディスクの変更は showme-ro: と showme-rw: の両方に映る", async () => {
    const roUri = await stageUri(MIRROR_DISK_REL, STAGE_SCHEME_READONLY);
    const rwUri = await stageUri(MIRROR_DISK_REL, STAGE_SCHEME_EDITABLE);
    const changed = "# mirror\n\nchanged on disk\n";
    const ro = await vscode.workspace.openTextDocument(roUri);
    const rw = await vscode.workspace.openTextDocument(rwUri);
    try {
      assert.strictEqual(ro.getText(), MIRROR_ORIGINAL_TEXT);
      assert.strictEqual(rw.getText(), MIRROR_ORIGINAL_TEXT);
      fs.writeFileSync(diskPath(MIRROR_DISK_REL), changed, "utf8");
      await waitFor("ro の映しがディスクの変更を映す", () => ro.getText() === changed);
      await waitFor("rw の映しがディスクの変更を映す", () => rw.getText() === changed);
    } finally {
      // 後始末はディスクを戻して閉じるだけにし、「映しが元に戻る」を待たない ―― ここで
      // `waitFor` が投げると、try の中で落ちた元の失敗（どちらの映しが映さなかったか）を
      // 後始末の失敗が上書きして隠す。映しが戻ることは後続の検査が必要なら自分で待つ。
      fs.writeFileSync(diskPath(MIRROR_DISK_REL), MIRROR_ORIGINAL_TEXT, "utf8");
      await revertAndClose([roUri, rwUri]);
    }
  });

  test("未保存の file: 文書を revert して閉じると、showme-ro: はディスクの中身に戻る", async () => {
    const fileUri = vscode.Uri.joinPath(workspaceRoot(), MIRROR_CLOSE_REL);
    const roUri = await stageUri(MIRROR_CLOSE_REL, STAGE_SCHEME_READONLY);
    const mirror = await vscode.workspace.openTextDocument(roUri);
    try {
      const editor = await vscode.window.showTextDocument(fileUri, { preview: false });
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "about to be discarded\n"));
      assert.strictEqual(editor.document.isDirty, true, "未保存にできていない（前提）");
      await waitFor(
        "映しが未保存の行を映す",
        () => mirror.lineAt(0).text === "about to be discarded",
      );
      await vscode.window.showTextDocument(editor.document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      await waitFor("映しがディスクの中身に戻る", () => mirror.getText() === MIRROR_ORIGINAL_TEXT);
      assert.strictEqual(fs.readFileSync(diskPath(MIRROR_CLOSE_REL), "utf8"), MIRROR_ORIGINAL_TEXT);
    } finally {
      await revertAndClose([fileUri, roUri]);
    }
  });

  test("file: と showme-rw: の両方が未保存なら、先に保存した側が勝ち、人間の保存は競合で止まる", async () => {
    await withSettings({ "stage.editable": true }, async () => {
      const fileUri = vscode.Uri.joinPath(workspaceRoot(), MIRROR_CONFLICT_REL);
      const rwUri = await stageUri(MIRROR_CONFLICT_REL, STAGE_SCHEME_EDITABLE);
      const human = "# mirror\n\nhuman unsaved\n";
      const agent = "# mirror\n\nsaved through showme-rw\n";
      try {
        const fileDoc = (await vscode.window.showTextDocument(fileUri, { preview: false }))
          .document;
        const rwDoc = (await vscode.window.showTextDocument(rwUri, { preview: false })).document;
        await replaceAll(fileDoc, human);
        await replaceAll(rwDoc, agent);
        assert.strictEqual(fileDoc.isDirty, true, "file: を未保存にできていない（前提）");
        assert.strictEqual(rwDoc.isDirty, true, "showme-rw を未保存にできていない（前提）");

        assert.strictEqual(await rwDoc.save(), true, "showme-rw の保存が失敗した");
        assert.strictEqual(fs.readFileSync(diskPath(MIRROR_CONFLICT_REL), "utf8"), agent);

        // VS Code 標準の競合（「ファイルの方が新しい」）で止まる。上書きしない。
        assert.strictEqual(await fileDoc.save(), false, "人間の保存が上書きした");
        assert.strictEqual(fs.readFileSync(diskPath(MIRROR_CONFLICT_REL), "utf8"), agent);
        // 人間の未保存は消えない。
        assert.strictEqual(fileDoc.isDirty, true);
        assert.strictEqual(fileDoc.getText(), human);
      } finally {
        await revertAndClose([fileUri, rwUri]);
        fs.writeFileSync(diskPath(MIRROR_CONFLICT_REL), MIRROR_ORIGINAL_TEXT, "utf8");
      }
    });
  });

  test("片方だけ未保存なら保存はそのまま通り、もう片方が追従する（両方向）", async () => {
    await withSettings({ "stage.editable": true }, async () => {
      const fileUri = vscode.Uri.joinPath(workspaceRoot(), MIRROR_FOLLOW_REL);
      const rwUri = await stageUri(MIRROR_FOLLOW_REL, STAGE_SCHEME_EDITABLE);
      const byAgent = "# mirror\n\nsaved through showme-rw\n";
      const byHuman = "# mirror\n\nsaved by the human\n";
      try {
        const fileDoc = (await vscode.window.showTextDocument(fileUri, { preview: false }))
          .document;
        const rwDoc = (await vscode.window.showTextDocument(rwUri, { preview: false })).document;

        await replaceAll(rwDoc, byAgent);
        assert.strictEqual(await rwDoc.save(), true, "showme-rw の保存が失敗した");
        assert.strictEqual(fs.readFileSync(diskPath(MIRROR_FOLLOW_REL), "utf8"), byAgent);
        await waitFor("file: が showme-rw の保存に追従する", () => fileDoc.getText() === byAgent);
        assert.strictEqual(fileDoc.isDirty, false);

        await replaceAll(fileDoc, byHuman);
        assert.strictEqual(await fileDoc.save(), true, "人間の保存が失敗した");
        assert.strictEqual(fs.readFileSync(diskPath(MIRROR_FOLLOW_REL), "utf8"), byHuman);
        await waitFor("showme-rw が人間の保存に追従する", () => rwDoc.getText() === byHuman);
        assert.strictEqual(rwDoc.isDirty, false);
      } finally {
        await revertAndClose([fileUri, rwUri]);
        fs.writeFileSync(diskPath(MIRROR_FOLLOW_REL), MIRROR_ORIGINAL_TEXT, "utf8");
      }
    });
  });

  test("ディスクの権限で書けないファイルの showme-rw: は読み取り専用に見え、編集できない", async function () {
    // root は権限を無視して書けてしまうので、この検査は成り立たない
    if (process.getuid?.() === 0 || process.platform === "win32") this.skip();
    await withSettings({ "stage.editable": true }, async () => {
      const disk = diskPath(MIRROR_READONLY_DISK_REL);
      const rwUri = await stageUri(MIRROR_READONLY_DISK_REL, STAGE_SCHEME_EDITABLE);
      fs.chmodSync(disk, 0o444);
      try {
        const stat = await vscode.workspace.fs.stat(rwUri);
        assert.ok(
          ((stat.permissions ?? 0) & vscode.FilePermission.Readonly) !== 0,
          "showme-rw の stat が Readonly でない",
        );
        const editor = await vscode.window.showTextDocument(rwUri, { preview: false });
        // `edit` の戻り値は見ない（読み取り専用でも true を返す）。
        await editor.edit((b) => b.insert(new vscode.Position(0, 0), "should not apply\n"));
        assert.strictEqual(editor.document.isDirty, false, "読み取り専用のはずの映しが編集できた");
        assert.strictEqual(fs.readFileSync(disk, "utf8"), MIRROR_ORIGINAL_TEXT);
      } finally {
        await revertAndClose([rwUri]);
        fs.chmodSync(disk, 0o644);
      }
    });
  });
});
