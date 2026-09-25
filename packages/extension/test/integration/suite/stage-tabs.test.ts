import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  ENV_REL,
  REAL_FILE_DEEP_LINE,
  REAL_FILE_RELS,
  STAGE_TABS_MARKER,
  STAGE_TABS_RELS,
} from "../fixture.js";
import {
  STAGE_SCHEME_EDITABLE,
  STAGE_SCHEME_READONLY,
  type VisualState,
  activateExtension,
  activeEditorSnapshot,
  annotate,
  annotateClear,
  annotationThread,
  arrangeEditors,
  assertGlobal,
  getEditorState,
  inspectVisuals,
  layoutGroups,
  layoutTabs,
  lendWindow,
  showCode,
  showOne,
  stageUri,
  visibleEditorFor,
  waitFor,
  waitForSharedSelection,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 舞台を映しで開き、ハイライトと吹き出しを同じ URI に付ける（D84 / D85）。
 *
 * `showme.stage.agentTabs` の既定は `true`だが、各検査は**グローバルに**
 * `true` を明示し、`finally` で戻す（不変条件9: 拡張はグローバル値しか読まない。helpers の
 * `withSettings`）―― 既定が変わっても、この節の前提は変わらない。既定そのものが映しで
 * あることは、この節の最初の検査が設定を書かずに見る（trusted / restricted の節は
 * `stageUri` で「いまの設定の舞台の URI」を引くので、既定が `false` に戻っても緑のまま
 * になる ―― 判別はここに置く）。`false` の経路（D53）は trusted / restricted の
 * `pinLegacyFileTabs` の節が見ている。
 *
 * 見るのは「舞台・塗り・吹き出しが**同じ1つの URI**に付くか」。人間が同じファイルを
 * `file:` で開いていても、そちらには何も付かない（映しと実ファイルは別の URI）。
 */

function fileUri(rel: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), rel);
}

function spotlightUris(visuals: VisualState): string[] {
  return visuals.highlightRanges.filter((r) => r.layer === "spotlight").map((r) => r.uri);
}

function annotationLayerUris(visuals: VisualState): string[] {
  return visuals.highlightRanges.filter((r) => r.layer === "annotation").map((r) => r.uri);
}

function textTabUris(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []));
}

/** `uri` の可視エディタが現れるまで待ち、それを返す。 */
async function visibleEditorEventually(label: string, uri: vscode.Uri): Promise<vscode.TextEditor> {
  await waitFor(label, () => visibleEditorFor(uri) !== undefined);
  const editor = visibleEditorFor(uri);
  assert.ok(editor, label);
  return editor;
}

