import * as assert from "node:assert";
import * as vscode from "vscode";
import { SHOWN_MARKER, SHOWN_RELS, STAGE_TABS_MARKER, STAGE_TABS_RELS } from "../fixture.js";
import {
  activateExtension,
  annotateClear,
  arrangeEditors,
  assertGlobal,
  getEditorState,
  lendWindow,
  panelColumn,
  panelTab,
  showCode,
  showOne,
  stageUri,
  waitFor,
  waitPastToolWindow,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 人間の列も使う配置（D93 / D94。`showme.stage.editorGroup`）。
 *
 * - 既定の `shared`: 人間の列より右の既存の列を先に使う。右に無ければ列を増やさずに人間の列に
 *   開く（D93）
 * - `dedicated`: 人間の列に人間のタブ（own でないタブ）があれば使わず、右に列を足す（以前どおり）。
 *   空の列・エージェントのタブだけの列なら使う（D94）
 *
 * 「開いた列」は VS Code のタブの観測（どの列にその URI のタブがあるか）で見る。
 */

function fileUri(rel: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), rel);
}

/** 人間が列1で `file:` を開き、フォーカスも列1に置く（列は1つ）。 */
async function humanFileInColumnOne(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fileUri(STAGE_TABS_RELS.human));
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false,
  });
  await waitFor(
    "人間が列1に居る",
    () => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One,
  );
}

/** その URI のテキストタブがある列（無ければ undefined）。 */
function columnOfUri(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const key = uri.toString();
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key,
    ),
  )?.viewColumn;
}

/** `show_code` で `rel` を開き、開いた列を返す。 */
async function showCodeColumn(rel: string): Promise<vscode.ViewColumn | undefined> {
  const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
  assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
  const uri = await stageUri(rel);
  await waitFor("舞台のタブが開いた", () => columnOfUri(uri) !== undefined);
  return columnOfUri(uri);
}

/** 画面を空にする。未保存（show_note のメモ）は戻してから閉じる ―― 保存の確認を出さない。 */
async function clearScreen(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  await waitFor("列が1つに戻る", () => vscode.window.tabGroups.all.length === 1);
}

