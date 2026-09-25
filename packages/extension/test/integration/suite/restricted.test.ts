import * as assert from "node:assert";
import * as path from "node:path";
import { getEditorStateResultSchema } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import {
  DEEP_TEXT,
  ENV_REL,
  JSON_REL,
  JSON_SYMBOL,
  SAMPLE_REL,
  STAGE_MARKER,
  STAGE_RELS,
  TS_SYMBOL,
  outsideDirFor,
} from "../fixture.js";
import {
  WINDOW_OFF_MESSAGE,
  activateExtension,
  arrangeEditors,
  assertSocketIsListening,
  currentRole,
  getEditorState,
  layoutTabs,
  lendWindow,
  listWorkspaces,
  showCode,
  showOne,
  stageUri,
  toggleCallCount,
  visibleEditorFor,
  visibleEditorSnapshot,
  waitFor,
  withSettings,
  workspaceRoot,
} from "./helpers.js";

/**
 * 制限モード（untrusted workspace）の実 VS Code に対する検査。
 *
 * 設計書 A1 は「制限モードで動くことは仕様からの推定であり実機未確認」と
 * 書いていた。この節はその推定を実機で確定させるためにある。
 *
 * この回のウィンドウは `--disable-workspace-trust` **なし**・まっさらな
 * user-data-dir で開かれる。最初の test が `isTrusted === false` を確かめる
 * ので、何かの拍子に信頼済みで開いた回は「制限モードで通った」と言えない
 * ことがその場で分かる。
 */