/** 人間が自分の列（1）で `file:` を開く。フォーカスも人間の列に置く。 */
async function humanOpens(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(fileUri(rel));
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  await waitFor(
    "人間の列に file: のエディタが見える",
    () => visibleEditorFor(fileUri(rel)) !== undefined,
  );
  return editor;
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

/** `get_editor_state` の、その列の `path` のタブ（列を指定して、同じ path の2枚を区別する）。 */
async function observedTab(
  rel: string,
  column: vscode.ViewColumn | undefined,
): Promise<Record<string, unknown> | undefined> {
  const state = await getEditorState();
  return layoutGroups(state)
    .find((group) => group.viewColumn === column)
    ?.tabs.find((tab) => tab.path === rel);
}

/** `show_code` で映しを舞台に開き、見えるまで待つ。 */
async function stageMirror(rel: string): Promise<vscode.TextEditor> {
  const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
  assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
  return visibleEditorEventually(
    "映しの編集器が見える",
    await stageUri(rel, STAGE_SCHEME_READONLY),
  );
}

/** 人間がその編集器のタブをクリックして前面にする（フォーカスごと）。 */
async function humanFocuses(editor: vscode.TextEditor): Promise<void> {
  const column = editor.viewColumn;
  assert.ok(column !== undefined, "編集器の列が読めない（前提）");
  await vscode.window.showTextDocument(editor.document, {
    viewColumn: column,
    preserveFocus: false,
    preview: false,
  });
  await waitFor(
    "人間がそのタブを見ている",
    () =>
      activeEditorSnapshot() === `${String(editor.viewColumn)}:${editor.document.uri.toString()}`,
  );
}

suite("舞台を映しで開く（D84 / D85）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await annotateClear();
  });

  teardown(async () => {
    // 映しのタブは未保存にならない（ro は書けない。rw もこの節では編集しない）ので
    // closeAllEditors で確認は出ない。
    await annotateClear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  test("show_code は showme-ro: の編集器を舞台の列に開き、塗りはその URI に付く", async () => {
    const rel = STAGE_TABS_RELS.show;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      // 人間の列を1つ作っておく（舞台がそれと別の列に開くことを見るため）。
      await humanOpens(STAGE_TABS_RELS.human);
      const focusBefore = activeEditorSnapshot();
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));

      const editor = await visibleEditorEventually("映しの編集器が見える", mirror);
      assert.strictEqual(editor.document.uri.scheme, STAGE_SCHEME_READONLY);
      assert.notStrictEqual(editor.viewColumn, humanColumn, "舞台が人間の列に開いた");
      assert.strictEqual(activeEditorSnapshot(), focusBefore, "フォーカスが舞台へ移った");
      assert.ok(
        !textTabUris().includes(fileUri(rel).toString()),
        `映しのはずが file: のタブも開いた: ${textTabUris().join(", ")}`,
      );

      const visuals = await inspectVisuals();
      assert.deepStrictEqual(
        spotlightUris(visuals),
        [mirror.toString()],
        JSON.stringify(visuals.highlightRanges),
      );
      assert.deepStrictEqual(
        visuals.highlightRanges.filter((r) => r.layer === "spotlight").map((r) => r.startLine),
        [2],
      );
    });
  });

  test("既定（設定を書かない）で show_code は showme-ro: に開く（D84 の既定）", async () => {
    // 他の節は `stageUri(rel)` で「いまの設定の舞台の URI」を引くので、既定が `false` に
    // 戻っても file: 同士で比べて緑のままになる。既定が映しであることはここだけが判別する。
    assertGlobal("stage.agentTabs", undefined);
    assertGlobal("stage.editable", undefined);
    const rel = STAGE_TABS_RELS.show;
    await humanOpens(STAGE_TABS_RELS.human);
    const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
    assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
    const expected = await stageUri(rel);
    assert.strictEqual(expected.scheme, STAGE_SCHEME_READONLY, expected.toString());
    const editor = await visibleEditorEventually("既定で映しの編集器が見える", expected);
    assert.strictEqual(editor.document.uri.scheme, STAGE_SCHEME_READONLY);
    assert.ok(
      !textTabUris().includes(fileUri(rel).toString()),
      `既定で file: のタブが開いた: ${textTabUris().join(", ")}`,
    );
  });

  test("人間が同じファイルを file: で開いていても、そちらには塗りも吹き出しも出ない", async () => {
    const rel = STAGE_TABS_RELS.human;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    const file = fileUri(rel);
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(rel);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      await showOne({ path: rel, text: STAGE_TABS_MARKER });
      const staged = await visibleEditorEventually("映しの編集器が見える", mirror);
      assert.notStrictEqual(staged.viewColumn, humanColumn, "舞台が人間の列に開いた");
      // 人間の file: タブはそのまま残っている（映しは別の URI）。
      assert.ok(visibleEditorFor(file), "人間の file: の編集器が消えた");

      const [annotated] = await annotate([
        { location: { path: rel, text: STAGE_TABS_MARKER }, text: "on the mirror" },
      ]);
      assert.ok(annotated && typeof annotated.id === "number", JSON.stringify(annotated));

      const visuals = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(visuals), [mirror.toString()]);
      assert.deepStrictEqual(visuals.annotatedUris, [mirror.toString()]);
      assert.deepStrictEqual(annotationLayerUris(visuals), [mirror.toString()]);
      for (const uris of [visuals.highlightedUris, visuals.annotatedUris]) {
        assert.ok(!uris.includes(file.toString()), `file: に付いた: ${uris.join(", ")}`);
      }
    });
  });

  test("annotate の吹き出しは映しの URI に付く（映しが開いていなくても作られ、開いた文書と同じ URI を持つ）", async () => {
    const rel = STAGE_TABS_RELS.annotate;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      const [annotated] = await annotate([
        { location: { path: rel, text: STAGE_TABS_MARKER }, text: "before open" },
      ]);
      assert.ok(annotated && typeof annotated.id === "number", JSON.stringify(annotated));
      assert.ok(!textTabUris().includes(mirror.toString()), "annotate がタブを開いた");

      const unopened = await inspectVisuals();
      assert.deepStrictEqual(unopened.annotatedUris, [mirror.toString()]);
      assert.deepStrictEqual(annotationLayerUris(unopened), [mirror.toString()]);

      // 開いたら: スレッドの URI が、開いた編集器の文書の URI と一致する（描画そのものは
      // API から読めないので、VS Code がスレッドを出す条件 ―― URI の一致 ―― を見る）。
      const doc = await vscode.workspace.openTextDocument(mirror);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      await visibleEditorEventually("映しの編集器が見える", mirror);
      const thread = await annotationThread(annotated.id as number);
      assert.strictEqual(thread.uri.toString(), doc.uri.toString());
      const opened = await inspectVisuals();
      assert.deepStrictEqual(opened.annotatedUris, [mirror.toString()]);
    });
  });

  test("stage.enabled: false（印だけ）では agentTabs でも file: に付く（D85）", async () => {
    const rel = STAGE_TABS_RELS.markOnly;
    const file = fileUri(rel);
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true, "stage.enabled": false }, async () => {
      const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
      assert.deepStrictEqual(textTabUris(), [], "印だけなのにタブを開いた");

      await annotate([{ location: { path: rel, text: STAGE_TABS_MARKER }, text: "mark only" }]);
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(visuals), [file.toString()]);
      assert.deepStrictEqual(visuals.annotatedUris, [file.toString()]);
      for (const uris of [visuals.highlightedUris, visuals.annotatedUris]) {
        assert.ok(!uris.includes(mirror.toString()), `映しに付いた: ${uris.join(", ")}`);
      }
    });
  });

  test("editable: true なら showme-rw: で開き、塗りもそこに付く", async () => {
    const rel = STAGE_TABS_RELS.editable;
    const rw = await stageUri(rel, STAGE_SCHEME_EDITABLE);
    const ro = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true, "stage.editable": true }, async () => {
      await showOne({ path: rel, text: STAGE_TABS_MARKER });
      const editor = await visibleEditorEventually("showme-rw: の編集器が見える", rw);
      assert.strictEqual(editor.document.uri.scheme, STAGE_SCHEME_EDITABLE);
      assert.ok(!textTabUris().includes(ro.toString()), "showme-ro: も開いた");

      await annotate([{ location: { path: rel, text: STAGE_TABS_MARKER }, text: "editable" }]);
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(visuals), [rw.toString()]);
      assert.deepStrictEqual(visuals.annotatedUris, [rw.toString()]);
    });
  });
});