suite("人間の列も使う配置（D93 / D94）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await clearScreen();
    await annotateClear();
  });

  teardown(async () => {
    await annotateClear();
    await clearScreen();
  });

  test("既定（shared）: 人間の file: タブだけの列1 → show_code は列1に開き、列は増えない", async () => {
    assertGlobal("stage.editorGroup", undefined);
    await humanFileInColumnOne();
    const column = await showCodeColumn(STAGE_TABS_RELS.show);
    assert.strictEqual(column, vscode.ViewColumn.One, `舞台が列${String(column)}に開いた`);
    assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
    // 人間のタブは閉じられず、同じ列に残る（エージェントのタブが前面に来るだけ）。
    assert.strictEqual(
      columnOfUri(fileUri(STAGE_TABS_RELS.human)),
      vscode.ViewColumn.One,
      "人間のタブが列1から消えた",
    );
  });

  test("既定（shared）: 空の画面 → show_code は列1に開き、列は増えない", async () => {
    assertGlobal("stage.editorGroup", undefined);
    const column = await showCodeColumn(STAGE_TABS_RELS.show);
    assert.strictEqual(column, vscode.ViewColumn.One, `舞台が列${String(column)}に開いた`);
    assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
  });

  // 以降は信頼の回だけ（配置の判断は信頼の有無に依らない。制限モードの回は上の2件で経路を見る）。
  if (!vscode.workspace.isTrusted) return;

  test("既定（shared）: 人間が列1、右に列2がある → show_code は列2に開く（右の既存の列が先）", async () => {
    assertGlobal("stage.editorGroup", undefined);
    await humanFileInColumnOne();
    const other = await vscode.workspace.openTextDocument(fileUri(STAGE_TABS_RELS.humanFile));
    await vscode.window.showTextDocument(other, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
      preview: false,
    });
    await waitFor("列が2つ", () => vscode.window.tabGroups.all.length === 2);
    await humanFileInColumnOne();
    const column = await showCodeColumn(STAGE_TABS_RELS.show);
    assert.strictEqual(column, vscode.ViewColumn.Two, `舞台が列${String(column)}に開いた`);
    assert.strictEqual(vscode.window.tabGroups.all.length, 2, "列が増えた");
  });

  test('既定（shared）: 列1だけの画面で layout: "split" → 列1と列2に開く', async () => {
    assertGlobal("stage.editorGroup", undefined);
    await humanFileInColumnOne();
    const rels = [STAGE_TABS_RELS.show, STAGE_TABS_RELS.annotate];
    const resolutions = await showCode(
      rels.map((rel) => ({ path: rel, text: STAGE_TABS_MARKER })),
      "split",
    );
    for (const r of resolutions) assert.strictEqual(r.match, "one", JSON.stringify(r));
    const uris = await Promise.all(rels.map((rel) => stageUri(rel)));
    await waitFor("2枚とも開いた", () => uris.every((u) => columnOfUri(u) !== undefined));
    assert.deepStrictEqual(
      uris.map((u) => columnOfUri(u)),
      [vscode.ViewColumn.One, vscode.ViewColumn.Two],
    );
    assert.strictEqual(vscode.window.tabGroups.all.length, 2, "列が2つでない");
  });

  test("dedicated: 人間の file: タブがある列1 → show_code は列2に開く（以前どおり）", async () => {
    await withSettings({ "stage.editorGroup": "dedicated" }, async () => {
      await humanFileInColumnOne();
      const column = await showCodeColumn(STAGE_TABS_RELS.show);
      assert.strictEqual(column, vscode.ViewColumn.Two, `舞台が列${String(column)}に開いた`);
      assert.strictEqual(vscode.window.tabGroups.all.length, 2);
    });
  });

  test("dedicated: 空の列1 → show_code は列1に開く（D94）", async () => {
    await withSettings({ "stage.editorGroup": "dedicated" }, async () => {
      const column = await showCodeColumn(STAGE_TABS_RELS.show);
      assert.strictEqual(column, vscode.ViewColumn.One, `舞台が列${String(column)}に開いた`);
      assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
    });
  });

  test("dedicated: エージェントのタブだけの列1 → 2回目の show_code も列1に開く（D94）", async () => {
    await withSettings({ "stage.editorGroup": "dedicated" }, async () => {
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.One);
      // 列1はエージェントのタブ（映し）だけ。人間のタブが無いので、使ってよい。
      const column = await showCodeColumn(STAGE_TABS_RELS.annotate);
      assert.strictEqual(column, vscode.ViewColumn.One, `舞台が列${String(column)}に開いた`);
      assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
      // 対照: 人間が同じ列1に自分のファイルを開けば、次は列2へ（人間のタブがある列は使わない）。
      await humanFileInColumnOne();
      const after = await showCodeColumn(STAGE_TABS_RELS.markOnly);
      assert.strictEqual(after, vscode.ViewColumn.Two, `舞台が列${String(after)}に開いた`);
    });
  });

  test("既定（shared）: 列1だけの画面で show_note は列1に開く", async () => {
    assertGlobal("stage.editorGroup", undefined);
    await humanFileInColumnOne();
    const before = new Set(
      vscode.workspace.textDocuments.filter((d) => d.isUntitled).map((d) => d.uri.toString()),
    );
    await vscode.commands.executeCommand("showme.test.showNote", { text: "# 配置の検査" });
    let note: vscode.Uri | undefined;
    await waitFor("メモのタブが開いた", () => {
      note = vscode.workspace.textDocuments.find(
        (d) => d.isUntitled && !before.has(d.uri.toString()) && d.getText() === "# 配置の検査",
      )?.uri;
      return note !== undefined && columnOfUri(note) !== undefined;
    });
    assert.ok(note);
    assert.strictEqual(columnOfUri(note), vscode.ViewColumn.One, "メモが列1に開いていない");
    assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
  });

  test("既定（shared）: 列1だけの画面で show_html のパネルは列1に開く", async () => {
    assertGlobal("stage.editorGroup", undefined);
    await humanFileInColumnOne();
    await vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>配置の検査</p>" });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    assert.strictEqual(panelColumn(), vscode.ViewColumn.One, "パネルが列1に開いていない");
    assert.strictEqual(vscode.window.tabGroups.all.length, 1, "列が増えた");
  });
});

/**
 * **ツールが見せた選択は返さない（D95）。** 人間の列にエージェントのタブが開くと、そのタブが
 * `activeTextEditor` になり、人間が以前そこで作った選択（タブの使い回し・表示状態の復元）を持ったまま
 * 前面に出る。待ち（`too-soon-after-tool`）が明けても、人間が選び直すまで返さない。
 *
 * 各場面は**対照を持つ**: 同じ編集器で人間が選び直すと返る（「何か別の理由で断られただけ」を
 * 「防御が効いた」と読まない）。
 *
 * 信頼の回だけ（判定は信頼の有無に依らない）。
 */