suite("実 VS Code / 制限モード", () => {
  suiteSetup(async () => {
    await activateExtension();
    // 預けない。既定が「不可」であることは制限モードでも同じで、最初の
    // 数件がそれを見る。役割が要るテストは各 test で `lendWindow()` を呼ぶ。
  });

  test("このウィンドウは信頼されていない", () => {
    assert.strictEqual(
      vscode.workspace.isTrusted,
      false,
      "制限モードの回のはずが信頼済みで開かれている（この節の結論は制限モードの証拠にならない）",
    );
  });

  test("制限モードでも拡張が activate する", () => {
    const ext = vscode.extensions.getExtension("zvxbase.vscode-showme");
    assert.ok(ext, "拡張が見つからない");
    assert.strictEqual(ext.isActive, true, "制限モードで activate しなかった");
  });

  test("制限モードでもコマンドが登録されている", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "showme.toggle",
      "showme.disableExtension",
      "showme.showAgentConfig",
      "showme.showLog",
      "showme.teardown",
      "showme.clearHighlights",
      "showme.clearAnnotations",
      "showme.annotation.resolve",
      "showme.annotation.unresolve",
      "showme.annotation.next",
      "showme.annotation.previous",
    ]) {
      assert.ok(commands.includes(id), `コマンドが登録されていない: ${id}`);
    }
  });

  test("制限モードでもソケットが実際に立っている", () => {
    // activate が例外を投げないことと、ソケットが立っていることは別である。
    assertSocketIsListening();
  });

  /**
   * 既定は制限モードでも「不可」である（設計書 §2A.1）。
   *
   * 信頼モードと同じ検査を制限モードでも置く。信頼の有無で分岐する経路が
   * 増えるほど、片方だけ既定が緩む形の間違いが入りやすい ―― 実際
   * `capabilities` は信頼の有無で変わる。既定の拒否だけは変わらない。
   */
  test("制限モードでも既定では預けられておらず、show_code は拒否される", async () => {
    assert.strictEqual(
      toggleCallCount(),
      0,
      "ここまでに役割を触っている。この test は『既定の』振る舞いを見ていない（並び順を戻すこと）",
    );
    assert.strictEqual(currentRole(), "idle", "activate 直後の役割が idle でない");

    const before = visibleEditorSnapshot();
    // 舞台で開くなら出るはずの URI（既定は映し）。
    const uri = await stageUri(SAMPLE_REL);

    await assert.rejects(
      () => showCode([{ path: SAMPLE_REL, text: DEEP_TEXT }]),
      (e: unknown) => String(e).includes(WINDOW_OFF_MESSAGE),
      "預けていない窓で show_code が拒否されなかった",
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepStrictEqual(visibleEditorSnapshot(), before, "拒否したのに可視エディタが変わった");
    // `strictEqual` にすると失敗時に TextEditor をまるごと印字して読めなくなる。
    assert.ok(visibleEditorFor(uri) === undefined, "拒否したのに対象ファイルが開いた");
  });

  test("制限モードでも text 指定の show_code が動き、ファイルが開く", async () => {
    await lendWindow();
    const uri = await stageUri(SAMPLE_REL);
    const resolution = await showOne({ path: SAMPLE_REL, text: DEEP_TEXT });

    assert.strictEqual(resolution.match, "one", "制限モードで text 解決ができなかった");
    assert.strictEqual(resolution.resolvedBy, "text");
    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "range が無い");

    await waitFor("対象ファイルが可視エディタに現れる", () => visibleEditorFor(uri) !== undefined);
    const zeroBased = range.startLine - 1;
    await waitFor(`${range.startLine} 行目が可視範囲に入る`, () => {
      const editor = visibleEditorFor(uri);
      return (
        editor?.visibleRanges.some((r) => r.start.line <= zeroBased && zeroBased <= r.end.line) ===
        true
      );
    });
  });

  /**
   * 制限モードの `.ts` は `restricted-mode` を名乗る（設計書 §3.4 の表）。
   *
   * 増分1ではここが `no-provider` だった（provider を繋いでいなかった）。
   * 2B で繋いだので、**引き直したうえで**引けなかったことの理由が変わる。
   *
   * この検査だけでは足りない ―― `isTrusted ? "no-provider" : "restricted-mode"`
   * という、シンボルを一度も引かない1行でも通ってしまう。下の
   * 「`.json` は実際に解決される」と**対で**意味を持つ（設計書 §3.5）。
   */
  test("制限モードの .ts は restricted-mode を名乗る", async () => {
    await lendWindow();
    const resolution = await showOne({ path: SAMPLE_REL, symbol: TS_SYMBOL });
    assert.strictEqual(resolution.match, "none");
    assert.strictEqual(
      resolution.reason,
      "restricted-mode",
      "制限モードの .ts が restricted-mode を名乗っていない",
    );
    assert.strictEqual(resolution.resolvedBy, "symbol");
  });

  /**
   * **制限モードでも `.json` のシンボルは実際に解決される。**
   *
   * これが 2B の symbol 解決の判別器である:
   *
   *   - 引き直しを1回に減らすと、`.json` は1回目に `undefined` を返すので
   *     `no-provider` に落ちる（実測。設計書 §3.4 の警告）
   *   - `capabilities.symbolResolution` の false を根拠に symbol を拒む実装に
   *     しても落ちる（あの申告は**過小申告**である）
   */
  test("制限モードでも .json のシンボルは実際に解決され、その位置が開く", async () => {
    await lendWindow();
    const uri = await stageUri(JSON_REL);
    const resolution = await showOne({ path: JSON_REL, symbol: JSON_SYMBOL });

    assert.strictEqual(
      resolution.match,
      "one",
      `制限モードで .json のシンボルが解決されなかった（reason: ${String(resolution.reason)}）`,
    );
    assert.strictEqual(resolution.resolvedBy, "symbol");
    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "range が無い");
    // フィクスチャの最上位キーは2行目にある（1行目は "{"）。
    assert.strictEqual(range.startLine, 2, "解決された行がフィクスチャの実際の位置と違う");
    await waitFor("対象ファイルが可視エディタに現れる", () => visibleEditorFor(uri) !== undefined);
  });

  test("制限モードでも除外パスは解決されない", async () => {
    await lendWindow();
    const resolution = await showOne({ path: ENV_REL, text: "SECRET" });
    assert.strictEqual(resolution.match, "none");
    assert.strictEqual(resolution.reason, "excluded-path");
  });

  test("list_workspaces の capabilities.symbolResolution が false", async () => {
    await lendWindow();
    const result = await listWorkspaces();
    assert.strictEqual(result.isTrusted, false);

    const capabilities = result.capabilities as Record<string, unknown> | undefined;
    assert.ok(capabilities, "capabilities が無い");
    // **これは過小申告である**（設計書 §3.4）。同じ回の中で `.json` の
    // シンボルは実際に解決できている。単一の boolean では言語ごとの崖を
    // 表現できないので安全側に倒してあり、そのことは
    // `TOOL_DESCRIPTIONS.list_workspaces` に書いてエージェントに伝えている。
    assert.strictEqual(
      capabilities.symbolResolution,
      false,
      "制限モードで symbolResolution が true になっている",
    );
    // 制限モードでは環境変数の注入も提供しない（package.json の説明と一致すること）。
    assert.strictEqual(capabilities.terminalEnvInjection, false);

    // ファイルの中身も、他のウィンドウの列挙も返さない。
    assert.strictEqual(result.otherWindowsListed, false);
    const bound = result.boundWorkspace as Record<string, unknown> | undefined;
    assert.ok(bound, "boundWorkspace が無い");
    assert.strictEqual(typeof bound.path, "string");
  });

  /**
   * **制限モードでも自分にできることは読める**（D56）。
   *
   * `capabilities` は信頼の有無で縮退するが、`permissions` / `disabledTools` /
   * `editorGroup` は設定を写すだけで、信頼とは無関係である。制限モードで
   * 欄が消える（あるいは全部 false に倒れる）実装を通さない。
   */
  test("制限モードでも permissions / features / disabledTools / editorGroup が返る（D56 / D74）", async () => {
    await lendWindow();
    // **既定のままであることを主張する。** 立っていたら「既定の」値を見ていない。
    for (const key of [
      "layout.closeHumanTabs",
      "layout.closeDirtyTabs",
      "stage.enabled",
      "html.enabled",
      "layout.enabled",
      "stage.editorGroup",
    ]) {
      assert.strictEqual(
        vscode.workspace.getConfiguration().inspect(`showme.${key}`)?.globalValue,
        undefined,
        `showme.${key} が立っている（前提が崩れている）`,
      );
    }
    const result = await listWorkspaces();
    assert.strictEqual(result.isTrusted, false, "制限モードで走っていない（前提が崩れている）");
    assert.deepStrictEqual(result.permissions, { closeHumanTabs: false, closeDirtyTabs: false });
    assert.deepStrictEqual(result.features, { stage: true, html: true, layout: true });
    assert.deepStrictEqual(result.disabledTools, []);
    assert.strictEqual(result.editorGroup, "dedicated");

    // 制限モードでもグローバル値は写る（信頼の有無で読み口が変わらない）。
    await vscode.workspace
      .getConfiguration()
      .update("showme.layout.closeHumanTabs", true, vscode.ConfigurationTarget.Global);
    try {
      assert.strictEqual(
        vscode.workspace.getConfiguration().inspect<boolean>("showme.layout.closeHumanTabs")
          ?.globalValue,
        true,
        "showme.layout.closeHumanTabs が書けていない（前提が崩れている）",
      );
      const flipped = await listWorkspaces();
      assert.strictEqual(flipped.isTrusted, false);
      assert.strictEqual(flipped.permissions.closeHumanTabs, true, JSON.stringify(flipped));
      assert.strictEqual(flipped.permissions.closeDirtyTabs, false, JSON.stringify(flipped));
    } finally {
      await vscode.workspace
        .getConfiguration()
        .update("showme.layout.closeHumanTabs", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual((await listWorkspaces()).permissions.closeHumanTabs, false);
  });

  /**
   * **制限モードでも、機能を切れば断られ、ワークスペースの設定では戻せない**
   * （増分6 D75 / C4'）。
   *
   * 制限モードは「読ませている repo を信用しない」モードなので、ここでこそ
   * `.vscode/settings.json` が扉を開けてはならない。global で `html.enabled` を
   * 切り、ワークスペースに true を置いても `show_html` は断られる。
   *
   * 対照に `editor.tabSize` を同じファイルに入れる ―― 制限モードでも通常の
   * 設定は読まれるので、これが効いていなければ設定ファイルが読まれていない
   * （空振りの緑）。
   */
  test("html を切ると show_html が断られ、ワークスペースの設定では戻せない（D75 / C4'）", async () => {
    await lendWindow();
    const settingsUri = vscode.Uri.joinPath(workspaceRoot(), ".vscode/settings.json");
    // global の書き込みも `try` の中 ―― 設定ファイルの書き込みで落ちても
    // `finally` が global を戻す（false が後の検査に漏れない）。
    try {
      await vscode.workspace
        .getConfiguration()
        .update("showme.html.enabled", false, vscode.ConfigurationTarget.Global);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), ".vscode"));
      await vscode.workspace.fs.writeFile(
        settingsUri,
        Buffer.from(
          `${JSON.stringify({ "editor.tabSize": 3, "showme.html.enabled": true }, null, 2)}\n`,
          "utf8",
        ),
      );
      assert.strictEqual(
        vscode.workspace.getConfiguration().inspect<boolean>("showme.html.enabled")?.globalValue,
        false,
        "showme.html.enabled が書けていない（前提が崩れている）",
      );
      await waitFor(
        "ワークスペースの設定ファイルが読まれる",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          3,
      );
      const r = await listWorkspaces();
      assert.strictEqual(r.isTrusted, false);
      assert.strictEqual(
        r.features.html,
        false,
        `ワークスペースが機能を戻した: ${JSON.stringify(r)}`,
      );
      assert.deepStrictEqual(r.disabledTools, ["show_html"], JSON.stringify(r));
      await assert.rejects(
        () =>
          Promise.resolve(
            vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>x</p>" }),
          ),
        (e: unknown) =>
          String(e).includes("Tool show_html is disabled by settings") &&
          String(e).includes("showme.html.enabled"),
        "html を切ったのに show_html が断られなかった（あるいは鍵を言わない）",
      );
    } finally {
      await vscode.workspace
        .getConfiguration()
        .update("showme.html.enabled", undefined, vscode.ConfigurationTarget.Global);
      await vscode.workspace.fs.delete(settingsUri, { useTrash: false }).then(undefined, () => {});
      await waitFor(
        "ワークスペースの設定ファイルが消える",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          undefined,
      );
    }
    assert.deepStrictEqual((await listWorkspaces()).disabledTools, []);
  });
});

