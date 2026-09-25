import * as assert from "node:assert";
import * as vscode from "vscode";
import { REAL_FILE_RELS, STAGE_TABS_MARKER, STAGE_TABS_RELS } from "../fixture.js";
import {
  activateExtension,
  allPanelTabs,
  annotateClear,
  arrangeEditors,
  assertGlobal,
  lendWindow,
  listWorkspaces,
  showOne,
  stageUri,
  waitFor,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 道具の列を避ける（D90。`showme.stage.avoidToolColumns`）。
 *
 * 人間は列1。列2の**表示中のタブ**がターミナルか他の拡張の webview なら、設定がオンのとき
 * `show_code` は列2に描かず列3に開く。オフなら今どおり列2。列2の表示中のタブが人間の `file:`
 * タブ・映しのタブ・ShowMe のパネルなら、オンでも列2に開く（道具ではない）。
 *
 * 判定は表示中のタブの**入力の型**で、「own でない」ではない ―― 人間の `file:` タブの行がそれを見る。
 */

const SETTING = "stage.avoidToolColumns";
/** 他の拡張のパネルの代わり。ShowMe の枠の `viewType`（`showme.view*`）ではない。 */
const FOREIGN_VIEW_TYPE = "showmeTest.foreignPanel";

function fileUri(rel: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), rel);
}

/** 人間が列1で `file:` を開き、フォーカスも列1に置く。 */
async function humanInColumnOne(): Promise<void> {
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

/** その列の表示中のタブ。 */
function activeTabOf(column: vscode.ViewColumn): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.find((g) => g.viewColumn === column)?.activeTab;
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

/**
 * 列1..9 に人間の `file:` タブを置き、人間を列9に置く（右に列を足せない）。`fromColumn` より
 * 左の列は触らない（呼ぶ前に置いたタブを残すため）。
 */
async function fillToNineWithHumanInNine(fromColumn = 1): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fileUri(REAL_FILE_RELS.plain));
  for (let column = fromColumn; column <= 9; column += 1) {
    await vscode.window.showTextDocument(doc, {
      viewColumn: column as vscode.ViewColumn,
      preserveFocus: false,
      preview: false,
    });
  }
  await waitFor("列が9つ", () => vscode.window.tabGroups.all.length === 9);
  await waitFor(
    "人間が列9に居る",
    () => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.Nine,
  );
}

/** テスト専用コマンドが投げた `ToolError` の code。投げなければ undefined。 */
async function errorCodeOf(
  command: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    await vscode.commands.executeCommand(command, args);
    return undefined;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : `no-code:${String(e)}`;
  }
}

const terminals: vscode.Terminal[] = [];
const foreignPanels: vscode.WebviewPanel[] = [];

/** 列2にターミナル（編集器の領域）を開き、表示中にする。 */
async function terminalInColumnTwo(): Promise<void> {
  const terminal = vscode.window.createTerminal({
    name: "showme-test-tool",
    location: { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
  });
  terminals.push(terminal);
  await waitFor(
    "列2の表示中のタブがターミナル",
    () => activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputTerminal,
  );
}

/** 列2に他の拡張のパネル（テスト用の webview）を開き、表示中にする。 */
async function foreignPanelInColumnTwo(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(FOREIGN_VIEW_TYPE, "Foreign tool", {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: true,
  });
  panel.webview.html = "<p>tool</p>";
  foreignPanels.push(panel);
  await waitFor(
    "列2の表示中のタブが他の拡張の webview",
    () => activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputWebview,
  );
}

/** `show_code` で `rel` を開き、開いた列を返す。 */
async function showCodeColumn(rel: string): Promise<vscode.ViewColumn | undefined> {
  const resolution = await showOne({ path: rel, text: STAGE_TABS_MARKER });
  assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
  const uri = await stageUri(rel);
  await waitFor("舞台のタブが開いた", () => columnOfUri(uri) !== undefined);
  return columnOfUri(uri);
}

/** 人間が列1、列2にターミナル、列3に人間の `file:` タブ（3列）。フォーカスは列1。 */
async function terminalBetweenThreeColumns(): Promise<void> {
  await humanInColumnOne();
  await terminalInColumnTwo();
  const doc = await vscode.workspace.openTextDocument(fileUri(REAL_FILE_RELS.plain));
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Three,
    preserveFocus: true,
    preview: false,
  });
  await waitFor("列が3つ", () => vscode.window.tabGroups.all.length === 3);
  await humanInColumnOne();
}

