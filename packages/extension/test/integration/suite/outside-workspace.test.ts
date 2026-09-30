import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  STAGE_SCHEME_READONLY,
  type VisualState,
  activateExtension,
  annotate,
  annotateClear,
  arrangeEditors,
  getEditorState,
  inspectVisuals,
  layoutTabs,
  lendWindow,
  listWorkspaces,
  pinDedicatedStage,
  showOne,
  stageUri,
  visibleEditorFor,
  waitFor,
  withSettings,
} from "./helpers.js";

/**
 * ワークスペースの外のファイル（D101 / D102）を実機で確かめる。
 *
 * - 設定 `showme.allowOutsideWorkspace` がオフなら、外の絶対パスは今までどおり `invalid-path`
 * - オンなら外の一時ファイルがエージェントのタブ（外の映し `showme-ro://outside/…`）で開き、
 *   own の印が付き、塗りと吹き出しが同じ URI に付く。`realFile: true` なら本物の `file:` で開く
 * - 資格情報の置き場所（テストを走らせているプロセスの本物のホームの `~/.ssh` の下の、**無い**
 *   ファイル）はオンでも `excluded-path`。何も作らない
 * - 設定をオフに戻すと、開いている外の映しはもう読めない
 *
 * 制限モードの回は主要な2本（オフで断る・オンで開く）だけを走らせる。
 */

const MARKER = "OUTSIDE_MARKER_D102";
const trusted = process.env.SHOWME_TEST_MODE !== "restricted";

/** 塗りが付いている URI（塗るのは注釈だけ。増分13 D116。無印の注釈は灰で塗る）。 */
function paintedUris(visuals: VisualState): string[] {
  return visuals.highlightRanges.map((r) => r.uri);
}

function textTabUris(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []));
}