/**
 * 何が返ったかを、名前と一緒に畳んだもの。
 *
 * 「シンボルが返らなかった」は3通りある（プロバイダが無い / 引けたが空 / 例外）。
 * 真偽値に潰すと、まさに測りたい区別が消える。
 */
interface SymbolProbe {
  /** "symbols" | "undefined" | "empty-array" | "throws:…" | "other:…" */
  readonly outcome: string;
  /** 最上位のシンボル名（`outcome === "symbols"` のときだけ中身がある）。 */
  readonly names: readonly string[];
  /** 何回引き直したか。1 なら一発で確定している。 */
  readonly attempts: number;
}

function symbolNames(raw: readonly unknown[]): string[] {
  return raw.map((item) => {
    const name = (item as { name?: unknown }).name;
    return typeof name === "string" ? name : "(名前なし)";
  });
}

/**
 * そのファイルの文書シンボルを引く。**上限つきで引き直す。**
 *
 * 言語プロバイダは対応する同梱拡張が activate してから登録される。一度引いて
 * `undefined` だったことは「プロバイダが無い」の証拠にならないので、時間を
 * 与えたうえで、最後に見えた姿を返す。
 */
async function probeDocumentSymbols(uri: vscode.Uri, timeoutMs = 10_000): Promise<SymbolProbe> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });

  let attempts = 0;
  let last: unknown;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    attempts += 1;
    try {
      last = await vscode.commands.executeCommand<unknown>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      );
    } catch (e) {
      return { outcome: `throws:${String(e)}`, names: [], attempts };
    }
    if (Array.isArray(last) && last.length > 0) {
      return { outcome: "symbols", names: symbolNames(last), attempts };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (last === undefined) return { outcome: "undefined", names: [], attempts };
  if (Array.isArray(last)) return { outcome: "empty-array", names: [], attempts };
  return { outcome: `other:${typeof last}`, names: [], attempts };
}