/**
 * 所有はスキーム（D82）と、観測で映しを相対パスに戻す（D83）。
 *
 * 映しのタブは `show_code` だけが開き、スキームは人間の移動でもプリセットの合流でも残る。
 * だから own は記録ではなくスキームで決まる ―― 人間が映しを別の列へ動かしても own のまま
 * `close-own` で閉じられ、人間が同じファイルを `file:` で開いたタブは own にならない。
 * 床（人間が見ているタブは閉じない）は変わらない。観測の側では、映しのタブも `file:` と同じ
 * 相対パスで `get_editor_state` / `arrange_editors` に現れる。
 */
suite("所有はスキーム・観測で映しを相対パスに（D82 / D83）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await annotateClear();
  });

  teardown(async () => {
    // 映しの ro タブは書けないので未保存にならず、人間の file: タブもこの節では編集しない
    // ―― closeAllEditors で確認は出ない。
    await annotateClear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  test("get_editor_state: 映しのタブが path・own・visibleLines を持ち、吹き出しが annotations に出る（D83）", async () => {
    const rel = STAGE_TABS_RELS.observe;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const staged = await stageMirror(rel);
      const [annotated] = await annotate([
        { location: { path: rel, text: STAGE_TABS_MARKER }, text: "observed" },
      ]);
      assert.ok(annotated && typeof annotated.id === "number", JSON.stringify(annotated));

      const state = await getEditorState();
      const tab = layoutGroups(state)
        .find((group) => group.viewColumn === staged.viewColumn)
        ?.tabs.find((t) => t.path === rel);
      assert.ok(tab, `映しのタブが path で現れない: ${JSON.stringify(state.groups)}`);
      assert.strictEqual(tab.own, true, JSON.stringify(tab));
      assert.ok(
        tab.visibleLines && typeof tab.visibleLines === "object",
        `映しのタブに visibleLines が無い: ${JSON.stringify(tab)}`,
      );
      assert.ok(
        Array.isArray(state.openPaths) && state.openPaths.includes(rel),
        `openPaths に映しの rel が無い: ${JSON.stringify(state.openPaths)}`,
      );
      const annotations = state.annotations as Array<Record<string, unknown>> | undefined;
      assert.ok(
        annotations?.some((a) => a.id === annotated.id && a.path === rel && a.line === 3),
        `吹き出しが annotations に出ない: ${JSON.stringify(annotations)}`,
      );
      // 窓の全タブに path がある（映しが「ワークスペースの外」に落ちていない）。
      for (const t of layoutTabs(state)) {
        if (t.kind === "file") assert.ok(typeof t.path === "string", JSON.stringify(t));
      }
      assert.strictEqual(staged.document.uri.toString(), mirror.toString());
    });
  });

  test("人間が映しのタブを別の列へ動かしても own のまま。見ている間は close-own でも閉じず、離れたら閉じる（D82・床1）", async () => {
    const rel = STAGE_TABS_RELS.moved;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    const humanRel = STAGE_TABS_RELS.human;
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(humanRel);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const staged = await stageMirror(rel);
      assert.notStrictEqual(staged.viewColumn, humanColumn, "舞台が人間の列に開いた（前提）");

      // 人間が映しのタブを自分の列へ動かす（VS Code は close+open として発火する）。
      await humanFocuses(staged);
      await vscode.commands.executeCommand("workbench.action.moveEditorToPreviousGroup");
      await waitFor("映しが人間の列へ移る", () => columnOfUri(mirror) === humanColumn);

      const moved = await observedTab(rel, humanColumn);
      assert.strictEqual(moved?.own, true, `動かしたら own が消えた: ${JSON.stringify(moved)}`);

      // 床1: 人間が見ている映しは閉じない。
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText &&
          vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(),
        mirror.toString(),
        "人間が映しを見ていない（前提）",
      );
      const whileViewing = await arrangeEditors("close-own");
      assert.deepStrictEqual(
        whileViewing,
        { done: true, closed: 0, withheld: ["viewing-tab"] },
        JSON.stringify(whileViewing),
      );
      assert.strictEqual(columnOfUri(mirror), humanColumn, "人間が見ている映しを閉じた");

      // 人間が自分の file: タブに戻る → 映しは見られていない own のタブ → close-own で閉じる。
      await humanOpens(humanRel);
      const closed = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(mirror) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
      assert.strictEqual(columnOfUri(fileUri(humanRel)), humanColumn, "人間の file: を閉じた");
    });
  });

  test("人間が同じファイルを file: で開いても、それは own にならず、映しは own のまま（D82）", async () => {
    const rel = STAGE_TABS_RELS.humanFile;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    const file = fileUri(rel);
    await withSettings({ "stage.agentTabs": true }, async () => {
      const staged = await stageMirror(rel);
      // 映しの後から、人間が同じファイルを自分の列に file: で開く。
      await humanOpens(rel);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      assert.notStrictEqual(staged.viewColumn, humanColumn, "舞台が人間の列に開いた（前提）");

      const humanTab = await observedTab(rel, humanColumn);
      assert.ok(humanTab, "人間の file: タブが path で現れない");
      assert.ok(
        !("own" in humanTab),
        `人間の file: タブが own になった: ${JSON.stringify(humanTab)}`,
      );
      const mirrorTab = await observedTab(rel, staged.viewColumn);
      assert.strictEqual(mirrorTab?.own, true, `映しの own が消えた: ${JSON.stringify(mirrorTab)}`);

      const closed = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(mirror) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
      assert.strictEqual(columnOfUri(file), humanColumn, "close-own が人間の file: タブを閉じた");
    });
  });

  test("move-tab / close-tabs が path で映しのタブを指せる（D83）", async () => {
    const rel = STAGE_TABS_RELS.arrange;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      // 舞台の列にもう1枚置いておく。動かした1枚で元の列が空になると VS Code がその列を
      // 閉じ、移動先の列が繰り上がって番号で追えなくなる。
      const keep = await stageMirror(STAGE_TABS_RELS.show);
      const staged = await stageMirror(rel);
      assert.strictEqual(staged.viewColumn, keep.viewColumn, "2枚が同じ舞台の列にない（前提）");
      const toColumn = (staged.viewColumn ?? 2) + 1;

      const moved = await arrangeEditors("move-tab", { path: rel, toColumn });
      assert.deepStrictEqual(moved, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved));
      await waitFor("映しが移動先の列に移る", () => columnOfUri(mirror) === toColumn);
      const after = await observedTab(rel, toColumn);
      assert.strictEqual(after?.own, true, `move-tab で own が消えた: ${JSON.stringify(after)}`);

      const closed = await arrangeEditors("close-tabs", { paths: [rel] });
      await waitFor("映しが閉じる", () => columnOfUri(mirror) === undefined);
      assert.strictEqual(closed.done, true, JSON.stringify(closed));
      assert.strictEqual(closed.closed, 1, JSON.stringify(closed));
      assert.strictEqual(
        columnOfUri(await stageUri(STAGE_TABS_RELS.show, STAGE_SCHEME_READONLY)),
        keep.viewColumn,
        "close-tabs が指していない映しまで閉じた",
      );
    });
  });

  /**
   * 旧来の経路の「閉じたら忘れる」（D53）の、映しの側の対（D82）。映しは記録に頼らないので、
   * 人間が閉じても・close-own で閉じても、次の show_code が開く映しはまた own である。
   * 間に人間が同じファイルを file: で開いても、そちらは own にならない。
   */
  test("映しを閉じたあと（人間でも close-own でも）同じファイルを show_code すると、映しはまた own。間の人間の file: は own でない（D82）", async () => {
    const rel = STAGE_TABS_RELS.reopen;
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    const humanRel = STAGE_TABS_RELS.human;
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(humanRel);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      // 1回目: 開いて close-own で閉じる。
      const first = await stageMirror(rel);
      assert.strictEqual((await observedTab(rel, first.viewColumn))?.own, true, "前提: own でない");
      const closedByAgent = await arrangeEditors("close-own");
      await waitFor("映しが閉じる（close-own）", () => columnOfUri(mirror) === undefined);
      assert.deepStrictEqual(
        closedByAgent,
        { done: true, closed: 1 },
        JSON.stringify(closedByAgent),
      );

      // 間に人間が同じファイルを file: で開く。それは own でない。
      await humanOpens(rel);
      const humanTab = await observedTab(rel, humanColumn);
      assert.ok(humanTab, "人間の file: タブが path で現れない");
      assert.ok(
        !("own" in humanTab),
        `人間の file: タブが own になった: ${JSON.stringify(humanTab)}`,
      );

      // 2回目: 同じファイルを show_code → 映しはまた own。
      const second = await stageMirror(rel);
      assert.notStrictEqual(second.viewColumn, humanColumn, "舞台が人間の列に開いた（前提）");
      assert.strictEqual(
        (await observedTab(rel, second.viewColumn))?.own,
        true,
        "close-own のあとに開き直した映しが own でない",
      );

      // 今度は人間が映しのタブを閉じる。
      const tab = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find(
          (t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === mirror.toString(),
        );
      assert.ok(tab, "映しのタブが見つからない");
      assert.ok(await vscode.window.tabGroups.close(tab, true), "映しのタブを閉じられない");
      await waitFor("映しが閉じる（人間）", () => columnOfUri(mirror) === undefined);

      // 3回目: また show_code → own。人間の file: は own でないまま。
      await humanOpens(humanRel);
      const third = await stageMirror(rel);
      assert.strictEqual(
        (await observedTab(rel, third.viewColumn))?.own,
        true,
        "人間が閉じたあとに開き直した映しが own でない",
      );
      const humanAgain = await observedTab(rel, humanColumn);
      assert.ok(humanAgain, "人間の file: タブが消えた");
      assert.ok(
        !("own" in humanAgain),
        `人間の file: タブが own になった: ${JSON.stringify(humanAgain)}`,
      );

      // close-own は映しだけを閉じる（人間の file: 2枚は残る）。
      const cleaned = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(mirror) === undefined);
      assert.deepStrictEqual(cleaned, { done: true, closed: 1 }, JSON.stringify(cleaned));
      assert.strictEqual(
        columnOfUri(fileUri(rel)),
        humanColumn,
        "close-own が人間の file: を閉じた",
      );
    });
  });

  /**
   * 旧来の経路の「人間が起こしたレイアウトの合流で列が畳まれたタブは own でなくなる」（D53。
   * trusted.test.ts で agentTabs: false に固定）の、映しの側の対（D82）。人間がコマンドを
   * 直接叩いて（`arrange_editors` を通さずに）列3を列2へ畳んでも、動いた映しは own のままで、
   * `close-own` で2枚とも閉じる。合流の close+open が実際に起きたことも観測する。
   */
  test("人間が起こしたレイアウトの合流で列が畳まれても、映しは own のまま close-own で閉じる（D82）", async () => {
    const humanRel = STAGE_TABS_RELS.human;
    const rels = [STAGE_TABS_RELS.mergeStay, STAGE_TABS_RELS.mergeMoved];
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(humanRel);
      const resolutions = await showCode(
        rels.map((rel) => ({ path: rel, text: STAGE_TABS_MARKER })),
        "split",
      );
      assert.deepStrictEqual(
        resolutions.map((r) => r.match),
        ["one", "one"],
        JSON.stringify(resolutions),
      );
      const mirrors = await Promise.all(rels.map((rel) => stageUri(rel, STAGE_SCHEME_READONLY)));
      await waitFor(
        "列が 人間1 + 舞台2 = 3 になる",
        () =>
          vscode.window.tabGroups.all.length === 3 &&
          mirrors.every((m) => columnOfUri(m) !== undefined),
      );
      const movedIndex = columnOfUri(mirrors[1] as vscode.Uri) === 3 ? 1 : 0;
      const moved = mirrors[movedIndex] as vscode.Uri;
      assert.strictEqual(columnOfUri(moved), 3, "映しが列3に開いていない（前提）");
      for (const rel of rels) {
        const tab = layoutTabs(await getEditorState()).find((t) => t.path === rel);
        assert.strictEqual(tab?.own, true, `合流前の ${rel} が own でない（前提）`);
      }

      let closedEvents = 0;
      const listener = vscode.window.tabGroups.onDidChangeTabs((e) => {
        closedEvents += e.closed.filter(
          (t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === moved.toString(),
        ).length;
      });
      try {
        // **人間として**叩く（`arrange_editors` ではない）。
        await vscode.commands.executeCommand("workbench.action.editorLayoutTwoColumns");
        await waitFor("2列に畳まれる", () => vscode.window.tabGroups.all.length === 2);
      } finally {
        listener.dispose();
      }
      assert.strictEqual(closedEvents, 1, `合流で closed が1回発火しなかった: ${closedEvents} 回`);
      assert.strictEqual(columnOfUri(moved), 2, "合流で動いた映しが列2に無い");

      // 人間は自分の file: を見ている（床1 で残らないように）。
      await humanOpens(humanRel);
      for (const rel of rels) {
        const tab = layoutTabs(await getEditorState()).find((t) => t.path === rel);
        assert.strictEqual(tab?.own, true, `人間の合流のあと ${rel} の own が消えた`);
      }
      const cleaned = await arrangeEditors("close-own");
      await waitFor("映しが2枚とも閉じる", () =>
        mirrors.every((m) => columnOfUri(m) === undefined),
      );
      assert.deepStrictEqual(cleaned, { done: true, closed: 2 }, JSON.stringify(cleaned));
      assert.strictEqual(columnOfUri(fileUri(humanRel)), 1, "close-own が人間の file: を閉じた");
    });
  });

  test("人間が映しのタブで選んだテキストは file: と同じ規則（judgeSelection）で扱われる（D83）", async () => {
    const rel = STAGE_TABS_RELS.select;
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const staged = await stageMirror(rel);
      await humanFocuses(staged);

      // 語を選ぶ → 返る（activePath は映しの rel）。
      const text = staged.document.getText();
      const index = text.indexOf(STAGE_TABS_MARKER);
      assert.ok(index >= 0, "フィクスチャに目印が無い");
      staged.selection = new vscode.Selection(
        staged.document.positionAt(index),
        staged.document.positionAt(index + STAGE_TABS_MARKER.length),
      );
      const shared = await waitForSharedSelection();
      assert.strictEqual(shared.activePath, rel, JSON.stringify(shared));
      assert.strictEqual(shared.selectedText, STAGE_TABS_MARKER, JSON.stringify(shared));

      // 全体を選ぶ → file: と同じく whole-document で返らない（映しだから緩めない）。
      const lastLine = staged.document.lineCount - 1;
      staged.selection = new vscode.Selection(
        0,
        0,
        lastLine,
        staged.document.lineAt(lastLine).range.end.character,
      );
      await waitFor("全体の選択が反映される", () => !staged.selection.isEmpty);
      const whole = await getEditorState();
      assert.strictEqual(whole.selectedText, undefined, JSON.stringify(whole));
      assert.strictEqual(whole.selectionWithheld, "whole-document", JSON.stringify(whole));
      assert.strictEqual(whole.activePath, rel);
    });
  });

  test("人間の › は吹き出しの URI（映し）を開く。それは own で、見ている間は床1 が守る（D85）", async () => {
    const fromRel = STAGE_TABS_RELS.navFrom;
    const toRel = STAGE_TABS_RELS.navTo;
    const toMirror = await stageUri(toRel, STAGE_SCHEME_READONLY);
    const humanRel = STAGE_TABS_RELS.human;
    await withSettings({ "stage.agentTabs": true }, async () => {
      const [first, second] = await annotate([
        { location: { path: fromRel, text: STAGE_TABS_MARKER }, text: "from" },
        { location: { path: toRel, text: STAGE_TABS_MARKER }, text: "to" },
      ]);
      assert.ok(first && typeof first.id === "number", JSON.stringify(first));
      assert.ok(second && typeof second.id === "number", JSON.stringify(second));
      await humanOpens(humanRel);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      const thread = await annotationThread(first.id as number);
      await vscode.commands.executeCommand("showme.annotation.next", thread);
      await waitFor(
        "› が映しを人間の列に開き、フォーカスを移す",
        () => activeEditorSnapshot() === `${String(humanColumn)}:${toMirror.toString()}`,
      );
      assert.ok(
        !textTabUris().includes(fileUri(toRel).toString()),
        `› が file: を開いた: ${textTabUris().join(", ")}`,
      );

      const opened = await observedTab(toRel, humanColumn);
      assert.strictEqual(
        opened?.own,
        true,
        `› で開いた映しが own でない: ${JSON.stringify(opened)}`,
      );

      // 床1: 人間が見ている間は close-own でも閉じない。
      const whileViewing = await arrangeEditors("close-own");
      assert.deepStrictEqual(
        whileViewing,
        { done: true, closed: 0, withheld: ["viewing-tab"] },
        JSON.stringify(whileViewing),
      );
      assert.strictEqual(columnOfUri(toMirror), humanColumn, "人間が見ている映しを閉じた");

      // 人間が自分の file: に戻れば、映しは own のタブとして閉じられる。
      await humanOpens(humanRel);
      const closed = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(toMirror) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
    });
  });
});