suite("道具の列を避ける（D90）", () => {
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
    for (const terminal of terminals.splice(0)) terminal.dispose();
    for (const panel of foreignPanels.splice(0)) panel.dispose();
    await annotateClear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  test("既定はオフで、list_workspaces.avoidToolColumns がその値を写す", async () => {
    assertGlobal(SETTING, undefined);
    assert.strictEqual((await listWorkspaces()).avoidToolColumns, false);
    await withSettings({ [SETTING]: true }, async () => {
      assert.strictEqual((await listWorkspaces()).avoidToolColumns, true);
    });
  });

  for (const [label, placeTool] of [
    ["ターミナル", terminalInColumnTwo],
    ["他の拡張の webview", foreignPanelInColumnTwo],
  ] as const) {
    test(`列2に${label}: オンなら show_code は列3に開き、列2は表示中のまま`, async () => {
      await humanInColumnOne();
      await placeTool();
      await humanInColumnOne();
      await withSettings({ [SETTING]: true }, async () => {
        const column = await showCodeColumn(STAGE_TABS_RELS.show);
        assert.strictEqual(column, vscode.ViewColumn.Three, `舞台が列${String(column)}に開いた`);
        // 道具は列2で表示中のまま（被せていない）。
        const tool = activeTabOf(vscode.ViewColumn.Two)?.input;
        assert.ok(
          tool instanceof vscode.TabInputTerminal || tool instanceof vscode.TabInputWebview,
          "列2の道具が表示中でなくなった",
        );
        assert.strictEqual(
          vscode.window.tabGroups.activeTabGroup.viewColumn,
          vscode.ViewColumn.One,
          "フォーカスが舞台へ移った",
        );
      });
    });

    test(`列2に${label}: オフなら今どおり列2に開く`, async () => {
      assertGlobal(SETTING, undefined);
      await humanInColumnOne();
      await placeTool();
      await humanInColumnOne();
      const column = await showCodeColumn(STAGE_TABS_RELS.show);
      assert.strictEqual(column, vscode.ViewColumn.Two, `舞台が列${String(column)}に開いた`);
    });
  }

  test("列2の表示中のタブが人間の file: タブなら、オンでも列2に開く（own でないだけでは道具でない）", async () => {
    await humanInColumnOne();
    const doc = await vscode.workspace.openTextDocument(fileUri(REAL_FILE_RELS.plain));
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
      preview: false,
    });
    await humanInColumnOne();
    await withSettings({ [SETTING]: true }, async () => {
      const column = await showCodeColumn(STAGE_TABS_RELS.show);
      assert.strictEqual(column, vscode.ViewColumn.Two, `舞台が列${String(column)}に開いた`);
    });
  });

  test("列2の表示中のタブが映しのタブなら、オンでも列2に開く", async () => {
    await humanInColumnOne();
    await withSettings({ [SETTING]: true }, async () => {
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.Two);
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.annotate), vscode.ViewColumn.Two);
    });
  });

  test("列2の表示中のタブが ShowMe のパネルなら、オンでも列2に開く", async () => {
    await humanInColumnOne();
    await withSettings({ [SETTING]: true }, async () => {
      await vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>own</p>" });
      await waitFor(
        "ShowMe のパネルが列2で表示中",
        () =>
          activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputWebview &&
          allPanelTabs().some((tab) => tab === activeTabOf(vscode.ViewColumn.Two)),
      );
      await humanInColumnOne();
      const column = await showCodeColumn(STAGE_TABS_RELS.show);
      assert.strictEqual(column, vscode.ViewColumn.Two, `舞台が列${String(column)}に開いた`);
    });
  });

  test("gather-own は show_code と同じ列（道具の列の右）に集める", async () => {
    await humanInColumnOne();
    // own の映しを列2に置いてから、その上にターミナルを開いて表示中にする。
    const own = await stageUri(STAGE_TABS_RELS.show);
    assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.Two);
    await terminalInColumnTwo();
    await humanInColumnOne();
    await withSettings({ [SETTING]: true }, async () => {
      const result = await arrangeEditors("gather-own");
      assert.strictEqual(result.done, true, JSON.stringify(result));
      await waitFor("own の映しが列3へ動いた", () => columnOfUri(own) === vscode.ViewColumn.Three);
      // 同じ観測で show_code が開く列も列3。
      await humanInColumnOne();
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.annotate), vscode.ViewColumn.Three);
      assert.ok(
        activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputTerminal,
        "列2のターミナルが表示中でなくなった",
      );
    });
  });

  test("オンで置ける列が無ければ、show_code / show_note / show_html は no-stage-column で断り、何も開かない", async () => {
    // 列1..9 を作り、人間は列9（右に列を足せない）。避ける列が無くても Nine の外には置かない。
    await fillToNineWithHumanInNine();
    const tabsBefore = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;

    await withSettings({ [SETTING]: true }, async () => {
      const resolution = await showOne({ path: STAGE_TABS_RELS.show, text: STAGE_TABS_MARKER });
      assert.strictEqual(resolution.reason, "no-stage-column", JSON.stringify(resolution));
      assert.strictEqual(resolution.range, undefined, "開けなかった位置の範囲が返った");

      assert.strictEqual(
        await errorCodeOf("showme.test.showNote", { text: "note" }),
        "no-stage-column",
        "show_note が no-stage-column で断らなかった",
      );
      assert.strictEqual(
        await errorCodeOf("showme.test.showHtml", { html: "<p>x</p>" }),
        "no-stage-column",
        "show_html が no-stage-column で断らなかった",
      );

      assert.strictEqual(vscode.window.tabGroups.all.length, 9, "列が増えた");
      assert.strictEqual(
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).length,
        tabsBefore,
        "断ったのにタブが増えた",
      );
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.viewColumn,
        vscode.ViewColumn.Nine,
        "人間の列が動いた",
      );
    });
  });

  test("オフなら、9列で人間が列9でも断らない（以前の振る舞い）", async () => {
    assertGlobal(SETTING, undefined);
    await fillToNineWithHumanInNine();
    const resolution = await showOne({ path: STAGE_TABS_RELS.show, text: STAGE_TABS_MARKER });
    assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
    assert.strictEqual(resolution.reason, undefined, JSON.stringify(resolution));
    const uri = await stageUri(STAGE_TABS_RELS.show);
    await waitFor("舞台のタブが開いた", () => columnOfUri(uri) !== undefined);
  });

  test("オンなら、ターミナルの列を合流させる two-columns は tool-column-would-merge で断り、列を変えない", async () => {
    await terminalBetweenThreeColumns();
    await withSettings({ [SETTING]: true }, async () => {
      const result = await arrangeEditors("two-columns");
      assert.strictEqual(result.done, false, JSON.stringify(result));
      assert.deepStrictEqual(result.withheld, ["tool-column-would-merge"], JSON.stringify(result));
      assert.strictEqual(vscode.window.tabGroups.all.length, 3, "列が合流した");
      assert.ok(
        activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputTerminal,
        "列2のターミナルが表示中でなくなった",
      );
    });
  });

  test("オフなら、同じ画面で two-columns は今どおり走る（列が2つになる）", async () => {
    assertGlobal(SETTING, undefined);
    await terminalBetweenThreeColumns();
    const result = await arrangeEditors("two-columns");
    assert.strictEqual(result.done, true, JSON.stringify(result));
    assert.strictEqual(result.withheld, undefined, JSON.stringify(result));
    await waitFor("列が2つになった", () => vscode.window.tabGroups.all.length === 2);
  });

  test("オンなら move-tab でターミナルの列へ入れず（tool-column-target）、オフなら入れる", async () => {
    await humanInColumnOne();
    await terminalInColumnTwo();
    await humanInColumnOne();
    const own = await stageUri(STAGE_TABS_RELS.show);
    await withSettings({ [SETTING]: true }, async () => {
      assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.Three);
      const result = await arrangeEditors("move-tab", {
        path: STAGE_TABS_RELS.show,
        toColumn: 2,
      });
      assert.strictEqual(result.done, false, JSON.stringify(result));
      assert.deepStrictEqual(result.withheld, ["tool-column-target"], JSON.stringify(result));
      assert.strictEqual(result.moved, 0, JSON.stringify(result));
      assert.strictEqual(columnOfUri(own), vscode.ViewColumn.Three, "own の映しが動いた");
      assert.ok(
        activeTabOf(vscode.ViewColumn.Two)?.input instanceof vscode.TabInputTerminal,
        "列2のターミナルが表示中でなくなった",
      );
    });
    // 対照: オフなら同じ移動が通る。
    await humanInColumnOne();
    const result = await arrangeEditors("move-tab", { path: STAGE_TABS_RELS.show, toColumn: 2 });
    assert.strictEqual(result.done, true, JSON.stringify(result));
    await waitFor("own の映しが列2へ動いた", () => columnOfUri(own) === vscode.ViewColumn.Two);
  });

  test("オンで集め先が作れなければ、gather-own は withheld: no-stage-column で断り、何も動かさない", async () => {
    // own の映しを列2に置いてから、列3..9 を人間のタブで埋め、人間を列9に置く。
    await humanInColumnOne();
    const own = await stageUri(STAGE_TABS_RELS.show);
    assert.strictEqual(await showCodeColumn(STAGE_TABS_RELS.show), vscode.ViewColumn.Two);
    await fillToNineWithHumanInNine(3);
    await withSettings({ [SETTING]: true }, async () => {
      const result = await arrangeEditors("gather-own");
      assert.strictEqual(result.done, false, JSON.stringify(result));
      assert.deepStrictEqual(result.withheld, ["no-stage-column"], JSON.stringify(result));
      assert.strictEqual(result.moved, 0, JSON.stringify(result));
      assert.strictEqual(columnOfUri(own), vscode.ViewColumn.Two, "own の映しが動いた");
      assert.strictEqual(vscode.window.tabGroups.all.length, 9, "列が増えた");
    });
  });
});
