import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { NOTES_REL, SAMPLE_REL } from "../fixture.js";
import {
  activateExtension,
  allPanelTabs,
  arrangeEditors,
  assertGlobal,
  getEditorState,
  layoutGroups,
  layoutTabs,
  lendWindow,
  listWorkspaces,
  measureDisplayedLength,
  panelColumn,
  panelTab,
  panelTabs,
  setGlobal,
  waitFor,
  workspaceRoot,
} from "./helpers.js";

/**
 * パネル2枚目（`slot`。設計 D61 / §B2 / C5）と、上限が人間の設定になったこと
 * （`showme.html.maxPanels`。増分6.2 D80）を実機で確かめる。
 *
 * 単体は「枠2の面だけが呼ばれる」「`showme.view.2` は枠1に当たらない」「上限の判定は
 * `handleShowHtml` の1箇所」を見ているが、**VS Code が N 枚目の webview を本当に別のタブとして
 * 持ち、`TabInputWebview.viewType` から枠が読めるか**は実機でしか分からない。
 * `get_editor_state` の `slot` は `slotOfViewType` の実機の答えそのものである。
 *
 * trusted / restricted の**両方**で走る（`index.ts`）。「制限モードでも N 枚」は推定なので、
 * 両方の回で実測に変える。
 */

const LIVE_REL = "docs/showme-slot-live.html";

interface ShowHtmlResult {
  shown?: unknown;
  droppedDeclarations?: unknown;
}

async function showHtml(args: Record<string, unknown>): Promise<ShowHtmlResult> {
  await vscode.commands.executeCommand("showme.test.resetRateLimits");
  return (await vscode.commands.executeCommand("showme.test.showHtml", args)) as ShowHtmlResult;
}

function liveFile(): string {
  return path.join(workspaceRoot().fsPath, LIVE_REL);
}

function removeLiveFile(): void {
  try {
    fs.unlinkSync(liveFile());
  } catch {
    // 無ければそれでよい。
  }
}

/** own の webview タブ（`get_editor_state` の観測）。`slot` 順に並べる。 */
async function ownWebviews(): Promise<Array<Record<string, unknown>>> {
  return layoutTabs(await getEditorState())
    .filter((t) => t.kind === "webview" && t.own === true)
    .sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0));
}

/**
 * 窓の中の、自分の webview タブの実枚数（VS Code のタブそのもの。`get_editor_state` とは別の観測）。
 * **枠を列挙しない**（上限は設定次第。D80）―― 3枚目以降が出ていても数える。
 */
function panelTabCount(): number {
  return allPanelTabs().length;
}

/** 変化が**起きない**ことを見る待ち。起きたら即座に落とす（黙って待ち切らない）。 */
async function assertLengthStays(slot: 1 | 2, before: number, label: string, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = await measureDisplayedLength(slot);
    assert.strictEqual(
      now,
      before,
      `${label}: 枠${slot}の表示の長さが変わった（${before} → ${now}）`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 列 `column` に人間のタブ（`NOTES_REL`。own ではない）を pinned で置き、その列が空にならない
 * ようにする。フォーカスは動かさない（人間は列1のまま）。
 */
async function keepColumnOpenWithNotes(column: number): Promise<void> {
  const notes = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceRoot(), NOTES_REL),
  );
  await vscode.window.showTextDocument(notes, {
    viewColumn: column,
    preview: false,
    preserveFocus: true,
  });
  await waitFor(`列${column}ができる`, () =>
    vscode.window.tabGroups.all.some((g) => g.viewColumn === column),
  );
}

/** 人間が列1で `SAMPLE_REL` を見ている状態にする（パネルを人間が見ていると床1 で残る）。 */
async function humanLooksAtSample(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
  );
  return await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
}