/**
 * 映しのタブの「本物のファイルを開く」（D87）。人間の命令なので**人間の規則**（D79 の
 * `revealForHuman`）で開く: 見えていればその編集器、無ければ人間の今の列、フォーカスも移す。
 * 開いた `file:` のタブは人間のもの（記録しない）で own にならず、映しは own のまま。
 * 見ている位置の行を持っていく。映しでない編集器で押しても何も開かない。
 */
suite("本物のファイルを開く（D87）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await annotateClear();
  });

  teardown(async () => {
    // 映しの ro タブは書けず、開いた file: タブもこの節では編集しない ―― 確認は出ない。
    await annotateClear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  function showsLine(editor: vscode.TextEditor, line: number): boolean {
    return editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
  }

  /** 映しを開き、目印の行が見えていて先頭は見えていないこと（行を持っていく判別の前提）を確かめる。 */
  async function stageDeepMirror(rel: string): Promise<vscode.TextEditor> {
    const staged = await stageMirror(rel);
    await waitFor("映しで目印の行が見える", () => showsLine(staged, REAL_FILE_DEEP_LINE));
    assert.ok(!showsLine(staged, 0), "映しの先頭が見えている（判別しない前提）");
    return staged;
  }

  /** 本物のファイルの編集器が `column`（人間の今の列）に開き、フォーカスがそこへ移り、目印の行が見えるのを待つ。 */
  async function realFileEventually(rel: string, column: vscode.ViewColumn | undefined) {
    const file = fileUri(rel);
    await waitFor(
      "本物のファイルが今の列に開き、フォーカスが移る",
      () => activeEditorSnapshot() === `${String(column)}:${file.toString()}`,
    );
    const editor = await visibleEditorEventually("本物のファイルの編集器が見える", file);
    await waitFor("本物のファイルで同じ行が見える", () => showsLine(editor, REAL_FILE_DEEP_LINE));
    assert.ok(!showsLine(editor, 0), "本物のファイルが先頭のまま（行を持ってきていない）");
    return editor;
  }

  test("ボタン（引数は映しの URI）は同じ行を本物のファイルで、今いる列（映しの隣）に開く。file: は own でなく、映しは own のまま", async () => {
    const rel = REAL_FILE_RELS.deep;
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const staged = await stageDeepMirror(rel);
      const stageColumn = staged.viewColumn;
      assert.notStrictEqual(stageColumn, humanColumn, "舞台が人間の列に開いた（前提）");

      // 実機のクリックと同じ状態にする: editor/title のボタンを押すと、その編集器の列が今の列になる。
      // そのうえでボタンはその編集器の資源の URI を引数に渡す。
      await humanFocuses(staged);
      await vscode.commands.executeCommand("showme.openRealFile", staged.document.uri);
      // 人間の規則（D79）: 見えていなければ今の列 ―― 映しの列に、映しの隣のタブとして開く。
      await realFileEventually(rel, stageColumn);
      assert.strictEqual(columnOfUri(fileUri(rel)), stageColumn, "本物のファイルが映しの列に無い");
      assert.strictEqual(columnOfUri(staged.document.uri), stageColumn, "映しが列から消えた");

      // 同じ列に同じ path の2枚: own は映しの1枚だけ（本物のファイルは own でない）。
      const same = layoutGroups(await getEditorState())
        .find((group) => group.viewColumn === stageColumn)
        ?.tabs.filter((tab) => tab.path === rel);
      assert.deepStrictEqual(
        same?.map((tab) => tab.own === true).sort(),
        [false, true],
        `映しの列の ${rel} のタブ: ${JSON.stringify(same)}`,
      );

      // own は記録でもない: close-own は映しだけを閉じ、人間の file: は残る。
      const closed = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(staged.document.uri) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
      assert.strictEqual(
        columnOfUri(fileUri(rel)),
        stageColumn,
        "close-own が本物のファイルを閉じた",
      );
    });
  });

  test("引数なし（パレット）は前面の映しの編集器から開く", async () => {
    const rel = REAL_FILE_RELS.palette;
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const staged = await stageDeepMirror(rel);
      // 人間が映しのタブをクリックして前面にする。人間の今の列は映しの列になる。
      await humanFocuses(staged);
      await vscode.commands.executeCommand("showme.openRealFile");
      await realFileEventually(rel, staged.viewColumn);
      // 映しと本物のファイルが同じ列に同じ path で並ぶ: own はちょうど1枚（映し）だけ。
      const state = await getEditorState();
      const same = layoutGroups(state)
        .find((group) => group.viewColumn === staged.viewColumn)
        ?.tabs.filter((tab) => tab.path === rel);
      assert.deepStrictEqual(
        same?.map((tab) => tab.own === true).sort(),
        [false, true],
        `同じ列の ${rel} のタブ: ${JSON.stringify(same)}`,
      );
    });
  });

  test("映しでない編集器（file:）や、関門に落ちる映しの URI（秘匿・不在）で呼んでも何も開かない", async () => {
    const rel = REAL_FILE_RELS.plain;
    await withSettings({ "stage.agentTabs": true }, async () => {
      const human = await humanOpens(rel);
      const before = textTabUris();
      const focus = activeEditorSnapshot();
      await vscode.commands.executeCommand("showme.openRealFile", human.document.uri);
      await vscode.commands.executeCommand("showme.openRealFile");
      // 形の違う引数（編集器のタイトル以外から executeCommand で任意の値が来うる）も黙って無視する。
      await vscode.commands.executeCommand("showme.openRealFile", { path: rel });
      // 組み立てた映しの URI でも、関門（秘匿・不在）に落ちるものは開かない。
      // 1本ずつ確かめる（不在が投げると、先の秘匿が開いたことを隠す）。
      for (const crafted of [ENV_REL, "tabs/no-such-file.md"]) {
        await vscode.commands.executeCommand(
          "showme.openRealFile",
          vscode.Uri.from({ scheme: STAGE_SCHEME_READONLY, path: `/${crafted}` }),
        );
        assert.deepStrictEqual(textTabUris(), before, `${crafted} を開いた`);
      }
      assert.deepStrictEqual(textTabUris(), before);
      assert.strictEqual(activeEditorSnapshot(), focus);
    });
  });
});