/**
 * 増分2B が乗る土台を、**実装を始める前に**制限モードの実機で測る。
 *
 * 設計レビューは「制限モードで無効になるのは同梱97拡張のうち
 * `typescript-language-features` と `git` の2つだけで、JSON / CSS / HTML /
 * Markdown のプロバイダは動く」と報告した。それは**推定**であり、2B の
 * `annotate`（comment thread）と `symbol` 解決はその推定の上に立っている。
 * 推定のまま設計に書かないために、ここで測る。
 *
 * 測った値は記録に写す。だから各測定は
 * 結果を `console.log` にも出す ―― assert が通ったことだけでは、記録に
 * 何を書けばよいかが分からない。
 */
suite("実 VS Code / 制限モード / 2B の前提測定", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  /**
   * 何が無効なのかを、**制限モードのせいだと決めつける前に**見る。
   *
   * 統合テストの起動引数には `--disable-extensions` が入っている
   * （`test/integration/runTest.ts`）。これは制限モードとは別の理由で同梱拡張を
   * 落としうる。プロバイダが返らなかったときに、原因が信頼の有無なのか起動引数
   * なのかを、同じ回の中で判別できるようにしておく。
   */
  test("[測定] 同梱拡張が、この回で実際にどれだけ読み込まれているか", () => {
    const ids = vscode.extensions.all.map((e) => e.id);
    const builtIns = vscode.extensions.all.filter((e) => e.id.startsWith("vscode."));
    const named = (id: string) => {
      const ext = vscode.extensions.getExtension(id);
      return ext === undefined ? "(未ロード)" : `ロード済み(isActive=${String(ext.isActive)})`;
    };
    console.log(
      [
        "[測定] 拡張の在庫",
        `  extensions.all: ${ids.length} 件（うち vscode.* が ${builtIns.length} 件）`,
        `  vscode.json-language-features:       ${named("vscode.json-language-features")}`,
        `  vscode.typescript-language-features: ${named("vscode.typescript-language-features")}`,
        `  vscode.markdown-language-features:   ${named("vscode.markdown-language-features")}`,
        `  vscode.git:                          ${named("vscode.git")}`,
        `  zvxbase.vscode-showme:                ${named("zvxbase.vscode-showme")}`,
        // 一覧そのものを出す。「2つだけ無効になる」という報告を確かめるには、
        // 件数ではなく**どれが**欠けているかが要る（件数だけだと、名指しされた
        // 2つ以外が欠けていても同じ数になりうる）。
        `  ids: ${[...ids].sort().join(",")}`,
      ].join("\n"),
    );
    assert.ok(
      ids.includes("zvxbase.vscode-showme"),
      "自分自身が在庫に無い（測定が成立していない）",
    );
  });

  /**
   * `annotate` はこの上に乗る（設計書 §3.2）。
   *
   * **描かれているかは API からは読めない。** VS Code は comment thread の
   * 描画状態を問い合わせる口を持たない。だからここで確定できるのは
   * 「制限モードでも controller と thread が作れて、指定した uri / range /
   * 本文 / 返信不可 がそのまま保たれる」までである。色と吹き出しが実際に
   * 出ていることは runbook の「目で見る確認」に残す。
   */
  test("[測定] 制限モードで comment thread が作れる", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });

    let controller: vscode.CommentController | undefined;
    let observed: Record<string, unknown> = {};
    try {
      controller = vscode.comments.createCommentController(
        "showme.probe.restricted",
        "ShowMe (前提測定)",
      );
      // `commentingRangeProvider` は設定しない（設定しないと人間は書き込めない）。
      // `reactionHandler` も設定しない（設計書 §3.2.1）。
      const thread = controller.createCommentThread(uri, new vscode.Range(4, 0, 4, 0), [
        {
          // 本文は **プレーンな文字列**（設計書 §3.2.1）。MarkdownString を使わない。
          body: "ShowMe 前提測定: この行に注釈が出るか",
          // `Editing = 0` なので、未設定だと危ない側に倒れる。必ず明示する。
          mode: vscode.CommentMode.Preview,
          author: { name: "ShowMe" },
        },
      ]);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.label = "ShowMe";

      // 作った直後だけでなく、一度イベントループを回してから読み直す。
      // ホスト側が黙って捨てるなら、ここで姿が変わる。
      await new Promise((resolve) => setTimeout(resolve, 500));

      observed = {
        uriMatches: thread.uri.toString() === uri.toString(),
        rangeStartLine: thread.range?.start.line,
        comments: thread.comments.length,
        bodyIsString: typeof thread.comments[0]?.body === "string",
        canReply: thread.canReply,
        collapsibleState: thread.collapsibleState,
      };
      console.log(`[測定] comment thread: ${JSON.stringify(observed)}`);

      assert.strictEqual(observed.uriMatches, true, "thread.uri が指定した uri と違う");
      assert.strictEqual(observed.rangeStartLine, 4, "thread.range が指定した行と違う");
      assert.strictEqual(observed.comments, 1, "本文が1件保たれていない");
      assert.strictEqual(observed.bodyIsString, true, "本文が string のまま保たれていない");
      assert.strictEqual(observed.canReply, false, "canReply=false が保たれていない");
      assert.strictEqual(
        observed.collapsibleState,
        vscode.CommentThreadCollapsibleState.Expanded,
        "collapsibleState が保たれていない（畳まれていると行の下に出ない）",
      );
    } finally {
      controller?.dispose();
    }
  });

  /**
   * `show_code` のハイライトと `annotate` の下線がこの上に乗る。
   *
   * `setDecorations` にも**読み出し口が無い**（runbook に既出）。ここで確定
   * できるのは「制限モードでも装飾の型が作れて、可視エディタに当てても例外に
   * ならない」までである。
   */
  test("[測定] 制限モードで setDecorations が例外にならない", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: true,
      preview: false,
    });

    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      overviewRulerColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: true,
    });
    try {
      editor.setDecorations(decoration, [new vscode.Range(0, 0, 0, 0)]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 外しても例外にならないこと（`annotate` の `mode: "replace"` が要る）。
      editor.setDecorations(decoration, []);
      console.log(`[測定] setDecorations: 例外なし（decorationType.key=${decoration.key}）`);
      assert.strictEqual(typeof decoration.key, "string", "装飾の型が作れていない");
    } finally {
      decoration.dispose();
    }
  });

  /**
   * 制限モードで `.ts` が**何語として開かれるか**。
   *
   * 理由の判定（`symbol-lookup.ts` の `symbolUnavailableReason`）は言語 id と
   * パスの綴りの両方を見る。無効化された拡張は `contributes.languages` ごと
   * 消えうるので、`languageId` だけを見る実装は**まさに制限モードのときだけ**
   * 判定材料を失う、という読みからそうしてある。実際にどちらなのかを記録する
   * ―― 推定のまま「両方見る必要がある」と書かない。
   */
  test("[測定] 制限モードで .ts はどの言語として開かれるか", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    console.log(`[測定] .ts の languageId（制限モード）: ${doc.languageId}`);
    assert.strictEqual(typeof doc.languageId, "string", "languageId が読めない");
  });

  /**
   * 設計書 §3.4 の前提。**`.json` は制限モードでも引けるはず**という報告を実機に当てる。
   *
   * ここが落ちたら §3.4 の表（`restricted-mode` を TS/JS に限る）が成り立たない。
   */
  test("[測定] 制限モードで .json のシンボルが実際に返る", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), JSON_REL);
    const probe = await probeDocumentSymbols(uri);
    console.log(`[測定] .json のシンボル: ${JSON.stringify(probe)}`);

    assert.strictEqual(
      probe.outcome,
      "symbols",
      `制限モードで .json のシンボルが返らなかった（${probe.outcome}）。設計書 §3.4 の前提が崩れている`,
    );
    assert.ok(
      probe.names.includes(JSON_SYMBOL),
      `シンボルは返ったが ${JSON_SYMBOL} が含まれない: ${probe.names.join(", ")}`,
    );
  });

  /**
   * 同じく §3.4 の前提。**`.ts` は制限モードでは引けないはず**。
   *
   * `typescript-language-features` は `untrustedWorkspaces.supported: false` なので
   * 制限モードでは動かない、という報告を実機に当てる。ここで `undefined` が返り、
   * かつ上の `.json` が返ることの**両方**が揃って初めて、§3.4 の
   * 「`undefined` ＋ 信頼依存の言語なら `restricted-mode`」が意味を持つ。
   */
  test("[測定] 制限モードで .ts のシンボルは返らない", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    // `.json` より短い上限で十分（ここは「返らない」を確かめるので、待つほど遅くなる）。
    const probe = await probeDocumentSymbols(uri, 5_000);
    console.log(`[測定] .ts のシンボル: ${JSON.stringify(probe)}`);

    assert.notStrictEqual(
      probe.outcome,
      "symbols",
      `制限モードで .ts のシンボルが返った（${probe.names.join(", ")}）。` +
        `${TS_SYMBOL} が引けるなら、制限モードで symbol を拒む理由が無い`,
    );
  });
});