suite("show_html の slot（D61 / C5）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    removeLiveFile();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("パネルが無い状態から始める", () => panelTabCount() === 0);
  });

  teardown(async () => {
    removeLiveFile();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("slot 1 と 2 で2枚並び、get_editor_state の own の webview に slot が 1 と 2 で付く", async () => {
    await showHtml({ html: "<p>前の図</p>", title: "前の図", slot: 1 });
    await showHtml({ html: "<p>今の図</p>", title: "今の図", slot: 2 });
    await waitFor("2枚のパネルが開く", () => panelTabCount() === 2);

    // **実機の `viewType` を完全一致で記録する。** 拡張の照合（`slotOfViewType`）は完全一致なので、
    // ここがずれたら所有判定が黙って外れる ―― 赤くする。
    const first = panelTab(1)?.input;
    const second = panelTab(2)?.input;
    assert.ok(first instanceof vscode.TabInputWebview, "枠1が TabInputWebview でない");
    assert.ok(second instanceof vscode.TabInputWebview, "枠2が TabInputWebview でない");
    console.log(`[測定] 枠1 viewType: ${first.viewType} / 枠2 viewType: ${second.viewType}`);
    assert.strictEqual(first.viewType, "mainThreadWebview-showme.view");
    assert.strictEqual(second.viewType, "mainThreadWebview-showme.view.2");
    assert.notStrictEqual(panelTab(1), panelTab(2), "枠1と枠2が同じタブ");

    const own = await ownWebviews();
    assert.strictEqual(own.length, 2, `own の webview が2枚でない: ${JSON.stringify(own)}`);
    assert.deepStrictEqual(
      own.map((t) => [t.slot, t.label]),
      [
        [1, "ShowMe: 前の図"],
        [2, "ShowMe: 今の図"],
      ],
      `slot と題の対応が違う: ${JSON.stringify(own)}`,
    );
    // 両方とも中身の口は開かない。
    for (const t of own) {
      assert.strictEqual(t.path, undefined, "webview に path が付いた");
      assert.strictEqual(t.visibleLines, undefined, "webview に可視行が付いた");
    }
    // どちらも中身が届いている（2枚目が「タブはあるが空」でない）。
    assert.ok((await measureDisplayedLength(1)) > 0, "枠1が空");
    assert.ok((await measureDisplayedLength(2)) > 0, "枠2が空");
  });

  test("slot 省略は 1（既存の呼び方は壊れない）。同じ slot に2回出すと差し替わり、タブは増えない", async () => {
    await showHtml({ html: "<p>a</p>", title: "一枚目" });
    await waitFor("パネルが開く", () => panelTab(1) !== undefined);
    assert.strictEqual(panelTab(2), undefined, "slot 省略で枠2が開いた");
    let own = await ownWebviews();
    assert.deepStrictEqual(
      own.map((t) => t.slot),
      [1],
    );

    await showHtml({ html: "<p>b</p>", title: "二枚目", slot: 2 });
    await waitFor("2枚になる", () => panelTabCount() === 2);
    const before = { first: panelTab(1), second: panelTab(2) };

    // 同じ枠に出し直す → 差し替え。タブは同じ実体のまま（枚数も題の対応も）。
    await showHtml({ html: `<p>${"c".repeat(500)}</p>`, title: "一枚目の差し替え", slot: 1 });
    await showHtml({ html: `<p>${"d".repeat(700)}</p>`, title: "二枚目の差し替え", slot: 2 });
    await waitFor("題が差し替わる", () => panelTab(2)?.label === "ShowMe: 二枚目の差し替え");
    assert.strictEqual(panelTabCount(), 2, "同じ slot に出し直したらタブが増えた");
    assert.strictEqual(panelTab(1), before.first, "枠1のタブの実体が変わった");
    assert.strictEqual(panelTab(2), before.second, "枠2のタブの実体が変わった");
    own = await ownWebviews();
    assert.deepStrictEqual(
      own.map((t) => [t.slot, t.label]),
      [
        [1, "ShowMe: 一枚目の差し替え"],
        [2, "ShowMe: 二枚目の差し替え"],
      ],
      JSON.stringify(own),
    );
    // 中身も枠ごとに差し替わっている（長さで見る。中身は返さない）。
    const len1 = await measureDisplayedLength(1);
    const len2 = await measureDisplayedLength(2);
    assert.ok(len1 > 500, `枠1が差し替わっていない（${len1}）`);
    assert.ok(len2 > 700, `枠2が差し替わっていない（${len2}）`);
    assert.notStrictEqual(len1, len2, "枠1と枠2が同じ中身");
  });

  test('既定（設定なし）では3枚目は無い: slot: 3 は拡張が上限（2）を言って断り、0 / "1" はスキーマで落ち、パネルは増えない（D61 → D80）', async () => {
    assertGlobal("html.maxPanels", undefined);
    assert.deepStrictEqual((await listWorkspaces()).panels, { max: 2 });
    await showHtml({ html: "<p>a</p>", slot: 1 });
    await showHtml({ html: "<p>b</p>", slot: 2 });
    await waitFor("2枚になる", () => panelTabCount() === 2);

    // 3 は**スキーマを通って拡張が断る**（上限は人間の設定。文言が上限を言う）。
    await assert.rejects(
      async () => showHtml({ html: "<p>c</p>", slot: 3 }),
      (e: unknown) => String(e).includes("slot 3 exceeds showme.html.maxPanels (2)"),
      "slot: 3 が通った、または断りが上限を言わない",
    );
    // 0 と "1" は線の形で落ちる（整数 1〜999）。
    for (const bad of [0, "1", 1000]) {
      await assert.rejects(
        async () => showHtml({ html: "<p>c</p>", slot: bad }),
        (e: unknown) => String(e).includes("slot"),
        `slot: ${JSON.stringify(bad)} が通った`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(panelTabCount(), 2, "落ちたのにパネルが増えた／減った");
    assert.strictEqual((await ownWebviews()).length, 2);
  });

  test("close-own は2枚とも閉じる（closed: 2）", async () => {
    await humanLooksAtSample();
    await showHtml({ html: "<p>a</p>", title: "片づけ1", slot: 1 });
    await showHtml({ html: "<p>b</p>", title: "片づけ2", slot: 2 });
    await waitFor("2枚になる", () => panelTabCount() === 2);
    // **前提: 人間はパネルを見ていない**（見ていると床1 で残り、「閉じる」を言えない）。
    const viewing = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(viewing !== panelTab(1) && viewing !== panelTab(2), "人間がパネルを見ている（前提）");

    const result = await arrangeEditors("close-own");
    assert.deepStrictEqual(result, { done: true, closed: 2 }, JSON.stringify(result));
    await waitFor("2枚とも消える", () => panelTabCount() === 0);
    assert.strictEqual((await ownWebviews()).length, 0);
    // 人間のタブは残る。
    assert.ok(
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some(
          (t) => t.input instanceof vscode.TabInputText && t.label === path.basename(SAMPLE_REL),
        ),
      ),
      "人間のタブが巻き込まれた",
    );
  });

  test("move-panel { slot: 2 } は枠2だけを動かす。動かした枠は pinned で、次の preview に消されない。slot 省略は枠1。出ていない slot: 3 は moved: 0", async () => {
    await humanLooksAtSample();
    await showHtml({ html: "<p>動かす1</p>", title: "動かす1", slot: 1 });
    await showHtml({ html: `<p>${"動かす2".repeat(30)}</p>`, title: "動かす2", slot: 2 });
    await waitFor("2枚になる", () => panelTabCount() === 2);
    const from1 = panelColumn(1);
    const from2 = panelColumn(2);
    assert.ok(typeof from1 === "number" && from1 > 1, `枠1が人間の列に開いた: ${String(from1)}`);
    assert.ok(typeof from2 === "number" && from2 > 1, `枠2が人間の列に開いた: ${String(from2)}`);
    // 枠2の既定は舞台の2列目なので、2枚は別の列に居る。
    assert.notStrictEqual(from1, from2, "枠1と枠2が同じ列に開いた（枠2の既定は舞台の2列目）");
    // どちらも作った直後は **pinned**（VS Code の `openWebview` は `pinned: true` で開く。実測）。
    assert.strictEqual(panelTab(1)?.isPreview, false, "作った枠1が preview（前提）");
    assert.strictEqual(panelTab(2)?.isPreview, false, "作った枠2が preview（前提）");
    const tab1Before = panelTab(1);
    const len1 = await measureDisplayedLength(1);
    const len2 = await measureDisplayedLength(2);
    assert.ok(len1 > 0 && len2 > 0, `前提: 中身が入っている（${len1} / ${len2}）`);
    const groupCount = vscode.window.tabGroups.all.length;

    // 枠2を**枠1の居る列**へ。実測ではここで枠2が preview になり、次の preview で消えた。
    const moved2 = await arrangeEditors("move-panel", { toColumn: from1, slot: 2 });
    assert.deepStrictEqual(moved2, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved2));
    await waitFor(
      `枠2が列${from1}に移り、空いた列が閉じ、枠2のタブは1枚に戻る`,
      () =>
        panelColumn(2) === from1 &&
        panelTabs(2).length === 1 &&
        vscode.window.tabGroups.all.length === groupCount - 1,
    );
    assert.strictEqual(panelColumn(1), from1, "枠1まで動いた");
    assert.strictEqual(panelTab(1), tab1Before, "枠1のタブの実体が変わった（枠1まで作り直した）");
    // `get_editor_state` でも枠2が枠1の列に居る。
    const groups = layoutGroups(await getEditorState());
    const columnOfSlot = (slot: number) =>
      groups.find((g) =>
        g.tabs.some((t) => t.kind === "webview" && t.own === true && t.slot === slot),
      )?.viewColumn;
    assert.strictEqual(columnOfSlot(2), from1, `get_editor_state で枠2が列${from1}に無い`);
    assert.strictEqual(columnOfSlot(1), from1, "get_editor_state で枠1が動いている");

    // **直した欠陥:** `WebviewPanel.reveal(column)` で動かしたパネルは
    // 移動先で **preview タブ**になっていた（VS Code の `revealWebview` は `openEditor` に
    // `pinned` を渡さない。拡張の API に pin する口も無い）。この検査の前の版は
    // `isPreview === true` を「起きていることの記録」として固定していた。いまは `move-panel` が
    // 移動先で**作り直す**（`createWebviewPanel` は pinned で開く）ので、false を主張する。
    assert.strictEqual(
      panelTab(2)?.isPreview,
      false,
      "move-panel で動かした枠2が preview（作り直しになっていない）",
    );
    // 中身は覚えていたサニタイズ済み HTML から描き直されている（長さが一致。中身は返さない）。
    assert.strictEqual(await measureDisplayedLength(2), len2, "動かした枠2の中身が変わった");
    assert.strictEqual(await measureDisplayedLength(1), len1, "動かしていない枠1の中身が変わった");

    // **その列で次に preview を開いても、枠2は残る**（preview なら差し替えられて消えていた）。
    const notes = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), NOTES_REL),
    );
    await vscode.window.showTextDocument(notes, {
      viewColumn: from1,
      preview: true,
      preserveFocus: true,
    });
    const previewIn = (column: number) =>
      vscode.window.tabGroups.all
        .find((g) => g.viewColumn === column)
        ?.tabs.find((t) => t.isPreview && t.input instanceof vscode.TabInputText);
    // 食わせられた（preview が本当にその列で開いた）ことを先に確かめる。開いていなければ
    // 「消えなかった」は空振りである。
    await waitFor(`列${from1}に preview のタブが開く`, () => previewIn(from1) !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(panelTabs(2).length, 1, "preview を開いたら枠2が消えた／増えた");
    assert.strictEqual(panelColumn(2), from1, "preview を開いたら枠2が動いた");
    assert.strictEqual(panelTab(2)?.isPreview, false, "preview を開いたら枠2が preview になった");
    assert.strictEqual(
      await measureDisplayedLength(2),
      len2,
      "preview を開いたら枠2の中身が変わった",
    );
    const previewTab = previewIn(from1);
    assert.ok(previewTab !== undefined, "preview のタブが消えた（前提）");
    await vscode.window.tabGroups.close(previewTab, true);

    // slot 省略 → 枠1。新しい列へ（枠2は残る）。
    const target1 = vscode.window.tabGroups.all.length + 1;
    const moved1 = await arrangeEditors("move-panel", { toColumn: target1 });
    assert.deepStrictEqual(moved1, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved1));
    await waitFor(
      "枠1が新しい列に移り、枠2は元の列に残る",
      () =>
        panelTabs(1).length === 1 &&
        panelTabs(2).length === 1 &&
        panelColumn(1) === target1 &&
        panelColumn(2) === from1,
    );
    assert.strictEqual(panelTab(1)?.isPreview, false, "move-panel で動かした枠1が preview");
    assert.ok((panelColumn(1) ?? 0) > 1 && (panelColumn(2) ?? 0) > 1, "パネルが人間の列に居る");
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, 1, "人間の列が変わった");
    assert.strictEqual(await measureDisplayedLength(1), len1, "動かした枠1の中身が変わった");

    // 出ていない枠 3 は**別の枠を代わりに動かさない**（`moved: 0`。D80 で 3 はスキーマを通る ――
    // 上限の判定は `show_html` の側で、`move-panel` は在るものを動かすだけ）。
    const none = await arrangeEditors("move-panel", { toColumn: 2, slot: 3 });
    assert.deepStrictEqual(none, { done: true, closed: 0, moved: 0 }, JSON.stringify(none));
    assert.strictEqual(panelColumn(1), target1, "slot: 3 で枠1が動いた");
    assert.strictEqual(panelColumn(2), from1, "slot: 3 で枠2が動いた");
    // 0 は線の形で落ちる。
    await assert.rejects(
      async () => arrangeEditors("move-panel", { toColumn: 2, slot: 0 }),
      (e: unknown) => String(e).includes("slot"),
      "slot: 0 が通った",
    );
    // `slot` は `move-panel` 以外に付けたら invalid-request。
    await assert.rejects(
      async () => arrangeEditors("close-own", { slot: 2 }),
      (e: unknown) => String(e).includes("slot"),
      "close-own に slot が通った",
    );
    assert.strictEqual(panelTabCount(), 2, "落ちたのに閉じた");
  });

  test("path 由来の枠を動かすと、中身は関門を通して読み直され、見張りも生きている（保存で描き直る）", async () => {
    await humanLooksAtSample();
    // 元の列（列2）を人間のタブで開けたままにする。パネルが1枚だけの列は、動かすと空になって
    // VS Code が閉じ、新しいパネルが元の番号に繰り上がる（D59「呼んだあと読み直す」）――
    // それでは「動いた」を列番号で言えない。
    await keepColumnOpenWithNotes(2);
    fs.writeFileSync(liveFile(), `<p>v1</p><ul>${"<li>動かす前</li>".repeat(20)}</ul>`, "utf8");
    await showHtml({ path: LIVE_REL, slot: 1 });
    await waitFor("パネルが開く", () => panelTab(1) !== undefined);
    const before = await measureDisplayedLength(1);
    assert.ok(before > 0, `初回が空（${before}）`);
    assert.strictEqual(panelColumn(1), 2, "枠1が列2に開かない（前提）");

    const moved = await arrangeEditors("move-panel", { toColumn: 3 });
    assert.deepStrictEqual(moved, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved));
    await waitFor(
      "枠1が列3に動き、タブは1枚",
      () => panelTabs(1).length === 1 && panelColumn(1) === 3,
    );
    assert.strictEqual(panelTab(1)?.isPreview, false, "動かした枠1が preview");
    // 作り直した直後の中身は、同じファイルを関門とサニタイザに通し直したもの（同じ長さ）。
    assert.strictEqual(await measureDisplayedLength(1), before, "動かした直後の中身が違う");

    // **見張りは生きている。** 保存で描き直る（長さが伸びる）。
    fs.writeFileSync(
      liveFile(),
      `<p>v2</p><ul>${"<li>動かした後に育てた</li>".repeat(60)}</ul>`,
      "utf8",
    );
    await waitFor(
      "動かした後も保存で描き直る",
      async () => (await measureDisplayedLength(1)) > before,
    );
    assert.strictEqual(panelTabs(1).length, 1, "描き直しでタブが増えた");
    assert.strictEqual(panelColumn(1), 3, "描き直しで動いた");
  });

  test("gather-own は別々の列に散った両枠を集め、両方 pinned で残る（moved: 2。中身も同じ）", async () => {
    await humanLooksAtSample();
    // 集め先（舞台の1列目 ＝ 列2）を、人間のタブで**開けたまま**にする（空になると閉じて
    // 番号が繰り上がり、「両枠とも集め先の外」の前提が組めない）。own ではないので集められない。
    await keepColumnOpenWithNotes(2);
    await showHtml({ html: `<p>${"集める1".repeat(10)}</p>`, title: "集める1", slot: 1 });
    await waitFor("枠1が開く", () => panelTab(1) !== undefined);
    // 枠1を列3へ、枠2を出してから列4へ（両方を集め先の外に散らす）。
    let r = await arrangeEditors("move-panel", { toColumn: 3, slot: 1 });
    assert.strictEqual(r.moved, 1, `枠1を列3に置けない: ${JSON.stringify(r)}`);
    await waitFor("枠1が列3", () => panelColumn(1) === 3 && panelTabs(1).length === 1);
    await showHtml({ html: `<p>${"集める2".repeat(40)}</p>`, title: "集める2", slot: 2 });
    await waitFor("枠2が開く", () => panelTab(2) !== undefined);
    if (panelColumn(2) !== 4) {
      r = await arrangeEditors("move-panel", { toColumn: 4, slot: 2 });
      assert.strictEqual(r.moved, 1, `枠2を列4に置けない: ${JSON.stringify(r)}`);
    }
    await waitFor("枠2が列4", () => panelColumn(2) === 4 && panelTabs(2).length === 1);
    // **前提: 両枠とも集め先（列2）の外の、別々の列に居る。人間は列1。**
    assert.strictEqual(panelColumn(1), 3, "枠1が列3に居ない（前提）");
    assert.strictEqual(panelColumn(2), 4, "枠2が列4に居ない（前提）");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間が列1に居ない（前提）",
    );
    const len1 = await measureDisplayedLength(1);
    const len2 = await measureDisplayedLength(2);
    assert.ok(len1 > 0 && len2 > 0 && len1 !== len2, `前提: 2枚の中身が違う（${len1} / ${len2}）`);

    // 実測では、先に動かした枠が preview になり、後の移動で消えた（`moved: 2` と言いながら）。
    const result = await arrangeEditors("gather-own");
    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 2 }, JSON.stringify(result));
    await waitFor(
      "両枠が列2に集まり、空いた列が閉じる",
      () =>
        panelTabs(1).length === 1 &&
        panelTabs(2).length === 1 &&
        panelColumn(1) === 2 &&
        panelColumn(2) === 2 &&
        vscode.window.tabGroups.all.length === 2,
    );
    assert.strictEqual(panelTab(1)?.isPreview, false, "集めた枠1が preview");
    assert.strictEqual(panelTab(2)?.isPreview, false, "集めた枠2が preview");
    assert.strictEqual(await measureDisplayedLength(1), len1, "集めた枠1の中身が変わった");
    assert.strictEqual(await measureDisplayedLength(2), len2, "集めた枠2の中身が変わった");
    // 人間の列は無傷。
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, 1, "人間の列が変わった");
    assert.deepStrictEqual(
      vscode.window.tabGroups.all.find((g) => g.viewColumn === 1)?.tabs.map((t) => t.label),
      [path.basename(SAMPLE_REL)],
      "人間の列に何かが流れ込んだ、または消えた",
    );
  });

  test("枠2の既定の置き場は舞台の2列目: 人間が列1なら枠1は列2、枠2は列3", async () => {
    await humanLooksAtSample();
    await showHtml({ html: "<p>1</p>", slot: 1 });
    await waitFor("枠1が開く", () => panelTab(1) !== undefined);
    await showHtml({ html: "<p>2</p>", slot: 2 });
    await waitFor("枠2が開く", () => panelTab(2) !== undefined);
    await waitFor("列が3つになる", () => vscode.window.tabGroups.all.length === 3);
    const groups = layoutGroups(await getEditorState());
    const columnOfSlot = (slot: number) =>
      groups.find((g) =>
        g.tabs.some((t) => t.kind === "webview" && t.own === true && t.slot === slot),
      )?.viewColumn;
    assert.strictEqual(columnOfSlot(1), 2, `枠1が列2に無い: ${JSON.stringify(groups)}`);
    assert.strictEqual(columnOfSlot(2), 3, `枠2が列3に無い: ${JSON.stringify(groups)}`);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, 1, "人間の列が変わった");
    // 舞台は上限2列のまま（人間1 ＋ 舞台2）。
    assert.strictEqual(vscode.window.tabGroups.all.length, 3, "列が3つでない");
  });

  test("path の見張りは枠ごと: 枠1のファイルを書き換えると枠1だけ描き直る（C4 × D61）", async () => {
    fs.writeFileSync(liveFile(), "<p>v1</p>", "utf8");
    await showHtml({ path: LIVE_REL, slot: 1 });
    await showHtml({ html: "<p>inline</p>", slot: 2 });
    await waitFor("2枚になる", () => panelTabCount() === 2);
    const first1 = await measureDisplayedLength(1);
    const first2 = await measureDisplayedLength(2);
    assert.ok(first1 > 0, `枠1の初回が空（${first1}）`);
    assert.ok(first2 > 0, `枠2の初回が空（${first2}）`);

    fs.writeFileSync(
      liveFile(),
      `<p>v2</p><ul>${"<li>育てた図の1行</li>".repeat(40)}</ul>`,
      "utf8",
    );
    await waitFor("枠1が保存で描き直る", async () => (await measureDisplayedLength(1)) > first1);
    // 枠2はそのまま（描き直りが起きないことを、待ちながら見る）。
    await assertLengthStays(2, first2, "枠1のファイルの保存");

    // 逆向きの対照: 枠2を path にして枠1を html にしたら、枠2だけが描き直る。
    await showHtml({ html: "<p>inline now</p>", slot: 1 });
    await showHtml({ path: LIVE_REL, slot: 2 });
    const before1 = await measureDisplayedLength(1);
    const before2 = await measureDisplayedLength(2);
    fs.writeFileSync(liveFile(), `<p>v3</p><ul>${"<li>さらに育てた</li>".repeat(80)}</ul>`, "utf8");
    await waitFor("枠2が保存で描き直る", async () => (await measureDisplayedLength(2)) > before2);
    // 枠1の見張りは `html` で出し直したときに止まっている。
    await assertLengthStays(1, before1, "枠2のファイルの保存");
  });
});