/**
 * エージェントの選択肢 `show_code` の `realFile: true`（D87）。舞台の列に**本物のファイル**（`file:`）を
 * 開き、塗りもそこに付く。そのタブは人間のもの（記録しない）なので own にならず、`close-own` でも
 * 閉じない ―― `agentTabs` の値に関わらず。`realFile` なしの `show_code` は今までどおり（映しの窓では
 * 映し、従来の窓では記録して own）。
 */
suite("show_code の realFile: true（D87）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await annotateClear();
  });

  teardown(async () => {
    // この節は本物のファイルを開くが編集はしない。万一未保存になっていても確認で止まらないよう、
    // 戻してから閉じる。
    await annotateClear();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.isDirty) {
        await vscode.window.showTextDocument(editor.document, { preserveFocus: false });
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  /** `realFile: true` で1件だけ見せる（線上と同じ検証を通るテスト専用コマンド）。 */
  async function showRealFile(rel: string): Promise<Record<string, unknown>> {
    const raw = (await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [{ path: rel, text: STAGE_TABS_MARKER }],
      realFile: true,
    })) as { resolutions?: Array<Record<string, unknown>> };
    const [resolution] = raw.resolutions ?? [];
    assert.ok(resolution, JSON.stringify(raw));
    assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
    return resolution;
  }

  test("映しの窓: file: の編集器が舞台の列に開き、塗りはそこに付く。own でなく close-own で閉じない。realFile なしは映しのまま", async () => {
    const rel = REAL_FILE_RELS.agent;
    const file = fileUri(rel);
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const focusBefore = activeEditorSnapshot();

      await showRealFile(rel);
      const editor = await visibleEditorEventually("本物のファイルの編集器が見える", file);
      assert.strictEqual(editor.document.uri.scheme, "file");
      assert.notStrictEqual(editor.viewColumn, humanColumn, "本物のファイルが人間の列に開いた");
      assert.strictEqual(activeEditorSnapshot(), focusBefore, "フォーカスが舞台へ移った");
      assert.ok(
        !textTabUris().includes(mirror.toString()),
        `realFile なのに映しも開いた: ${textTabUris().join(", ")}`,
      );
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(
        spotlightUris(visuals),
        [file.toString()],
        JSON.stringify(visuals.highlightRanges),
      );

      const fileTab = await observedTab(rel, editor.viewColumn);
      assert.ok(fileTab, "本物のファイルのタブが path で現れない");
      assert.ok(!("own" in fileTab), `本物のファイルが own になった: ${JSON.stringify(fileTab)}`);
      const nothing = await arrangeEditors("close-own");
      assert.strictEqual(nothing.closed, 0, JSON.stringify(nothing));
      assert.strictEqual(
        columnOfUri(file),
        editor.viewColumn,
        "close-own が本物のファイルを閉じた",
      );

      // 同じファイルを realFile なしで見せる → 映しが開き、塗りは映しへ移る。
      const again = await showOne({ path: rel, text: STAGE_TABS_MARKER });
      assert.strictEqual(again.match, "one", JSON.stringify(again));
      await visibleEditorEventually("映しの編集器が見える", mirror);
      const after = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(after), [mirror.toString()]);

      const closed = await arrangeEditors("close-own");
      await waitFor("映しが閉じる", () => columnOfUri(mirror) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
      assert.ok(columnOfUri(file) !== undefined, "close-own が本物のファイルを閉じた");
    });
  });

  test("従来の窓（agentTabs: false）: realFile は記録せず own でない。realFile なしは記録して own（D53）", async () => {
    const rel = REAL_FILE_RELS.agentLegacy;
    const ownRel = REAL_FILE_RELS.legacyOwn;
    const file = fileUri(rel);
    await withSettings({ "stage.agentTabs": false }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      await showRealFile(rel);
      const editor = await visibleEditorEventually("本物のファイルの編集器が見える", file);
      assert.notStrictEqual(editor.viewColumn, humanColumn, "本物のファイルが人間の列に開いた");
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(visuals), [file.toString()]);
      const fileTab = await observedTab(rel, editor.viewColumn);
      assert.ok(fileTab, "本物のファイルのタブが path で現れない");
      assert.ok(!("own" in fileTab), `realFile のタブが own になった: ${JSON.stringify(fileTab)}`);

      // 対照: realFile なしの show_code は従来どおり file: で開き、記録して own。
      const plain = await showOne({ path: ownRel, text: STAGE_TABS_MARKER });
      assert.strictEqual(plain.match, "one", JSON.stringify(plain));
      const ownEditor = await visibleEditorEventually("従来の file: が見える", fileUri(ownRel));
      const ownTab = await observedTab(ownRel, ownEditor.viewColumn);
      assert.strictEqual(
        ownTab?.own,
        true,
        `従来の show_code が own でない: ${JSON.stringify(ownTab)}`,
      );

      const closed = await arrangeEditors("close-own");
      await waitFor("従来の file: が閉じる", () => columnOfUri(fileUri(ownRel)) === undefined);
      assert.deepStrictEqual(closed, { done: true, closed: 1 }, JSON.stringify(closed));
      assert.ok(columnOfUri(file) !== undefined, "close-own が realFile のタブを閉じた");
    });
  });

  test("annotate の realFile: true は吹き出しを本物のファイルに付け、その編集器に出る。realFile なしは映しに付く", async () => {
    const rel = REAL_FILE_RELS.annotate;
    const file = fileUri(rel);
    const mirror = await stageUri(rel, STAGE_SCHEME_READONLY);
    await withSettings({ "stage.agentTabs": true }, async () => {
      await humanOpens(STAGE_TABS_RELS.human);
      await showRealFile(rel);
      const editor = await visibleEditorEventually("本物のファイルの編集器が見える", file);

      const raw = (await vscode.commands.executeCommand("showme.test.annotate", {
        items: [{ location: { path: rel, text: STAGE_TABS_MARKER }, text: "on the real file" }],
        realFile: true,
      })) as { resolutions?: Array<Record<string, unknown>> };
      const [onFile] = raw.resolutions ?? [];
      assert.ok(onFile && typeof onFile.id === "number", JSON.stringify(raw));
      // VS Code がスレッドを出す条件（URI の一致）を、見えている file: の編集器の文書と比べる。
      const thread = await annotationThread(onFile.id as number);
      assert.strictEqual(thread.uri.toString(), editor.document.uri.toString());
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(visuals.annotatedUris, [file.toString()]);
      assert.deepStrictEqual(annotationLayerUris(visuals), [file.toString()]);
      assert.ok(!textTabUris().includes(mirror.toString()), "annotate が映しを開いた");

      // realFile なしは今までどおり映しの URI に付く。
      const [onMirror] = await annotate([
        { location: { path: rel, text: STAGE_TABS_MARKER }, text: "on the agent tab" },
      ]);
      assert.ok(onMirror && typeof onMirror.id === "number", JSON.stringify(onMirror));
      const mirrorThread = await annotationThread(onMirror.id as number);
      assert.strictEqual(mirrorThread.uri.toString(), mirror.toString());
      const after = await inspectVisuals();
      assert.deepStrictEqual(after.annotatedUris, [mirror.toString()]);
    });
  });

  test("印だけ（stage.enabled: false）では realFile でも開かず、塗りは file: に付く（D76）", async () => {
    const rel = REAL_FILE_RELS.agent;
    const file = fileUri(rel);
    await withSettings({ "stage.agentTabs": true, "stage.enabled": false }, async () => {
      await showRealFile(rel);
      assert.deepStrictEqual(textTabUris(), [], "印だけなのにタブを開いた");
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(spotlightUris(visuals), [file.toString()]);
    });
  });
});

