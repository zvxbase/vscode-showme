import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { ENV_REL, LANG_DEF_REL, LANG_POSITIONS, LANG_USE_REL } from "../fixture.js";
import {
  type LocationResult,
  STAGE_SCHEME_EDITABLE,
  STAGE_SCHEME_READONLY,
  type StageScheme,
  activateExtension,
  describeLocation,
  goToDefinitionFrom,
  stageUri,
  waitFor,
  withSettings,
} from "./helpers.js";

/**
 * エージェントのタブ（映し）で「定義へ移動」「参照」が効く（設計 D88 / B3）。
 *
 * 拡張の代理は、映しと同じ位置を `file:` に聞き、**別のファイル**の結果だけを
 * `showme.stage.definitionTarget` に従って写す（`file` → `file:`、`agentTab` → いまの設定で `show_code` が
 * 開くのと同じスキーム）。
 * 同じファイルの結果は TS が映しの上で答えるので返さない ―― VS Code は同じ定義を畳まず、返すと
 * F12 が飛ばずに覗き見になる（B3 の実測。`stage-language-measure.test.ts`）。
 *
 * 別のファイルから import した名前は定義が2件（TS が答える映しの import の行と、代理が返す本当の
 * 定義）になり、F12 は覗き見になる。代理からは TS の答えを消せない（B3）。
 *
 * **両方の回で走らせる。** 制限モードでは TS が動かないので、代理は何も返さず、例外にもならない
 * ことだけを見る。
 */

const imported = new vscode.Position(
  LANG_POSITIONS.importedCall.line,
  LANG_POSITIONS.importedCall.character,
);
const local = new vscode.Position(
  LANG_POSITIONS.localCall.line,
  LANG_POSITIONS.localCall.character,
);

async function definitions(uri: vscode.Uri, pos: vscode.Position): Promise<string[]> {
  const r = await vscode.commands.executeCommand<LocationResult[]>(
    "vscode.executeDefinitionProvider",
    uri,
    pos,
  );
  return (r ?? []).map(describeLocation).sort();
}

async function references(uri: vscode.Uri, pos: vscode.Position): Promise<string[]> {
  const r = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    pos,
  );
  return (r ?? []).map(describeLocation).sort();
}

/**
 * 拡張の代理**だけ**の答え（`showme.test.stageLanguage`。登録したのと同じインスタンスを呼ぶ）。
 * 開けない映しの URI（関門に落ちるもの）でも、代理自身が何を返すかを見られる。
 */
async function delegateOnly(
  kind: "definition" | "references",
  uri: vscode.Uri,
  pos: vscode.Position,
): Promise<string[]> {
  const raw = await vscode.commands.executeCommand("showme.test.stageLanguage", {
    kind,
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    line: pos.line,
    character: pos.character,
  });
  assert.ok(Array.isArray(raw), `stageLanguage が配列を返さなかった: ${JSON.stringify(raw)}`);
  return (raw as { scheme: string; path: string; line: number; character: number }[])
    .map((r) => `${r.scheme}:${path.posix.basename(r.path)}@${r.line}:${r.character}`)
    .sort();
}

function noDuplicates(results: readonly string[], label: string): void {
  assert.strictEqual(new Set(results).size, results.length, `${label} に重複: ${results}`);
}

/** TS が映し（`lang/b.ts`）の上で答える参照（どの設定でも変わらない）。 */
const tsGreetRefs = (s: StageScheme) => [`${s}:b.ts@0:9`, `${s}:b.ts@4:21`, `${s}:b.ts@5:22`];
const tsLocalRefs = (s: StageScheme) => [`${s}:b.ts@1:9`, `${s}:b.ts@6:21`, `${s}:b.ts@6:31`];
const sorted = (xs: string[]) => [...xs].sort();

/** 信頼の回だけ・制限の回だけの検査（片方の回では登録しない。skip の数を件数に混ぜない）。 */
const trustedTest = (title: string, fn: Mocha.Func) => {
  if (vscode.workspace.isTrusted) test(title, fn);
};
const restrictedTest = (title: string, fn: Mocha.Func) => {
  if (!vscode.workspace.isTrusted) test(title, fn);
};