/**
 * 上限は人間の設定 `showme.html.maxPanels`（増分6.2 D80）。
 *
 * 単体は表（max × slot）を見ているが、**VS Code が3枚目以降の webview を別のタブとして持ち、
 * `showme.view.N` から枠が読め、`move-panel` / `close-own` が枚数に追随するか**は実機でしか
 * 分からない。設定は global に書き、`finally` で必ず戻す（次の検査に漏らさない）。
 */
suite("show_html の上限は人間の設定（D80）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("パネルが無い状態から始める", () => panelTabCount() === 0);
    assertGlobal("html.maxPanels", undefined);
  });

  teardown(async () => {
    await setGlobal("html.maxPanels", undefined);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("max 5: 5枚目まで出て6枚目が上限を言って断られ、get_editor_state の slot は 1〜5、move-panel { slot: 3 } が動き、close-own で5枚とも消える", async () => {
    await humanLooksAtSample();
    await setGlobal("html.maxPanels", 5);
    try {
      assertGlobal("html.maxPanels", 5);
      assert.deepStrictEqual((await listWorkspaces()).panels, { max: 5 });

      for (let slot = 1; slot <= 5; slot++) {
        await showHtml({ html: `<p>${"枚".repeat(slot * 10)}</p>`, title: `枚${slot}`, slot });
      }
      await waitFor("5枚のパネルが開く", () => panelTabCount() === 5);
      // **実機の `viewType` を完全一致で記録する**（枠3以降が `showme.view.N` になっているか）。
      for (let slot = 3; slot <= 5; slot++) {
        const input = panelTab(slot)?.input;
        assert.ok(input instanceof vscode.TabInputWebview, `枠${slot}が TabInputWebview でない`);
        assert.strictEqual(input.viewType, `mainThreadWebview-showme.view.${slot}`);
      }
      const own = await ownWebviews();
      assert.deepStrictEqual(
        own.map((t) => [t.slot, t.label]),
        [
          [1, "ShowMe: 枚1"],
          [2, "ShowMe: 枚2"],
          [3, "ShowMe: 枚3"],
          [4, "ShowMe: 枚4"],
          [5, "ShowMe: 枚5"],
        ],
        `slot と題の対応が違う: ${JSON.stringify(own)}`,
      );
      // 中身も枠ごとに届いている（3枚目以降が「タブはあるが空」でない）。
      for (let slot = 3; slot <= 5; slot++) {
        assert.ok((await measureDisplayedLength(slot)) > 0, `枠${slot}が空`);
      }
      // 舞台は上限2列のまま（人間1 ＋ 舞台2。枚数が増えても列は増えない。不変条件10）。
      assert.ok(vscode.window.tabGroups.all.length <= 3, "パネルの枚数で列が増えた");
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.viewColumn,
        1,
        "人間の列が変わった",
      );

      // 6枚目は断られ、文言が上限を言う。パネルは増えない。
      await assert.rejects(
        async () => showHtml({ html: "<p>6</p>", slot: 6 }),
        (e: unknown) => String(e).includes("slot 6 exceeds showme.html.maxPanels (5)"),
        "slot: 6 が通った、または断りが上限を言わない",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(panelTabCount(), 5, "断ったのにパネルが増えた／減った");

      // `move-panel { slot: 3 }` は枠3だけを動かす（枠3の実体が `Map` にあり、面が枠を読める）。
      const from3 = panelColumn(3);
      assert.ok(typeof from3 === "number" && from3 > 1, `枠3が人間の列に開いた: ${String(from3)}`);
      const target = vscode.window.tabGroups.all.length + 1;
      const columnsBefore = new Map([1, 2, 4, 5].map((n) => [n, panelColumn(n)]));
      const moved = await arrangeEditors("move-panel", { toColumn: target, slot: 3 });
      assert.deepStrictEqual(moved, { done: true, closed: 0, moved: 1 }, JSON.stringify(moved));
      await waitFor(
        `枠3が列${target}に移り、タブは1枚`,
        () => panelTabs(3).length === 1 && panelColumn(3) === target,
      );
      assert.strictEqual(panelTab(3)?.isPreview, false, "動かした枠3が preview");
      for (const [n, column] of columnsBefore) {
        assert.strictEqual(panelColumn(n), column, `枠${n}まで動いた`);
      }
      assert.strictEqual(panelTabCount(), 5, "動かしたら枚数が変わった");

      // `close-own` は5枚とも閉じる。
      const viewing = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        viewing === undefined || !allPanelTabs().includes(viewing),
        "人間がパネルを見ている（前提）",
      );
      const closed = await arrangeEditors("close-own");
      assert.deepStrictEqual(closed, { done: true, closed: 5 }, JSON.stringify(closed));
      await waitFor("5枚とも消える", () => panelTabCount() === 0);
      assert.strictEqual((await ownWebviews()).length, 0);
    } finally {
      await setGlobal("html.maxPanels", undefined);
    }
    // 戻したら戻る（設定を毎回読み直している）。
    assert.deepStrictEqual((await listWorkspaces()).panels, { max: 2 });
    await assert.rejects(
      async () => showHtml({ html: "<p>3</p>", slot: 3 }),
      (e: unknown) => String(e).includes("slot 3 exceeds showme.html.maxPanels (2)"),
      "設定を戻したのに 3 が通った",
    );
  });

  /**
   * 設定は整数で `0` が無制限（設定画面に入力欄を出すため）。線上の語彙は `"unlimited"` の
   * まま ―― 設定の `0` を `"unlimited"` に畳むのは `panelLimitOr` 1箇所で、ここは
   * **本物の `inspect()` を通った `0` が線で `"unlimited"` になる**ことを実機で見る。
   */
  test("0（無制限）: 10枚出る（own の webview が10枚）。list_workspaces.panels.max は unlimited。close-own で全部消える", async () => {
    await humanLooksAtSample();
    await setGlobal("html.maxPanels", 0);
    try {
      assertGlobal("html.maxPanels", 0);
      assert.deepStrictEqual((await listWorkspaces()).panels, { max: "unlimited" });
      for (let slot = 1; slot <= 10; slot++) {
        await showHtml({ html: `<p>${slot}</p>`, title: `無制限${slot}`, slot });
      }
      await waitFor("10枚のパネルが開く", () => panelTabCount() === 10, 20_000);
      const own = await ownWebviews();
      assert.deepStrictEqual(
        own.map((t) => t.slot),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        `own の webview の slot: ${JSON.stringify(own)}`,
      );
      assert.strictEqual(panelTab(10)?.label, "ShowMe: 無制限10");
      assert.ok((await measureDisplayedLength(10)) > 0, "枠10が空");
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.viewColumn,
        1,
        "人間の列が変わった",
      );

      const closed = await arrangeEditors("close-own");
      assert.deepStrictEqual(closed, { done: true, closed: 10 }, JSON.stringify(closed));
      await waitFor("10枚とも消える", () => panelTabCount() === 0, 20_000);
    } finally {
      await setGlobal("html.maxPanels", undefined);
    }
    assert.deepStrictEqual((await listWorkspaces()).panels, { max: 2 });
  });

  test("max 1: 2枚目が断られる（既定より狭める向きも効く）", async () => {
    await setGlobal("html.maxPanels", 1);
    try {
      assertGlobal("html.maxPanels", 1);
      assert.deepStrictEqual((await listWorkspaces()).panels, { max: 1 });
      await showHtml({ html: "<p>1</p>", slot: 1 });
      await waitFor("枠1が開く", () => panelTab(1) !== undefined);
      await assert.rejects(
        async () => showHtml({ html: "<p>2</p>", slot: 2 }),
        (e: unknown) => String(e).includes("slot 2 exceeds showme.html.maxPanels (1)"),
        "slot: 2 が通った",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(panelTabCount(), 1, "断ったのにパネルが増えた");
    } finally {
      await setGlobal("html.maxPanels", undefined);
    }
  });

  /**
   * **ワークスペースの `.vscode/settings.json` では上限を広げられない**（不変条件9 / C4' と同じ形）。
   *
   * 上限は人間の作業面を守る量なので、広げてよいと言えるのは人間だけ。global を 2 にしてから
   * ワークスペースに `0`（無制限）を置き、それでも3枚目が断られることを実機で見る。
   * 対照に `editor.tabSize` を同じファイルに入れてある ―― これが効いていなければ、
   * 「断られた」のは設定ファイルが**そもそも読まれていない**からになる（空振りの緑）。
   */
  test("ワークスペースの設定ファイルに html.maxPanels: 0（無制限）があっても global の 2 が勝つ（C4'）", async () => {
    const settingsUri = vscode.Uri.joinPath(workspaceRoot(), ".vscode/settings.json");
    try {
      await setGlobal("html.maxPanels", 2);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), ".vscode"));
      await vscode.workspace.fs.writeFile(
        settingsUri,
        Buffer.from(
          `${JSON.stringify({ "editor.tabSize": 3, "showme.html.maxPanels": 0 }, null, 2)}\n`,
          "utf8",
        ),
      );
      await waitFor(
        "ワークスペースの設定ファイルが読まれる",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          3,
      );
      assertGlobal("html.maxPanels", 2);
      const r = await listWorkspaces();
      assert.deepStrictEqual(
        r.panels,
        { max: 2 },
        `ワークスペースの設定ファイルが上限を広げた: ${JSON.stringify(r)}`,
      );
      await showHtml({ html: "<p>1</p>", slot: 1 });
      await showHtml({ html: "<p>2</p>", slot: 2 });
      await waitFor("2枚になる", () => panelTabCount() === 2);
      await assert.rejects(
        async () => showHtml({ html: "<p>3</p>", slot: 3 }),
        (e: unknown) => String(e).includes("slot 3 exceeds showme.html.maxPanels (2)"),
        "ワークスペースの設定で3枚目が通った（読ませている repo が上限を広げられる）",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(panelTabCount(), 2, "断ったのにパネルが増えた");
    } finally {
      await setGlobal("html.maxPanels", undefined);
      // 書けていなくても消せるように（無ければ何もしない）。
      await vscode.workspace.fs.delete(settingsUri, { useTrash: false }).then(undefined, () => {});
      await waitFor(
        "ワークスペースの設定ファイルが消える",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          undefined,
      );
    }
    assertGlobal("html.maxPanels", undefined);
    assert.deepStrictEqual((await listWorkspaces()).panels, { max: 2 });
  });
});