suite("ツールが見せた選択は返さない（D95）", () => {
  if (!vscode.workspace.isTrusted) return;

  /** 人間は毎回違う長さで選ぶ（`already-returned` が別の理由を覆わないように）。 */
  let shrink = 0;
  function humanSelects(editor: vscode.TextEditor): string {
    const index = editor.document.getText().indexOf(SHOWN_MARKER);
    assert.ok(index >= 0, "目印が無い");
    shrink = (shrink % 20) + 1;
    const end = index + SHOWN_MARKER.length - shrink;
    editor.selection = new vscode.Selection(
      editor.document.positionAt(index),
      editor.document.positionAt(end),
    );
    return SHOWN_MARKER.slice(0, SHOWN_MARKER.length - shrink);
  }

  async function humanOpens(
    uri: vscode.Uri,
    column: vscode.ViewColumn,
    preserveFocus = false,
  ): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: column,
      preserveFocus,
      preview: false,
    });
  }

  /**
   * 前面に出たおとりで止めた理由。選択が空で出てきた（復元されなかった）なら `empty`、選択を
   * 持って出てきたなら `shown-by-tool`（D95）でなければならない ―― 待ちや焦点で止まったのを
   * 「防御が効いた」と読まない。
   */
  function expectedBaitReason(state: Record<string, unknown>): string {
    const sel = state.selection as
      | { startLine: number; startCharacter: number; endLine: number; endCharacter: number }
      | undefined;
    const empty =
      sel !== undefined && sel.startLine === sel.endLine && sel.startCharacter === sel.endCharacter;
    return empty ? "empty" : "shown-by-tool";
  }

  /** 人間が手元のファイルを開き、カーソルだけ置く（前のテストで作った選択を持ち越さない）。 */
  async function humanOpensWithoutSelection(
    uri: vscode.Uri,
    column: vscode.ViewColumn,
  ): Promise<void> {
    const editor = await humanOpens(uri, column);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
  }

  /** ツールの窓（D95。自ツールの待ちも含む）が明けてから `get_editor_state` を読む。 */
  async function stateAfterWait(): Promise<Record<string, unknown>> {
    await waitPastToolWindow();
    return getEditorState();
  }

  /** 人間が前面の編集器で選び直すと、待ちの後に返る（対照）。 */
  async function humanReselectsAndItIsReturned(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "前面の編集器が無い（対照の前提）");
    const text = humanSelects(editor);
    const state = await stateAfterWait();
    assert.strictEqual(
      state.selectedText,
      text,
      `人間が選び直したのに返らない: ${JSON.stringify(state.selectionWithheld)}`,
    );
  }

  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });
  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await clearScreen();
    await annotateClear();
  });
  teardown(async () => {
    await annotateClear();
    await clearScreen();
  });

  for (const editorGroup of ["shared", "dedicated"] as const) {
    for (const agentTabs of [false, true]) {
      const settings = { "stage.editorGroup": editorGroup, "stage.agentTabs": agentTabs };
      const label = `${editorGroup} / agentTabs: ${agentTabs}`;

      test(`人間が舞台の列を覗いたあと、選んでおいたファイルを見せられても選択は返らない（${label}）`, async () => {
        await withSettings(settings, async () => {
          // 人間がおとりを列1で開いて選ぶ。おとりは舞台と同じ URI（表示状態の復元は URI ごと）。
          const baitUri = await stageUri(SHOWN_RELS.bait);
          humanSelects(await humanOpens(baitUri, vscode.ViewColumn.One));
          // エージェントが舞台を作り、人間がそこを覗く。
          await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
          const stagedUri = await stageUri(SHOWN_RELS.stage);
          await waitFor("舞台が開く", () => columnOfUri(stagedUri) !== undefined);
          const stagedColumn = columnOfUri(stagedUri) ?? vscode.ViewColumn.One;
          await humanOpens(stagedUri, stagedColumn);
          // エージェントが、人間が選んでおいたファイルを見せに来る。
          await showCode([{ path: SHOWN_RELS.bait, text: SHOWN_MARKER }]);
          const state = await stateAfterWait();
          assert.strictEqual(
            state.selectedText,
            undefined,
            `ツールが見せた選択が返った: ${String(state.selectedText)}`,
          );
          if (state.activePath === SHOWN_RELS.bait) {
            // おとりが人間の前面に出たなら、止めたのは D95（選択を持って出たとき）である。
            assert.strictEqual(state.selectionWithheld, expectedBaitReason(state));
          }
          await humanReselectsAndItIsReturned();
        });
      });

      test(`人間の列の裏にあるおとりのタブを見せられても、選択は返らない（${label}）`, async () => {
        await withSettings(settings, async () => {
          const baitUri = await stageUri(SHOWN_RELS.bait);
          humanSelects(await humanOpens(baitUri, vscode.ViewColumn.One));
          // 人間は同じ列で別のファイルに移る（おとりのタブは裏に残る）。前のテストでそこに作った
          // 選択は持ち越さない（人間自身の選択が前面に残ると、この検査が見たいものと混ざる）。
          await humanOpensWithoutSelection(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
          await showCode([{ path: SHOWN_RELS.bait, text: SHOWN_MARKER }]);
          const state = await stateAfterWait();
          assert.strictEqual(
            state.selectedText,
            undefined,
            `ツールが見せた選択が返った: ${String(state.selectedText)}`,
          );
          if (state.activePath === SHOWN_RELS.bait) {
            assert.strictEqual(state.selectionWithheld, expectedBaitReason(state));
          }
          if (editorGroup === "shared") {
            // shared は人間の列の裏のタブを使い回す ―― 選択を持ったまま前面に出る（D95 を
            // 必ず踏む場面。D95 が無いとここで選択が返った。実測）。
            assert.strictEqual(state.activePath, SHOWN_RELS.bait);
            assert.strictEqual(state.selectionWithheld, "shown-by-tool");
          }
          await humanReselectsAndItIsReturned();
        });
      });
    }
  }

  test("人間が閉じたおとりを見せられても、復元された選択は返らない（shared / agentTabs: false）", async () => {
    await withSettings({ "stage.agentTabs": false }, async () => {
      const baitUri = fileUri(SHOWN_RELS.bait);
      humanSelects(await humanOpens(baitUri, vscode.ViewColumn.One));
      await humanOpensWithoutSelection(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
      // おとりのタブを閉じる。開き直すと VS Code が表示状態（選択）を復元しうる。
      const baitTab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find(
          (t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === baitUri.toString(),
        );
      assert.ok(baitTab, "おとりのタブが無い");
      await vscode.window.tabGroups.close(baitTab);
      await waitFor("おとりが閉じる", () => columnOfUri(baitUri) === undefined);
      await showCode([{ path: SHOWN_RELS.bait, text: SHOWN_MARKER }]);
      // **復元の時機を測る。** 返った直後の前面の選択と 300 ms 後の選択が同じなら、呼び出しの後の
      // 観測（前面が落ち着いてから読む。`runRecordingFront`）は、この場面の復元を取りこぼさない
      // （前面の変化の事象の時点で復元前だった場面は、窓の間の選択の変化として記録する）。
      const immediately = vscode.window.activeTextEditor?.selection;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = vscode.window.activeTextEditor?.selection;
      // 復元は実際に起きている（空でない選択が前面に出た）。起きていなければ、この検査は時機も
      // D95 も見ていない。
      assert.ok(
        immediately !== undefined && !immediately.isEmpty,
        "選択が復元されていない（前提）",
      );
      assert.ok(
        immediately !== undefined && later !== undefined && immediately.isEqual(later),
        `呼び出しが返ったあとで前面の選択が変わった: ${JSON.stringify(immediately)} → ${JSON.stringify(later)}`,
      );
      const state = await stateAfterWait();
      assert.strictEqual(
        state.selectedText,
        undefined,
        `復元された選択が返った: ${String(state.selectedText)}`,
      );
      assert.strictEqual(state.selectionWithheld, "shown-by-tool");
      await humanReselectsAndItIsReturned();
    });
  });

  test("人間の列の外に開いたとき（前面が変わらない）は、人間の選択は今までどおり返る（「これ何？」）", async () => {
    // 右に列2がある画面では、shared でも舞台は列2（人間の前面は変わらない）。
    await humanOpens(fileUri(SHOWN_RELS.other), vscode.ViewColumn.Two, true);
    const editor = await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
    const text = humanSelects(editor);
    await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
    const stagedUri = await stageUri(SHOWN_RELS.stage);
    await waitFor("舞台が開く", () => columnOfUri(stagedUri) !== undefined);
    assert.strictEqual(
      columnOfUri(stagedUri),
      vscode.ViewColumn.Two,
      "舞台が列2に開いていない（前提）",
    );
    const state = await stateAfterWait();
    assert.strictEqual(
      state.selectedText,
      text,
      `人間の選択が返らない: ${JSON.stringify(state.selectionWithheld)}`,
    );
  });

  test("人間の列に開かれたあと、人間が元の編集器に戻れば、そこで作ってあった選択は返る", async () => {
    const editor = await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
    const text = humanSelects(editor);
    await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
    const stagedUri = await stageUri(SHOWN_RELS.stage);
    await waitFor("舞台が人間の列に開く", () => columnOfUri(stagedUri) === vscode.ViewColumn.One);
    // 人間が自分の編集器に戻る（人間の操作。ツールではない）。
    await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
    const state = await stateAfterWait();
    assert.strictEqual(
      state.selectedText,
      text,
      `人間の選択が返らない: ${JSON.stringify(state.selectionWithheld)}`,
    );
  });

  for (const stackWith of ["show_code", "show_html"] as const) {
    test(`人間の列に重ねた自分のタブを close-own で閉じ、人間のタブが前に戻っても、その選択は窓の間も後も返らない（${stackWith}）`, async () => {
      // 人間が Y を列1で開いて選ぶ（人間自身の選択）。
      const y = await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
      humanSelects(y);
      // エージェントが同じ列に重ねる（shared は人間の列を使う）。
      if (stackWith === "show_code") {
        await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
        const stagedUri = await stageUri(SHOWN_RELS.stage);
        await waitFor(
          "舞台が人間の列に開く",
          () => columnOfUri(stagedUri) === vscode.ViewColumn.One,
        );
      } else {
        await vscode.commands.executeCommand("showme.test.resetRateLimits");
        await vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>重ねる</p>" });
        await waitFor("パネルが人間の列に開く", () => panelColumn() === vscode.ViewColumn.One);
      }
      await waitPastToolWindow();
      // 片づけると、下の Y が前面に戻る ―― 人間が以前作った選択を持ったまま。
      const closed = await arrangeEditors("close-own");
      assert.strictEqual(closed.closed, 1, JSON.stringify(closed));
      // 直後は窓の間。理由は判定の順で先に当たるものになる: 閉じた後の前面の更新や選択の復元が
      // まだなら not-active / empty、済んでいれば too-soon-after-tool（どれも実測）。どれでも返らない。
      const immediately = await getEditorState();
      assert.strictEqual(immediately.selectedText, undefined, "窓の間に選択が返った");
      assert.ok(
        ["too-soon-after-tool", "not-active", "empty"].includes(
          String(immediately.selectionWithheld),
        ),
        `直後の理由: ${String(immediately.selectionWithheld)}`,
      );
      const later = await stateAfterWait();
      assert.strictEqual(
        later.selectedText,
        undefined,
        `窓の後に選択が返った: ${String(later.selectedText)}`,
      );
      assert.strictEqual(later.activePath, SHOWN_RELS.human, "前面が Y に戻っていない（前提）");
      assert.strictEqual(later.selectionWithheld, "shown-by-tool");
      await humanReselectsAndItIsReturned();
    });
  }

  test("並行に投げた get_editor_state でも選択は返らない（煙の検査。最中に読んだことは下の検査が確かめる）", async () => {
    const y = await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One);
    humanSelects(y);
    await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
    await waitPastToolWindow();
    // close-own と同時に読む。どちらが先に着いても、選択は返らない。
    const [closed, during] = await Promise.all([arrangeEditors("close-own"), getEditorState()]);
    assert.strictEqual(closed.closed, 1, JSON.stringify(closed));
    assert.strictEqual(
      during.selectedText,
      undefined,
      `並行の読み出しで選択が返った: ${String(during.selectedText)}`,
    );
    const later = await stateAfterWait();
    assert.strictEqual(
      later.selectedText,
      undefined,
      `窓の後に選択が返った: ${String(later.selectedText)}`,
    );
    await humanReselectsAndItIsReturned();
  });

  test("Y を見せてから Z を見せ、人間がクリックで Y に戻っても、Y の古い選択は返らない（パスごとの記録）", async () => {
    await withSettings({ "stage.agentTabs": false }, async () => {
      // 人間が Y（file:）で選び、同じ列の別のファイルに移る（Y は裏）。
      humanSelects(await humanOpens(fileUri(SHOWN_RELS.bait), vscode.ViewColumn.One));
      await humanOpensWithoutSelection(fileUri(SHOWN_RELS.other), vscode.ViewColumn.One);
      // エージェントが Y を見せる（人間の Y のタブを使い回し、選択ごと前面に出る）→ 次に Z。
      await showCode([{ path: SHOWN_RELS.bait, text: SHOWN_MARKER }]);
      await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
      // 人間がクリックで Y に戻る（人間の操作）。
      await humanOpens(fileUri(SHOWN_RELS.bait), vscode.ViewColumn.One);
      const state = await stateAfterWait();
      assert.strictEqual(state.activePath, SHOWN_RELS.bait, "前面が Y でない（前提）");
      assert.strictEqual(
        state.selectedText,
        undefined,
        `Y の古い選択が返った: ${String(state.selectedText)}`,
      );
      assert.strictEqual(state.selectionWithheld, "shown-by-tool");
      await humanReselectsAndItIsReturned();
    });
  });

  for (const how of ["move-tab", "gather-own"] as const) {
    test(`人間の列から自分のタブを外へ出し（${how}）、下の人間の編集器が前に戻っても、その選択は返らない`, async () => {
      // 人間が Y を列1で開いて選ぶ。エージェントが同じ列に重ねる（shared・列1だけ）。
      humanSelects(await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One));
      await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
      const stagedUri = await stageUri(SHOWN_RELS.stage);
      await waitFor("舞台が人間の列に開く", () => columnOfUri(stagedUri) === vscode.ViewColumn.One);
      if (how === "gather-own") {
        // 右に人間の列2を作る（フォーカスは列1のまま）。gather-own の集め先は右の既存の列2。
        await humanOpens(fileUri(SHOWN_RELS.other), vscode.ViewColumn.Two, true);
        await waitFor("列が2つ", () => vscode.window.tabGroups.all.length === 2);
      }
      await waitPastToolWindow();
      const result =
        how === "move-tab"
          ? await arrangeEditors("move-tab", { path: SHOWN_RELS.stage, toColumn: 2 })
          : await arrangeEditors("gather-own");
      assert.strictEqual(result.moved, 1, JSON.stringify(result));
      await waitFor(
        "自分のタブが列2に移る",
        () => columnOfUri(stagedUri) === vscode.ViewColumn.Two,
      );
      const later = await stateAfterWait();
      assert.strictEqual(later.activePath, SHOWN_RELS.human, "前面が Y に戻っていない（前提）");
      assert.strictEqual(
        later.selectedText,
        undefined,
        `Y の選択が返った: ${String(later.selectedText)}`,
      );
      assert.strictEqual(later.selectionWithheld, "shown-by-tool");
      await humanReselectsAndItIsReturned();
    });
  }

  test("close-own が走っている最中に Y が前に出た瞬間に読んでも、選択は返らない（窓の最中）", async () => {
    humanSelects(await humanOpens(fileUri(SHOWN_RELS.human), vscode.ViewColumn.One));
    await showCode([{ path: SHOWN_RELS.stage, text: SHOWN_MARKER }]);
    const stagedUri = await stageUri(SHOWN_RELS.stage);
    await waitFor("舞台が人間の列に開く", () => columnOfUri(stagedUri) === vscode.ViewColumn.One);
    await waitPastToolWindow();
    const yUri = fileUri(SHOWN_RELS.human).toString();
    // Y が前に出た瞬間（close-own の途中）に、窓の状態と get_editor_state を読む。
    let read: Promise<[{ inFlight: boolean }, Record<string, unknown>]> | undefined;
    const listener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (read !== undefined || editor?.document.uri.toString() !== yUri) return;
      read = Promise.all([
        vscode.commands.executeCommand("showme.test.toolWindowState") as Thenable<{
          inFlight: boolean;
        }>,
        getEditorState(),
      ]);
    });
    try {
      const closed = await arrangeEditors("close-own");
      assert.strictEqual(closed.closed, 1, JSON.stringify(closed));
    } finally {
      listener.dispose();
    }
    assert.ok(read, "Y が前に出る事象が来なかった（前提）");
    const [windowState, during] = await read;
    assert.strictEqual(
      windowState.inFlight,
      true,
      "読んだ時点で呼び出しが終わっていた（この検査は最中を見ていない）",
    );
    assert.strictEqual(
      during.selectedText,
      undefined,
      `最中の読み出しで選択が返った: ${String(during.selectedText)}`,
    );
    // 最中の理由は、判定の順で先に当たるもの（前に出た瞬間は選択の復元前で empty のことがある）。
    assert.ok(
      ["too-soon-after-tool", "empty", "not-active"].includes(String(during.selectionWithheld)),
      `最中の理由: ${String(during.selectionWithheld)}`,
    );
    const later = await stateAfterWait();
    assert.strictEqual(
      later.selectedText,
      undefined,
      `窓の後に選択が返った: ${String(later.selectedText)}`,
    );
    await humanReselectsAndItIsReturned();
  });
});