suite("ワークスペースの外のファイル（D101 / D102）", () => {
  pinDedicatedStage();
  let dir: string;
  let file: string;

  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
    // 外のパスの鍵（`normalizedPath`・`openPaths`・映しの URI）は、Windows ではドライブ文字を小文字に
    // 揃えた綴りである（`normalizeAbsolutePath`。VS Code の URI と同じ）。`TEMP` は `D:\…` で来るので、
    // 期待値もその鍵の綴りで持つ（大文字のままだと、同じ実体なのに文字列が一致しない）。
    const real = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "showme-outside-it-")),
    );
    dir =
      process.platform === "win32" && /^[A-Za-z]:\\/.test(real)
        ? real.charAt(0).toLowerCase() + real.slice(1)
        : real;
    file = path.join(dir, "outside.ts");
    fs.writeFileSync(file, `export const a = 1;\n// ${MARKER}\nexport const b = 2;\n`);
    fs.writeFileSync(
      path.join(dir, "lib.ts"),
      "export function outsideHelperD102(): number {\n  return 1;\n}\n",
    );
    fs.writeFileSync(
      path.join(dir, "use.ts"),
      'import { outsideHelperD102 } from "./lib";\nexport const v = outsideHelperD102();\n',
    );
  });

  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await annotateClear();
  });

  teardown(async () => {
    await annotateClear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  test("設定がオフなら外の絶対パスは invalid-path で、何も開かない", async () => {
    const lw = await listWorkspaces();
    assert.strictEqual((lw as Record<string, unknown>).outsideWorkspace, false);
    const resolution = await showOne({ path: file, text: MARKER });
    assert.strictEqual(resolution.reason, "invalid-path", JSON.stringify(resolution));
    assert.strictEqual(resolution.normalizedPath, undefined);
    assert.deepStrictEqual(textTabUris(), []);
  });

  test("オンなら外のファイルがエージェントのタブで開き、塗りと吹き出しが同じ URI に付く", async () => {
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      const lw = await listWorkspaces();
      assert.strictEqual((lw as Record<string, unknown>).outsideWorkspace, true);
      const mirror = await stageUri(file, STAGE_SCHEME_READONLY);
      assert.strictEqual(mirror.authority, "outside", mirror.toString());

      const resolution = await showOne({ path: file, text: MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
      assert.strictEqual(resolution.normalizedPath, file);
      await waitFor("外の映しの編集器が見える", () => visibleEditorFor(mirror) !== undefined);
      const editor = visibleEditorFor(mirror);
      assert.ok(editor?.document.getText().includes(MARKER), "外の映しの中身が読めていない");

      const decoration = await vscode.commands.executeCommand("showme.test.agentTabDecoration", {
        scheme: mirror.scheme,
        authority: mirror.authority,
        path: mirror.path,
      });
      assert.strictEqual((decoration as { badge?: unknown } | undefined)?.badge, "SM");

      const [annotated] = await annotate([
        { location: { path: file, text: MARKER }, text: "outside" },
      ]);
      assert.ok(annotated && typeof annotated.id === "number", JSON.stringify(annotated));
      const visuals = await inspectVisuals();
      assert.deepStrictEqual(paintedUris(visuals), [mirror.toString()]);
      assert.deepStrictEqual(visuals.annotatedUris, [mirror.toString()]);
    });
  });

  if (!trusted) return;

  test("get_editor_state: オンなら外の映しのタブを絶対パスで名指し、オフなら (outside workspace)", async () => {
    let mirror: vscode.Uri | undefined;
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      mirror = await stageUri(file, STAGE_SCHEME_READONLY);
      const resolution = await showOne({ path: file, text: MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
      const m = mirror;
      await waitFor("外の映しの編集器が見える", () => visibleEditorFor(m) !== undefined);
      const state = await getEditorState();
      assert.ok((state.openPaths as string[]).includes(file), JSON.stringify(state.openPaths));
      const tab = layoutTabs(state).find((t) => t.path === file);
      assert.ok(tab, JSON.stringify(layoutTabs(state)));
      assert.strictEqual(tab.own, true);
      assert.strictEqual(tab.label, "outside.ts");
    });
    // オフに戻した後は、開いている外の映しのタブをパスで名指さない（`openPaths` にも載らない）。
    // 見出しは own のタブなので出る（own の見出しはエージェント自身が開いたもの。D41 の規則のまま）。
    const state = await getEditorState();
    assert.ok(!(state.openPaths as string[]).includes(file), JSON.stringify(state.openPaths));
    const tabs = layoutTabs(state);
    assert.ok(
      tabs.some((t) => t.own === true && t.path === undefined),
      JSON.stringify(tabs),
    );
    assert.ok(
      tabs.every((t) => t.path !== file && t.visibleLines === undefined),
      JSON.stringify(tabs),
    );
  });

  test("arrange_editors close-tabs: 外の自分のタブを絶対パスで閉じる（オフなら invalid-path で断る）", async () => {
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      const mirror = await stageUri(file, STAGE_SCHEME_READONLY);
      await showOne({ path: file, text: MARKER });
      await waitFor("外の映しの編集器が見える", () => visibleEditorFor(mirror) !== undefined);
      const result = await arrangeEditors("close-tabs", { paths: [file] });
      assert.strictEqual(result.closed, 1, JSON.stringify(result));
      await waitFor("外の映しのタブが閉じる", () => !textTabUris().includes(mirror.toString()));
    });
    await assert.rejects(
      async () => arrangeEditors("close-tabs", { paths: [file] }),
      (e: unknown) => String((e as { code?: unknown }).code ?? e).includes("invalid-path"),
    );
  });

  test("find_definition: 外のファイルから引いた定義が、関門を通る外の絶対パスで返る（引ければ）", async () => {
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      const result = (await vscode.commands.executeCommand("showme.test.findDefinition", {
        location: { path: path.join(dir, "use.ts"), text: "outsideHelperD102()" },
      })) as { match?: unknown; reason?: unknown; locations?: Array<{ path?: unknown }> };
      assert.ok(["none", "one", "many"].includes(String(result.match)), JSON.stringify(result));
      // TS が外の単独のファイルを解決できるかは環境に依る。引けたなら、返る場所は外の絶対パス。
      for (const loc of result.locations ?? []) {
        assert.ok(
          typeof loc.path === "string" && path.isAbsolute(loc.path),
          `外の結果が絶対パスでない: ${JSON.stringify(result)}`,
        );
      }
      if (result.match === "one") {
        assert.deepStrictEqual(
          result.locations?.map((l) => l.path),
          [path.join(dir, "lib.ts")],
          JSON.stringify(result),
        );
      }
    });
  });

  test("show_html の path はオンでもワークスペースの中だけ（外の HTML は読まない）", async () => {
    const html = path.join(dir, "page.html");
    fs.writeFileSync(html, "<p>outside page</p>\n");
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      await assert.rejects(
        async () => vscode.commands.executeCommand("showme.test.showHtml", { path: html }),
        (e: unknown) => String((e as { code?: unknown }).code ?? e).includes("excluded-path"),
      );
    });
  });

  test("ステータスバー: オンの間は印と警告色、オフなら無し", async () => {
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      await waitFor(
        "警告の印が出る",
        async () => (await inspectVisuals()).statusBar.warning === true,
      );
      const on = (await inspectVisuals()).statusBar;
      assert.ok(on.text.includes("$(warning)"), on.text);
      assert.ok(on.tooltip.includes("showme.allowOutsideWorkspace"), on.tooltip);
    });
    await waitFor(
      "警告の印が消える",
      async () => (await inspectVisuals()).statusBar.warning === false,
    );
    const off = (await inspectVisuals()).statusBar;
    assert.ok(!off.text.includes("$(warning)"), off.text);
  });

  test("realFile: true なら外のファイルを本物の file: で開く", async () => {
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      const raw = (await vscode.commands.executeCommand("showme.test.showCode", {
        locations: [{ path: file, text: MARKER }],
        realFile: true,
      })) as { resolutions?: Array<Record<string, unknown>> };
      const [resolution] = raw.resolutions ?? [];
      assert.strictEqual(resolution?.match, "one", JSON.stringify(raw));
      const real = vscode.Uri.file(file);
      await waitFor("本物の file: の編集器が見える", () => visibleEditorFor(real) !== undefined);
      const mirror = await stageUri(file, STAGE_SCHEME_READONLY);
      assert.ok(!textTabUris().includes(mirror.toString()), "realFile なのに映しで開いた");
    });
  });

  test("資格情報の置き場所は、オンでも（無いファイルでも）excluded-path。何も作らない", async () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const target = path.join(sshDir, "showme-test-nonexistent");
    const sshExisted = fs.existsSync(sshDir);
    assert.strictEqual(fs.existsSync(target), false, "前提: そのファイルは無い");
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      const resolution = await showOne({ path: target, text: "x" });
      assert.strictEqual(resolution.reason, "excluded-path", JSON.stringify(resolution));
      assert.deepStrictEqual(textTabUris(), []);
    });
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(sshDir), sshExisted);
  });

  test("設定をオフに戻すと、開いている外の映しはもう読めない", async () => {
    let mirror: vscode.Uri | undefined;
    await withSettings({ allowOutsideWorkspace: true }, async () => {
      mirror = await stageUri(file, STAGE_SCHEME_READONLY);
      const resolution = await showOne({ path: file, text: MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
      const bytes = await vscode.workspace.fs.readFile(mirror);
      assert.ok(Buffer.from(bytes).toString("utf8").includes(MARKER));
    });
    assert.ok(mirror);
    const target = mirror;
    await assert.rejects(
      async () => vscode.workspace.fs.readFile(target),
      (e: unknown) => (e as { code?: unknown }).code === "FileNotFound",
    );
    await assert.rejects(
      async () => vscode.workspace.fs.stat(target),
      (e: unknown) => (e as { code?: unknown }).code === "FileNotFound",
    );
  });
});