/**
 * **制限モードでもレイアウトの規則は変わらない**（設計 D37/D37' / §1.4）。
 *
 * 制限モードは言語プロバイダを止めるだけで、`tabGroups` も
 * `visibleTextEditors` もそのまま読める。信頼モードで塞いだ口が、
 * こちらでは開いている ―― という壊れ方を許さない。
 */
suite("実 VS Code / 制限モード / get_editor_state のレイアウト", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  test("秘匿ファイルは名前が出て可視行が出ない、外のファイルは名前も可視行も出ない", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // 対照になる普通のファイル。これが可視行を返さないなら、下の「返らない」は
    // 伏せたからではなく、そもそも観測が無いからになる（空振りの緑）。
    const plain = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    // **3つを別々の列に開く。** 同じ列に重ねると後から開いたものしか可視
    // エディタにならず、対照の可視行が「伏せたから」ではなく「観測が無いから」
    // 返らなくなる（空振りの緑）。
    await vscode.window.showTextDocument(plain, { viewColumn: 1, preview: false });
    const env = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), ENV_REL),
    );
    await vscode.window.showTextDocument(env, { viewColumn: 2, preview: false });
    const outsidePath = path.join(outsideDirFor(workspaceRoot().fsPath), "secret.txt");
    const outside = await vscode.workspace.openTextDocument(vscode.Uri.file(outsidePath));
    await vscode.window.showTextDocument(outside, { viewColumn: 3, preview: false });
    await waitFor("3列になる", () => vscode.window.tabGroups.all.length >= 3);

    const state = await getEditorState();
    const tabs = layoutTabs(state);
    assert.ok(tabs.length >= 3, `タブが揃っていない: ${JSON.stringify(tabs)}`);

    const plainTab = tabs.find((t) => t.path === SAMPLE_REL);
    assert.ok(plainTab, `対照のタブが返らない: ${JSON.stringify(tabs)}`);
    assert.ok(
      plainTab.visibleLines !== undefined,
      "制限モードで普通のファイルの可視行が返らない（この検査は空振りする）",
    );

    const envTab = tabs.find((t) => t.path === ENV_REL);
    assert.ok(envTab, "秘匿ファイルのタブが返らない（D37 で出すと決めた）");
    assert.strictEqual(envTab.visibleLines, undefined, "制限モードで秘匿ファイルの可視行が返った");

    // 名前が出ていないタブは、種類を言う固定文字列でなければならない。
    // そして可視行も持たない（§1.4b の一覧に `visibleLines` は無い）。
    const anonymous = tabs.filter((t) => t.path === undefined);
    assert.ok(anonymous.length >= 1, "名前を伏せたタブが1枚も無い（走査が何も言わない）");
    for (const tab of anonymous) {
      assert.ok(
        ["(outside workspace)", "(terminal)", "(other)"].includes(String(tab.label)),
        `名前が出た: ${String(tab.label)}`,
      );
      assert.strictEqual(
        tab.visibleLines,
        undefined,
        `path の無いタブに可視行が付いた: ${JSON.stringify(tab)}`,
      );
    }
    assert.ok(
      !(state.openPaths as string[]).some((p) => p.includes("secret.txt")),
      "openPaths に外のファイルが載った",
    );
  });

  test("結果はスキーマを通る", async () => {
    const state = await getEditorState();
    const parsed = getEditorStateResultSchema.safeParse(state);
    assert.ok(parsed.success, JSON.stringify(parsed));
  });
});