/**
 * **既定（shared。D93）の配置で、既存の主張の双子。** dedicated を前提にした節（stage-avoid・panel-slots・
 * タブとパネルを動かす・split の上限）はそのまま残し、ここでは人間の列を使う既定の答えを確かめる。
 * 信頼の回だけ。
 */
suite("既定（shared）の配置の双子（D90 / D61 / D59 / D55-1 / 不変条件10）", () => {
  if (!vscode.workspace.isTrusted) return;

  const terminals: vscode.Terminal[] = [];

  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });
  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    assertGlobal("stage.editorGroup", undefined);
    await clearScreen();
    await annotateClear();
  });
  teardown(async () => {
    for (const terminal of terminals.splice(0)) terminal.dispose();
    await annotateClear();
    await clearScreen();
  });

  async function humanIn(
    column: vscode.ViewColumn,
    rel: string,
    preserveFocus = false,
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(fileUri(rel));
    await vscode.window.showTextDocument(doc, {
      viewColumn: column,
      preserveFocus,
      preview: false,
    });
  }

  async function showCodeColumn(rel: string): Promise<vscode.ViewColumn | undefined> {
    const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
    assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
    const uri = await stageUri(rel);
    await waitFor("舞台のタブが開いた", () => columnOfUri(uri) !== undefined);
    return columnOfUri(uri);
  }

  test("D90: 列2にターミナル、人間は列1。オンなら shared は人間の列1に開き（道具の列を避け、列を増やさない）、オフなら列2", async () => {
    await humanIn(vscode.ViewColumn.One, STAGE_TABS_RELS.human);
    const terminal = vscode.window.createTerminal({
      name: "showme-test-shared-tool",
      location: { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    });
    terminals.push(terminal);
    await waitFor("列2の表示中のタブがターミナル", () =>
      vscode.window.tabGroups.all.some(
        (g) =>
          g.viewColumn === vscode.ViewColumn.Two &&
          g.activeTab?.input instanceof vscode.TabInputTerminal,
      ),
    );
    await humanIn(vscode.ViewColumn.One, STAGE_TABS_RELS.human);
    // placeStageColumn([1,2], single, 0, human 1, 2, avoid {2}, useHumanColumn) = 1。
    await withSettings({ "stage.avoidToolColumns": true }, async () => {
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.One);
      assert.strictEqual(vscode.window.tabGroups.all.length, 2, "列が増えた");
      assert.ok(
        vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.Two)?.activeTab
          ?.input instanceof vscode.TabInputTerminal,
        "列2のターミナルが表示中でなくなった",
      );
    });
    // オフなら右の既存の列（ターミナルの列）が先。
    assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.annotate), vscode.ViewColumn.Two);
  });

  test("D61: 列1だけの画面で、枠1は列1・枠2は列2。人間の列に重なった枠を move-panel と close-own で扱える", async () => {
    await humanIn(vscode.ViewColumn.One, STAGE_TABS_RELS.human);
    await vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>一枚目</p>" });
    await waitFor("枠1が開く", () => panelTab(1) !== undefined);
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>二枚目</p>",
      slot: 2,
    });
    await waitFor("枠2が開く", () => panelTab(2) !== undefined);
    assert.deepStrictEqual(
      [panelColumn(1), panelColumn(2)],
      [vscode.ViewColumn.One, vscode.ViewColumn.Two],
    );
    // 人間の列に重なった枠1を列2へ動かす（own のパネル）。
    const moved = await arrangeEditors("move-panel", { toColumn: 2, slot: 1 });
    assert.deepStrictEqual(moved, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved));
    await waitFor("枠1が列2に移る", () => panelColumn(1) === vscode.ViewColumn.Two);
    // 列2から人間の列1へ戻す（shared は人間の列を使える）。
    const back = await arrangeEditors("move-panel", { toColumn: 1, slot: 1 });
    assert.deepStrictEqual(back, { done: true, closed: 0, moved: 1 }, JSON.stringify(back));
    await waitFor("枠1が列1に戻る", () => panelColumn(1) === vscode.ViewColumn.One);
    const closed = await arrangeEditors("close-own");
    assert.deepStrictEqual(closed, { done: true, closed: 2 }, JSON.stringify(closed));
    await waitFor("パネルが消える", () => panelTab(1) === undefined && panelTab(2) === undefined);
    assert.strictEqual(
      columnOfUri(fileUri(STAGE_TABS_RELS.human)),
      vscode.ViewColumn.One,
      "人間のタブが消えた",
    );
  });

  for (const editorGroup of ["shared", "dedicated"] as const) {
    test(`D59 / D55-1: 人間の列への move-tab と gather-own（${editorGroup}）`, async () => {
      await withSettings({ "stage.editorGroup": editorGroup }, async () => {
        // 人間のファイルが列1と列2。人間は列1。舞台は列2（右の既存の列。どちらの設定でも）。
        await humanIn(vscode.ViewColumn.Two, STAGE_TABS_RELS.humanFile, true);
        await humanIn(vscode.ViewColumn.One, STAGE_TABS_RELS.human);
        assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.arrange), vscode.ViewColumn.Two);
        const staged = await stageUri(STAGE_TABS_RELS.arrange);
        const moved = await arrangeEditors("move-tab", {
          path: STAGE_TABS_RELS.arrange,
          toColumn: 1,
        });
        if (editorGroup === "dedicated") {
          // 人間のタブがある人間の列へは断る（以前どおり）。
          assert.deepStrictEqual(
            moved,
            { done: false, closed: 0, moved: 0, withheld: ["human-column-target"] },
            JSON.stringify(moved),
          );
          return;
        }
        assert.deepStrictEqual(moved, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved));
        await waitFor(
          "自分のタブが人間の列1に移る",
          () => columnOfUri(staged) === vscode.ViewColumn.One,
        );
        // 人間が右端の列2へ移る。gather-own は右に列が無いので人間の列2へ集める（列を増やさない）。
        await humanIn(vscode.ViewColumn.Two, STAGE_TABS_RELS.humanFile);
        const gathered = await arrangeEditors("gather-own");
        assert.deepStrictEqual(
          gathered,
          { done: true, closed: 0, moved: 1 },
          JSON.stringify(gathered),
        );
        await waitFor("人間の列2に集まる", () => columnOfUri(staged) === vscode.ViewColumn.Two);
        assert.strictEqual(vscode.window.tabGroups.all.length, 2, "列が増えた");
        assert.strictEqual(
          columnOfUri(fileUri(STAGE_TABS_RELS.human)),
          vscode.ViewColumn.One,
          "人間のタブが動いた",
        );
      });
    });
  }

  test('不変条件10: shared で layout: "split" を8回繰り返しても、列は人間の列を含めて2を超えない', async () => {
    await humanIn(vscode.ViewColumn.One, STAGE_TABS_RELS.human);
    const locations = [
      STAGE_TABS_RELS.show,
      STAGE_TABS_RELS.annotate,
      STAGE_TABS_RELS.markOnly,
    ].map((rel) => ({ path: rel, text: STAGE_TABS_MARKER }));
    let worst = vscode.window.tabGroups.all.length;
    for (let i = 0; i < 8; i += 1) {
      const resolutions = await showCode(locations, "split");
      for (const r of resolutions)
        assert.strictEqual(r.match, "one", `${i + 1} 回目: ${JSON.stringify(r)}`);
      worst = Math.max(worst, vscode.window.tabGroups.all.length);
      assert.ok(
        vscode.window.tabGroups.all.length <= 2,
        `${i + 1} 回目で列が ${vscode.window.tabGroups.all.length}`,
      );
    }
    // 上限に張り付いた回があったこと（1列のままでは split を見ていない）。
    assert.strictEqual(worst, 2);
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      vscode.ViewColumn.One,
      "フォーカスが舞台へ移った",
    );
  });
});