suite("エージェントのタブの定義・参照（D88）", () => {
  let mirror: vscode.Uri;
  let editableMirror: vscode.Uri;

  suiteSetup(async function () {
    this.timeout(150_000);
    await activateExtension();
    mirror = await stageUri(LANG_USE_REL, STAGE_SCHEME_READONLY);
    editableMirror = await stageUri(LANG_USE_REL, STAGE_SCHEME_EDITABLE);
    if (!vscode.workspace.isTrusted) return;
    const fileUri = await stageUri(LANG_USE_REL, "file");
    await vscode.workspace.openTextDocument(await stageUri(LANG_DEF_REL, "file"));
    await vscode.workspace.openTextDocument(fileUri);
    await vscode.workspace.openTextDocument(mirror);
    // TS が温まるまで待つ: file: で別ファイルの定義が出る、映しで同じファイルの定義が出る。
    await waitFor(
      "TS が file: で別ファイルの定義を返す",
      async () =>
        (
          (await vscode.commands.executeCommand<LocationResult[]>(
            "vscode.executeDefinitionProvider",
            fileUri,
            imported,
          )) ?? []
        ).some((t) => describeLocation(t).startsWith("file:a.ts@")),
      60_000,
    );
    await waitFor(
      "TS が映しで同じファイルの定義を返す",
      async () =>
        (
          (await vscode.commands.executeCommand<LocationResult[]>(
            "vscode.executeDefinitionProvider",
            mirror,
            local,
          )) ?? []
        ).length > 0,
      60_000,
    );
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  trustedTest(
    "既定（file）: 別のファイルの定義・参照は file:、同じファイルは TS の1件だけで F12 が飛ぶ",
    async function () {
      this.timeout(60_000);
      // 別のファイルの名前: import の行（TS）と本当の定義（代理、file:）の2件。
      assert.deepStrictEqual(
        await definitions(mirror, imported),
        sorted(["file:a.ts@0:16", `${STAGE_SCHEME_READONLY}:b.ts@0:9`]),
      );
      // 同じファイルの名前: TS の1件だけ（代理は返さない）。
      assert.deepStrictEqual(await definitions(mirror, local), [
        `${STAGE_SCHEME_READONLY}:b.ts@1:9`,
      ]);
      assert.strictEqual(
        await goToDefinitionFrom(mirror, local),
        `jump ${STAGE_SCHEME_READONLY}:b.ts@1:9`,
      );
      const greet = await references(mirror, imported);
      noDuplicates(greet, "refs(greet)");
      assert.deepStrictEqual(
        greet,
        sorted(["file:a.ts@0:16", ...tsGreetRefs(STAGE_SCHEME_READONLY)]),
      );
      const loc = await references(mirror, local);
      noDuplicates(loc, "refs(local)");
      assert.deepStrictEqual(loc, sorted(tsLocalRefs(STAGE_SCHEME_READONLY)));
    },
  );

  trustedTest(
    "agentTab: 別のファイルの定義・参照は映しのスキームに写り、同じファイルは1件のまま",
    async function () {
      this.timeout(60_000);
      await withSettings({ "stage.definitionTarget": "agentTab" }, async () => {
        assert.deepStrictEqual(
          await definitions(mirror, imported),
          sorted([`${STAGE_SCHEME_READONLY}:a.ts@0:16`, `${STAGE_SCHEME_READONLY}:b.ts@0:9`]),
        );
        assert.deepStrictEqual(await definitions(mirror, local), [
          `${STAGE_SCHEME_READONLY}:b.ts@1:9`,
        ]);
        assert.strictEqual(
          await goToDefinitionFrom(mirror, local),
          `jump ${STAGE_SCHEME_READONLY}:b.ts@1:9`,
        );
        const greet = await references(mirror, imported);
        noDuplicates(greet, "refs(greet)");
        assert.deepStrictEqual(
          greet,
          sorted([`${STAGE_SCHEME_READONLY}:a.ts@0:16`, ...tsGreetRefs(STAGE_SCHEME_READONLY)]),
        );
        const loc = await references(mirror, local);
        noDuplicates(loc, "refs(local)");
        assert.deepStrictEqual(loc, sorted(tsLocalRefs(STAGE_SCHEME_READONLY)));
        // 写す先のスキームは聞いた映しでなく、いまの設定の舞台のスキーム（`show_code` と同じ決め方）。
        // editable がオフなら、編集できる映しから聞いても読み取り専用の映しに写る。
        assert.deepStrictEqual(await delegateOnly("definition", editableMirror, imported), [
          `${STAGE_SCHEME_READONLY}:a.ts@0:16`,
        ]);
      });
      await withSettings(
        { "stage.definitionTarget": "agentTab", "stage.editable": true },
        async () => {
          // editable がオンなら、読み取り専用の映しから聞いても編集できる映しに写る。
          for (const from of [mirror, editableMirror]) {
            assert.deepStrictEqual(
              await delegateOnly("definition", from, imported),
              [`${STAGE_SCHEME_EDITABLE}:a.ts@0:16`],
              from.toString(),
            );
          }
        },
      );
      // 設定を戻せば file: に戻る（呼ばれるたびに読む）。
      assert.deepStrictEqual(await delegateOnly("definition", editableMirror, imported), [
        "file:a.ts@0:16",
      ]);
    },
  );

  trustedTest("関門に落ちる映し・結果は代理が返さない（秘匿・別綴り）", async function () {
    this.timeout(60_000);
    // 対照: 何も秘匿しなければ代理は別のファイルの定義・参照を返す。
    assert.deepStrictEqual(await delegateOnly("definition", mirror, imported), ["file:a.ts@0:16"]);
    assert.deepStrictEqual(await delegateOnly("references", mirror, imported), ["file:a.ts@0:16"]);
    // 聞いた映しそのものが秘匿: 聞きに行かない。
    await withSettings({ redactedPathPatterns: [LANG_USE_REL] }, async () => {
      assert.deepStrictEqual(await delegateOnly("definition", mirror, imported), []);
      assert.deepStrictEqual(await delegateOnly("references", mirror, imported), []);
    });
    // 結果の先が秘匿: どちらの行き先でも返さない（映しに写すかどうかで答えを割らない）。
    for (const target of ["file", "agentTab"] as const) {
      await withSettings(
        { redactedPathPatterns: [LANG_DEF_REL], "stage.definitionTarget": target },
        async () => {
          assert.deepStrictEqual(await delegateOnly("definition", mirror, imported), [], target);
          assert.deepStrictEqual(await delegateOnly("references", mirror, imported), [], target);
        },
      );
    }
    // 既定の秘匿（.env）と、別綴りの映し（authority 付き）。
    for (const crafted of [
      vscode.Uri.from({ scheme: STAGE_SCHEME_READONLY, path: `/${ENV_REL}` }),
      vscode.Uri.from({ scheme: STAGE_SCHEME_READONLY, authority: "x", path: `/${LANG_USE_REL}` }),
    ]) {
      assert.deepStrictEqual(
        await delegateOnly("definition", crafted, imported),
        [],
        crafted.toString(),
      );
      assert.deepStrictEqual(
        await delegateOnly("references", crafted, imported),
        [],
        crafted.toString(),
      );
    }
  });

  restrictedTest("制限モード: 代理は何も返さず、例外にもならない", async function () {
    this.timeout(30_000);
    for (const target of ["file", "agentTab"] as const) {
      await withSettings({ "stage.definitionTarget": target }, async () => {
        assert.deepStrictEqual(await delegateOnly("definition", mirror, imported), [], target);
        assert.deepStrictEqual(await delegateOnly("references", mirror, imported), [], target);
      });
    }
    await vscode.workspace.openTextDocument(mirror);
    // 画面の経路（VS Code が全プロバイダを集める）も例外にならず、代理の file: は混ざらない。
    for (const r of [
      ...(await definitions(mirror, imported)),
      ...(await references(mirror, imported)),
    ]) {
      assert.ok(!r.startsWith("file:"), `制限モードで代理が返した: ${r}`);
    }
  });
});