/**
 * **制限モードでも片づけの規則は変わらない**（設計 D41/D43）。
 *
 * 制限モードが止めるのは言語プロバイダだけで、`tabGroups` も
 * `tabGroups.close` もそのまま触れる。信頼モードで閉じた口が、こちらでは
 * 開いている ―― という壊れ方を許さない。**片づけは人間の作業に触る唯一の
 * 機能なので、両方の回で言う。**
 */
suite("実 VS Code / 制限モード / arrange_editors は人間のタブを閉じない", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("既定のまま3枚開いて close-other-tabs を呼んでも、3枚とも残る", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // **既定のままであることを主張する。** グローバル値が立っていたら、
    // この検査は「既定の」振る舞いを見ていない。
    for (const key of ["closeHumanTabs", "closeDirtyTabs"]) {
      assert.strictEqual(
        vscode.workspace.getConfiguration().inspect<boolean>(`showme.layout.${key}`)?.globalValue,
        undefined,
        `showme.layout.${key} が立っている（前提が崩れている）`,
      );
    }

    for (const rel of [SAMPLE_REL, JSON_REL, ENV_REL]) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspaceRoot(), rel),
      );
      await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
    }
    const labels = (): string[] =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => tab.label)
        .sort();
    await waitFor("3枚のタブが開く", () => labels().length === 3);
    // **前提を主張する。** 開いていなければ「1枚も閉じなかった」は自明に真になる。
    const before = labels();
    assert.strictEqual(before.length, 3, `前提が崩れている: ${before.join(", ")}`);

    const result = await arrangeEditors("close-other-tabs");

    assert.deepStrictEqual(labels(), before, "制限モードで人間のタブが閉じた");
    assert.strictEqual(result.closed, 0, `closed が 0 でない: ${JSON.stringify(result)}`);
    // **空振りの緑を防ぐ。** 候補が0枚でも `closed: 0` は真になる。断った理由が
    // 返ることが、候補に入って**拒まれた**ことの証拠である。
    assert.deepStrictEqual(
      result.withheld,
      ["human-tabs-not-allowed"],
      `断った理由が返らない（候補が0枚だった可能性がある）: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **制限モードでも、自分が開いたものは片づけられる**（増分5 D53）。
   *
   * 所有の記録は言語機能に依らない（`Stage.open()` が記録する）ので、制限モードで
   * 縮退しない。対照に人間の1枚を置く ―― それが残ることで、`own` が
   * 「全部」になっていないことを言う。
   */
  test("show_code で自分が開いたタブは、制限モードでも close-own で消える（D53）", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    const human = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), JSON_REL),
    );
    await vscode.window.showTextDocument(human, { viewColumn: 1, preview: false });
    await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    const labels = (): string[] =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => tab.label)
        .sort();
    await waitFor("2枚のタブが開く", () => labels().length === 2);
    const sampleName = path.basename(SAMPLE_REL);
    const humanName = path.basename(JSON_REL);
    assert.deepStrictEqual(labels(), [humanName, sampleName].sort(), "前提が崩れている");
    // 人間が見ているのは自分の1枚（ここが sample なら床1 で残る）。
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      humanName,
      "人間が見ているタブが変わった（前提が崩れている）",
    );
    const ownPaths = layoutTabs(await getEditorState())
      .filter((t) => t.own === true)
      .map((t) => t.path);
    assert.deepStrictEqual(ownPaths, [SAMPLE_REL], "own: true が自分の1枚でない");

    const result = await arrangeEditors("close-own");

    await waitFor("自分の1枚が消える", () => labels().length === 1);
    assert.deepStrictEqual(
      labels(),
      [humanName],
      "人間の1枚が巻き込まれた、または自分の1枚が残った",
    );
    assert.deepStrictEqual(
      result,
      { done: true, closed: 1 },
      `結果が違う: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **制限モードでも、人間の列を巻き込むプリセットは断る**（増分5 D55-2）。
   *
   * 判定は `tabGroups` の観測だけで、言語機能に依らない ―― 制限モードで縮退しない
   * ことを実機で言う。信頼モードの節と同じ形（人間を列2に移して `two-columns`）。
   */
  test("人間が列2なら two-columns は制限モードでも断り、列の数は変わらない（D55-2）", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await waitFor("編集グループが1つに戻る", () => vscode.window.tabGroups.all.length === 1);
    const humanDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    await vscode.window.showTextDocument(humanDoc, { viewColumn: 1, preview: false });
    const [oneRel, twoRel] = STAGE_RELS;
    assert.ok(oneRel && twoRel, "舞台用のフィクスチャが足りない");
    const resolutions = await showCode(
      [
        { path: oneRel, text: STAGE_MARKER },
        { path: twoRel, text: STAGE_MARKER },
      ],
      "split",
    );
    for (const r of resolutions)
      assert.strictEqual(r.match, "one", `解決できない: ${String(r.reason)}`);
    await waitFor("列が3つになる", () => vscode.window.tabGroups.all.length === 3);
    const movedDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), JSON_REL),
    );
    await vscode.window.showTextDocument(movedDoc, {
      viewColumn: 2,
      preview: false,
      preserveFocus: false,
    });
    await waitFor("人間が列2に移る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 2);
    assert.strictEqual(vscode.window.tabGroups.all.length, 3, "列が3つでない（前提が崩れている）");

    const result = await arrangeEditors("two-columns");

    assert.deepStrictEqual(
      result,
      { done: false, closed: 0, withheld: ["human-column-would-merge"] },
      `断らなかった: ${JSON.stringify(result)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(vscode.window.tabGroups.all.length, 3, "断ったのに列が減った（呼んでいる）");
    // 対照: 人間を列1に戻せば、同じ操作が通る（断ったのが「人間の列」のせいであることの証拠）。
    await vscode.window.showTextDocument(humanDoc, {
      viewColumn: 1,
      preview: false,
      preserveFocus: false,
    });
    await waitFor("人間が列1に戻る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 1);
    const back = await arrangeEditors("two-columns");
    assert.deepStrictEqual(
      back,
      { done: true, closed: 0 },
      `対照が通らない: ${JSON.stringify(back)}`,
    );
    await waitFor("列が2つになる", () => vscode.window.tabGroups.all.length === 2);
  });

  /**
   * エージェントが舞台に開いたファイルの URI（いまの設定で決まる。D84: 既定は映し）。
   * `columnOf` は `waitFor` の中で同期に呼ぶので、舞台を開くときに引いておく。
   * 人間のファイル（sample.ts）は人間の `file:` のまま。
   */
  const staged = new Map<string, vscode.Uri>();

  /** その文書のテキストタブが載っている列（無ければ undefined）。 */
  function columnOf(rel: string): number | undefined {
    const key = (staged.get(rel) ?? vscode.Uri.joinPath(workspaceRoot(), rel)).toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) {
          return group.viewColumn;
        }
      }
    }
    return undefined;
  }

  /** 人間が列1（sample.ts）、自分が列2・3（stage/one, stage/two）の3グループ。 */
  async function humanInOneStageInTwoAndThree(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await waitFor("編集グループが1つに戻る", () => vscode.window.tabGroups.all.length === 1);
    const humanDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    await vscode.window.showTextDocument(humanDoc, { viewColumn: 1, preview: false });
    const [oneRel, twoRel] = STAGE_RELS;
    assert.ok(oneRel && twoRel, "舞台用のフィクスチャが足りない");
    staged.clear();
    for (const rel of [oneRel, twoRel]) staged.set(rel, await stageUri(rel));
    const resolutions = await showCode(
      [
        { path: oneRel, text: STAGE_MARKER },
        { path: twoRel, text: STAGE_MARKER },
      ],
      "split",
    );
    for (const r of resolutions)
      assert.strictEqual(r.match, "one", `解決できない: ${String(r.reason)}`);
    await waitFor("列が3つになる", () => vscode.window.tabGroups.all.length === 3);
    assert.strictEqual(columnOf(SAMPLE_REL), 1, "人間の sample.ts が列1でない（前提）");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間が列1に居ない（前提）",
    );
  }

  /**
   * **制限モードでも `gather-own` は自分のものを集め、人間の列に触れない**（D55-1）。
   * 移動は `showTextDocument` と `tabGroups.close` だけで、言語機能に依らない。
   */
  test("gather-own は制限モードでも列2・3の own を列2に集め、人間の列1は無傷（D55-1）", async () => {
    await humanInOneStageInTwoAndThree();
    const [oneRel, twoRel] = STAGE_RELS;
    assert.ok(oneRel && twoRel, "舞台用のフィクスチャが足りない");
    const columnsBefore = new Set([columnOf(oneRel), columnOf(twoRel)]);
    assert.ok(
      columnsBefore.size === 2 && !columnsBefore.has(1),
      `own が散っていない（前提）: ${[...columnsBefore].join(",")}`,
    );

    const result = await arrangeEditors("gather-own");

    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 1 }, JSON.stringify(result));
    await waitFor("列3が消える", () => vscode.window.tabGroups.all.length === 2);
    assert.strictEqual(columnOf(oneRel), 2, "one.ts が列2に無い");
    assert.strictEqual(columnOf(twoRel), 2, "two.ts が列2に無い");
    const humanGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === 1);
    assert.deepStrictEqual(
      humanGroup?.tabs.map((t) => t.label),
      [path.basename(SAMPLE_REL)],
      "人間の列に何かが流れ込んだ、または消えた",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間の居る列が変わった",
    );
    // 集めたあとも own（再記録）。
    const owns = layoutTabs(await getEditorState())
      .filter((t) => t.own === true)
      .map((t) => t.path)
      .sort();
    assert.deepStrictEqual(owns, [oneRel, twoRel].sort(), "集めたあと own が消えた");
  });

  /**
   * **制限モードでも、未保存のタブを動かして中身が失われない**（D59。開いてから閉じる）。
   */
  //
  // 舞台のタブを人間が編集できるのは、旧来の file: の舞台（`agentTabs: false`）か、編集できる
  // 映し（`editable: true` の `showme-rw:`）のとき（既定の `showme-ro:` は未保存にならない）。
  // 両方の経路で回す（設定はグローバルに書く ―― 制限モードでもグローバル値は読まれる。不変条件9）。
  for (const settings of [
    { "stage.agentTabs": false },
    { "stage.agentTabs": true, "stage.editable": true },
  ]) {
    test(`未保存の自分のタブは制限モードでも中身を保ったまま動く（D59 / ${JSON.stringify(settings)}）`, async () => {
      await withSettings(settings, async () => {
        await humanInOneStageInTwoAndThree();
        const [oneRel] = STAGE_RELS;
        assert.ok(oneRel, "舞台用のフィクスチャが足りない");
        const uri = await stageUri(oneRel);
        const editor = visibleEditorFor(uri);
        assert.ok(editor, "自分が開いたエディタが可視でない（前提）");
        const marker = "// 未保存の変更 RESTRICTED_MOVE_MARKER\n";
        try {
          const applied = await editor.edit((b) => b.insert(new vscode.Position(0, 0), marker));
          assert.ok(applied && editor.document.isDirty, "未保存にできていない（前提）");
          const [, twoRel] = STAGE_RELS;
          assert.ok(twoRel, "舞台用のフィクスチャが足りない");
          const from = columnOf(oneRel);
          assert.ok(from === 2 || from === 3, `one.ts の列が舞台でない（前提）: ${String(from)}`);
          const to = from === 2 ? 3 : 2;
          assert.strictEqual(columnOf(twoRel), to, "two.ts が移動先の列に居ない（前提）");

          const result = await arrangeEditors("move-tab", { path: oneRel, toColumn: to });

          assert.deepStrictEqual(
            result,
            { done: true, closed: 0, moved: 1 },
            JSON.stringify(result),
          );
          // 元の列は1枚だけだったので空になり VS Code が閉じ、列が繰り上がる。だから
          // 「列 `to` に居る」ではなく「two.ts と同じ列に居て、列が2つになった」で言う。
          await waitFor(
            "one.ts が two.ts の列に移り、空いた列が閉じる",
            () => vscode.window.tabGroups.all.length === 2 && columnOf(oneRel) === columnOf(twoRel),
          );
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === uri.toString(),
          );
          assert.ok(doc, "文書が閉じた（未保存が飛んだ）");
          assert.strictEqual(doc.isDirty, true, "動かしたら未保存でなくなった");
          assert.ok(doc.getText().includes(marker), "動かしたら編集が消えた");
          assert.strictEqual(doc, editor.document, "文書の実体が変わった（閉じて開き直している）");
        } finally {
          // 未保存を残すと teardown の `closeAllEditors` が保存の確認で固まる。
          await vscode.window.showTextDocument(uri, { preview: false });
          await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
        }
      });
    });
  }
});