suite("エージェントのタブの印（D89）", () => {
  suiteSetup(async () => {
    // 窓を預けるかどうかに依らず登録される（映しの FS と同じ）。ここでは預けない。
    await activateExtension();
  });

  /** 拡張が登録したのと同じプロバイダに `uri` を渡した結果（統合テスト専用の口）。 */
  async function decorationOf(uri: vscode.Uri): Promise<unknown> {
    return vscode.commands.executeCommand("showme.test.agentTabDecoration", {
      scheme: uri.scheme,
      authority: uri.authority,
      path: uri.path,
    });
  }

  test("正しい綴りの映し（ro / rw）には SM のバッジと色、file: と別綴りには何も付かない", async () => {
    const rel = STAGE_TABS_RELS.observe;
    for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
      const mirror = await stageUri(rel, scheme);
      assert.deepStrictEqual(await decorationOf(mirror), {
        badge: "SM",
        tooltip: "ShowMe: the agent's tab",
        color: "showme.agentTabForeground",
        propagate: false,
      });
      // 別綴り（authority つき・`/./`）。実物の `Uri` は authority の無い `//` 始まりを拒むので使わない。
      for (const alias of [
        mirror.with({ authority: "host" }),
        mirror.with({ path: `/.${mirror.path}` }),
      ]) {
        assert.strictEqual(await decorationOf(alias), undefined, alias.toString());
      }
    }
    assert.strictEqual(await decorationOf(await stageUri(rel, "file")), undefined);
  });
});
