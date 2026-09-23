import * as assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  annotateResultSchema,
  getEditorStateResultSchema,
  processUid,
  runtimeDirCandidates,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import {
  ANNOTATE_MARKER,
  ANNOTATE_ORDER_A_REL,
  ANNOTATE_ORDER_B_REL,
  ANNOTATE_REL,
  CANARY,
  COLUMN_BAIT_MARKER,
  COLUMN_BAIT_REL,
  COLUMN_STAGE_MARKER,
  COLUMN_STAGE_REL,
  COMPOSITION_MARKER,
  COMPOSITION_REL,
  DEEP_TEXT,
  EDITOR_STATE_MARKER,
  EDITOR_STATE_REL,
  ENV_REL,
  ESCAPE_REL,
  JSON_REL,
  MARKDOWN_ATTACK_MARKER,
  MARKDOWN_ATTACK_REL,
  MARK_ONLY_MARKER,
  MARK_ONLY_RELS,
  NOTES_REL,
  NOT_ACTIVE_MARKER,
  NOT_ACTIVE_REL,
  OUTSIDE_MARKER,
  REPEATED_TEXT,
  SAMPLE_REL,
  STAGE_MARKER,
  STAGE_RELS,
  SYMLINK_TO_ENV_REL,
  TOUR_LINES,
  TOUR_RELS,
  TS_SYMBOL,
  UNIQUE_TEXT,
  outsideDirFor,
} from "../fixture.js";
import {
  ALLOWED_ANNOTATE_RESOLUTION_KEYS,
  ALLOWED_RESOLUTION_KEYS,
  EXTENSION_ID,
  type RawResolution,
  type VisualState,
  WINDOW_OFF_MESSAGE,
  activateExtension,
  activeEditorSnapshot,
  annotate,
  annotateClear,
  annotationThread,
  arrangeCommands,
  arrangeEditors,
  asNumber,
  assertGlobal,
  assertSocketIsListening,
  currentRole,
  getEditorState,
  inspectVisuals,
  layoutGroups,
  layoutTabs,
  lendWindow,
  listWorkspaces,
  mcpDefinitions,
  measureDisplayedLength,
  panelColumn,
  panelIsVisible,
  panelTab,
  setGlobal,
  setRole,
  showCode,
  showOne,
  showsLine,
  tabGroupCount,
  toggleCallCount,
  viewCommands,
  visibleEditorFor,
  visibleEditorSnapshot,
  waitFor,
  waitForSharedSelection,
  workspaceRoot,
} from "./helpers.js";

/**
 * 信頼モードの実 VS Code に対する検査（設計書 §7.3 のうち増分1の範囲）。
 *
 * ここまでの単体テストは vscode API を一度も叩いていない。この節は
 * `vscode.window` / `TextEditor` / ワークスペース信頼が**本物**のときに
 * 何が起きるかだけを見る。
 */
suite("実 VS Code / 信頼モード", () => {
  suiteSetup(async () => {
    await activateExtension();
    // **ここで預けない。** 最初の数件は「預けていない窓では何もできない」を
    // 見るテストで、suiteSetup が預けるとその前提が消える。役割が要るテストは
    // 各 test の先頭で `lendWindow()` を呼ぶ（前のテストの状態に依存しない）。
  });

  test("拡張が有効になる", () => {
    const ext = vscode.extensions.getExtension("zvxbase.vscode-showme");
    assert.ok(ext, "拡張が見つからない");
    assert.strictEqual(ext.isActive, true);
    assert.strictEqual(vscode.workspace.isTrusted, true, "この回は信頼モードで走るはず");
  });

  test("ソケットが実際に立っている", () => {
    assertSocketIsListening();
  });

  /**
   * 増分 2A の中心（設計書 §2A.1）: **エージェント操作の既定は「不可」**である。
   *
   * 「拒否の例外が飛んだ」だけでは足りない。拒否しておいて開いてしまえば、
   * 人間の画面には同じものが出ており、エージェントは戻り値ではなく画面から
   * 目的を達している。だから**可視エディタが変わらないこと**まで見る。
   */
  test("既定では預けられておらず、show_code は拒否され、エディタも開かない", async () => {
    // この test は「ここまで一度も役割を触っていない」ことに乗っている。
    // 並べ替えで前提が消えるので、前提そのものを検査する。
    assert.strictEqual(
      toggleCallCount(),
      0,
      "ここまでに役割を触っている。この test は『既定の』振る舞いを見ていない（並び順を戻すこと）",
    );
    assert.strictEqual(currentRole(), "idle", "activate 直後の役割が idle でない");

    const before = visibleEditorSnapshot();
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);

    await assert.rejects(
      () => showCode([{ path: SAMPLE_REL, text: DEEP_TEXT }]),
      (e: unknown) => String(e).includes(WINDOW_OFF_MESSAGE),
      "預けていない窓で show_code が拒否されなかった",
    );

    // 遅れて開く実装を見逃さないよう、少し待ってから見る。
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepStrictEqual(visibleEditorSnapshot(), before, "拒否したのに可視エディタが変わった");
    // `strictEqual` にすると失敗時に TextEditor をまるごと印字して読めなくなる。
    assert.ok(visibleEditorFor(uri) === undefined, "拒否したのに対象ファイルが開いた");
  });

  test("ステータスバーのトグルで預けると、同じ呼び出しでファイルが開く", async () => {
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    // 前の test が開いていないことが、この test の「開いた」を意味あるものにする。
    assert.ok(
      visibleEditorFor(uri) === undefined,
      "預ける前から対象ファイルが開いている（この検査の前提が崩れている）",
    );

    await lendWindow();
    // 役割は登録ファイルにも出る。ここが変わらないと、人間には預けたように
    // 見えてブリッジからは見つからない窓ができる（設計書 §2A.4）。
    assert.strictEqual(currentRole(), "stage", "トグルしても登録ファイルの役割が stage にならない");

    const resolution = await showOne({ path: SAMPLE_REL, text: DEEP_TEXT });
    assert.strictEqual(resolution.match, "one", "預けたのに解決できない");
    await waitFor("対象ファイルが可視エディタに現れる", () => visibleEditorFor(uri) !== undefined);
  });

  test('layout: "split" は2つの列に開き、人間の列は使わない', async () => {
    await lendWindow();
    const [oneRel, twoRel] = STAGE_RELS;
    assert.ok(oneRel && twoRel, "舞台用のフィクスチャが足りない");

    const resolutions = await showCode(
      [
        { path: oneRel, text: STAGE_MARKER },
        { path: twoRel, text: STAGE_MARKER },
      ],
      "split",
    );
    assert.strictEqual(resolutions.length, 2, "2箇所渡したのに結果が2件でない");
    for (const r of resolutions)
      assert.strictEqual(r.match, "one", `解決できない: ${String(r.reason)}`);

    const uris = [oneRel, twoRel].map((rel) => vscode.Uri.joinPath(workspaceRoot(), rel));
    await waitFor("2箇所とも可視エディタに現れる", () =>
      uris.every((u) => visibleEditorFor(u) !== undefined),
    );

    // 件数で見る。1列に2つ重ねた実装は、片方が背面タブになるので1つしか可視にならない。
    assert.strictEqual(
      vscode.window.visibleTextEditors.length,
      2,
      `split なのに可視エディタが2つでない: ${visibleEditorSnapshot().join(", ")}`,
    );

    const columns = uris.map((u) => visibleEditorFor(u)?.viewColumn);
    assert.notStrictEqual(
      columns[0],
      columns[1],
      `split なのに同じ列に開いた（列 ${String(columns[0])}）`,
    );
    // 舞台は人間の列を含まない（不変条件10）。人間の列はいちばん手前＝1 である。
    for (const column of columns) {
      assert.ok(
        typeof column === "number" && column > 1,
        `舞台が人間の列に開いた（列 ${String(column)}）`,
      );
    }
  });

  /**
   * 舞台は**有界**である（設計書 §2A.7 / 不変条件10）。
   *
   * 繰り返して増えないことを見る。1回だけ呼んで「2列だった」では、毎回1列
   * 足す実装と区別できない ―― その実装も初回は2列になる。
   *
   * `locations` を上限の3件で渡すのは、枠の数（`chooseStageColumns` の上限）を
   * 実際に踏むため。2件で回すと、上限が3に緩んでも同じ結果になって判別しない。
   *
   * **この test が判別するのは `chooseStageColumns` の上限だけである。**
   * `clampStageColumn` の丸めを外しても、ここは緑のままだった（実測）。枠は
   * 昇順に、開けた分だけ進み、`Stage.targetColumn` は毎回いまの可視列を読み直す
   * ので、実機の経路では要求列が「存在する列＋1」を超えない。丸めは順序が
   * 崩れたときのための防御であり、それを判別しているのは
   * `test/stage-column.test.ts` の3件（外すと落ちる。実測）である。
   */
  test('layout: "split" を繰り返しても列は 人間1 + 舞台2 を超えない', async () => {
    await lendWindow();

    // 人間の列だけの状態から始める。既に舞台が開いていると「増えなかった」が
    // 「もう上限に張り付いていた」と区別できない。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが人間の1つに戻る", () => tabGroupCount() === 1);

    const locations = STAGE_RELS.map((rel) => ({ path: rel, text: STAGE_MARKER }));
    let worst = tabGroupCount();
    for (let i = 0; i < 8; i += 1) {
      const resolutions = await showCode(locations, "split");
      for (const r of resolutions) {
        assert.strictEqual(r.match, "one", `${i + 1} 回目に解決できない: ${String(r.reason)}`);
      }
      worst = Math.max(worst, tabGroupCount());
      assert.ok(
        tabGroupCount() <= 3,
        `${i + 1} 回目で編集グループが ${tabGroupCount()} になった（人間1 + 舞台2 = 3 が上限）`,
      );
    }
    // 上限に達していない回だけを見て通したのではないことを、記録として残す。
    assert.strictEqual(worst, 3, `舞台が2列に開いていない（最大の編集グループ数 ${worst}）`);
  });

  test("text 指定でファイルが実際に開き、該当位置が可視になる", async () => {
    await lendWindow();
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const resolution = await showOne({ path: SAMPLE_REL, text: DEEP_TEXT });

    assert.strictEqual(resolution.match, "one", "唯一の一致が one にならなかった");
    assert.strictEqual(resolution.resolvedBy, "text");

    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "match が one なのに range が無い");
    // 埋め草を挟んであるので、この行は初期表示には入っていない。
    assert.ok(range.startLine > 100, `対象行が浅すぎる（${range.startLine}）`);

    // 「エラーが出なかった」ではなく「対象が可視エディタに現れた」を見る。
    await waitFor("対象ファイルが可視エディタに現れる", () => visibleEditorFor(uri) !== undefined);
    const editor = visibleEditorFor(uri);
    assert.ok(editor, "可視エディタが取れない");

    // revealRange が効いたことを、可視範囲そのもので確かめる。
    const zeroBased = range.startLine - 1;
    await waitFor(`${range.startLine} 行目が可視範囲に入る`, () => {
      const current = visibleEditorFor(uri);
      return (
        current?.visibleRanges.some((r) => r.start.line <= zeroBased && zeroBased <= r.end.line) ===
        true
      );
    });
  });

  test("show_code は TextEditor.selection を変更しない", async () => {
    await lendWindow();
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    // 人間の側の面も作る。舞台は専用グループ（隣の列）に開くので、
    // 触られうるエディタは1つとは限らない。
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });

    const sampleEditors = (): vscode.TextEditor[] =>
      vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString());

    const before = sampleEditors();
    assert.ok(before.length >= 1, "sample.ts を表示しているエディタが無い");

    // 人間が選んだことにする。既定の (0,0) のままだと、「動かさなかった」と
    // 「まだ何も起きていない」が同じ値になって判別しない。
    const marker = new vscode.Selection(1, 0, 1, 5);
    for (const editor of before) editor.selection = marker;
    await waitFor("テスト側の selection が反映される", () =>
      sampleEditors().every((e) => e.selection.isEqual(marker)),
    );

    // ファイルのずっと下の行を見せる。selection を動かす実装なら、ここで
    // 400 行以上離れた位置へ飛ぶ。
    const resolution = await showOne({ path: SAMPLE_REL, text: DEEP_TEXT });
    assert.strictEqual(resolution.match, "one");
    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "range が無い");

    // 非同期に遅れて動く実装を見逃さないよう、少し待ってから確かめる。
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = sampleEditors();
    assert.ok(after.length >= 1, "検査の途中で sample.ts のエディタが消えた");
    for (const editor of after) {
      assert.ok(
        editor.selection.isEqual(marker),
        `show_code が selection を動かした（列 ${String(editor.viewColumn)}: ${editor.selection.start.line}:${editor.selection.start.character}-${editor.selection.end.line}:${editor.selection.end.character}）。get_editor_state との合成で任意ファイルの生テキストが漏れる`,
      );
      assert.notStrictEqual(
        editor.selection.active.line,
        range.startLine - 1,
        "selection が見せた行に移っている",
      );
    }
  });

  test("除外パスは解決されない", async () => {
    await lendWindow();
    const resolution = await showOne({ path: ENV_REL, text: "SECRET" });
    assert.strictEqual(resolution.match, "none");
    assert.strictEqual(resolution.reason, "excluded-path");
    assert.strictEqual(resolution.resolvedBy, "none");
    assert.strictEqual(resolution.range, undefined, "拒否したのに range を返している");
    assert.strictEqual(resolution.candidates, undefined, "拒否したのに candidates を返している");
    // .env が可視エディタに開かれていないこと（拒否したのに開けば同じことである）。
    const envUri = vscode.Uri.joinPath(workspaceRoot(), ENV_REL);
    assert.strictEqual(visibleEditorFor(envUri), undefined, ".env が開かれている");
  });

  test("多重一致でも正確な件数を返さない", async () => {
    await lendWindow();
    const resolution = await showOne({ path: SAMPLE_REL, text: REPEATED_TEXT });
    assert.strictEqual(resolution.match, "many");

    const candidates = resolution.candidates;
    assert.ok(Array.isArray(candidates), "candidates が配列でない");
    // フィクスチャは4行に現れる。3件に切り詰められていることが、
    // 件数を漏らしていないことの実証になる（4件返ったら件数そのものである）。
    assert.strictEqual(candidates.length, 3, "候補が3件に切り詰められていない");

    // 鍵の集合ごと見る。個別の禁止語（count / total）だけを見ると、
    // 別名の鍵（matchCount など）が生えたときに素通りする。
    for (const key of Object.keys(resolution)) {
      assert.ok(
        ALLOWED_RESOLUTION_KEYS.has(key),
        `結果に未知の鍵がある: ${key}（件数を漏らす経路になりうる）`,
      );
    }
    for (const forbidden of ["count", "total", "matchCount", "totalMatches", "hits"]) {
      assert.ok(!(forbidden in resolution), `件数を漏らす鍵がある: ${forbidden}`);
    }
  });

  test("realpath 後の除外再判定が効く（前段の関門はこのパスを通す）", async () => {
    await lendWindow();
    const root = workspaceRoot().fsPath;
    const notesPath = path.join(root, NOTES_REL);

    // (a) まず実ファイルのまま引く。第一の関門（生の path 文字列に対する
    //     除外判定）が docs/notes.md を通していることの証拠になる。
    const asRealFile = await showOne({ path: NOTES_REL, text: CANARY });
    assert.strictEqual(
      asRealFile.match,
      "one",
      "docs/notes.md が実ファイルの時点で解決できない（この検査の前提が崩れている）",
    );
    assert.notStrictEqual(asRealFile.reason, "excluded-path");

    // (b) 中身を変えず、パスも変えず、**実体だけ** .env に差し替える。
    fs.rmSync(notesPath);
    fs.symlinkSync(path.join("..", ENV_REL), notesPath);
    assert.ok(fs.lstatSync(notesPath).isSymbolicLink(), "シンボリックリンクになっていない");
    // OS はこのパス経由で .env の中身を返す。つまり止めているのは我々だけである。
    assert.ok(
      fs.readFileSync(notesPath, "utf8").includes(CANARY),
      "リンク経由で .env が読めない（この検査の前提が崩れている）",
    );

    const viaSymlink = await showOne({ path: NOTES_REL, text: CANARY });
    assert.strictEqual(viaSymlink.match, "none", "シンボリックリンク経由で .env が解決できた");
    // 第一の関門は (a) の通り docs/notes.md を通している。止めたのは
    // readWorkspaceFile の realpath 後の再判定だけである。
    assert.strictEqual(
      viaSymlink.reason,
      "not-found",
      "止めた場所が違う（excluded-path なら前段で落ちており、再判定は検査できていない）",
    );
    assert.strictEqual(viaSymlink.normalizedPath, NOTES_REL);
  });

  test("ワークスペースの外へ出るリンクも読めない", async () => {
    await lendWindow();
    const root = workspaceRoot().fsPath;
    const escapePath = path.join(root, ESCAPE_REL);
    const outside = path.join(outsideDirFor(root), "secret.txt");
    assert.ok(fs.existsSync(outside), "ワークスペース外のファイルが用意されていない");

    fs.symlinkSync(outside, escapePath);
    // docs/*.md が第一の関門を通ることは前のテストで示してある。
    const resolution = await showOne({ path: ESCAPE_REL, text: OUTSIDE_MARKER });
    assert.strictEqual(resolution.match, "none", "ワークスペース外のファイルが解決できた");
    assert.strictEqual(resolution.reason, "not-found");
  });

  test("同一ファイルへの試行は回数制限され、綴りを変えても抜けられない", async () => {
    await lendWindow();
    // 統合テストはレート制限を一度も見ていなかった。`if (!limiter.allow(key))` を
    // `if (false)` にしても単体・統合とも全部緑だった（実測）。設計書 §4.1 ⑦ は
    // レート制限を、リテラル検索オラクルに対する実際の防御3本のうち1本に
    // 数えている。
    const root = workspaceRoot().fsPath;
    const dir = path.join(root, "rl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "target.txt"), "nothing interesting\n", "utf8");
    // 自己参照リンク。これ1本で `rl/self/target.txt` / `rl/self/self/target.txt` …
    // という別名が無限に作れる。
    fs.symlinkSync(".", path.join(dir, "self"));

    // 当たらない文字列で叩く。エディタを開かせずに予算だけを消費できる。
    const miss = { path: "rl/target.txt", text: "NEVER_MATCHES_ANYTHING" } as const;
    // 既定の上限は 30（src/rate-limit.ts の RATE_LIMIT_MAX_HITS）。
    // 定数を変えたらこの検査が落ちる ―― それでよい。
    for (let i = 0; i < 30; i += 1) {
      const r = await showOne(miss);
      assert.strictEqual(r.reason, "not-found", `${i + 1} 回目で早すぎる制限に当たった`);
    }

    // 31 回目を**別の綴り**で叩く。綴りを鍵にしていれば通ってしまう。
    const aliased = await showOne({
      path: "rl/self/self/target.txt",
      text: "NEVER_MATCHES_ANYTHING",
    });
    assert.strictEqual(
      aliased.reason,
      "rate-limited",
      "シンボリックリンクの別名で回数制限を抜けられた（予算が綴りごとになっている）",
    );
    // 返り値には realpath の結果を載せない（載せるとリンクの解決器になる）。
    assert.strictEqual(aliased.normalizedPath, "rl/self/self/target.txt");
  });

  test("信頼モードでは symbolResolution が true（2B で provider を繋いだ）", async () => {
    await lendWindow();
    const result = await listWorkspaces();
    assert.strictEqual(result.isTrusted, true);

    const capabilities = result.capabilities as Record<string, unknown> | undefined;
    assert.ok(capabilities, "capabilities が無い");
    // 増分1では provider を繋いでいなかったので、ここは信頼の有無を判別
    // しなかった（信頼モードでも false）。2B で繋いだので、制限モード側の
    // false と初めて対になる。
    assert.strictEqual(
      capabilities.symbolResolution,
      true,
      "信頼モードなのに symbolResolution が false（provider を繋いだのなら true になるはず）",
    );
    // 一方こちらは信頼の有無で本当に変わる（制限モードでは false）。
    assert.strictEqual(capabilities.terminalEnvInjection, true);
    assert.strictEqual(result.otherWindowsListed, false);
  });

  /**
   * 不変条件10 の `preserveFocus: true`（設計書 §4.6）。
   *
   * **判別器が無かった。** `packages/extension/src/stage.ts` の
   * `preserveFocus: true` を `false` に変えても、単体441件・統合24件が
   * すべて緑のままだった（実測）。不変条件が名指しで挙げている性質を
   * 一度も測っていなかったということである。
   *
   * 見るのは `activeTextEditor`。エージェントが舞台に開いたときに、人間が
   * タイピングしていた先が動かないこと ―― 「人間の作業面を奪わない」の、
   * 列とは別の半分である（列は `layout` の検査が見ている）。
   */
  test("show_code は人間のフォーカスを奪わない（preserveFocus）", async () => {
    await lendWindow();
    const humanUri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    // 人間がいちばん手前の列で編集している状態を作る。preserveFocus を
    // 見ない実装は、ここから舞台の列へ焦点を持っていく。
    await vscode.window.showTextDocument(humanUri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await waitFor(
      "人間のエディタが active になる",
      () =>
        vscode.window.activeTextEditor?.document.uri.toString() === humanUri.toString() &&
        vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One,
    );
    const before = activeEditorSnapshot();

    // **別のファイル**を舞台に開かせる。同じファイルだと、焦点が移っても
    // スナップショットの URI が変わらず判別しない。
    const stageRel = STAGE_RELS[0];
    assert.ok(stageRel, "舞台用のフィクスチャが足りない");
    const resolution = await showOne({ path: stageRel, text: STAGE_MARKER });
    assert.strictEqual(resolution.match, "one", "舞台のファイルが解決できない");
    const stageUri = vscode.Uri.joinPath(workspaceRoot(), stageRel);
    await waitFor("舞台のファイルが可視エディタに現れる", () => {
      return visibleEditorFor(stageUri) !== undefined;
    });

    // 遅れて焦点を奪う実装を見逃さないよう、少し待ってから見る。
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(
      activeEditorSnapshot(),
      before,
      `show_code が人間のフォーカスを奪った（${before} -> ${activeEditorSnapshot()}）。preserveFocus: true が効いていない`,
    );
  });

  /**
   * 預けるのをやめたら、エージェントが描いた装飾が残らない（設計書 §5.4）。
   *
   * `extension.ts` の `applyRole` から `highlights.clearAll()` を**削除しても
   * 全部緑だった**（実測）。統合テストが見ていたのは可視エディタと登録ファイル
   * だけで、装飾はどちらにも出ない。「預けるのをやめても装飾が残る」は、
   * 停止中と表示しながら描いたものが残るのと同じ嘘である。
   */
  test("預けるのをやめると、エージェントが描いた装飾が消える", async () => {
    await lendWindow();
    const stageRel = STAGE_RELS[1];
    assert.ok(stageRel, "舞台用のフィクスチャが足りない");
    const uri = vscode.Uri.joinPath(workspaceRoot(), stageRel);

    const resolution = await showOne({ path: stageRel, text: STAGE_MARKER });
    assert.strictEqual(resolution.match, "one", "ハイライトの前提が崩れている");
    await waitFor("装飾を預かっている状態になる", async () =>
      (await inspectVisuals()).highlightedUris.includes(uri.toString()),
    );

    await setRole("idle");
    const after = await inspectVisuals();
    assert.deepStrictEqual(
      after.highlightedUris,
      [],
      `預けるのをやめたのに装飾が残っている: ${after.highlightedUris.join(", ")}`,
    );
  });

  /**
   * **スポットライトは窓ごと**（増分6 D67）。増分5 まではファイルごとに残した（LRU 32）
   * ので、別のファイルへの `show_code` の後も前のファイルの塗りが残っていた。
   * 人間には戻る手段も消す手段も無いものを残さない（§C1）。
   */
  test("別のファイルへ show_code すると、前のファイルのスポットライトが消える（D67）", async () => {
    await lendWindow();
    const [firstRel, secondRel] = STAGE_RELS;
    const firstUri = vscode.Uri.joinPath(workspaceRoot(), firstRel).toString();
    const secondUri = vscode.Uri.joinPath(workspaceRoot(), secondRel).toString();

    const first = await showOne({ path: firstRel, text: STAGE_MARKER });
    assert.strictEqual(first.match, "one", "1枚目の前提が崩れている");
    await waitFor("1枚目に貼られる", async () =>
      (await inspectVisuals()).highlightedUris.includes(firstUri),
    );

    const second = await showOne({ path: secondRel, text: STAGE_MARKER });
    assert.strictEqual(second.match, "one", "2枚目の前提が崩れている");
    await waitFor("2枚目に貼られる", async () =>
      (await inspectVisuals()).highlightedUris.includes(secondUri),
    );
    // **1枚目のタブはまだ開いている**（`preview: false`。同じ列で2枚目の後ろに隠れて
    // いるので可視エディタではなくタブで見る）のに、塗りだけが消えている。
    // タブが閉じたから消えたのではない ―― 窓が置き換わったから消えた。
    const firstTabOpen = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === firstUri,
      ),
    );
    assert.ok(firstTabOpen, "1枚目のタブが閉じた（前提が崩れている）");
    const after = await inspectVisuals();
    assert.deepStrictEqual(
      after.highlightedUris,
      [secondUri],
      `前のファイルの塗りが残っている: ${after.highlightedUris.join(", ")}`,
    );
  });

  /**
   * 観測面が**層**を言う（増分6 §C2）。`show_code` の塗りは `spotlight` で、注釈の塗り
   * と同じ `highlightRanges` に並ぶ。層が無いと「互いを消していない」を言えない。
   */
  test("show_code の塗りは spotlight 層に載る（§C2）", async () => {
    await lendWindow();
    const stageRel = STAGE_RELS[2];
    assert.ok(stageRel, "舞台用のフィクスチャが足りない");
    const uri = vscode.Uri.joinPath(workspaceRoot(), stageRel).toString();
    const resolution = await showOne({ path: stageRel, text: STAGE_MARKER });
    assert.strictEqual(resolution.match, "one", "前提が崩れている");
    await waitFor("貼られる", async () => (await inspectVisuals()).highlightedUris.includes(uri));

    const ranges = (await inspectVisuals()).highlightRanges;
    assert.ok(ranges.length > 0, "highlightRanges が空");
    assert.deepStrictEqual(
      ranges.map((r) => r.layer),
      ranges.map(() => "spotlight"),
      `spotlight 以外の層が載っている: ${JSON.stringify(ranges)}`,
    );
    assert.ok(
      ranges.every((r) => r.uri === uri),
      `1回の show_code の窓に別のファイルが残っている: ${JSON.stringify(ranges)}`,
    );
  });

  /**
   * 画面が役割を映す（設計書 §2A.3 / §5.4）。
   *
   * `applyRole` から `statusBar.setRole(role)` を**削除しても全部緑だった**
   * （実測）。役割はツール呼び出しの可否そのものなので、画面に出ていない役割は
   * 存在しないのと同じである ―― 人間は自分が何を預けたか確かめられない。
   */
  test("ステータスバーが役割を映す", async () => {
    await setRole("idle");
    const idle = (await inspectVisuals()).statusBar;
    // 文言は英語の原文（D58）。この回の表示言語は既定（en）で、束は読まれない。
    // 日本語は locale-ja.test.ts が `--locale=ja` ＋ 言語パックの窓で見る。
    assert.strictEqual(vscode.env.language, "en", "この回の表示言語は既定の en のはず");
    assert.strictEqual(
      idle.text,
      "$(shield) ShowMe: Off",
      `預けていない窓の表示が役割を映していない: ${idle.text}`,
    );

    await lendWindow();
    const staged = (await inspectVisuals()).statusBar;
    assert.notStrictEqual(
      staged.text,
      idle.text,
      "預けても表示が変わらない（画面が役割を映していない）",
    );
    assert.ok(
      /ShowMe: On\b/.test(staged.text) || staged.text.includes("Connected"),
      `預けた窓の表示が役割を映していない: ${staged.text}`,
    );
    assert.ok(
      /Click to turn (it|ShowMe) off/.test(staged.tooltip),
      `預けた窓の説明が次の操作を案内していない: ${staged.tooltip}`,
    );

    // 戻す向きも見る。片道だけだと、一度 stage にしたら戻らない実装が通る。
    await setRole("idle");
    assert.strictEqual((await inspectVisuals()).statusBar.text, idle.text);
  });

  test("解決できた行番号がファイルの実際の位置と一致する", async () => {
    await lendWindow();
    const resolution = await showOne({ path: SAMPLE_REL, text: UNIQUE_TEXT });
    assert.strictEqual(resolution.match, "one");
    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "range が無い");
    assert.strictEqual(asNumber(range.startLine, "startLine"), 1);
  });
});

/**
 * 制限モードの前提測定（`restricted.test.ts`）の**対照**。
 *
 * 制限モードの回で `vscode.typescript-language-features` が在庫に無く、`.ts` の
 * シンボルが `undefined` になった。それを「制限モードのせい」と言うには、
 * **同じ起動引数の信頼モードでは在庫にある**ことが要る。統合テストは
 * `--disable-extensions` を付けて起動しており（`test/integration/runTest.ts`）、
 * これは信頼の有無とは別の理由で同梱拡張を落としうるからである。
 *
 * この対照が無いと、「制限モードで TS が死んだ」と「起動引数で TS が死んだ」が
 * 同じ観測値になる。
 */
suite("実 VS Code / 信頼モード / 2B の前提測定の対照", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("[測定] 同梱拡張の在庫（制限モードとの差が、信頼の有無の効果）", () => {
    const all = vscode.extensions.all.map((e) => e.id);
    const builtIns = all.filter((id) => id.startsWith("vscode."));
    const present = (id: string) => (all.includes(id) ? "ロード済み" : "(未ロード)");
    console.log(
      [
        "[測定] 拡張の在庫（信頼モード）",
        `  extensions.all: ${all.length} 件（うち vscode.* が ${builtIns.length} 件）`,
        `  vscode.json-language-features:       ${present("vscode.json-language-features")}`,
        `  vscode.typescript-language-features: ${present("vscode.typescript-language-features")}`,
        `  vscode.markdown-language-features:   ${present("vscode.markdown-language-features")}`,
        `  vscode.git:                          ${present("vscode.git")}`,
        // 制限モードの一覧との差集合を取るために、一覧そのものを出す。
        `  ids: ${[...all].sort().join(",")}`,
      ].join("\n"),
    );

    // 信頼モードでこの2つが在庫にあることが、制限モードでの不在の意味を決める。
    // ここが落ちたら、`--disable-extensions` が同梱拡張ごと落としているという
    // ことなので、制限モードの測定は「信頼の有無の効果」を測れていない。
    assert.ok(
      all.includes("vscode.typescript-language-features"),
      "信頼モードでも typescript-language-features が在庫に無い。" +
        "制限モードでの不在は、信頼の有無ではなく起動引数の効果である",
    );
    assert.ok(
      all.includes("vscode.json-language-features"),
      "信頼モードでも json-language-features が在庫に無い",
    );
  });
});

/**
 * `annotate`（設計書 §3.2）を実 VS Code に当てる。
 *
 * **単体テストは偽の面（`AnnotationSurface`）に対してしか置換を見ていない。**
 * 本物の comment thread が `dispose()` で本当に消えるか ―― つまり
 * `mode: "replace"` が実機でも冪等か ―― は、ここでしか判別しない。
 *
 * 吹き出しが**描かれている**ことは API からは読めない（VS Code に問い合わせ口が
 * 無い）。ここで確定できるのは「拡張が保持している thread の集合」までで、
 * 色と吹き出しが実際に見えることは runbook の目視確認に残す。
 */
suite("実 VS Code / 信頼モード / 注釈", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  /**
   * 注釈を次の節に持ち越さない。注釈は塗りも持つ（D65）ので、残すと後の節の
   * 「塗りが空」の主張（片づけ・窓の置き換え）が、この節の残り物で赤くなる。
   */
  suiteTeardown(async () => {
    await lendWindow();
    await annotateClear();
  });

  const annotateUri = (): string => vscode.Uri.joinPath(workspaceRoot(), ANNOTATE_REL).toString();

  /** いま出ている、そのファイル宛ての吹き出しの数。 */
  async function bubbleCount(): Promise<number> {
    const visuals = await inspectVisuals();
    return visuals.annotatedUris.filter((uri) => uri === annotateUri()).length;
  }

  test("解決できた位置に吹き出しが1件立つ", async () => {
    await lendWindow();
    const resolutions = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "ここが注釈の対象" },
    ]);
    assert.strictEqual(resolutions.length, 1);
    assert.strictEqual(resolutions[0]?.match, "one");
    // 返り値に本文もファイルの内容も入らない（不変条件2）。
    assert.deepStrictEqual(
      Object.keys(resolutions[0] ?? {})
        .filter((key) => !ALLOWED_ANNOTATE_RESOLUTION_KEYS.has(key))
        .sort(),
      [],
      "resolution に知らない鍵が生えている",
    );
    await waitFor("吹き出しが1件になる", async () => (await bubbleCount()) === 1);
  });

  test("同じ引数で2回呼んでも吹き出しは増えない（mode: replace が冪等）", async () => {
    await lendWindow();
    const args = [{ location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "同じ説明" }];
    await annotate(args);
    await annotate(args);
    // 1件でないなら、置換が実機の thread に効いていない（＝ dispose が消していない）。
    assert.strictEqual(await bubbleCount(), 1, "同じ引数で2回呼んだら吹き出しが増えた");
  });

  test("mode: add は増え、replace で元に戻る（判別器: 上のテストが偶然でないこと）", async () => {
    await lendWindow();
    const item = { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "足す説明" };
    await annotate([item]);
    await annotate([item], "add");
    assert.strictEqual(await bubbleCount(), 2, "mode: add で増えていない（置換と区別が付かない）");
    await annotate([item]);
    assert.strictEqual(await bubbleCount(), 1, "replace が add の分を消していない");
  });

  test("mode: clear で注釈が全部消える（D54: 解決しない位置を渡す副作用に頼らない）", async () => {
    await lendWindow();
    await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "消す前" },
      { location: { path: ANNOTATE_REL, lines: { start: 1, end: 1 } }, text: "消す前2" },
    ]);
    // 前提: 消す前に出ている。出ていなければ「消えた」は空虚に真になる。
    assert.strictEqual(await bubbleCount(), 2, "前提が成立していない（吹き出しが出ていない）");

    const resolutions = await annotateClear();
    assert.deepStrictEqual(resolutions, [], "clear の resolutions が空でない");
    await waitFor("吹き出しが全部消える", async () => (await bubbleCount()) === 0);
    assert.deepStrictEqual(
      (await inspectVisuals()).annotatedUris,
      [],
      "他のファイル宛ての注釈が残っている",
    );
  });

  test("clear に items を付けると線上の検証で落ちる（意図が曖昧）", async () => {
    await lendWindow();
    await assert.rejects(
      async () =>
        vscode.commands.executeCommand("showme.test.annotate", {
          mode: "clear",
          items: [{ location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "x" }],
        }),
      (e: unknown) => String(e).includes("items"),
      "clear に items を付けても拒否されなかった",
    );
  });

  test("預けるのをやめると吹き出しも注釈の塗りも消え、annotate は拒否される", async () => {
    await lendWindow();
    // 色つきにして、塗り（注釈層）も一緒に消えることを同じ観測で言う（D66 の「停止」経路）。
    await annotate([
      {
        location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER },
        text: "消えるべき説明",
        color: "red",
      },
    ]);
    assert.strictEqual(await bubbleCount(), 1, "前提が成立していない（吹き出しが出ていない）");
    await waitFor("注釈の塗りが貼られる", async () =>
      (await inspectVisuals()).highlightRanges.some((r) => r.layer === "annotation"),
    );

    await setRole("idle");
    await waitFor("吹き出しが消える", async () => (await bubbleCount()) === 0);
    // 注釈の層を空にするのは注釈ストアだけ（`applyRole` は `annotations.clearAll()` を呼ぶ）。
    // ここが残るなら、役割の解除が画家の全消しに頼っていて、吹き出しと塗りの持ち主が割れている。
    const after = await inspectVisuals();
    assert.deepStrictEqual(
      after.highlightRanges.filter((r) => r.layer === "annotation"),
      [],
      `預けるのをやめたのに注釈の塗りが残っている: ${JSON.stringify(after.highlightRanges)}`,
    );

    await assert.rejects(
      () =>
        annotate([{ location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "出ないはず" }]),
      (e: unknown) => String(e).includes(WINDOW_OFF_MESSAGE),
      "預けていない窓で annotate が拒否されなかった",
    );
    assert.strictEqual(await bubbleCount(), 0, "拒否したのに吹き出しが出た");
  });

  test("空振りは吹き出しを出さず、置換の約束は果たす", async () => {
    await lendWindow();
    await annotate([{ location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "古い説明" }]);
    await annotate([
      { location: { path: ANNOTATE_REL, text: "このファイルに無い文字列" }, text: "新しい説明" },
    ]);
    assert.strictEqual(await bubbleCount(), 0, "1件も解決できなかったのに古い注釈が残っている");
  });

  test("色を付けても本文はプレーンな文字列のまま（設計 D57/D48）", async () => {
    await lendWindow();
    const resolutions = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "赤い注釈", color: "red" },
      { location: { path: ANNOTATE_REL, lines: { start: 1, end: 1 } }, text: "無印の注釈" },
    ]);
    // **先に「食わせられた」ことを言う。** どちらかが空振りしていると、
    // 以下の主張は「吹き出しが無いので何も壊れていない」で通ってしまう。
    assert.strictEqual(resolutions[0]?.match, "one", "色つきの注釈が出せなかった");
    assert.strictEqual(resolutions[1]?.match, "one", "無印の注釈が出せなかった");
    await waitFor("吹き出しが2件になる", async () => (await bubbleCount()) === 2);

    const bodies = (await inspectVisuals()).annotatedBodies;
    assert.strictEqual(bodies.length, 2, "吹き出しが2件でない");
    for (const body of bodies) {
      // 色は `author` 側の欄（作成者名）である。本文が markdown に載ったら、
      // リモート画像も `command:` リンクも一斉に戻る（設計書 §3.2.1）。
      assert.strictEqual(body.kind, "string", "本文が markdown に載った");
    }
    // 色は作成者名に出る（D57）。**名前ではなく値**を主張する。2件なので番号が付く（D69）。
    assert.strictEqual(bodies[0]?.author, "1/2 · ShowMe 🔴 R");
    // **無印は「既定色」ではなく「色を持たない固定名」である。**
    assert.strictEqual(bodies[1]?.author, "2/2 · ShowMe");
  });

  /**
   * **注釈の色は行にも塗られる**（増分6 D65）。作者名だけに色を出していた D57 では、
   * 吹き出しを畳むと行は灰色の印1つで、どの色の注釈か分からなかった。
   * 塗りは `Highlights` の `annotation` 層に載る。無印は**灰で塗る**（増分6.1 D78。
   * D65 の「塗らない」は実機で目立たなすぎたので撤回）。作者名は `ShowMe` のまま。
   */
  async function annotationRanges(): Promise<VisualState["highlightRanges"]> {
    return (await inspectVisuals()).highlightRanges.filter(
      (r) => r.layer === "annotation" && r.uri === annotateUri(),
    );
  }

  test("色つきの注釈は行に塗られ（annotation 層・行全体）、無印は灰で塗られ、作者名は ShowMe のまま（D65 / D78）", async () => {
    await lendWindow();
    const resolutions = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "赤く塗る", color: "red" },
      { location: { path: ANNOTATE_REL, lines: { start: 1, end: 1 } }, text: "無印は灰で塗る" },
    ]);
    assert.strictEqual(resolutions[0]?.match, "one", "色つきの注釈が出せなかった");
    assert.strictEqual(resolutions[1]?.match, "one", "無印の注釈が出せなかった");
    await waitFor("吹き出しが2件になる", async () => (await bubbleCount()) === 2);

    const range = resolutions[0]?.range as { startLine?: unknown } | undefined;
    const startLine = asNumber(range?.startLine, "range.startLine");
    const painted = await annotationRanges();
    // 吹き出しは2件、塗りも2件: 色つきは自分の色、無印は灰（D78）。「無印は既定色（黄）で
    // 塗る」にも「無印は塗らない」（D65 の旧形）にも倒れていない。
    assert.strictEqual(painted.length, 2, `注釈層の塗りが2件でない: ${JSON.stringify(painted)}`);
    const shape = (r: (typeof painted)[number] | undefined) => ({
      layer: r?.layer,
      color: r?.color,
      startLine: r?.startLine,
      wholeLine: r?.wholeLine,
    });
    const red = painted.find((r) => r.color === "red");
    const grey = painted.find((r) => r.color === "grey");
    assert.deepStrictEqual(
      shape(red),
      { layer: "annotation", color: "red", startLine: startLine - 1, wholeLine: true },
      `色つきの塗りの中身が違う: ${JSON.stringify(painted)}`,
    );
    assert.deepStrictEqual(
      shape(grey),
      { layer: "annotation", color: "grey", startLine: 0, wholeLine: true },
      `無印の塗りの中身が違う: ${JSON.stringify(painted)}`,
    );
    // 灰は塗りだけで、作者名には出ない（注釈の語彙に灰は無い）。絵文字も付かない。
    const bodies = (await inspectVisuals()).annotatedBodies;
    assert.strictEqual(bodies[1]?.author, "2/2 · ShowMe", "無印の作者名が変わった");
  });

  /**
   * **注釈の塗りは注釈の寿命**（増分6 D66）。`clear` で消え、`replace` では古い塗りが
   * 消えて新しい塗りだけが残る。「吹き出しは消えたが塗りが残る」は、`thread.dispose()` と
   * 層の抹消を別々の場所に書いたときの壊れ方である。
   */
  test("mode: clear で注釈の塗りも消え、replace で古い塗りが新しい塗りに置き換わる（D66）", async () => {
    await lendWindow();
    const first = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "1回目", color: "green" },
    ]);
    assert.strictEqual(first[0]?.match, "one", "前提が崩れている");
    await waitFor("塗りが1件になる", async () => (await annotationRanges()).length === 1);

    await annotateClear();
    await waitFor("吹き出しが消える", async () => (await bubbleCount()) === 0);
    assert.deepStrictEqual(await annotationRanges(), [], "clear したのに注釈の塗りが残っている");

    // replace: 別の行へ。古い行の塗りは消え、新しい行だけが塗られている。
    const second = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "古い", color: "red" },
    ]);
    const oldLine = asNumber((second[0]?.range as { startLine?: unknown })?.startLine, "old") - 1;
    await waitFor("古い塗りが貼られる", async () => (await annotationRanges()).length === 1);
    const third = await annotate([
      {
        location: { path: ANNOTATE_REL, lines: { start: 1, end: 1 } },
        text: "新しい",
        color: "blue",
      },
    ]);
    assert.strictEqual(third[0]?.match, "one", "置き換えの前提が崩れている");
    await waitFor("新しい塗りだけになる", async () => {
      const painted = await annotationRanges();
      return painted.length === 1 && painted[0]?.color === "blue";
    });
    const painted = await annotationRanges();
    assert.strictEqual(
      painted[0]?.startLine,
      0,
      `新しい塗りの行が違う: ${JSON.stringify(painted)}`,
    );
    assert.ok(
      !painted.some((r) => r.startLine === oldLine && r.color === "red"),
      `replace したのに古い塗りが残っている: ${JSON.stringify(painted)}`,
    );
  });

  /**
   * **同じ行に `show_code` の塗りと注釈の塗りが同時にあっても、互いを消さない**（§C2）。
   * `setDecorations` は型ごとの全置換なので、2つの書き手が別々に書けば後から書いた
   * ほうが前を消す。画家が1つで両層の和を書いていることを、同じ行で言う。
   */
  test("同じ行に注釈（赤）と show_code（青）を重ねても、両方の層が残る（§C2）", async () => {
    await lendWindow();
    const annotated = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "赤い注釈", color: "red" },
    ]);
    assert.strictEqual(annotated[0]?.match, "one", "注釈の前提が崩れている");
    await waitFor("注釈の塗りが貼られる", async () => (await annotationRanges()).length === 1);

    const shown = await showOne({ path: ANNOTATE_REL, text: ANNOTATE_MARKER, color: "blue" });
    assert.strictEqual(shown.match, "one", "show_code の前提が崩れている");
    await waitFor("スポットライトが貼られる", async () =>
      (await inspectVisuals()).highlightRanges.some(
        (r) => r.layer === "spotlight" && r.uri === annotateUri(),
      ),
    );

    const line = asNumber((annotated[0]?.range as { startLine?: unknown })?.startLine, "line") - 1;
    const onLine = (await inspectVisuals()).highlightRanges
      .filter((r) => r.uri === annotateUri() && r.startLine === line)
      .map((r) => `${r.layer}:${r.color}`)
      .sort();
    assert.deepStrictEqual(
      onLine,
      ["annotation:red", "spotlight:blue"],
      `同じ行に両層が無い: ${onLine.join(", ")}`,
    );
  });

  /**
   * **`annotate` の `location` に `color` は無い**（増分6 D65'）。色は項目の `color` で、
   * 行の塗りと作者名の両方に出る。`location.color` は `show_code` の摘みで、注釈では
   * 効かない ―― 効かない摘みを受けて黙って捨てない。線上と同じ検証で落ちる。
   */
  test("annotate の location.color は線上の検証で落ちる（D65'）", async () => {
    await lendWindow();
    await assert.rejects(
      async () =>
        vscode.commands.executeCommand("showme.test.annotate", {
          items: [
            {
              location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER, color: "red" },
              text: "落ちるはず",
            },
          ],
        }),
      (e: unknown) => String(e).includes("color"),
      "annotate の location.color が通った",
    );
    // 肯定対照: 同じ位置を項目の color で渡せば通る（落ちたのが位置のせいでないこと）。
    const ok = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "通る", color: "red" },
    ]);
    assert.strictEqual(ok[0]?.match, "one", "肯定対照が通らない");
  });

  test("除外パスには注釈を出さない（観測面にも載らない。D72 の「伏せ字の分岐は無い」の根拠）", async () => {
    await lendWindow();
    await annotateClear();
    const resolutions = await annotate([
      { location: { path: ENV_REL, text: "SECRET" }, text: "出ないはず" },
    ]);
    assert.strictEqual(resolutions[0]?.reason, "excluded-path");
    // 出せなかったので番号も無い（D71）。
    assert.ok(!("id" in (resolutions[0] ?? {})), "excluded-path に id が付いた");
    assert.ok(!("index" in (resolutions[0] ?? {})), "excluded-path に index が付いた");
    assert.strictEqual(await bubbleCount(), 0);
    // 注釈が1件も無いので `annotations` は鍵ごと無い。秘匿パスの注釈は**作れない**ので、
    // `get_editor_state.annotations` に伏せ字の分岐は要らない（D72）。
    const state = await getEditorState();
    assert.ok(
      !("annotations" in state),
      `秘匿パスの注釈が観測面に載った: ${JSON.stringify(state.annotations)}`,
    );
  });
});

/**
 * 注釈の**順番と id**（増分6 D69 / D71 / D72）を実 VS Code に当てる。
 *
 * - 作者名の番号（`1/3 · ShowMe 🔴 R`）は**スレッドの `author.name`** で見る（D69）。
 *   単体は偽の vscode で `comments` の再代入までしか見ていない
 * - `resolution` の `id` / `index`（D71）と `get_editor_state.annotations`（D72）が
 *   **同じ数**を言うことを、同じ状態で両方読んで確かめる
 * - 結果は毎回 protocol の結果スキーマを通す（ブリッジが線で当てるのと同じもの。
 *   ここで通らなければ、拡張は動いていてもエージェントには1件も届かない）
 */
suite("実 VS Code / 信頼モード / 注釈の順番と id", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  // 専用の2ファイルを使うが、前の節の残りで予算に当たると「回数制限」が「番号の不具合」に
  // 見える。テストごとに予算を戻しておく。
  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  suiteTeardown(async () => {
    await lendWindow();
    await annotateClear();
  });

  /** 線上の結果スキーマを通してから返す（ブリッジと同じ検証）。 */
  function parsedAnnotate(resolutions: RawResolution[]): Record<string, unknown>[] {
    const parsed = annotateResultSchema.safeParse({ resolutions });
    assert.ok(
      parsed.success,
      `annotate の結果が線上のスキーマを通らない: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`,
    );
    return resolutions;
  }

  async function parsedState(): Promise<Record<string, unknown>> {
    const state = await getEditorState();
    const parsed = getEditorStateResultSchema.safeParse(state);
    assert.ok(
      parsed.success,
      `get_editor_state の結果が線上のスキーマを通らない: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`,
    );
    return state;
  }

  const at = (rel: string, line: number) => ({ path: rel, lines: { start: line, end: line } });

  test("3件出すと resolution に id / index が付き、作者名と annotations が同じ番号を言う（D69 / D71 / D72）", async () => {
    await lendWindow();
    await annotateClear();
    const resolutions = parsedAnnotate(
      await annotate([
        { location: at(ANNOTATE_ORDER_A_REL, 3), text: "1つ目", color: "red" },
        { location: at(ANNOTATE_ORDER_B_REL, 5), text: "2つ目", color: "blue" },
        { location: at(ANNOTATE_ORDER_A_REL, 1), text: "3つ目" },
      ]),
    );
    assert.strictEqual(resolutions.length, 3);
    for (const r of resolutions) assert.strictEqual(r.match, "one", JSON.stringify(r));

    // index は配列の順そのもの。id は窓内で単調増加（前の節が使った分だけ大きい）。
    assert.deepStrictEqual(
      resolutions.map((r) => r.index),
      [1, 2, 3],
      `index が配列の順でない: ${JSON.stringify(resolutions)}`,
    );
    const ids = resolutions.map((r) => asNumber(r.id, "id"));
    assert.ok(ids[0] !== undefined && ids[0] >= 1, "id が 1 未満");
    assert.deepStrictEqual(ids, [ids[0], (ids[0] ?? 0) + 1, (ids[0] ?? 0) + 2], "id が連番でない");
    for (const r of resolutions) {
      for (const key of Object.keys(r)) {
        assert.ok(ALLOWED_ANNOTATE_RESOLUTION_KEYS.has(key), `結果に未知の鍵がある: ${key}`);
      }
    }

    // 作者名（実機のスレッドの `author.name`）。3件なので番号が付く。
    await waitFor(
      "吹き出しが3件になる",
      async () => (await inspectVisuals()).annotatedBodies.length === 3,
    );
    assert.deepStrictEqual(
      (await inspectVisuals()).annotatedBodies.map((b) => b.author),
      ["1/3 · ShowMe 🔴 R", "2/3 · ShowMe 🔵 B", "3/3 · ShowMe"],
    );

    // 観測面。resolution と同じ id / index、相対パス、1始まりの行、resolved: false。
    const state = await parsedState();
    assert.deepStrictEqual(state.annotations, [
      { id: ids[0], index: 1, path: ANNOTATE_ORDER_A_REL, line: 3, color: "red", resolved: false },
      { id: ids[1], index: 2, path: ANNOTATE_ORDER_B_REL, line: 5, color: "blue", resolved: false },
      { id: ids[2], index: 3, path: ANNOTATE_ORDER_A_REL, line: 1, resolved: false },
    ]);
    // 本文はどこにも無い（§C6）。
    assert.ok(!JSON.stringify(state).includes("1つ目"), "get_editor_state に注釈の本文が載った");
  });

  test("mode: add は続き番号で、既存の吹き出しの分母も書き直される（D69）", async () => {
    await lendWindow();
    // 前提: 前のテストの3件が出ている。出ていなければ「分母が更新された」は空虚に真になる。
    assert.strictEqual((await inspectVisuals()).annotatedBodies.length, 3, "前提が崩れている");
    const before = await parsedState();
    const beforeIds = (before.annotations as { id: number }[]).map((a) => a.id);

    const added = parsedAnnotate(
      await annotate(
        [
          { location: at(ANNOTATE_ORDER_B_REL, 2), text: "4つ目", color: "green" },
          { location: at(ANNOTATE_ORDER_B_REL, 4), text: "5つ目", color: "purple" },
        ],
        "add",
      ),
    );
    assert.deepStrictEqual(
      added.map((r) => r.index),
      [4, 5],
      JSON.stringify(added),
    );
    assert.deepStrictEqual(
      added.map((r) => r.id),
      [(beforeIds[2] ?? 0) + 1, (beforeIds[2] ?? 0) + 2],
      "add の id が続き番号でない",
    );

    await waitFor(
      "吹き出しが5件になる",
      async () => (await inspectVisuals()).annotatedBodies.length === 5,
    );
    // **既存の3件の分母が 5 になっている**（`comments` の再代入が実機で効いている）。
    assert.deepStrictEqual(
      (await inspectVisuals()).annotatedBodies.map((b) => b.author),
      [
        "1/5 · ShowMe 🔴 R",
        "2/5 · ShowMe 🔵 B",
        "3/5 · ShowMe",
        "4/5 · ShowMe 🟢 G",
        "5/5 · ShowMe 🟣 P",
      ],
    );
    const state = await parsedState();
    const annotations = state.annotations as { id: number; index: number }[];
    assert.deepStrictEqual(
      annotations.map((a) => a.index),
      [1, 2, 3, 4, 5],
      "annotations の index が読む順でない",
    );
    // 既存の id は変わらない（番号は付け直しても id は据え置き）。
    assert.deepStrictEqual(
      annotations.slice(0, 3).map((a) => a.id),
      beforeIds,
    );
  });

  test("1件だけなら作者名に番号が付かず、annotations は index: 1 の1件（D69）", async () => {
    await lendWindow();
    const resolutions = parsedAnnotate(
      await annotate([{ location: at(ANNOTATE_ORDER_A_REL, 2), text: "ひとつ", color: "yellow" }]),
    );
    assert.strictEqual(resolutions[0]?.index, 1);
    await waitFor(
      "吹き出しが1件になる",
      async () => (await inspectVisuals()).annotatedBodies.length === 1,
    );
    assert.deepStrictEqual(
      (await inspectVisuals()).annotatedBodies.map((b) => b.author),
      ["ShowMe 🟡 Y"],
    );
    const state = await parsedState();
    assert.deepStrictEqual(state.annotations, [
      {
        id: resolutions[0]?.id,
        index: 1,
        path: ANNOTATE_ORDER_A_REL,
        line: 2,
        color: "yellow",
        resolved: false,
      },
    ]);
  });

  test("mode: clear の後は annotations の鍵が無い（D71 / D72）", async () => {
    await lendWindow();
    assert.strictEqual((await inspectVisuals()).annotatedBodies.length, 1, "前提が崩れている");
    const cleared = parsedAnnotate(await annotateClear());
    assert.deepStrictEqual(cleared, []);
    await waitFor(
      "吹き出しが消える",
      async () => (await inspectVisuals()).annotatedBodies.length === 0,
    );
    const state = await parsedState();
    assert.ok(
      !("annotations" in state),
      `clear したのに annotations が残っている: ${JSON.stringify(state.annotations)}`,
    );
  });

  /**
   * 人間の読了は1ビット（§C3 / D70）。吹き出しのボタンが渡す引数（スレッド）で
   * **本物の命令**（`showme.annotation.resolve` / `unresolve`）を呼び、`get_editor_state` の
   * `resolved` が反転することを見る。番号（作者名）と id は変わらない ―― 順番は案内であって
   * 未読管理ではない。
   */
  test("Resolve / Unresolve の命令で annotations[].resolved が反転し、番号は変わらない（D70 / D72）", async () => {
    await lendWindow();
    const resolutions = parsedAnnotate(
      await annotate([
        { location: at(ANNOTATE_ORDER_A_REL, 3), text: "読んで", color: "red" },
        { location: at(ANNOTATE_ORDER_B_REL, 5), text: "これも" },
      ]),
    );
    const ids = resolutions.map((r) => asNumber(r.id, "id"));
    const first = ids[0];
    assert.ok(first !== undefined, "id が無い");
    await waitFor(
      "吹き出しが2件になる",
      async () => (await inspectVisuals()).annotatedBodies.length === 2,
    );
    const authorsBefore = (await inspectVisuals()).annotatedBodies.map((b) => b.author);
    assert.deepStrictEqual(authorsBefore, ["1/2 · ShowMe 🔴 R", "2/2 · ShowMe"]);
    const resolvedOf = async (): Promise<boolean[]> =>
      ((await parsedState()).annotations as { resolved: boolean }[]).map((a) => a.resolved);
    assert.deepStrictEqual(await resolvedOf(), [false, false]);

    // ボタンが渡すのと同じ引数（スレッドそのもの）で本物の命令を呼ぶ。
    const thread = await annotationThread(first);
    await vscode.commands.executeCommand("showme.annotation.resolve", thread);
    assert.deepStrictEqual(await resolvedOf(), [true, false], "1件目だけが resolved になる");
    assert.strictEqual(thread.state, vscode.CommentThreadState.Resolved);
    // `when` 句が見る値は読了と位置の1つの文字列（D79）。1件目なので first。
    assert.strictEqual(thread.contextValue, "resolved first", "メニューの when が見る値");

    await vscode.commands.executeCommand("showme.annotation.unresolve", thread);
    assert.deepStrictEqual(await resolvedOf(), [false, false]);
    assert.strictEqual(thread.state, vscode.CommentThreadState.Unresolved);
    assert.strictEqual(thread.contextValue, "unresolved first");

    // 番号と id は据え置き。
    assert.deepStrictEqual(
      (await inspectVisuals()).annotatedBodies.map((b) => b.author),
      authorsBefore,
    );
    assert.deepStrictEqual(
      ((await parsedState()).annotations as { id: number }[]).map((a) => a.id),
      ids,
    );
  });

  test("自分のストアに無いスレッド（形だけ同じ object）を渡しても投げず、何も変わらない（D70）", async () => {
    await lendWindow();
    assert.strictEqual((await inspectVisuals()).annotatedBodies.length, 2, "前提が崩れている");
    const state = await parsedState();
    const annotations = state.annotations as { id: number; resolved: boolean }[];
    assert.deepStrictEqual(
      annotations.map((a) => a.resolved),
      [false, false],
    );
    const own = await annotationThread(annotations[0]?.id ?? -1);
    // 中身を写した別オブジェクト。`when` を通り抜けて executeCommand で渡ってきた形。
    const foreign = {
      uri: own.uri,
      range: own.range,
      comments: own.comments,
      state: vscode.CommentThreadState.Unresolved,
      contextValue: "unresolved first",
    };
    await vscode.commands.executeCommand("showme.annotation.resolve", foreign);
    await vscode.commands.executeCommand("showme.annotation.resolve", undefined);
    await vscode.commands.executeCommand("showme.annotation.resolve", "not a thread");
    assert.deepStrictEqual(
      ((await parsedState()).annotations as { resolved: boolean }[]).map((a) => a.resolved),
      [false, false],
      "他人のスレッドで自分の注釈が resolved になった",
    );
    assert.strictEqual(
      foreign.state,
      vscode.CommentThreadState.Unresolved,
      "他人の object に書いた",
    );
    assert.strictEqual(foreign.contextValue, "unresolved first");
  });

  test("吹き出しに他の UI は無い: canReply false、範囲プロバイダもリアクションの口も無い（D70）", async () => {
    await lendWindow();
    const visuals = await inspectVisuals();
    assert.strictEqual(visuals.annotatedBodies.length, 2, "前提が崩れている");
    assert.deepStrictEqual(visuals.annotationUi.canReply, [false, false]);
    assert.strictEqual(visuals.annotationUi.hasCommentingRangeProvider, false);
    assert.strictEqual(visuals.annotationUi.hasReactionHandler, false);
  });

  // D70 の2件は suiteTeardown（`annotateClear`）が消す。
});

/**
 * 人間向けの消す命令（増分6 D68）。**ShowMe: Clear highlights** / **ShowMe: Clear annotations**。
 *
 * どちらも人間の操作であって、エージェントへの入力路ではない（§C5: 設定が縛るのは
 * エージェントであって人間ではない）。だから窓を預けていなくても効く。
 * 2つは独立している ―― Clear highlights は `show_code` のスポットライトだけ、
 * Clear annotations は吹き出しと注釈の塗りだけを消す。片方を消して他方が残ることを
 * 同じ観測で言わないと、両層ごと消す実装でも片方ずつは緑になる。
 */
suite("実 VS Code / 信頼モード / 人間の消す命令（D68）", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  /** 両方を消して次の節に持ち越さない。命令そのものが役割に依らず効くので、預け直さない。 */
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("showme.clearAnnotations");
    await vscode.commands.executeCommand("showme.clearHighlights");
  });

  const uriOf = (rel: string): string => vscode.Uri.joinPath(workspaceRoot(), rel).toString();
  const annotationLayer = (visuals: VisualState): VisualState["highlightRanges"] =>
    visuals.highlightRanges.filter((r) => r.layer === "annotation");
  const isTabOpen = (uri: string): boolean =>
    vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri,
      ),
    );

  test("Clear highlights でスポットライトが消え、タブは開いたまま", async () => {
    await lendWindow();
    const rel = STAGE_RELS[0];
    assert.ok(rel, "舞台用のフィクスチャが足りない");
    const uri = uriOf(rel);
    const shown = await showOne({ path: rel, text: STAGE_MARKER });
    assert.strictEqual(shown.match, "one", "show_code の前提が崩れている");
    await waitFor("スポットライトが貼られる", async () =>
      (await inspectVisuals()).highlightedUris.includes(uri),
    );

    await vscode.commands.executeCommand("showme.clearHighlights");

    const after = await inspectVisuals();
    assert.deepStrictEqual(
      after.highlightedUris,
      [],
      `Clear highlights の後に塗りが残っている: ${after.highlightedUris.join(", ")}`,
    );
    // 消したのは塗りであって、タブではない。タブが閉じたから塗りが無いのではない。
    assert.ok(isTabOpen(uri), "Clear highlights がタブを閉じた");
  });

  test("Clear annotations で吹き出しと注釈の塗りが消え、別ファイルのスポットライトは残る", async () => {
    await lendWindow();
    const stageRel = STAGE_RELS[1];
    assert.ok(stageRel, "舞台用のフィクスチャが足りない");
    const stageUri = uriOf(stageRel);
    const shown = await showOne({ path: stageRel, text: STAGE_MARKER, color: "blue" });
    assert.strictEqual(shown.match, "one", "show_code の前提が崩れている");
    await waitFor("スポットライトが貼られる", async () =>
      (await inspectVisuals()).highlightedUris.includes(stageUri),
    );
    const annotated = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "消える", color: "red" },
    ]);
    assert.strictEqual(annotated[0]?.match, "one", "注釈の前提が崩れている");
    await waitFor(
      "注釈の塗りが貼られる",
      async () => annotationLayer(await inspectVisuals()).length === 1,
    );
    // 前提: 消す前に両方が出ている。出ていなければ「消えた」は空虚に真になる。
    const before = await inspectVisuals();
    assert.strictEqual(before.annotatedUris.length, 1, "前提が崩れている（吹き出しが無い）");
    assert.ok(
      before.highlightedUris.includes(stageUri),
      "前提が崩れている（スポットライトが無い）",
    );

    await vscode.commands.executeCommand("showme.clearAnnotations");

    await waitFor(
      "吹き出しが消える",
      async () => (await inspectVisuals()).annotatedUris.length === 0,
    );
    const after = await inspectVisuals();
    assert.deepStrictEqual(after.annotatedUris, [], "吹き出しが残っている");
    // 注釈の塗りは注釈と一緒に消える（D66 の経路の1つ）。
    assert.deepStrictEqual(
      annotationLayer(after),
      [],
      `注釈の塗りが残っている: ${JSON.stringify(after.highlightRanges)}`,
    );
    // スポットライトは Clear annotations の対象ではない。
    assert.deepStrictEqual(
      after.highlightedUris,
      [stageUri],
      `Clear annotations がスポットライトに触った: ${after.highlightedUris.join(", ")}`,
    );
  });

  test("同じ行の注釈は Clear highlights で消えない（2つの命令は独立）", async () => {
    await lendWindow();
    const uri = uriOf(ANNOTATE_REL);
    const annotated = await annotate([
      { location: { path: ANNOTATE_REL, text: ANNOTATE_MARKER }, text: "残る", color: "red" },
    ]);
    assert.strictEqual(annotated[0]?.match, "one", "注釈の前提が崩れている");
    const line = asNumber((annotated[0]?.range as { startLine?: unknown })?.startLine, "line") - 1;
    const shown = await showOne({ path: ANNOTATE_REL, text: ANNOTATE_MARKER, color: "blue" });
    assert.strictEqual(shown.match, "one", "show_code の前提が崩れている");
    const layersOnLine = async (): Promise<string[]> =>
      (await inspectVisuals()).highlightRanges
        .filter((r) => r.uri === uri && r.startLine === line)
        .map((r) => `${r.layer}:${r.color}`)
        .sort();
    await waitFor("同じ行に両層が載る", async () => (await layersOnLine()).length === 2);
    assert.deepStrictEqual(await layersOnLine(), ["annotation:red", "spotlight:blue"]);

    await vscode.commands.executeCommand("showme.clearHighlights");

    const after = await inspectVisuals();
    assert.deepStrictEqual(
      await layersOnLine(),
      ["annotation:red"],
      `Clear highlights が注釈の塗りに触った: ${JSON.stringify(after.highlightRanges)}`,
    );
    assert.strictEqual(after.annotatedUris.length, 1, "Clear highlights が吹き出しを消した");
  });

  test("窓を預けていなくても命令は登録されていて、呼んでも失敗しない（§C5）", async () => {
    await setRole("idle");
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["showme.clearHighlights", "showme.clearAnnotations"]) {
      assert.ok(commands.includes(id), `コマンドが登録されていない: ${id}`);
      // 人間の操作なので役割で拒否しない。消すものが無くても成功する。
      await vscode.commands.executeCommand(id);
    }
    const after = await inspectVisuals();
    assert.deepStrictEqual(after.highlightedUris, []);
    assert.deepStrictEqual(after.annotatedUris, []);
  });
});

/**
 * 信頼モードでの `symbol` 解決（設計書 §3.4 / §3.5）。
 *
 * 制限モード側の `restricted-mode` は、**信頼モードで同じ `.ts` が実際に
 * 解決される**ことと対で初めて意味を持つ。片方だけだと、シンボルを一度も
 * 引かない実装（`isTrusted ? … : …` の1行）でも通ってしまう。
 */
/**
 * 吹き出しの ‹ › （増分6.1 D79 / D77）。**起点は押した吹き出し**で、パレットの命令は無い。
 *
 * `comments/commentThread/title` のボタンが渡すスレッドを `executeCommand` に渡す（Resolve と
 * 同じ経路。`showme.test.annotationThread` で本物のスレッドを取る）。隣（`index` ± 1）へ
 * 進み、読了済みは飛ばさず（§C3）、端では何もしない（ボタンは `contextValue` で消えている）。
 *
 * **開き方は人間の規則**（§C5。`human-reveal.ts`）: 飛び先が既に見えていればそのエディタで、
 * 無ければ**人間の今の列**に開き、**フォーカスも移す**。`show_code` の `Stage.open` ではない
 * ので、舞台の列は増えず、開いたタブは own にならない（人間のもの）。
 * 設定が縛るのはエージェントであって人間ではない ―― `stage.enabled: false` でも動く（D77）。
 *
 * 「その行が見える」は 200 行のファイル（`TOUR_RELS`）で言う ―― 短いファイルは全行が可視で、
 * どの行に案内しても緑になる。
 */
suite("実 VS Code / 信頼モード / 注釈の案内（D79 / D77）", () => {
  const [aRel, bRel] = TOUR_RELS;
  const aUri = vscode.Uri.joinPath(workspaceRoot(), aRel);
  const bUri = vscode.Uri.joinPath(workspaceRoot(), bRel);
  const at = (rel: string, line: number) => ({ path: rel, lines: { start: line, end: line } });
  /**
   * 案内先（1始まりの行）。a.md に 3件、b.md に 2件。2件目は 1件目と同じファイルの遠い行で、
   * 「行が変わった」を可視範囲で見る（5 と 150 は同時に見えない ―― D73 の検査で実測済み）。
   */
  const A1 = 5;
  const A2 = TOUR_LINES - 50;
  const A3 = 10;
  const B4 = 3;
  const B5 = TOUR_LINES - 50;

  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  teardown(async () => {
    await closeTabsOf(aUri, bUri);
  });

  suiteTeardown(async () => {
    await lendWindow();
    await annotateClear();
    await arrangeEditors("close-own");
  });

  /** いまのタブの集合を、列ごとに（列の位置と中身の両方）。 */
  function tabSnapshot(): { column: vscode.ViewColumn; tabs: string[] }[] {
    return vscode.window.tabGroups.all.map((group) => ({
      column: group.viewColumn,
      tabs: group.tabs.map((tab) => tab.label).sort(),
    }));
  }

  /** その列のタブの枚数。 */
  function tabCountIn(column: vscode.ViewColumn): number {
    return vscode.window.tabGroups.all.find((g) => g.viewColumn === column)?.tabs.length ?? 0;
  }

  /** そのファイルが可視で、その行（1始まり）が可視範囲に入っている。 */
  function shows(uri: vscode.Uri, line: number): boolean {
    const editor = visibleEditorFor(uri);
    return editor !== undefined && showsLine(editor, line - 1);
  }

  /** 人間が開いたタブは own ではないので `close-own` では消えない。テストが自分で閉じる。 */
  async function closeTabsOf(...uris: vscode.Uri[]): Promise<void> {
    const keys = new Set(uris.map((u) => u.toString()));
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (tab) => tab.input instanceof vscode.TabInputText && keys.has(tab.input.uri.toString()),
      );
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
  }

  /** 人間が a.md を 1列目に開いて見ている状態を作る。 */
  async function humanOpens(uri: vscode.Uri, column: vscode.ViewColumn): Promise<void> {
    await vscode.window.showTextDocument(uri, { viewColumn: column, preview: false });
    await waitFor(
      "人間のエディタが前面になる",
      () => activeEditorSnapshot() === `${String(column)}:${uri.toString()}`,
    );
  }

  async function fiveAnnotations(): Promise<number[]> {
    const resolutions = await annotate([
      { location: at(aRel, A1), text: "1つ目", color: "red" },
      { location: at(aRel, A2), text: "2つ目", color: "blue" },
      { location: at(aRel, A3), text: "3つ目" },
      { location: at(bRel, B4), text: "4つ目", color: "green" },
      { location: at(bRel, B5), text: "5つ目" },
    ]);
    assert.deepStrictEqual(
      resolutions.map((r) => r.match),
      ["one", "one", "one", "one", "one"],
      JSON.stringify(resolutions),
    );
    await waitFor(
      "吹き出しが5件になる",
      async () => (await inspectVisuals()).annotatedBodies.length === 5,
    );
    return resolutions.map((r) => asNumber(r.id, "id"));
  }

  test("› は見えているエディタでは行だけ動かし、無いファイルは人間の列に開いてフォーカスを移す（D79）", async () => {
    assert.ok(
      !tabSnapshot().some((g) => g.tabs.includes("a.md") || g.tabs.includes("b.md")),
      "前提が崩れている: tour/*.md が既に開いている",
    );
    const ids = await fiveAnnotations();
    const threads = await Promise.all(ids.map((id) => annotationThread(id)));
    const [t1, t2, t3, t4, t5] = threads;
    assert.ok(t1 && t2 && t3 && t4 && t5, "スレッドが取れない");

    // 端の印は contextValue にある（‹ › の when 句が読む）。
    assert.match(t1.contextValue ?? "", /^unresolved first$/);
    assert.match(t3.contextValue ?? "", /^unresolved middle$/);
    assert.match(t5.contextValue ?? "", /^unresolved last$/);

    // 人間が a.md を 1列目で見ている。人間の列は**観測する**（推測しない）。
    await humanOpens(aUri, vscode.ViewColumn.One);
    const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const groupsBefore = vscode.window.tabGroups.all.length;
    const tabsBefore = tabCountIn(humanColumn);

    // --- 1件目 の › → 2件目（同じファイルの遠い行）。同じエディタで行が動き、タブも列も増えない ---
    t2.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    await vscode.commands.executeCommand("showme.annotation.next", t1);
    await waitFor("2件目の行が見える", () => shows(aUri, A2));
    assert.ok(!shows(aUri, A1), "2件目に進んだのに1件目の行がまだ見えている（動いていない）");
    assert.strictEqual(activeEditorSnapshot(), `${String(humanColumn)}:${aUri.toString()}`);
    assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore, "列が増えた");
    assert.strictEqual(tabCountIn(humanColumn), tabsBefore, "同じファイルなのにタブが増えた");
    // 開き直し（`annotations.expand`）は行を見せた**後**に起きる。行が見えた時点で
    // 同期に見ると、遅い機械では畳んだままの瞬間を撮る（CI で実測: 0 !== 1）。
    await waitFor(
      "案内した吹き出しが開き直される",
      () => t2.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
    );

    // --- 2件目 の › → 3件目 ---
    await vscode.commands.executeCommand("showme.annotation.next", t2);
    await waitFor("3件目の行が見える", () => shows(aUri, A3));

    // --- 3件目 の › → 4件目（別のファイル）。人間の列に新しいタブで開き、フォーカスが移る ---
    await vscode.commands.executeCommand("showme.annotation.next", t3);
    await waitFor("4件目のファイルが人間の列に開く", () => shows(bUri, B4));
    await waitFor(
      "フォーカスが飛び先に移る",
      () => activeEditorSnapshot() === `${String(humanColumn)}:${bUri.toString()}`,
    );
    assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore, "舞台の列が増えた");
    assert.strictEqual(tabCountIn(humanColumn), tabsBefore + 1, "人間の列にタブが1枚増えていない");
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, humanColumn);
    // 人間の命令で開いたタブは人間のもの（own ではない。線上では `own` の鍵ごと無い）。
    const tabB = layoutTabs(await getEditorState()).find((tab) => tab.path === bRel);
    assert.ok(tabB, "get_editor_state に案内で開いたタブが無い");
    assert.ok(!("own" in tabB), `人間の命令で開いたタブが own になった: ${JSON.stringify(tabB)}`);

    // --- 4件目 の › → 5件目（同じファイルの遠い行） ---
    await vscode.commands.executeCommand("showme.annotation.next", t4);
    await waitFor("5件目の行が見える", () => shows(bUri, B5));
    assert.ok(!shows(bUri, B4), "5件目に進んだのに4件目の行がまだ見えている");

    // --- 末尾: 5件目 の › は何もしない（ボタンは無いが executeCommand は呼べる） ---
    const atEnd = tabSnapshot();
    const activeAtEnd = activeEditorSnapshot();
    await vscode.commands.executeCommand("showme.annotation.next", t5);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepStrictEqual(tabSnapshot(), atEnd, "末尾の › がタブを変えた");
    assert.strictEqual(activeEditorSnapshot(), activeAtEnd, "末尾の › がフォーカスを動かした");

    // --- 4件目 の ‹ → 3件目。a.md は同じ列に開いたままなので、そのタブに戻る（増えない） ---
    await vscode.commands.executeCommand("showme.annotation.previous", t4);
    await waitFor("3件目の行に戻る", () => shows(aUri, A3));
    await waitFor(
      "フォーカスが a.md に戻る",
      () => activeEditorSnapshot() === `${String(humanColumn)}:${aUri.toString()}`,
    );
    assert.strictEqual(tabCountIn(humanColumn), tabsBefore + 1, "戻るときにタブが増えた");
    assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore);

    // --- 先頭: 1件目 の ‹ は何もしない ---
    const atStart = tabSnapshot();
    await vscode.commands.executeCommand("showme.annotation.previous", t1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepStrictEqual(tabSnapshot(), atStart, "先頭の ‹ がタブを変えた");

    // --- 読了済みは飛ばさない: 2件目 を Resolve しても 1件目 の › は 2件目 に行く ---
    await vscode.commands.executeCommand("showme.annotation.resolve", t2);
    assert.strictEqual(t2.state, vscode.CommentThreadState.Resolved);
    assert.strictEqual(t2.contextValue, "resolved middle", "読了で位置が落ちた");
    await vscode.commands.executeCommand("showme.annotation.next", t1);
    await waitFor("読了済みの2件目に進む", () => shows(aUri, A2));
    assert.strictEqual(t2.state, vscode.CommentThreadState.Resolved, "案内が読了を変えた");

    // 人間が開いたタブは own ではないので close-own では消えない（teardown が閉じる）。
    const cleaned = await arrangeEditors("close-own");
    assert.strictEqual(cleaned.done, true, JSON.stringify(cleaned));
    assert.ok(
      tabSnapshot().some((g) => g.tabs.includes("a.md")),
      "close-own が人間のタブを閉じた",
    );
    assert.ok(
      tabSnapshot().some((g) => g.tabs.includes("b.md")),
      "close-own が人間のタブを閉じた",
    );
  });

  test("飛び先が別の列に見えていれば、その列のエディタで行を出し、フォーカスをそちらに移す（D79）", async () => {
    await annotateClear();
    const ids = await fiveAnnotations();
    const [t3] = await Promise.all([annotationThread(ids[2] ?? -1)]);
    // b.md を 2列目に、a.md を 1列目に開き、人間は 1列目を見ている。
    await humanOpens(bUri, vscode.ViewColumn.Two);
    await humanOpens(aUri, vscode.ViewColumn.One);
    // 列は観測する（推測しない）: b.md が見えている列と、人間が今いる列は別。
    const bColumn = visibleEditorFor(bUri)?.viewColumn;
    const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    assert.ok(
      bColumn !== undefined && bColumn !== humanColumn,
      "前提が崩れている: b.md が別の列に見えていない",
    );
    const before = tabSnapshot();
    const groupsBefore = vscode.window.tabGroups.all.length;

    await vscode.commands.executeCommand("showme.annotation.next", t3);
    await waitFor("4件目の行が b.md の列で見える", () => shows(bUri, B4));
    await waitFor(
      "フォーカスが b.md の列に移る",
      () => activeEditorSnapshot() === `${String(bColumn)}:${bUri.toString()}`,
    );
    assert.strictEqual(
      visibleEditorFor(bUri)?.viewColumn,
      bColumn,
      "見えている列を使わず別に開いた",
    );
    assert.deepStrictEqual(tabSnapshot(), before, "見えているのにタブが増えた");
    assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore);
  });

  test("stage.enabled: false でも人間の › はファイルを開く（D77 / §C5）", async () => {
    await annotateClear();
    await setGlobal("stage.enabled", false);
    try {
      assertGlobal("stage.enabled", false);
      assert.strictEqual((await listWorkspaces()).features.stage, false, "前提が崩れている");
      // annotate は核（切れない）なので、stage を切っていても出せる。
      const resolutions = await annotate([
        { location: at(bRel, B4), text: "見て" },
        { location: at(bRel, B5), text: "次も" },
      ]);
      assert.deepStrictEqual(
        resolutions.map((r) => r.match),
        ["one", "one"],
      );
      const first = await annotationThread(asNumber(resolutions[0]?.id, "id"));
      await humanOpens(aUri, vscode.ViewColumn.One);
      const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const groupsBefore = vscode.window.tabGroups.all.length;
      await vscode.commands.executeCommand("showme.annotation.next", first);
      await waitFor("stage を切っていても案内でファイルが開く", () => shows(bUri, B5));
      assert.strictEqual(visibleEditorFor(bUri)?.viewColumn, humanColumn, "人間の列に開いていない");
      assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore, "列が増えた");
    } finally {
      await setGlobal("stage.enabled", undefined);
    }
    assertGlobal("stage.enabled", undefined);
  });

  test("自分のものでないスレッドと、clear の後の古いスレッドでは何もしない（投げない）", async () => {
    await annotateClear();
    const resolutions = await annotate([
      { location: at(aRel, A1), text: "消える1" },
      { location: at(aRel, A2), text: "消える2" },
    ]);
    const stale = await annotationThread(asNumber(resolutions[0]?.id, "id"));
    await humanOpens(aUri, vscode.ViewColumn.One);

    /**
     * **「動かない」は、可視範囲の同一性では言えない。**
     *
     * 吹き出しはエディタの中に場所を取るので、描画と `clear` による撤去で
     * 可視範囲の行の窓が数行ぶん伸び縮みする ―― それは VS Code の正しい振る舞いである。
     * 可視範囲をそのまま比べると、その動きを**案内のせい**として告発する
     * （CI で 3 回連続 `[[133,156]]` → `[[137,160]]`、手元でも `[[131,149]]` と、
     * 値は環境で変わるが向きは同じ）。
     *
     * この検査が言いたいのは「無効な起点では**案内が起きない**」なので、そのとおりに測る:
     * 先頭に寄せてから叩き、**遠い行（A2）が見えないまま**であることを見る。
     * 吹き出しの伸び縮み（数行）では、先頭から 150 行目は決して見えない。
     */
    const editorFor = (): vscode.TextEditor => {
      const editor = visibleEditorFor(aUri);
      assert.ok(editor !== undefined, "a.md が可視でない");
      return editor;
    };
    const parkAtTop = async (): Promise<void> => {
      editorFor().revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
      await waitFor("先頭に寄せる", () => shows(aUri, 1));
    };
    const assertNoGuidance = async (
      label: string,
      tabs: ReturnType<typeof tabSnapshot>,
      active: ReturnType<typeof activeEditorSnapshot>,
    ): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepStrictEqual(tabSnapshot(), tabs, `${label}でタブが変わった`);
      assert.strictEqual(activeEditorSnapshot(), active, `${label}でフォーカスが動いた`);
      assert.ok(!shows(aUri, A2), `${label}で遠い行が見えた（案内が起きている）`);
      assert.ok(shows(aUri, 1), `${label}で先頭から離れた`);
    };

    // 吹き出しがある状態で、自分のものでない起点を叩く。
    await parkAtTop();
    let tabs = tabSnapshot();
    let active = activeEditorSnapshot();
    // 形だけ同じ object（自分の一覧に無い）。
    await vscode.commands.executeCommand("showme.annotation.next", { uri: aUri, comments: [] });
    await vscode.commands.executeCommand("showme.annotation.previous", { uri: aUri, comments: [] });
    // 形が違うもの。
    await vscode.commands.executeCommand("showme.annotation.next", undefined);
    await vscode.commands.executeCommand("showme.annotation.next", "thread");
    await assertNoGuidance("自分のものでない起点", tabs, active);

    // clear の後は古いスレッドが一覧に無い。吹き出しが消える分の動きは案内の仕業ではないので、
    // 撤去が終わってから寄せ直して測る。
    await annotateClear();
    await parkAtTop();
    tabs = tabSnapshot();
    active = activeEditorSnapshot();
    await vscode.commands.executeCommand("showme.annotation.next", stale);
    await vscode.commands.executeCommand("showme.annotation.previous", stale);
    await assertNoGuidance("clear の後の古い起点", tabs, active);
  });

  test("窓を預けていなくても案内の命令は登録されていて、呼んでも失敗しない（§C5）", async () => {
    await setRole("idle");
    try {
      const commands = await vscode.commands.getCommands(true);
      for (const id of ["showme.annotation.next", "showme.annotation.previous"]) {
        assert.ok(commands.includes(id), `コマンドが登録されていない: ${id}`);
      }
      // 預けていない窓には注釈が無い（役割の解除で消える）ので、起点が無く何も起きない。
      await vscode.commands.executeCommand("showme.annotation.next", { uri: aUri, comments: [] });
      await vscode.commands.executeCommand("showme.annotation.previous", {
        uri: aUri,
        comments: [],
      });
    } finally {
      await lendWindow();
    }
  });
});

suite("実 VS Code / 信頼モード / symbol 解決", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("信頼モードでは .ts のシンボルが実際に解決され、その位置が開く", async () => {
    await lendWindow();
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const resolution = await showOne({ path: SAMPLE_REL, symbol: TS_SYMBOL });

    assert.strictEqual(
      resolution.match,
      "one",
      `信頼モードで .ts のシンボルが解決されなかった（reason: ${String(resolution.reason)}）`,
    );
    assert.strictEqual(resolution.resolvedBy, "symbol");
    const range = resolution.range as { startLine: number; endLine: number } | undefined;
    assert.ok(range, "range が無い");
    // フィクスチャの `function target()` は1行目から3行目。
    assert.strictEqual(range.startLine, 1, "解決された行がフィクスチャの実際の位置と違う");
    assert.ok(range.endLine >= 1, "endLine が無い");
    await waitFor("対象ファイルが可視エディタに現れる", () => visibleEditorFor(uri) !== undefined);
  });

  test("一覧は取れるが名前が無ければ not-found（no-provider ではない）", async () => {
    await lendWindow();
    const resolution = await showOne({ path: SAMPLE_REL, symbol: "thisSymbolDoesNotExist" });
    assert.strictEqual(resolution.match, "none");
    assert.strictEqual(
      resolution.reason,
      "not-found",
      "一覧が取れているのに not-found を名乗っていない（プロバイダの有無と混ざっている）",
    );
  });

  test("symbol で解決した位置にも注釈を出せる", async () => {
    await lendWindow();
    const resolutions = await annotate([
      { location: { path: SAMPLE_REL, symbol: TS_SYMBOL }, text: "シンボルで指した説明" },
    ]);
    assert.strictEqual(resolutions[0]?.match, "one");
    assert.strictEqual(resolutions[0]?.resolvedBy, "symbol");
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL).toString();
    await waitFor("吹き出しが立つ", async () =>
      (await inspectVisuals()).annotatedUris.includes(uri),
    );
    // 後始末（次のスイートに吹き出しを持ち越さない）。
    await annotate([{ location: { path: SAMPLE_REL, text: DEEP_TEXT }, text: "後始末" }]);
  });
});

/**
 * 2B の存在理由（設計書 §3.1 / §3.2）。**「これ何？」が成立すること。**
 *
 * 人間がエディタで選ぶ → `get_editor_state` がそのテキストを返す →
 * `annotate` がその行の下に説明を出す。この3つが繋がって初めて、この道具は
 * 一方向でなくなる。
 *
 * 単体テストは偽の面に対して判定だけを見ている。本物の `window.state.focused` /
 * `activeTextEditor` / `tabGroups` が絡んだときに同じ答えになるかは、ここでしか
 * 判別しない。
 */
suite("実 VS Code / 信頼モード / 双方向（これ何？）", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  /** 人間がファイルを開く。**自分の列に、フォーカスごと**（エージェントの経路は通らない）。 */
  async function humanOpens(rel: string): Promise<vscode.TextEditor> {
    const uri = vscode.Uri.joinPath(workspaceRoot(), rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
  }

  /** 人間が語を選ぶ。返すのは1始まりの行番号（線上の数え方）。 */
  function humanSelects(editor: vscode.TextEditor, marker: string): number {
    const index = editor.document.getText().indexOf(marker);
    assert.ok(index >= 0, `フィクスチャに ${marker} が無い`);
    const start = editor.document.positionAt(index);
    const end = editor.document.positionAt(index + marker.length);
    editor.selection = new vscode.Selection(start, end);
    return start.line + 1;
  }

  test("人間が選んだテキストが返り、その行に説明が出る（2B の主たる流れ）", async () => {
    await lendWindow();
    const editor = await humanOpens(EDITOR_STATE_REL);
    const line = humanSelects(editor, EDITOR_STATE_MARKER);

    const state = await waitForSharedSelection();
    assert.strictEqual(state.activePath, EDITOR_STATE_REL, "人間が見ているファイルが返らない");
    assert.strictEqual(
      state.selectedText,
      EDITOR_STATE_MARKER,
      "人間が選んだテキストがそのまま返らない",
    );
    const selection = state.selection as { startLine: number } | undefined;
    assert.ok(selection, "selection が返らない");
    assert.strictEqual(selection.startLine, line, "返った選択範囲が人間の選んだ行と違う");

    // エージェントが、その同じ行に説明を出す。**本文は複数行**にする ――
    // 改行が潰れていると、ここが1行に化ける（実際に化けていた）。
    const explanation = "これは目印の行である。\n\n人間が選んだのはこの語で、説明はその下に出る。";
    const resolutions = await annotate([
      { location: { path: EDITOR_STATE_REL, text: EDITOR_STATE_MARKER }, text: explanation },
    ]);
    assert.strictEqual(resolutions[0]?.match, "one", "選んだ行に注釈を出せなかった");
    const range = resolutions[0]?.range as { startLine: number } | undefined;
    assert.ok(range, "range が無い");
    assert.strictEqual(range.startLine, line, "注釈が出た行が、人間の選んだ行と違う");

    const uri = vscode.Uri.joinPath(workspaceRoot(), EDITOR_STATE_REL).toString();
    await waitFor("吹き出しが立つ", async () =>
      (await inspectVisuals()).annotatedUris.includes(uri),
    );

    // 本文が実機の吹き出しにどう載ったか。**改行が残っていること**まで見る。
    const bodies = (await inspectVisuals()).annotatedBodies;
    assert.strictEqual(bodies.length, 1, "吹き出しが1件でない");
    const bubble = bodies[0];
    assert.ok(bubble, "吹き出しの本文が読めない");
    assert.strictEqual(bubble.kind, "string", "本文が文字列で渡っていない（設計書 §3.2.1）");
    assert.strictEqual(bubble.text, explanation, "本文が送ったものと違う（改行が潰れている）");
    assert.ok(bubble.text.includes("\n"), "本文の改行が失われている（説明が1行に潰れている）");
  });

  test("同じ選択は二度返らない（人間が動かすまで）", async () => {
    await lendWindow();
    const editor = await humanOpens(EDITOR_STATE_REL);
    // **他のテストと違う範囲を選ぶ。** 記憶は直前の1つなので、前のテストが
    // 返した範囲をそのまま選ぶと、最初から `already-returned` になる
    // ―― それはこのテストが見たいものではない（実際に一度そうなった）。
    humanSelects(editor, "editor state");

    await waitForSharedSelection();
    const again = await getEditorState();
    assert.strictEqual(again.selectedText, undefined, "同じ選択が二度返った");
    assert.strictEqual(again.selectionWithheld, "already-returned");
  });

  /**
   * **エージェントが作った選択は返らない。**
   *
   * `show_code` は `TextEditor.selection` を変更しない（不変条件3）。これと
   * 「人間由来の選択だけを返す」（§3.1）は**対で意味を持つ**ので、どちらかが
   * 崩れたときに落ちる形で置く。
   */
  test("show_code の直後は、選択があっても返さない（too-soon-after-tool）", async () => {
    await lendWindow();
    const editor = await humanOpens(EDITOR_STATE_REL);
    humanSelects(editor, EDITOR_STATE_MARKER);

    // エージェントが別のファイルを舞台に開く。人間の選択には触らないはず。
    await showCode([{ path: SAMPLE_REL, text: UNIQUE_TEXT }]);

    const state = await getEditorState();
    assert.strictEqual(
      state.selectedText,
      undefined,
      "自ツール呼び出しの直後に選択テキストが返った",
    );
    assert.strictEqual(state.selectionWithheld, "too-soon-after-tool");
  });

  /**
   * 合成攻撃そのもの: `show_code` で開いた側に人間が移っても、**そこに人間の
   * 選択は無い**。
   *
   * 上のテストは時間の窓しか見ていない。`show_code` が開いたエディタに選択を
   * 代入していると、待ちが明けた瞬間に**エージェントが選んだファイルの生テキスト**
   * が返る ―― 人間は一度も選んでいないのに、である。だから待ちを明けてから見る。
   */
  test("エージェントが開いた側に人間が移っても、選択テキストは返らない", async () => {
    await lendWindow();
    const human = await humanOpens(EDITOR_STATE_REL);
    humanSelects(human, EDITOR_STATE_MARKER);

    // **このファイルは他のテストが一度も触っていない。** 触られたファイルを
    // 使うと、そのテストが付けた選択が舞台のエディタに残り、`show_code` が
    // 作った選択と見分けが付かない（一度そう誤った。fixture の COMPOSITION_REL）。
    await showCode([{ path: COMPOSITION_REL, text: COMPOSITION_MARKER }]);
    const stagedUri = vscode.Uri.joinPath(workspaceRoot(), COMPOSITION_REL);
    await waitFor("舞台にエージェントのファイルが開く", () => {
      const shown = visibleEditorFor(stagedUri);
      return shown !== undefined && shown.viewColumn !== vscode.ViewColumn.One;
    });
    const staged = visibleEditorFor(stagedUri);
    assert.ok(staged, "舞台のエディタが見つからない");

    // 人間が舞台の列を覗きに行く（クリックで移るのと同じ状態にする）。
    const stagedColumn = staged.viewColumn;
    assert.ok(stagedColumn !== undefined, "舞台のエディタに列が無い");
    await vscode.window.showTextDocument(staged.document, {
      viewColumn: stagedColumn,
      preserveFocus: false,
    });

    // 自ツール呼び出しの待ちを明ける。ここを待たずに終えると、
    // 「時間で断られた」だけを見て「選択が無い」と読んでしまう。
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const state = await getEditorState();
    assert.strictEqual(
      state.selectedText,
      undefined,
      `エージェントが開いたファイルの選択テキストが返った: ${String(state.selectedText)}`,
    );
    assert.strictEqual(
      state.selectionWithheld,
      "empty",
      "舞台のエディタに選択が作られている（show_code が selection に触っている）",
    );
  });

  /**
   * **人間が2列目に居るとき、舞台はその列を奪わない**（設計書 §2A.7.1 / 不変条件10）。
   *
   * これは1つの欠陥が2つの防御を同時に外す形をしている。舞台の列を「最小の列が
   * 人間」という**推測**で決めていると（`chooseStageColumns` の第3引数を渡さない
   * 実装）、人間が舞台を一度覗きにクリックしただけで仮定が崩れ:
   *
   *   1. `show_code` が人間の列に開き、人間が見ていたタブを置き換える（不変条件10）
   *   2. そのエディタが `activeTextEditor` の座に就くので、§3.1.1 (d) が要求する
   *      `activeTabGroup` との一致が**エージェントが選んだファイル**に対して真になる
   *   3. 待ち（条件4）が明けると、VS Code が復元した選択がそのまま返る
   *
   * だから列と選択の**両方**を見る。`stage.ts` から `humanColumn` の受け渡しを
   * 外すと、両方が落ちる（実測）。
   */
  test("人間が2列目に居ても、show_code はその列を奪わず、そこから選択テキストも返らない", async () => {
    await lendWindow();

    // 人間の列だけの状態から始める。既に舞台が開いていると、「人間の列に
    // 開かなかった」が「たまたま別の列が空いていた」と区別できない。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが人間の1つに戻る", () => tabGroupCount() === 1);

    // 人間が**おとり**を自分の列で開いて選ぶ。VS Code はエディタを開き直す
    // ときに表示状態（＝この選択）を復元するので、このファイルが後で舞台に
    // 開かれると、そこに人間が作った選択が現れる。
    const bait = await humanOpens(COLUMN_BAIT_REL);
    humanSelects(bait, COLUMN_BAIT_MARKER);

    // エージェントが舞台の列を作る。
    await showCode([{ path: COLUMN_STAGE_REL, text: COLUMN_STAGE_MARKER }]);
    const stageUri = vscode.Uri.joinPath(workspaceRoot(), COLUMN_STAGE_REL);
    await waitFor("舞台にエージェントのファイルが開く", () => {
      const shown = visibleEditorFor(stageUri);
      return shown !== undefined && shown.viewColumn !== vscode.ViewColumn.One;
    });
    const staged = visibleEditorFor(stageUri);
    assert.ok(staged?.viewColumn !== undefined, "舞台のエディタに列が無い");

    // **人間が舞台を覗きに行く。** クリック1回で成立する、ごく普通の状態である。
    await vscode.window.showTextDocument(staged.document, {
      viewColumn: staged.viewColumn,
      preserveFocus: false,
    });
    const humanColumn = staged.viewColumn;
    await waitFor(
      "人間のタブグループが舞台の列になる",
      () => vscode.window.tabGroups.activeTabGroup.viewColumn === humanColumn,
    );
    assert.notStrictEqual(
      humanColumn,
      vscode.ViewColumn.One,
      "人間の列が1のまま。この検査の前提（人間が2列目に居る）が作れていない",
    );

    // エージェントが、人間が選択を作ってあるファイルを見せに来る。
    await showCode([{ path: COLUMN_BAIT_REL, text: COLUMN_BAIT_MARKER }]);
    const baitUri = vscode.Uri.joinPath(workspaceRoot(), COLUMN_BAIT_REL);
    await waitFor(
      "おとりが人間の列の外にも開く",
      () =>
        vscode.window.visibleTextEditors.some(
          (e) => e.document.uri.toString() === baitUri.toString() && e.viewColumn !== humanColumn,
        ) || vscode.window.tabGroups.all.length > 2,
    );
    // 遅れて開く実装を見逃さないよう、待ってから測る。
    await new Promise((resolve) => setTimeout(resolve, 500));

    // ここが不変条件10 の本体。**人間の列には開いていない。**
    const inHumanColumn = vscode.window.visibleTextEditors.filter(
      (e) => e.viewColumn === humanColumn,
    );
    for (const editor of inHumanColumn) {
      assert.strictEqual(
        editor.document.uri.toString(),
        stageUri.toString(),
        `人間の列（${String(humanColumn)}）のタブがエージェントに置き換えられた: ${editor.document.uri.toString()}`,
      );
    }

    // 自ツール呼び出しの待ちを明ける。ここを待たずに終えると、
    // 「時間で断られた」だけを見て「漏れていない」と読んでしまう。
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const state = await getEditorState();
    assert.strictEqual(
      state.selectedText,
      undefined,
      `舞台が人間の列を奪い、そこに復元された選択が返った: ${String(state.selectedText)}`,
    );
    assert.notStrictEqual(
      state.activePath,
      COLUMN_BAIT_REL,
      "エージェントが開いたファイルが、人間の使っているエディタの座に就いている",
    );
  });

  /**
   * **`isActiveEditor` の導出を実機で判別する**（設計書 §3.1 条件2 / §3.1.1 (d)）。
   *
   * この判定は `editor-surface.ts` にあり、そこは `vscode` を値 import するので
   * 単体テストからは読み込めない。レビュアが `isActiveEditor` を `true` に潰しても
   * **613+50件がすべて緑**のままだった（実測）―― 設計書が名指しした唯一の防御に、
   * 検査が1件も当たっていなかった。
   *
   * 判定は「`activeTextEditor` であること」ではなく「**人間が実際に使っている
   * タブグループと同じ列にあること**」である。両者はずれる: 人間が新しい編集
   * グループへ移ると（そこにはまだ何も開いていない）、`tabGroups.activeTabGroup`
   * はその列になるのに、`activeTextEditor` は前の列のエディタを指したままになる
   * （実測）。そのとき前の列には**人間が作った選択**が残っている。
   *
   * **対照を付ける。** 人間がその列に戻れば同じ選択が返ることまで見ないと、
   * 「何か別の理由で断られただけ」を「防御が効いた」と読める。
   */
  test("人間が別の編集グループへ移ると、選択は返らない（not-active）", async () => {
    await lendWindow();

    // 人間の列だけの状態から始める。舞台が開いたままだと、下で作る
    // 「人間が移った先の列」が舞台の列と重なって、状態が読めなくなる。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが人間の1つに戻る", () => tabGroupCount() === 1);

    // 他のどのテストも触らないファイルを使う。触られたファイルだと、前のテストが
    // 返した範囲と一致して `already-returned` になり、この検査が見たいものが
    // 別の理由に覆われる。
    const human = await humanOpens(NOT_ACTIVE_REL);
    humanSelects(human, NOT_ACTIVE_MARKER);

    // 人間が新しい編集グループへ移る。**まだ何も開いていない列**である。
    await vscode.commands.executeCommand("workbench.action.newGroupRight");
    await waitFor(
      "人間のタブグループが新しい列になる",
      () => vscode.window.tabGroups.activeTabGroup.viewColumn !== vscode.ViewColumn.One,
    );
    // 前提そのものを測る。ここがずれていないなら、この検査は何も判別していない。
    assert.strictEqual(
      vscode.window.activeTextEditor?.viewColumn,
      vscode.ViewColumn.One,
      "activeTextEditor が人間の移った先へ付いてきた。この検査の前提が作れていない",
    );
    assert.strictEqual(
      vscode.window.state.focused,
      true,
      "窓が前面にない。この検査が見ているのは not-focused であって not-active ではない",
    );

    // 自ツール呼び出しの待ちを明ける。明けないと `too-soon-after-tool` が
    // 先に当たり、`isActiveEditor` を潰しても同じ結果になって判別しない。
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const away = await getEditorState();
    assert.strictEqual(
      away.activePath,
      NOT_ACTIVE_REL,
      "人間が選んだファイルが activePath に出ていない（前提が崩れている）",
    );
    assert.strictEqual(
      away.selectedText,
      undefined,
      `人間の使っているタブグループの外にあるエディタの選択が返った: ${String(away.selectedText)}`,
    );
    assert.strictEqual(away.selectionWithheld, "not-active");

    // **対照。** 人間がその列に戻れば、同じ選択が返る。返らないなら、上の
    // 「返らなかった」は `isActiveEditor` の働きではない。
    await vscode.commands.executeCommand("workbench.action.focusLeftGroup");
    await waitFor(
      "人間のタブグループが元の列に戻る",
      () => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One,
    );
    const back = await getEditorState();
    assert.strictEqual(
      back.selectedText,
      NOT_ACTIVE_MARKER,
      `対照が成立しない（理由: ${String(back.selectionWithheld)}）。上の検査は isActiveEditor を測っていない`,
    );
  });

  /**
   * **預けていない窓では、人間の画面を読めない**（設計書 §2A.1 / §6.1）。
   *
   * `checkToolGate` の単体検査は「判定が正しい」ことしか言わない。`handle` の
   * ゲートを `get_editor_state` **だけ**迂回させても 613+50件が緑のままだった
   * （実測）―― 判定は正しく、呼び出し口が通していなかった、という壊れ方を
   * 誰も落とさない。だから線上と同じ道（`showme.test.getEditorState` は
   * `handle` を通る）で、役割を外した窓に投げる。
   */
  test("預けていない窓では get_editor_state が拒否される", async () => {
    await setRole("idle");
    await assert.rejects(
      () => getEditorState(),
      (e: unknown) => String(e).includes(WINDOW_OFF_MESSAGE),
      "預けていない窓で get_editor_state が拒否されなかった（人間の画面が読める）",
    );

    // 対照。同じ呼び出しが、預けた窓では通る。通らないなら、上の「拒否された」は
    // ゲートの働きではない（例えば呼び出し口そのものが壊れている）。
    await lendWindow();
    const state = await getEditorState();
    assert.ok(Array.isArray(state.openPaths), "預けた窓で get_editor_state が通らない");
  });

  /**
   * **開いているタブの一覧は、人間が出しているものの観測である**（設計 D37）。
   *
   * 増分3 までは `.env` を落とし、落とした件数を `openPathsHidden` で返して
   * いた。増分4 でその判断を覆した ―― 伏せて得ていたのは「`.env` が存在する」
   * の1ビットだけで、それは `show_code` に問えば `excluded-path` として既に
   * 読める。一方、伏せるとレイアウトに穴が空き、片づけの判断に使えない一覧に
   * なる。**名前は出し、中身（可視行）は伏せる。**
   */
  test("開いているタブの一覧に秘匿パスも載る（名前だけ・中身は伏せる）", async () => {
    await lendWindow();

    // **preview: false で開く。** 既定のプレビュータブは次に開いたファイルに
    // 置き換えられるので、`.env` がタブとして残らず、この検査が空振りする。
    const envUri = vscode.Uri.joinPath(workspaceRoot(), ENV_REL);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(envUri), {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: false,
    });
    // 人間は普通のファイルに戻る（`.env` はタブとして残る）。
    const plainUri = vscode.Uri.joinPath(workspaceRoot(), EDITOR_STATE_REL);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(plainUri), {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: false,
    });
    await waitFor("2枚ともタブとして開く", () =>
      vscode.window.tabGroups.all.some((g) => g.tabs.length >= 2),
    );

    const state = await getEditorState();
    const openPaths = state.openPaths;
    assert.ok(Array.isArray(openPaths), "openPaths が配列で返らなかった");
    // 対照。普通のファイルまで落ちているなら、下の「載っている」は何も言わない。
    assert.ok(
      openPaths.includes(EDITOR_STATE_REL),
      `普通のファイルが openPaths に載っていない: ${openPaths.join(", ")}`,
    );
    assert.ok(
      openPaths.includes(ENV_REL),
      `秘匿パスが openPaths に載っていない（D37 で出すと決めた）: ${openPaths.join(", ")}`,
    );
    // 同じ量を2箇所で返さない。溢れは `openPaths.length` から読める。
    assert.strictEqual(
      state.openPathsHidden,
      undefined,
      "openPathsHidden が返った（D37 で削除したはず）",
    );
    assert.ok(!Object.hasOwn(state, "openPathsHidden"), "openPathsHidden の鍵が残っている");
  });

  /** 除外パスでは、選択テキストも**範囲も**返らない（設計書 §3.1.1 (c)）。 */
  test("除外パスでは選択テキストも位置情報も返らない", async () => {
    await lendWindow();
    const editor = await humanOpens(ENV_REL);
    humanSelects(editor, "SECRET");

    const state = await getEditorState();
    assert.strictEqual(state.activePath, ENV_REL, "パスは返す（伏せても隠せるものが無い）");
    assert.strictEqual(state.selectedText, undefined, "除外パスの選択テキストが返った");
    assert.strictEqual(state.selectionWithheld, "redacted");
    // 範囲だけでも「その行の長さ」が読める。まとめて落ちていること。
    assert.strictEqual(state.cursor, undefined, "除外パスで cursor が返った");
    assert.strictEqual(state.selection, undefined, "除外パスで selection が返った");
    assert.strictEqual(state.visibleLines, undefined, "除外パスで visibleLines が返った");
  });
});

/**
 * 注釈の本文に markdown 経路の攻撃を入れて、**いずれも無害である**ことを実機で見る
 * （設計書 §3.2.1 / §3.3 / 本体 §5.2）。
 *
 * ## なぜ受信サーバを実際に立てるのか
 *
 * 「CSP を書いた」「`MarkdownString` を使っていない」は**我々の側の主張**である。
 * 本体 §5.2 が主張しているのは「外部への送信を持たない」という**結果**なので、
 * 証拠も結果の側で採る ―― 受信する口を実際に開けて、そこに何も来ないことを見る。
 *
 * この listener は**テストのもの**であって拡張のものではない（不変条件1 は
 * 出荷する拡張に掛かる）。127.0.0.1 の一時ポートに束ね、suiteTeardown で閉じる。
 * 接続そのものも数える ―― 中身が HTTP として成立しなくても、**繋ぎに来たこと**
 * が egress である。
 *
 * ## 判別すること（実際に壊して確かめた。Task 6 Step 6）
 *
 * 本文が `string` である限り、画像記法はただの文字列なので**この検査は
 * 何も検査していない可能性がある**。だから本文を markdown の値に変えて走らせた:
 * **受信サーバに接続が4件届き、この検査が落ちた**（`0 件` → `connection` 4件）。
 * 吹き出しは実際に描かれ、markdown の画像は実際に取りに行かれている。
 *
 * その実験で分かったことがもう1つある。**`http:` だけでは何も届かない。**
 * ワークベンチの CSP は `img-src` に `https:` を含むが `http:` は含まないので、
 * http の画像はレンダラの手前で落ちる ―― つまり http だけで測っていたら、
 * markdown に変えても「送信は無かった」と読めていた（＝何も検査していない
 * テストになっていた）。だから https も送り、TLS として成立しない接続も
 * **繋ぎに来たこと**として数える。
 *
 * 型が `string` であること自体も、ここで併せて観測している
 * （`annotatedBodies[].kind`）。
 */
suite("実 VS Code / 信頼モード / 注釈の markdown 経路", () => {
  /** 起動されたら数える口。エージェントの本文からリンクとして踏まれたら増える。 */
  const CANARY_COMMAND = "showme.test.markdownCanary";

  let server: http.Server | undefined;
  let port = 0;
  /** 受信サーバに来たもの。**空であることが結論である。** */
  const received: string[] = [];
  let canaryFired = 0;
  let canary: vscode.Disposable | undefined;

  suiteSetup(async () => {
    await activateExtension();
    canary = vscode.commands.registerCommand(CANARY_COMMAND, () => {
      canaryFired += 1;
    });
    const created = http.createServer((req, res) => {
      received.push(`request ${req.url ?? "(no url)"}`);
      res.statusCode = 204;
      res.end();
    });
    // HTTP として成立しない接続（TLS ハンドシェイクなど）も egress である。
    created.on("connection", () => received.push("connection"));
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const address = created.address();
    assert.ok(address !== null && typeof address === "object", "受信サーバのポートが読めない");
    port = address.port;
    server = created;
  });

  suiteTeardown(async () => {
    canary?.dispose();
    const running = server;
    if (running !== undefined) await new Promise((resolve) => running.close(() => resolve(null)));
  });

  test("command: リンク・リモート画像・双方向オーバーライドのいずれも無害である", async () => {
    await lendWindow();

    // **先にファイルを開く。** 吹き出しは、そのファイルを映しているエディタが
    // 無ければ描かれない ―― 描かれなければ画像も取りに行かないので、
    // egress の検査が空振りする（＝何を入れても緑になる）。
    await showCode([{ path: MARKDOWN_ATTACK_REL, text: MARKDOWN_ATTACK_MARKER }]);
    const uri = vscode.Uri.joinPath(workspaceRoot(), MARKDOWN_ATTACK_REL);
    await waitFor("攻撃対象のファイルが可視になる", () => visibleEditorFor(uri) !== undefined);

    // 不可視文字は**6文字のエスケープ列で書く**（生で書くと
    // `test/source-hygiene.test.ts` が落ちる。この repo は2回それで壊れている）。
    const attack = [
      `[開く](command:${CANARY_COMMAND})`,
      `![leak](http://127.0.0.1:${port}/image-notation.png)`,
      // **https も送る。** ワークベンチの CSP は `img-src` に `https:` を含むが
      // `http:` は含まないことがある ―― http だけで測ると、レンダラが画像を
      // 描いていても「送信が無かった」と読めてしまう。TLS として成立しなくても、
      // **繋ぎに来たこと**が egress なので、接続の数え上げで捕まえる。
      `![leak-tls](https://127.0.0.1:${port}/image-notation-tls.png)`,
      `<img src="http://127.0.0.1:${port}/html-tag.png">`,
      "a\u202eb\u200bc",
    ].join("\n");

    const resolutions = await annotate([
      { location: { path: MARKDOWN_ATTACK_REL, text: MARKDOWN_ATTACK_MARKER }, text: attack },
    ]);
    assert.strictEqual(resolutions[0]?.match, "one", "攻撃文字列の注釈が出せなかった");
    await waitFor("吹き出しが立つ", async () =>
      (await inspectVisuals()).annotatedUris.includes(uri.toString()),
    );

    // レンダラが画像を取りに行くだけの時間を与える。**空である**ことを主張する
    // 検査なので、待たずに空を見ても何も言えない。
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    console.log(
      `[測定] 受信サーバ: 到着 ${received.length} 件${received.length > 0 ? `（${received.join(", ")}）` : "（空）"} / canary 起動 ${canaryFired} 回`,
    );

    assert.deepStrictEqual(
      received,
      [],
      `受信サーバにアクセスがあった（外部への送信が起きている）: ${received.join(", ")}`,
    );
    assert.strictEqual(canaryFired, 0, "本文から command: が起動された");

    const bodies = (await inspectVisuals()).annotatedBodies;
    assert.strictEqual(bodies.length, 1, "吹き出しが1件でない");
    const bubble = bodies[0];
    assert.ok(bubble, "吹き出しの本文が読めない");
    // 型が `string` であること自体が防御である（設計書 §3.2.1）。
    assert.strictEqual(bubble.kind, "string", "本文が markdown の値として渡っている");
    // 記法は**消さずに文字列のまま**残っている（消すと「何が来たか」も消える）。
    assert.ok(bubble.text.includes(`command:${CANARY_COMMAND}`), "command: の記法が消えている");
    assert.ok(bubble.text.includes("image-notation.png"), "画像記法が消えている");
    // 双方向オーバーライドとゼロ幅は可視化される（生の文字は残らない）。
    assert.ok(bubble.text.includes("\\u202e"), "双方向オーバーライドが可視化されていない");
    assert.ok(bubble.text.includes("\\u200b"), "ゼロ幅文字が可視化されていない");
    assert.strictEqual(bubble.text.includes("\u202e"), false, "生の双方向オーバーライドが残った");
    assert.strictEqual(bubble.text.includes("\u200b"), false, "生のゼロ幅文字が残った");
  });
});

/**
 * **隠して出し直したら中身が戻る**（増分 4A / 設計 D49）。
 *
 * `retainContextWhenHidden` を設定しないと、VS Code は webview が隠れた時点で
 * DOM ごと捨て、再表示時に `webview.html` から作り直す。作り直された外側には
 * `buildOuterHtml` の骨しか無く、`postMessage` で入れた表示フレームの中身は
 * 戻らない（`postMessage` は状態ではなく**出来事**である）。
 * 実地で「同じ列で表示を切り替えて戻ると空になる」として観測された。
 *
 * **「出した」ではなく「戻ってきた」を見る。** `showme.test.panelState` は
 * 「最後に投げたものが届いた」という出来事の記録なので、DOM が消えても残る ――
 * そこに assert すると**空になっていても緑**になる。だから生きているフレームに
 * 問い合わせる `measureDisplayedLength()` で測る。
 */
suite("実 VS Code / 信頼モード / webview は隠れても中身を保つ", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  test("同じ列で別のタブに切り替えて戻ると、表示フレームに中身が残っている", async () => {
    // 1プロセスで何十回も呼ぶので、先に予算を戻す。制限で弾かれると
    // 「出していないのに消えた」を見ることになる。
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>ぶら下がりの検査</p>",
      title: "retain",
    });

    const state = (await vscode.commands.executeCommand("showme.test.panelState")) as {
      acknowledged?: unknown;
      length?: unknown;
    };
    assert.strictEqual(state.acknowledged, true, "1回目が表示フレームに届いていない");
    const firstLength = asNumber(state.length, "1回目の長さ");
    assert.ok(firstLength > 0, "1回目の長さが 0");

    // **測る口が効いていることを、隠す前に確かめる。** ここを飛ばすと
    // 「最初から測れていなかった」も「隠したら消えた」と読めてしまう
    // （検査は両方向に当てる）。
    assert.strictEqual(
      await measureDisplayedLength(),
      firstLength,
      "隠す前から表示フレームの中身が測れていない（検査が空振りしている）",
    );

    const column = panelColumn();
    assert.ok(column !== undefined, "パネルの列が見つからない");
    assert.strictEqual(panelIsVisible(), true, "出した直後にパネルが見えていない");

    // **同じ列に**別のエディタを出して webview を隠す（人間がタブを切り替える形）。
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
    await waitFor("パネルが隠れる", () => !panelIsVisible());

    // 出し直す。**新しい HTML は渡さない** ―― 渡すと入れ直しになって検査にならない。
    // 覆っているタブだけを閉じる（他の列の同じファイルは触らない）。
    const tab = panelTab();
    assert.ok(tab, "パネルのタブが見つからない");
    const stageGroup = vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab));
    assert.ok(stageGroup, "パネルの載っている編集グループが見つからない");
    await vscode.window.tabGroups.close(
      stageGroup.tabs.filter(
        (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
      ),
    );
    await waitFor("パネルが出し直される", () => panelIsVisible());

    const restored = await measureDisplayedLength();
    assert.strictEqual(
      restored,
      firstLength,
      `出し直したら表示フレームの中身が失われた（${firstLength} → ${restored}）`,
    );
  });
});

/**
 * **対応表のコマンドが実機に存在することを検査する**（設計 D44）。
 *
 * コマンド ID は VS Code のバージョンで変わる。存在しないコマンドを語彙に置くと、
 * `run()` が例外を飲んで `done: false` を返し、**エージェントには
 * 「そのビューが無い」と区別がつかない**。当てずっぽうの名前を置かないための歯止め。
 */
suite("show_view の対応表", () => {
  test("対応づけているコマンドがすべて実機に存在する", async () => {
    const available = new Set(await vscode.commands.getCommands(true));
    const commands = await viewCommands();
    // **0件でも「無いコマンドは無い」は真になる。** 食わせた件数を主張する。
    assert.ok(commands.length >= 10, `対応表が空に近い: ${commands.length} 件`);
    const missing = commands.filter((c) => !available.has(c));
    assert.deepStrictEqual(missing, [], `実機に無いコマンド: ${missing.join(", ")}`);
  });

  test("対応表は単射である（別の操作が同じコマンドを指していない）", async () => {
    // **型も「実機に在る」も、これを捕まえない。** 写し間違いで
    // `"show-search": "workbench.view.explorer"` と書いても、
    // Record の網羅は満たされ、コマンドは実在し、操作はすべて面に届く ――
    // それでも `show-search` は黙ってエクスプローラを開く。
    // 「1つの鍵につき1つの値」を決めているのに、**値が相異なることは
    // どこも確かめていない**（不変条件14 の形）。
    const commands = await viewCommands();
    const duplicated = commands.filter((c, i) => commands.indexOf(c) !== i);
    assert.deepStrictEqual(
      duplicated,
      [],
      `2つ以上の操作が同じコマンドを指している: ${duplicated.join(", ")}`,
    );
  });

  test("端末を起こす・殺すコマンドが対応表に無い（D45）", async () => {
    for (const command of await viewCommands()) {
      assert.ok(
        !command.startsWith("workbench.action.terminal."),
        `端末のコマンドが対応表に入っている: ${command}`,
      );
    }
  });
});

/**
 * `arrange_editors` の面（`arrange-surface.ts`）。**単体では1件も確かめられない**
 * ―― `vscode` を値 import しているので vitest から読み込めない。だから
 * 「対応表が実機と合っているか」と「端から端まで呼べるか」はここで見る。
 */
suite("arrange_editors の対応表と経路", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  test("対応づけているコマンドがすべて実機に存在する（D44）", async () => {
    const available = new Set(await vscode.commands.getCommands(true));
    const commands = await arrangeCommands();
    // **0件でも「無いコマンドは無い」は真になる。** 食わせた件数を主張する。
    // 語彙10語のうち枠の語は5つ（`close-own` / `close-other-tabs` はタブを閉じ、
    // `move-tab` / `move-panel` / `gather-own` は開いて閉じる／reveal で動かすので、
    // どれもコマンドではなく表に無い）。
    assert.strictEqual(commands.length, 5, `対応表の件数が5でない: ${commands.length} 件`);
    const missing = commands.filter((c) => !available.has(c));
    assert.deepStrictEqual(missing, [], `実機に無いコマンド: ${missing.join(", ")}`);
  });

  test("対応表は単射である（別の操作が同じコマンドを指していない）", async () => {
    // 型も「実機に在る」も、写し間違いを捕まえない。`"grid"` と `"two-rows"` が
    // 同じコマンドを指していても、Record の網羅は満たされる。
    const commands = await arrangeCommands();
    const duplicated = commands.filter((c, i) => commands.indexOf(c) !== i);
    assert.deepStrictEqual(
      duplicated,
      [],
      `2つ以上の操作が同じコマンドを指している: ${duplicated.join(", ")}`,
    );
  });

  test("配置の対応表にタブを閉じるコマンドが無い（許可の判断を迂回しない）", async () => {
    // **これが入ると `mayClose` が丸ごと迂回される。** 配置を変えるだけの語に
    // `workbench.action.closeOtherEditors` を割り当てれば、設定が false でも
    // 人間のタブが消える ―― 閉じる経路は `closeTabs` ただ1つでなければならない。
    for (const command of await arrangeCommands()) {
      assert.ok(
        !command.startsWith("workbench.action.close"),
        `閉じるコマンドが配置の対応表に入っている: ${command}`,
      );
    }
  });

  test("線上と同じ経路で呼べ、自分のパネルが実際に閉じる", async () => {
    // `arrange_editors` は `TOOL_NAMES` にあり、ブリッジは既に広告していた。
    // 一方 `requestSchema` の枝が無い間は、**呼んだ瞬間に要求解析で落ちていた**。
    // ここが通ることが「広告どおりに呼べる」の証拠である。
    //
    // **閉じる対象を自分で用意してから呼ぶ。** 何も無い画面で呼ぶと
    // `{done: true, closed: 0}` が返り、`isOwnTab` が常に false でも
    // `closeTabs` が何もしなくても緑になる（空振りの緑）。
    //
    // **画面を空にしてから。** 前の節が `show_code` で開いたタブは own のまま残っている
    // （D53）ので、そのまま呼ぶと `closed` が前の節の残り物の数だけ増える。
    await closeEverythingForArrange();
    // **人間は別のタブを見ている。** 前の節は同じ列でタブを切り替えてパネルに戻って
    // おり、そのままだとパネルが `activeTabGroup.activeTab`（＝人間が見ている）に
    // なって床1 で残る（C1。実測でそうなった）。「自分のパネルが閉じる」を言うには、
    // 人間が見ていない状態を先に作る。
    const humanDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    await vscode.window.showTextDocument(humanDoc, { viewColumn: 1, preview: false });
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>片づけの検査</p>",
      title: "片づけの検査",
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    assert.notStrictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab,
      panelTab(),
      "人間がパネルを見ている（床1 で残るので、この検査は「閉じる」を言えない）",
    );

    const result = await arrangeEditors("close-own");
    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.closed, 1, `閉じた枚数が1でない: ${JSON.stringify(result)}`);
    await waitFor("パネルのタブが消える", () => panelTab() === undefined);
    // 人間のタブは残る（`close-own` は own しか候補にしない）。
    assert.ok(visibleEditorFor(humanDoc.uri) !== undefined, "人間が見ていたタブが巻き込まれた");
    // 断るものは無い ―― 見ていない・保存済みの自分のものは、設定と無関係に閉じられる。
    assert.strictEqual(result.withheld, undefined, "自分のパネルで withheld が返った");
    // **返る鍵そのものを見る。** 断った枚数のような数が生えれば、人間のタブを
    // 数える口になる（`arrangeEditorsResultSchema` が許す鍵だけ）。
    for (const key of Object.keys(result)) {
      assert.ok(
        key === "done" || key === "closed" || key === "withheld",
        `結果に未知の鍵がある: ${key}`,
      );
    }
  });

  test("配置の語も線上と同じ経路で通る（閉じない側の枝）", async () => {
    // **通るべきものが通ることも見る。** 閉じる語だけを見ていると、
    // `applyLayout` が丸ごと死んでいても緑になる。
    // `even-widths` にしてあるのは、列を減らさない唯一の語だから ―― `single-column` は
    // 2列以上あると人間の列を巻き込むので断られる（D55-2）。前の節が残した列数に
    // 依らず「通る」を言える語で、経路の生死を見る。
    const result = await arrangeEditors("even-widths");
    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.closed, 0, "配置の変更で closed が 0 でない");
  });

  test("語彙の外は要求解析で落ちる（任意のコマンド名を受け取らない）", async () => {
    await assert.rejects(
      async () =>
        vscode.commands.executeCommand("showme.test.arrangeEditors", {
          action: "workbench.action.closeAllEditors",
        }),
      "VS Code のコマンド名がそのまま通った",
    );
  });

  test("預けていない窓では呼べない（checkToolGate を通っている）", async () => {
    // **ゲートを通る経路に入っていることの証拠。** 別経路を作ると、ここだけが
    // 通ってしまう ―― `role !== "stage"` を担っているのは `checkToolGate` である。
    await setRole("idle");
    try {
      await assert.rejects(
        async () => arrangeEditors("close-own"),
        (error: unknown) => String(error).includes(WINDOW_OFF_MESSAGE),
        "預けていない窓で arrange_editors が通った",
      );
    } finally {
      await lendWindow();
    }
    // 戻したら通る ―― 上の拒否が「役割のせい」であって
    // 「そもそも呼べない」ではないことの対照。
    const result = await arrangeEditors("close-own");
    assert.strictEqual(result.done, true, "役割を戻しても通らない");
    assert.strictEqual(typeof result.closed, "number", "closed が number でない");
  });
});

/**
 * **既定で人間のタブが1枚も閉じないことを、実機で確かめる**（設計 D41/D43）。
 *
 * 単体は偽の面（作り物の `ArrangeTab`）を渡すので、次の4つは1件も
 * 確かめられていない:
 *
 *   1. 本物の未保存エディタの `Tab.isDirty` が、我々の思っている値か
 *   2. 我々の所有判定が、本物の webview の本物の `viewType` に当たるか
 *   3. `tabGroups.close` が、選んだものだけを閉じるか
 *   4. エージェントが付けた題で、人間のファイルを自分のものに見せられないか
 *
 * どれか1つでも外れると、**単体が全部緑のまま人間の未保存が消える**。
 * この道具で人間の作業にいちばん近いところに触る機能なので、ここは実機で言う。
 */

/**
 * この節だけが使うファイル。**他の節のファイルを使わない。**
 *
 * ここは唯一「タブを閉じる」節で、落ちたときに壊れているのが片づけなのか
 * 前の節の後始末なのかを判別できなくなる。`docs/notes.md` は実際、この file の
 * 前のほうの test が実体を `.env` へ差し替える（使うと「普通のファイル」の
 * つもりが秘匿ファイルになる）。
 */
const ARRANGE_DIR = "arrange";
const ARRANGE_PLAIN_REL = `${ARRANGE_DIR}/plain.md`;
const ARRANGE_OTHER_REL = `${ARRANGE_DIR}/other.md`;
const ARRANGE_KEEP_REL = `${ARRANGE_DIR}/keep.md`;
const ARRANGE_DIRTY_REL = `${ARRANGE_DIR}/dirty.txt`;

/**
 * 題を偽る検査の題と、**それと同じ label になる人間のファイル**。
 *
 * 拡張はパネルの題に `ShowMe: ` を付ける（`panelTitle`）ので、エージェントが
 * `arrange-spoof.md` という題を送ると、パネルのタブの label は
 * `ShowMe: arrange-spoof.md` になる。人間のファイルの名前をそれと**同じ**に
 * しておくと、label で所有を決める実装ではこの人間のファイルが
 * 「自分のパネル」に見える ―― `close-own` が人間のタブを閉じる。
 * 所有は `viewType`（エージェントには作れない）で決まる、というのが D41 である。
 */
const ARRANGE_SPOOF_TITLE = "arrange-spoof.md";
const ARRANGE_SPOOF_REL = `${ARRANGE_DIR}/ShowMe: ${ARRANGE_SPOOF_TITLE}`;

function arrangeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function arrangeTabLabels(): string[] {
  return arrangeTabs()
    .map((tab) => tab.label)
    .sort();
}

function arrangeTextTabs(): vscode.Tab[] {
  return arrangeTabs().filter((tab) => tab.input instanceof vscode.TabInputText);
}

async function writeArrangeFile(rel: string, body: string): Promise<void> {
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(workspaceRoot(), rel),
    Buffer.from(body, "utf8"),
  );
}

/** 人間が1枚開く。**`preview: false`** ―― プレビュータブは次を開くと入れ替わる。 */
async function openHumanTab(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspaceRoot(), rel));
  return await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
}

type LayoutSettingKey = "closeHumanTabs" | "closeDirtyTabs";

/**
 * 設定を**グローバル（信頼できる範囲）に**書く。
 *
 * 拡張は `inspect()` の `globalValue` / `defaultValue` しか読まない（不変条件9）。
 * `ConfigurationTarget.Workspace` に書くと**何も起きない**ので、
 * 「設定を立てたのに閉じなかった」が「安全に断った」に見える（空振りの緑）。
 */
async function setLayoutSetting(key: LayoutSettingKey, value: boolean | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(`showme.layout.${key}`, value, vscode.ConfigurationTarget.Global);
}

/** 設定が**実際にその値で読まれる状態**か。前提として毎回確かめる。 */
function assertLayoutSetting(key: LayoutSettingKey, want: boolean | undefined): void {
  const inspected = vscode.workspace.getConfiguration().inspect<boolean>(`showme.layout.${key}`);
  assert.strictEqual(
    inspected?.globalValue,
    want,
    `showme.layout.${key} の globalValue が ${String(want)} でない（前提が崩れている）`,
  );
}

/**
 * **プリセットが人間の列を巻き込むなら、呼ばない**（設計 §C3 / D55-2。所見4b・4c）。
 *
 * 実測（所見4）: VS Code の `editorLayout*` は枠を作るだけで、目標より多いグループは
 * **最後の枠に合流**する。合流は一方通行。人間が列1で `single-column` を呼ぶと、
 * 舞台の3ファイルが人間の列に流れ込んだ。
 *
 * 単体は偽の面に数を渡すので、次の3つは1件も確かめられていない:
 *
 *   1. `activeTabGroup.viewColumn` が、人間を動かしたあと本当にその列を指すか
 *   2. 面の `groupCount()` が `tabGroups.all.length` を返し、`showCode(split)` の結果と合うか
 *   3. **断ったときに実機の列数が変わらない**か（判定が偽で呼んでいたら列が減る）
 *
 * 否定（断る）には対照（人間を列1に戻せば同じ操作が通る）を付ける。
 */
suite("実 VS Code / 信頼モード / プリセットは人間の列を巻き込まない（D55-2）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  teardown(async () => {
    await closeEverythingForArrange();
  });

  /** 人間の列だけの状態から、人間を列1に置き、舞台を列2・3に開く（3グループ）。 */
  async function humanInColumnOneWithStageInTwoAndThree(): Promise<vscode.TextDocument> {
    await closeEverythingForArrange();
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが1つに戻る", () => tabGroupCount() === 1);
    const humanDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    await vscode.window.showTextDocument(humanDoc, { viewColumn: 1, preview: false });
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間が列1に居ない（前提が崩れている）",
    );
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
    await waitFor("列が 人間1 + 舞台2 = 3 になる", () => tabGroupCount() === 3);
    // 舞台が人間の列を使っていない（不変条件10）。使っていたら、この節の「人間の列」
    // の意味が崩れる。
    for (const rel of [oneRel, twoRel]) {
      const column = visibleEditorFor(vscode.Uri.joinPath(workspaceRoot(), rel))?.viewColumn;
      assert.ok(typeof column === "number" && column > 1, `舞台が列 ${String(column)} に開いた`);
    }
    return humanDoc;
  }

  test("人間が列1なら two-columns は通り、列3が列2に合流して人間の列は無事", async () => {
    const humanDoc = await humanInColumnOneWithStageInTwoAndThree();

    const result = await arrangeEditors("two-columns");

    assert.deepStrictEqual(
      result,
      { done: true, closed: 0 },
      `通らなかった: ${JSON.stringify(result)}`,
    );
    await waitFor("列が2つになる（列3が列2に合流）", () => tabGroupCount() === 2);
    // 人間の列は無事: 人間の文書は列1に見えたままで、人間が居る列も1のまま。
    assert.strictEqual(
      visibleEditorFor(humanDoc.uri)?.viewColumn,
      1,
      "人間の文書が列1に見えていない（人間の列が巻き込まれた）",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間の居る列が変わった",
    );
    // 舞台の2ファイルは両方とも列2に居る（合流先は最後の枠）。
    const [oneRel, twoRel] = STAGE_RELS;
    const stageTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs.map((tab) => ({ group, tab })))
      .filter(
        ({ tab }) =>
          tab.input instanceof vscode.TabInputText &&
          [oneRel, twoRel].some(
            (rel) =>
              tab.input instanceof vscode.TabInputText && tab.input.uri.path.endsWith(`/${rel}`),
          ),
      );
    assert.strictEqual(stageTabs.length, 2, "舞台のタブが2枚でない");
    for (const { group } of stageTabs) {
      assert.strictEqual(group.viewColumn, 2, "舞台のタブが列2に合流していない");
    }
  });

  /** `get_editor_state` が言う own を、パスごとに読む（`own` は立っていれば true、無ければ undefined）。 */
  async function ownByPath(rels: readonly string[]): Promise<Record<string, unknown>> {
    const tabs = layoutTabs(await getEditorState());
    const out: Record<string, unknown> = {};
    for (const rel of rels) {
      const found = tabs.filter((t) => t.path === rel);
      assert.strictEqual(found.length, 1, `${rel} のタブが1枚でない: ${JSON.stringify(tabs)}`);
      out[rel] = found[0]?.own;
    }
    return out;
  }

  /**
   * 実機で2回観測: `show_code` split の2枚が列2・3 → 自分で `two-columns` →
   * 列3が列2に合流 → 合流で動いた1枚の own が消え、直後の `close-own` が `closed: 1`。
   *
   * VS Code は合流を close+open として扱い、`OpenedByAgent` はどの close でも忘れる（§C2）。
   * 合流の close は人間のドラッグと同じ形だが、**自分が呼んだプリセットの中で起きた close は
   * 自分の仕業**なので、面が合流の後に記録し直す（`restoreOwnership`。移動と同じ規則）。
   * 証拠は `get_editor_state` の `own` と、`close-own` が**2枚**閉じること。
   */
  test("自分の two-columns で合流した own のタブは own のまま、close-own で2枚とも消える", async () => {
    await humanInColumnOneWithStageInTwoAndThree();
    const [oneRel, twoRel] = STAGE_RELS;
    // 前提: 合流の前は2枚とも own。これが無いと「保った」と「最初から無い」が区別できない。
    assert.deepStrictEqual(
      await ownByPath([oneRel, twoRel]),
      { [oneRel]: true, [twoRel]: true },
      "合流の前に own でない（前提が崩れている）",
    );

    const result = await arrangeEditors("two-columns");
    assert.deepStrictEqual(result, { done: true, closed: 0 }, JSON.stringify(result));
    await waitFor("列が2つになる（列3が列2に合流）", () => tabGroupCount() === 2);

    // 合流のあとも2枚とも own（`get_editor_state` は `close-own` と同じ記録を読む）。
    assert.deepStrictEqual(
      await ownByPath([oneRel, twoRel]),
      { [oneRel]: true, [twoRel]: true },
      "合流で own が消えた（再発）",
    );

    const cleaned = await arrangeEditors("close-own");
    assert.strictEqual(
      cleaned.closed,
      2,
      `close-own が2枚閉じていない: ${JSON.stringify(cleaned)}`,
    );
    await waitFor(
      "舞台の2枚が消える",
      () =>
        !arrangeTabs().some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            [oneRel, twoRel].some(
              (rel) =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.path.endsWith(`/${rel}`),
            ),
        ),
    );
    // 人間の1枚は残る。
    assert.strictEqual(
      arrangeTabs().filter((tab) => tab.input instanceof vscode.TabInputText).length,
      1,
      `人間のタブが巻き込まれた: ${arrangeTabLabels().join(", ")}`,
    );
  });

  /**
   * 対照: **同じ合流で動いた人間のタブは人間のもののまま。** 記録し直すのは「前に own だった
   * もの」だけで、`opened.has()` でも「合流で動いたもの全部」でもない。これが無いと、
   * `restoreOwnership` が全タブを own にしても上の検査は緑である。
   */
  test("同じ two-columns で合流した人間のタブは own にならず、close-own で残る", async () => {
    await humanInColumnOneWithStageInTwoAndThree();
    const [oneRel, twoRel] = STAGE_RELS;
    // 人間が列3にもう1枚開く（フォーカスごと）。そのあと列1に戻る ―― 人間が列3に居るままだと
    // `two-columns` は `human-column-would-merge` で断られ、この検査は合流を見ない。
    const humanUri = vscode.Uri.joinPath(workspaceRoot(), JSON_REL);
    await vscode.window.showTextDocument(humanUri, { viewColumn: 3, preview: false });
    await waitFor("人間が列3に居る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 3);
    const sampleUri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    await vscode.window.showTextDocument(sampleUri, { viewColumn: 1, preview: false });
    await waitFor("人間が列1に戻る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 1);
    assert.strictEqual(tabGroupCount(), 3, "列が3つでない（前提が崩れている）");
    assert.deepStrictEqual(
      await ownByPath([oneRel, twoRel, JSON_REL]),
      { [oneRel]: true, [twoRel]: true, [JSON_REL]: undefined },
      "前提が崩れている（人間の1枚が own、または自分の2枚が own でない）",
    );

    const result = await arrangeEditors("two-columns");
    assert.deepStrictEqual(result, { done: true, closed: 0 }, JSON.stringify(result));
    await waitFor("列が2つになる（列3が列2に合流）", () => tabGroupCount() === 2);

    // 合流で動いたのは自分の1枚（列3の two）と人間の1枚（列3の JSON）。自分のは own のまま、
    // 人間のは own にならない。
    assert.deepStrictEqual(
      await ownByPath([oneRel, twoRel, JSON_REL]),
      { [oneRel]: true, [twoRel]: true, [JSON_REL]: undefined },
      "合流のあとの own が違う（人間のタブが own になった、または自分のが消えた）",
    );

    const cleaned = await arrangeEditors("close-own");
    assert.strictEqual(cleaned.closed, 2, `close-own の枚数が2でない: ${JSON.stringify(cleaned)}`);
    await waitFor("自分の2枚が消える", () => arrangeTextTabs().length === 2);
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["config.json", "sample.ts"],
      "人間の2枚が残っていない、または自分のが残った",
    );
  });

  test("減らないプリセット（three-columns）でも own は消えない", async () => {
    await humanInColumnOneWithStageInTwoAndThree();
    const [oneRel, twoRel] = STAGE_RELS;
    const result = await arrangeEditors("three-columns");
    assert.deepStrictEqual(result, { done: true, closed: 0 }, JSON.stringify(result));
    assert.strictEqual(tabGroupCount(), 3, "three-columns で列数が変わった");
    assert.deepStrictEqual(
      await ownByPath([oneRel, twoRel]),
      { [oneRel]: true, [twoRel]: true },
      "減らないプリセットで own が消えた",
    );
    const cleaned = await arrangeEditors("close-own");
    assert.strictEqual(
      cleaned.closed,
      2,
      `close-own が2枚閉じていない: ${JSON.stringify(cleaned)}`,
    );
  });

  test("人間が列2なら two-columns は呼ばずに断り、列の数は変わらない", async () => {
    await humanInColumnOneWithStageInTwoAndThree();
    // **人間を列2に移す**（`preserveFocus: false` でフォーカスごと）。`activeTabGroup`
    // が列2を指すことを**観測**で確かめる ―― ここが 1 のままなら、この検査は
    // 「人間が列2に居る」を見ていない。
    const movedDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), JSON_REL),
    );
    await vscode.window.showTextDocument(movedDoc, {
      viewColumn: 2,
      preview: false,
      preserveFocus: false,
    });
    await waitFor("人間が列2に移る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 2);
    assert.strictEqual(tabGroupCount(), 3, "列が3つでない（前提が崩れている）");

    const result = await arrangeEditors("two-columns");

    assert.deepStrictEqual(
      result,
      { done: false, closed: 0, withheld: ["human-column-would-merge"] },
      `断らなかった: ${JSON.stringify(result)}`,
    );
    // **列の数が変わっていない。** 判定が偽で呼んでいたら、列3が人間の列2に流れ込んで
    // 2になる。合流は非同期に見えることがあるので、少し待ってから見直す。
    assert.strictEqual(tabGroupCount(), 3, "断ったのに列が減った（呼んでいる）");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(tabGroupCount(), 3, "断ったのに、遅れて列が減った（呼んでいる）");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      2,
      "人間の居る列が変わった",
    );

    // 対照1: 同じ状態でも列を減らさない `even-widths` は通る。
    const even = await arrangeEditors("even-widths");
    assert.deepStrictEqual(
      even,
      { done: true, closed: 0 },
      `even-widths が通らない: ${JSON.stringify(even)}`,
    );
    assert.strictEqual(tabGroupCount(), 3, "even-widths で列が減った");

    // 対照2: 3列のまま `three-columns`（減らない）も通る。
    const three = await arrangeEditors("three-columns");
    assert.deepStrictEqual(
      three,
      { done: true, closed: 0 },
      `three-columns が通らない: ${JSON.stringify(three)}`,
    );
    assert.strictEqual(tabGroupCount(), 3, "three-columns で列数が変わった");
  });

  test("single-column は語彙に無く、線上の検証で落ちる（D55-1。列も減らない）", async () => {
    // かつては「人間がどこに居ても断る」語だった。名前が「画面全体を1列に」を約束して
    // 必ず人間の列を巻き込むので、語ごと消した。**落ちる理由まで見る** ―― 語彙の外
    // （invalid_enum_value）であって、別の形の崩れではない。
    await humanInColumnOneWithStageInTwoAndThree();
    await assert.rejects(
      async () =>
        vscode.commands.executeCommand("showme.test.arrangeEditors", { action: "single-column" }),
      (e: unknown) => String(e).includes("invalid_enum_value"),
      "single-column が語彙の外として落ちなかった",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(tabGroupCount(), 3, "落ちたのに列が減った（呼んでいる）");
  });
});

/**
 * 未保存を残さずに全部閉じる。
 *
 * 未保存のまま `closeAllEditors` を呼ぶと VS Code が保存の確認を出し、
 * 誰も押さないのでテストがそこで固まる。**後始末は必ずここを通す。**
 */
async function closeEverythingForArrange(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

suite("実 VS Code / 信頼モード / arrange_editors は人間のタブを閉じない", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIR));
    await writeArrangeFile(ARRANGE_PLAIN_REL, "# plain\n\n保存済みの人間のファイル\n");
    await writeArrangeFile(ARRANGE_OTHER_REL, "# other\n\nもう1枚の人間のファイル\n");
    await writeArrangeFile(ARRANGE_KEEP_REL, "# keep\n\n人間が今見ているファイル\n");
    await writeArrangeFile(
      ARRANGE_SPOOF_REL,
      "# spoof\n\nパネルと同じ label になる人間のファイル\n",
    );
  });

  suiteTeardown(async () => {
    // 作った材料は残さない（次に走る節が「知らないタブ」を見ることになる）。
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIR), {
      recursive: true,
      useTrash: false,
    });
  });

  setup(async () => {
    // パネルの呼び出し予算を戻す（`show_html` は予算を食う）。戻さないと
    // 「パネルが開かなかった」を「所有判定の不具合」と読むことになる。
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  teardown(async () => {
    // **設定を漏らさない。** `closeHumanTabs: true` が残ると、この後に走る
    // すべての test の意味が黙って変わる（人間のタブが閉じてよい世界になる）。
    await setLayoutSetting("closeHumanTabs", undefined);
    await setLayoutSetting("closeDirtyTabs", undefined);
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    // 注釈を次の test に持ち越さない。注釈は塗りも持つ（D65）ので、残すと
    // 「塗りが空」の主張（`close-own` でスポットライトが消える）が残り物で赤くなる。
    await lendWindow();
    await annotateClear();
    await closeEverythingForArrange();
  });

  /**
   * **この増分でいちばん重い主張。** 既定の設定で、人間のタブが1枚も閉じない。
   */
  test("既定のまま3枚開いて close-other-tabs を呼んでも、3枚とも残る", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);

    for (const rel of [ARRANGE_PLAIN_REL, ARRANGE_OTHER_REL, ARRANGE_KEEP_REL]) {
      await openHumanTab(rel);
    }
    await waitFor("3枚のタブが開く", () => arrangeTabs().length === 3);
    // **前提を主張する。** 開いていなければ「1枚も閉じなかった」は自明に真になる。
    const before = arrangeTabLabels();
    assert.deepStrictEqual(before, ["keep.md", "other.md", "plain.md"], "前提が崩れている");
    // 最後に開いた1枚がアクティブ＝候補から外れる。残り2枚が候補に入る。
    assert.deepStrictEqual(
      arrangeTabs()
        .filter((tab) => tab.isActive)
        .map((tab) => tab.label),
      ["keep.md"],
      "アクティブなタブが1枚でない（候補の作られ方が前提と違う）",
    );

    const result = await arrangeEditors("close-other-tabs");

    assert.strictEqual(
      arrangeTabs().length,
      3,
      `人間のタブが閉じた（3 → ${arrangeTabs().length}）: ${arrangeTabLabels().join(", ")}`,
    );
    // **枚数だけでなく名前まで見る。** 1枚閉じて1枚開いても枚数は変わらない。
    assert.deepStrictEqual(arrangeTabLabels(), before, "残ったタブの顔ぶれが変わった");
    assert.strictEqual(result.closed, 0, `closed が 0 でない: ${JSON.stringify(result)}`);
    // **空振りの緑を防ぐ。** 候補が0枚でも `closed: 0` は真になる。
    // 断った理由が返ることが、2枚が候補に入って**拒まれた**ことの証拠である。
    assert.deepStrictEqual(
      result.withheld,
      ["human-tabs-not-allowed"],
      `断った理由が返らない（候補が0枚だった可能性がある）: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **`isDirty` は床である**（D43）。`closeHumanTabs` を立てても未保存には届かない。
   *
   * 対照を同じ呼び出しに入れてある ―― **保存済みの人間のタブは閉じる**。
   * これが無いと、設定が効いていない（＝何も閉じられない）ときにも
   * 「未保存が残った」は真になる。
   */
  test("closeHumanTabs を立てても未保存は残り、保存済みは閉じる（D43）", async () => {
    await closeEverythingForArrange();
    await writeArrangeFile(ARRANGE_DIRTY_REL, "original\n");
    await setLayoutSetting("closeHumanTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      assertLayoutSetting("closeDirtyTabs", undefined);

      await openHumanTab(ARRANGE_PLAIN_REL);
      const dirty = await openHumanTab(ARRANGE_DIRTY_REL);
      const applied = await dirty.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), "未保存の変更\n"),
      );
      assert.ok(applied, "編集そのものが当たっていない ―― 前提が崩れている");
      // **本当に未保存にできたことを主張する。** できていなければ、この検査は
      // 「未保存は閉じない」を何も言っていない（前提が成立していない）。
      assert.ok(dirty.document.isDirty, "未保存にできていない ―― 前提が崩れている");
      await openHumanTab(ARRANGE_KEEP_REL);
      await waitFor("3枚のタブが開く", () => arrangeTabs().length === 3);
      assert.deepStrictEqual(
        arrangeTabLabels(),
        ["dirty.txt", "keep.md", "plain.md"],
        "前提が崩れている",
      );
      // 実機の `Tab.isDirty` が、ドキュメントの未保存と同じことを言っているか。
      // 単体は作り物の `isDirty` を渡すので、ここでしか確かめられない。
      const dirtyTab = arrangeTabs().find((tab) => tab.label === "dirty.txt");
      assert.ok(dirtyTab, "未保存のタブが見つからない");
      assert.strictEqual(
        dirtyTab.isDirty,
        true,
        "ドキュメントは未保存なのに Tab.isDirty が false（判断が見ている量が違う）",
      );

      const result = await arrangeEditors("close-other-tabs");

      const labels = arrangeTabLabels();
      assert.ok(labels.includes("dirty.txt"), `未保存のタブが閉じた: ${labels.join(", ")}`);
      // **対照。** 設定が届いていなければここが残り、上の主張は空振りになる。
      assert.ok(
        !labels.includes("plain.md"),
        `保存済みの人間のタブが閉じていない ―― closeHumanTabs が効いていない（この検査は空振りする）: ${labels.join(", ")}`,
      );
      assert.strictEqual(result.closed, 1, `閉じた枚数が1でない: ${JSON.stringify(result)}`);
      // 断るのは未保存の1件だけ ―― 人間のタブは許可されている。
      assert.deepStrictEqual(
        result.withheld,
        ["dirty-tabs-not-allowed"],
        `断った理由が違う: ${JSON.stringify(result)}`,
      );
    } finally {
      await closeEverythingForArrange();
      await setLayoutSetting("closeHumanTabs", undefined);
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIRTY_REL));
    }
  });

  /**
   * **2つの設定は直交する**（D43）。`closeDirtyTabs` だけでは何も開かない。
   *
   * `mayClose` が2つを OR で見ている実装は、ここで人間のタブを閉じる。
   */
  test("closeDirtyTabs だけを立てても、人間のタブは1枚も閉じない", async () => {
    await closeEverythingForArrange();
    await writeArrangeFile(ARRANGE_DIRTY_REL, "original\n");
    await setLayoutSetting("closeDirtyTabs", true);
    try {
      assertLayoutSetting("closeDirtyTabs", true);
      assertLayoutSetting("closeHumanTabs", undefined);

      await openHumanTab(ARRANGE_PLAIN_REL);
      const dirty = await openHumanTab(ARRANGE_DIRTY_REL);
      const applied = await dirty.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), "未保存の変更\n"),
      );
      assert.ok(applied, "編集そのものが当たっていない ―― 前提が崩れている");
      assert.ok(dirty.document.isDirty, "未保存にできていない ―― 前提が崩れている");
      await openHumanTab(ARRANGE_KEEP_REL);
      await waitFor("3枚のタブが開く", () => arrangeTabs().length === 3);
      const before = arrangeTabLabels();
      assert.deepStrictEqual(before, ["dirty.txt", "keep.md", "plain.md"], "前提が崩れている");

      const result = await arrangeEditors("close-other-tabs");

      assert.deepStrictEqual(arrangeTabLabels(), before, "人間のタブが閉じた");
      assert.strictEqual(result.closed, 0, `closed が 0 でない: ${JSON.stringify(result)}`);
      // 未保存は許してあるので、断る理由は「人間のタブだから」だけになる。
      assert.deepStrictEqual(
        result.withheld,
        ["human-tabs-not-allowed"],
        `断った理由が違う: ${JSON.stringify(result)}`,
      );
    } finally {
      await closeEverythingForArrange();
      await setLayoutSetting("closeDirtyTabs", undefined);
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIRTY_REL));
    }
  });

  /**
   * **題を偽っても自分のものにはならない**（D41）。
   *
   * エージェントが決められるのは題だけで、`viewType` は VS Code が付ける。
   * ここでは**人間のファイルの label とパネルの label を完全に一致させて**
   * から呼ぶ ―― label で所有を決める実装なら、人間のファイルが巻き込まれる。
   */
  test("パネルの label が人間のタブと同じでも、人間のタブは自分のものにならない", async () => {
    await closeEverythingForArrange();
    const collide = await openHumanTab(ARRANGE_SPOOF_REL);
    await openHumanTab(ARRANGE_PLAIN_REL);
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>x</p>",
      title: ARRANGE_SPOOF_TITLE,
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    const panel = panelTab();
    assert.ok(panel, "パネルのタブが見つからない");

    // **衝突が実際に作れたことを主張する。** 作れていなければ、この検査は
    // 「label が同じでも閉じない」を何も言っていない（空振りの緑）。
    const collideLabel = arrangeTextTabs().find((tab) => {
      const input: unknown = tab.input;
      return (
        input instanceof vscode.TabInputText &&
        input.uri.toString() === collide.document.uri.toString()
      );
    })?.label;
    assert.strictEqual(
      collideLabel,
      panel.label,
      `パネルと人間のタブの label が一致していない（衝突が作れていないので、この検査は何も言わない）: ${String(collideLabel)} / ${panel.label}`,
    );

    const result = await arrangeEditors("close-own");

    await waitFor("パネルのタブが消える", () => panelTab() === undefined);
    assert.strictEqual(result.closed, 1, `閉じた枚数が1でない: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["ShowMe: arrange-spoof.md", "plain.md"].sort(),
      "label が同じ人間のタブが巻き込まれた（label で所有を決めている）",
    );
  });

  /**
   * **`close-tabs { paths }` はパスで指したタブだけを閉じる**。
   *
   * 実機所見（2026-09-14）: `closeHumanTabs: true` で `close-other-tabs` を叩くと「各列の
   * 非アクティブ」しか消えず、「これとこれを閉じて」に届かない。`close-all` は列の裏の
   * ターミナルや他拡張のパネルまで消える。単体は偽の面なので、次は実機でしか言えない:
   *
   *   1. 実機の `Tab.isDirty` が床2 として効くこと（指した2枚のうち未保存だけ残る）
   *   2. **指していないタブと、パスを持たないタブ（端末エディタ・自分のパネル）が無傷**なこと
   *   3. 秘匿パス（`.env`）が1本混ざると呼び出し全体が `excluded-path` で、何も閉じないこと
   */
  test("close-tabs: closeHumanTabs で人間の2枚を指すと未保存の1枚だけ残り、指していないタブと端末・パネルは無傷", async () => {
    await closeEverythingForArrange();
    await writeArrangeFile(ARRANGE_DIRTY_REL, "original\n");
    await setLayoutSetting("closeHumanTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      assertLayoutSetting("closeDirtyTabs", undefined);

      // **パスの無いタブを先に作る**（端末エディタと自分のパネル）。後に開く人間のタブが
      // フォーカスを取り、最後に開いた keep.md が「見ている」1枚になる。
      await vscode.commands.executeCommand("workbench.action.createTerminalEditor");
      await waitFor("端末エディタのタブが開く", () =>
        arrangeTabs().some((tab) => tab.input instanceof vscode.TabInputTerminal),
      );
      await vscode.commands.executeCommand("showme.test.showHtml", {
        html: "<p>close-tabs の検査</p>",
        title: "close-tabs の検査",
      });
      await waitFor("パネルが開く", () => panelTab() !== undefined);

      await openHumanTab(ARRANGE_PLAIN_REL);
      await openHumanTab(ARRANGE_OTHER_REL);
      const dirty = await openHumanTab(ARRANGE_DIRTY_REL);
      const applied = await dirty.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), "未保存の変更\n"),
      );
      assert.ok(applied, "編集そのものが当たっていない ―― 前提が崩れている");
      assert.ok(dirty.document.isDirty, "未保存にできていない ―― 前提が崩れている");
      await openHumanTab(ARRANGE_KEEP_REL);
      await waitFor("テキストタブが4枚開く", () => arrangeTextTabs().length === 4);
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.activeTab?.label,
        "keep.md",
        "人間が見ているタブが keep.md でない（前提）",
      );
      const before = arrangeTabLabels();
      assert.ok(before.includes("dirty.txt") && before.includes("plain.md"), "前提が崩れている");
      const terminalsBefore = arrangeTabs().filter(
        (tab) => tab.input instanceof vscode.TabInputTerminal,
      ).length;
      assert.strictEqual(terminalsBefore, 1, "端末エディタが1枚でない（前提）");

      // 指すのは plain.md（保存済み）と dirty.txt（未保存）。other.md と keep.md は指さない。
      const result = await arrangeEditors("close-tabs", {
        paths: [ARRANGE_PLAIN_REL, ARRANGE_DIRTY_REL],
      });

      await waitFor("plain.md が閉じる", () => !arrangeTabLabels().includes("plain.md"));
      const after = arrangeTabLabels();
      assert.ok(after.includes("dirty.txt"), `未保存のタブが閉じた: ${after.join(", ")}`);
      assert.ok(after.includes("other.md"), `指していない other.md が閉じた: ${after.join(", ")}`);
      assert.ok(after.includes("keep.md"), `指していない keep.md が閉じた: ${after.join(", ")}`);
      assert.ok(panelTab() !== undefined, "パスの無い自分のパネルが閉じた（close-own の仕事）");
      assert.strictEqual(
        arrangeTabs().filter((tab) => tab.input instanceof vscode.TabInputTerminal).length,
        terminalsBefore,
        "端末エディタが閉じた（パスの無いタブは指せないはず）",
      );
      // 消えたのは plain.md だけ ―― 前後の差が1枚。
      assert.deepStrictEqual(
        before.filter((label) => label !== "plain.md"),
        after,
        "指した1枚以外にも差が出た",
      );
      assert.deepStrictEqual(
        result,
        { done: true, closed: 1, withheld: ["dirty-tabs-not-allowed"] },
        `結果が違う: ${JSON.stringify(result)}`,
      );
    } finally {
      for (const terminal of vscode.window.terminals) terminal.dispose();
      await closeEverythingForArrange();
      await setLayoutSetting("closeHumanTabs", undefined);
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIRTY_REL));
    }
  });

  test("close-tabs: 既定では人間のタブを指しても1枚も閉じず human-tabs-not-allowed。自分のタブは閉じ、開いていないパスは notOpen", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);

    await openHumanTab(ARRANGE_PLAIN_REL);
    await openHumanTab(ARRANGE_KEEP_REL);
    // 自分のタブ（`show_code` で開く。own）。人間の列より右に開く。
    const [opened] = await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    assert.strictEqual(opened?.match, "one", `自分のタブを開けない: ${JSON.stringify(opened)}`);
    await waitFor("3枚のテキストタブが開く", () => arrangeTextTabs().length === 3);
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが keep.md でない（前提）",
    );
    const before = arrangeTabLabels();

    // 人間の plain.md を指す → 既定では届かない。
    const refused = await arrangeEditors("close-tabs", { paths: [ARRANGE_PLAIN_REL] });
    assert.deepStrictEqual(arrangeTabLabels(), before, "既定で人間のタブが閉じた");
    assert.deepStrictEqual(
      refused,
      { done: true, closed: 0, withheld: ["human-tabs-not-allowed"] },
      `結果が違う: ${JSON.stringify(refused)}`,
    );

    // 自分の sample.ts と、実在するが開いていない other.md を指す → 1枚閉じ、other.md は notOpen。
    // `notOpen` に載るのは**送った綴り**そのもの。
    const result = await arrangeEditors("close-tabs", {
      paths: [SAMPLE_REL, ARRANGE_OTHER_REL],
    });
    await waitFor("sample.ts が閉じる", () => !arrangeTabLabels().includes("sample.ts"));
    assert.deepStrictEqual(
      arrangeTabLabels(),
      before.filter((label) => label !== "sample.ts"),
      "自分のタブ以外にも差が出た",
    );
    assert.deepStrictEqual(
      result,
      { done: true, closed: 1, notOpen: [ARRANGE_OTHER_REL] },
      `結果が違う: ${JSON.stringify(result)}`,
    );
  });

  test("close-tabs: 秘匿パスが1本混ざると呼び出し全体が excluded-path で、何も閉じない（パスごとに答えを割らない）", async () => {
    await closeEverythingForArrange();
    await openHumanTab(ARRANGE_KEEP_REL);
    const [opened] = await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    assert.strictEqual(opened?.match, "one", `自分のタブを開けない: ${JSON.stringify(opened)}`);
    await waitFor("2枚のテキストタブが開く", () => arrangeTextTabs().length === 2);
    const before = arrangeTabLabels();

    // 対照を先に: 同じ own のタブは単独なら閉じられる形である（下の「閉じない」が
    // 「閉じられないタブだった」せいでないことを、同じ画面の後半で示す）。
    let code: unknown;
    try {
      await arrangeEditors("close-tabs", { paths: [SAMPLE_REL, ENV_REL] });
    } catch (e) {
      code = (e as { code?: unknown }).code ?? `no-code:${String(e)}`;
    }
    assert.strictEqual(code, "excluded-path", `断り方が違う: ${String(code)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(arrangeTabLabels(), before, "秘匿パスが混ざった呼び出しで何かが閉じた");

    // 対照: `.env` を外せば同じ own のタブは閉じる。
    const allowed = await arrangeEditors("close-tabs", { paths: [SAMPLE_REL] });
    await waitFor("sample.ts が閉じる", () => !arrangeTabLabels().includes("sample.ts"));
    assert.deepStrictEqual(allowed, { done: true, closed: 1 }, JSON.stringify(allowed));
  });

  /**
   * **ワークスペースの `.vscode/settings.json` では扉を開けられない**（不変条件9 / D40）。
   *
   * この道具の主敵は、人間が読ませている OSS そのものである。そこには
   * `.vscode/settings.json` が入っていて、`closeHumanTabs: true` を置ける。
   * 単体（`pickTrustedValue`）は「ワークスペース値を採らない」を確かめているが、
   * **実機で設定ファイルを置いたときに本当に閉じないか**はここでしか言えない。
   *
   * 対照に `editor.tabSize` を同じファイルに入れてある ―― これが効いていなければ、
   * 「閉じなかった」のは設定ファイルが**そもそも読まれていない**からになる
   * （空振りの緑）。
   */
  test("ワークスペースの設定ファイルでは人間のタブの扉が開かない（不変条件9）", async () => {
    await closeEverythingForArrange();
    const settingsUri = vscode.Uri.joinPath(workspaceRoot(), ".vscode/settings.json");
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), ".vscode"));
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(
        `${JSON.stringify(
          {
            "editor.tabSize": 3,
            "showme.layout.closeHumanTabs": true,
            "showme.layout.closeDirtyTabs": true,
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    );
    try {
      // **前提: この設定ファイルが実際に読まれている。** 読まれていなければ、
      // 下の「閉じなかった」は何も言っていない。
      await waitFor(
        "ワークスペースの設定ファイルが読まれる",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          3,
      );
      // 実機で、ワークスペース値がどう見えるかを記録に残す。
      //
      // **実測（VS Code 1.137）: `inspect()` に `workspaceValue` が来ない。**
      // `scope: "machine"` の宣言が先に落としている（対照の `editor.tabSize` は
      // 来るので、設定ファイル自体は読まれている）。つまりこの検査が見ているのは
      // **結果**（読ませている repo が扉を開けられないこと）であって、
      // `pickTrustedValue` の判別力ではない ―― `pickTrustedValue` に
      // `workspaceValue ?? ...` を足す変異はここでは**生き残る**（実測）。
      // その判別は単体（`config.test.ts` の不変条件9 の節）が持っている。
      // 両方要る: 宣言が honor されなくなっても、コードの側が止める。
      const inspected = vscode.workspace
        .getConfiguration()
        .inspect<boolean>("showme.layout.closeHumanTabs");
      console.log(`[測定] closeHumanTabs の inspect: ${JSON.stringify(inspected)}`);
      assertLayoutSetting("closeHumanTabs", undefined);
      assertLayoutSetting("closeDirtyTabs", undefined);

      // D56: `list_workspaces` の `permissions` にもワークスペース値は載らない
      // （不変条件9）。ここが true になるなら、「読ませている repo が扉を開けた」と
      // エージェントに**申告する**経路が1つ増えたことになる。
      assert.deepStrictEqual(
        (await listWorkspaces()).permissions,
        { closeHumanTabs: false, closeDirtyTabs: false },
        "ワークスペースの設定ファイルの値が list_workspaces の permissions に載った",
      );

      for (const rel of [ARRANGE_PLAIN_REL, ARRANGE_OTHER_REL, ARRANGE_KEEP_REL]) {
        await openHumanTab(rel);
      }
      await waitFor("3枚のタブが開く", () => arrangeTabs().length === 3);
      const before = arrangeTabLabels();
      assert.deepStrictEqual(before, ["keep.md", "other.md", "plain.md"], "前提が崩れている");

      const result = await arrangeEditors("close-other-tabs");

      assert.deepStrictEqual(
        arrangeTabLabels(),
        before,
        "ワークスペースの設定で人間のタブが閉じた（読ませている repo が扉を開けられる）",
      );
      assert.strictEqual(result.closed, 0, `closed が 0 でない: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(
        result.withheld,
        ["human-tabs-not-allowed"],
        `断った理由が違う: ${JSON.stringify(result)}`,
      );
    } finally {
      await vscode.workspace.fs.delete(settingsUri, { useTrash: false });
      await waitFor(
        "ワークスペースの設定ファイルが消える",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          undefined,
      );
    }
  });

  /**
   * **自分が開いたものは既定で片づけられる**（増分5 D53）。
   *
   * 「片づけて」と言われたエージェントが自分で開いたファイルを閉じられなかった
   * （所見 2026-09-12）。`show_code` で開いたタブが own になり、`close-own` で
   * 消えることを実機で言う。`get_editor_state` の `own: true` も同じ観測から出る。
   *
   * 対照を同じ場面に入れてある ―― **人間が開いた `keep.md` は残る**。これが無いと、
   * `isOwnTab` が常に true でも（人間のタブごと消しても）緑になる。
   */
  test("show_code で自分が開いた2枚は close-own で消え、人間の1枚は残る（D53）", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);

    // 人間が先に1枚開いて見ている（＝舞台は隣の列に開く）。
    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } }]);
    await showCode([{ path: ARRANGE_OTHER_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("3枚のタブが開く", () => arrangeTabs().length === 3);
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["keep.md", "other.md", "plain.md"],
      "前提が崩れている",
    );
    // 人間が見ているのは keep.md のまま（`preserveFocus: true`）。ここが舞台側に
    // 移っていると、下の「消える」は床1 で断られて別の理由で赤くなる。
    const viewing = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.strictEqual(
      viewing?.label,
      "keep.md",
      "人間が見ているタブが keep.md でない（前提が崩れている）",
    );

    // `get_editor_state` の `own` は同じ記録から出る。人間のタブには立たない。
    const state = await getEditorState();
    const ownPaths = layoutTabs(state)
      .filter((t) => t.own === true)
      .map((t) => t.path)
      .sort();
    assert.deepStrictEqual(
      ownPaths,
      [ARRANGE_OTHER_REL, ARRANGE_PLAIN_REL].sort(),
      `own: true のタブが自分の2枚でない: ${JSON.stringify(layoutTabs(state))}`,
    );
    const keepTab = layoutTabs(state).find((t) => t.path === ARRANGE_KEEP_REL);
    assert.ok(keepTab, "keep.md が get_editor_state に無い");
    assert.strictEqual(keepTab.own, undefined, "人間が開いた keep.md に own が立った");

    const result = await arrangeEditors("close-own");

    await waitFor("自分の2枚が消える", () => arrangeTabs().length === 1);
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["keep.md"],
      "人間の keep.md が巻き込まれた、または自分の2枚が残った",
    );
    assert.strictEqual(result.closed, 2, `閉じた枚数が2でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.withheld, undefined, `断るものは無いはず: ${JSON.stringify(result)}`);
  });

  /**
   * **片づけたのに指差しが残るのは片づけていない**（増分6 D67）。`close-own` は
   * `show_code` のスポットライトも消す。人間の `keep.md` は開いたままなので、
   * 「タブが全部閉じたから塗りも無い」ではなく、片づけが塗りを消したことを言う。
   */
  test("close-own で show_code のスポットライトも消える（D67）", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);

    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
    const plainUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_PLAIN_REL).toString();
    await waitFor("スポットライトが貼られる", async () =>
      (await inspectVisuals()).highlightedUris.includes(plainUri),
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが keep.md でない（前提が崩れている）",
    );

    const result = await arrangeEditors("close-own");
    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.closed, 1, `閉じた枚数が1でない: ${JSON.stringify(result)}`);
    await waitFor("自分の1枚が消える", () => arrangeTabs().length === 1);
    assert.deepStrictEqual(arrangeTabLabels(), ["keep.md"], "人間の keep.md が巻き込まれた");

    const after = await inspectVisuals();
    assert.deepStrictEqual(
      after.highlightedUris,
      [],
      `片づけたのにスポットライトが残っている: ${after.highlightedUris.join(", ")}`,
    );
  });

  /**
   * **注釈の塗りは `show_code` でも `close-own` でも消えない**（増分6 D66 / §C2）。
   *
   * スポットライト（D67）は窓ごとに置き換わり、片づけでも消える。注釈の塗りは注釈の
   * 寿命なので、別ファイルへの `show_code` の後も、`close-own` の後も残る。
   * 両方を同じ場面で見る ―― 「スポットライトが消えた」と「注釈の塗りが残った」を
   * 同じ観測で言わないと、`clearAll()` で両層ごと消す実装でも片方ずつは緑になる。
   */
  test("annotate の塗りは show_code 別ファイルでも close-own でも残り、スポットライトだけ消える（D66）", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);

    await openHumanTab(ARRANGE_KEEP_REL);
    const otherUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_OTHER_REL).toString();
    const plainUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_PLAIN_REL).toString();
    const layersOf = (visuals: VisualState, uri: string): string[] =>
      visuals.highlightRanges
        .filter((r) => r.uri === uri)
        .map((r) => `${r.layer}:${r.color}`)
        .sort();

    // 注釈は other.md の1行目に赤。吹き出しはタブを開かない（塗りは可視になったとき貼る）。
    const annotated = await annotate([
      {
        location: { path: ARRANGE_OTHER_REL, lines: { start: 1, end: 1 } },
        text: "残る",
        color: "red",
      },
    ]);
    assert.strictEqual(annotated[0]?.match, "one", "注釈の前提が崩れている");
    await waitFor("注釈の塗りが層に載る", async () =>
      layersOf(await inspectVisuals(), otherUri).includes("annotation:red"),
    );

    // 別ファイルへ show_code（黄）。スポットライトは plain.md に、注釈の塗りは other.md に。
    await showCode([{ path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 }, color: "yellow" }]);
    await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
    await waitFor("スポットライトが貼られる", async () =>
      layersOf(await inspectVisuals(), plainUri).includes("spotlight:yellow"),
    );
    const mid = await inspectVisuals();
    assert.deepStrictEqual(
      layersOf(mid, otherUri),
      ["annotation:red"],
      `show_code で注釈の塗りが消えた: ${JSON.stringify(mid.highlightRanges)}`,
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが keep.md でない（前提が崩れている）",
    );

    const result = await arrangeEditors("close-own");
    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    await waitFor("自分の1枚が消える", () => arrangeTabs().length === 1);

    const after = await inspectVisuals();
    assert.deepStrictEqual(
      layersOf(after, plainUri),
      [],
      `片づけたのにスポットライトが残っている: ${JSON.stringify(after.highlightRanges)}`,
    );
    assert.deepStrictEqual(
      layersOf(after, otherUri),
      ["annotation:red"],
      `close-own で注釈の塗りが消えた: ${JSON.stringify(after.highlightRanges)}`,
    );
  });

  /**
   * **床2: 人間が編集して未保存になった自分のタブは閉じない**（D53'）。
   *
   * 4B の式は `own ||` で、自分のものは未保存でも閉じた。テキストタブが own になる
   * 今、エージェントが開いたファイルを人間が編集した瞬間に守られる必要がある。
   *
   * 人間が見ているのは別のタブにしてある ―― 見ていれば床1 で残るので、
   * 「未保存だから残った」を言えなくなる（違う理由で緑）。
   */
  test("自分が開いたタブを人間が編集したら、close-own でも残る（床2 / D53'）", async () => {
    await closeEverythingForArrange();
    await writeArrangeFile(ARRANGE_DIRTY_REL, "original\n");
    try {
      assertLayoutSetting("closeHumanTabs", undefined);
      assertLayoutSetting("closeDirtyTabs", undefined);

      await openHumanTab(ARRANGE_KEEP_REL);
      await showCode([{ path: ARRANGE_DIRTY_REL, lines: { start: 1, end: 1 } }]);
      await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
      const dirtyUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIRTY_REL);
      const editor = visibleEditorFor(dirtyUri);
      assert.ok(editor, "自分が開いたエディタが可視でない（前提が崩れている）");
      const applied = await editor.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), "人間の未保存の変更\n"),
      );
      assert.ok(applied, "編集そのものが当たっていない ―― 前提が崩れている");
      assert.ok(editor.document.isDirty, "未保存にできていない ―― 前提が崩れている");
      const dirtyTab = arrangeTabs().find((tab) => tab.label === "dirty.txt");
      assert.ok(dirtyTab, "未保存のタブが見つからない");
      assert.strictEqual(dirtyTab.isDirty, true, "Tab.isDirty が false（判断が見ている量が違う）");
      // 人間が見ているのは keep.md。ここが dirty.txt なら床1 が先に効く。
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.activeTab?.label,
        "keep.md",
        "人間が見ているタブが keep.md でない（床1 と床2 が区別できない）",
      );
      // 前提: 記録上は自分のもの。own でなければ「候補に入らなかった」でも残る（違う理由で緑）。
      const ownBefore = layoutTabs(await getEditorState()).find(
        (t) => t.path === ARRANGE_DIRTY_REL,
      );
      assert.strictEqual(
        ownBefore?.own,
        true,
        "dirty.txt が own でない（候補に入らないので、この検査は何も言わない）",
      );

      const result = await arrangeEditors("close-own");

      const labels = arrangeTabLabels();
      assert.ok(labels.includes("dirty.txt"), `未保存の自分のタブが閉じた: ${labels.join(", ")}`);
      assert.strictEqual(result.closed, 0, `closed が 0 でない: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(
        result.withheld,
        ["dirty-tabs-not-allowed"],
        `断った理由が違う（候補に入って床2 で断られた証拠が要る）: ${JSON.stringify(result)}`,
      );
    } finally {
      await closeEverythingForArrange();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), ARRANGE_DIRTY_REL));
    }
  });

  /**
   * **床1: 人間が見ているタブは、どの設定でも触らない**（増分5 §C1）。
   *
   * **この増分でいちばん重い主張。** 人間が自分の側から（`preserveFocus: false`）
   * 舞台のタブをアクティブにしたら、それは own のままだが、`close-own` でも
   * `closeHumanTabs: true` ＋ `closeDirtyTabs: true` でも閉じない。
   * 床は設定で外れない ―― 設定を全部立てた呼び出しを**同じ場面で**当てる。
   */
  test("人間が見ている自分のタブは、closeHumanTabs: true でも close-own で残る（床1 / C1）", async () => {
    await closeEverythingForArrange();
    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
    const plainUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_PLAIN_REL);
    const isPlain = (tab: vscode.Tab | undefined): boolean =>
      tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === plainUri.toString();
    // 舞台のタブが載っている列（人間の列とは別）。**同じ列で**アクティブにする ――
    // 列を指定しないと人間の列に同じファイルがもう1枚開き、それは別のタブになる。
    const stageGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some(isPlain));
    assert.ok(stageGroup, "自分が開いたタブの列が見つからない");
    assert.notStrictEqual(
      stageGroup,
      vscode.window.tabGroups.activeTabGroup,
      "舞台が人間の列に開いた（前提が崩れている）",
    );

    // **人間として見る。** `preserveFocus: false` でフォーカスごと移す。
    await vscode.window.showTextDocument(plainUri, {
      viewColumn: stageGroup.viewColumn,
      preserveFocus: false,
      preview: false,
    });
    await waitFor("人間が plain.md を見ている", () =>
      isPlain(vscode.window.tabGroups.activeTabGroup.activeTab),
    );
    // 前提: 同じファイルのタブは1枚（2枚あると、見ていないほうが閉じて closed: 1 になる）。
    assert.strictEqual(
      arrangeTabs().filter(isPlain).length,
      1,
      "plain.md のタブが2枚ある（前提が崩れている）",
    );
    // 前提: 記録上は自分のもの。own でなければ候補に入らず、違う理由で残る。
    const ownBefore = layoutTabs(await getEditorState()).find((t) => t.path === ARRANGE_PLAIN_REL);
    assert.strictEqual(
      ownBefore?.own,
      true,
      "plain.md が own でない（候補に入らないので、この検査は何も言わない）",
    );

    // 1回目: 既定。
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    const byDefault = await arrangeEditors("close-own");
    assert.ok(arrangeTabs().some(isPlain), "既定で、人間が見ている自分のタブが閉じた");
    assert.deepStrictEqual(
      byDefault,
      { done: true, closed: 0, withheld: ["viewing-tab"] },
      `既定の結果が違う: ${JSON.stringify(byDefault)}`,
    );

    // 2回目: **設定を全部立てても**残る。床は設定で外れない。
    await setLayoutSetting("closeHumanTabs", true);
    await setLayoutSetting("closeDirtyTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      assertLayoutSetting("closeDirtyTabs", true);
      assert.ok(
        isPlain(vscode.window.tabGroups.activeTabGroup.activeTab),
        "見ているタブが変わった（前提が崩れている）",
      );
      const withAll = await arrangeEditors("close-own");
      assert.ok(
        arrangeTabs().some(isPlain),
        "closeHumanTabs: true で、人間が見ている自分のタブが閉じた（床が設定で外れている）",
      );
      assert.deepStrictEqual(
        withAll,
        { done: true, closed: 0, withheld: ["viewing-tab"] },
        `設定を立てたときの結果が違う: ${JSON.stringify(withAll)}`,
      );
      // close-other-tabs でも同じ ―― 語彙を変えても床は同じ述語が当てる。
      const other = await arrangeEditors("close-other-tabs");
      assert.ok(arrangeTabs().some(isPlain), "close-other-tabs で、人間が見ているタブが閉じた");
      assert.strictEqual(other.done, true, JSON.stringify(other));
    } finally {
      await setLayoutSetting("closeHumanTabs", undefined);
      await setLayoutSetting("closeDirtyTabs", undefined);
    }

    // **対照: 人間が keep.md に戻れば、同じタブは既定で閉じる。** これが無いと、
    // 上の「残った」は `close-own` が丸ごと死んでいても真になる。
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md に戻る",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    const afterLeaving = await arrangeEditors("close-own");
    await waitFor("見るのをやめた自分のタブが消える", () => !arrangeTabs().some(isPlain));
    assert.deepStrictEqual(
      afterLeaving,
      { done: true, closed: 1 },
      `対照の結果が違う: ${JSON.stringify(afterLeaving)}`,
    );
    assert.deepStrictEqual(arrangeTabLabels(), ["keep.md"], "人間の keep.md が巻き込まれた");
  });

  /**
   * **閉じたら忘れる**（D53）。エージェントが開いた → 人間が閉じた → 人間が同じ
   * ファイルを自分で開いた、は**人間のもの**である。忘れないと、人間が自分で
   * 開き直したタブが `close-own` で消える。
   *
   * 人間が見ているのは別のタブにしてある（床1 で残っても区別がつかないため）。
   * 残った証拠は `withheld` が**無い**こと ―― 候補に入って断られたのではなく、
   * そもそも候補に入っていない（own でない）。
   */
  test("人間が閉じて開き直したタブは、もう自分のものではない（D53: 閉じたら忘れる）", async () => {
    await closeEverythingForArrange();
    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
    const plainUri = vscode.Uri.joinPath(workspaceRoot(), ARRANGE_PLAIN_REL);
    const isPlain = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === plainUri.toString();
    // 前提: 開いた直後は own。これが無いと「忘れた」と「最初から覚えていない」が区別できない。
    const ownAtFirst = layoutTabs(await getEditorState()).find((t) => t.path === ARRANGE_PLAIN_REL);
    assert.strictEqual(ownAtFirst?.own, true, "開いた直後に own でない（前提が崩れている）");

    // 人間が閉じる。
    const agentTab = arrangeTabs().find(isPlain);
    assert.ok(agentTab, "自分が開いたタブが見つからない");
    assert.ok(await vscode.window.tabGroups.close(agentTab, true), "タブを閉じられなかった");
    await waitFor("タブが閉じる", () => !arrangeTabs().some(isPlain));

    // 人間が同じファイルを自分で開き、そのあと keep.md に戻る（plain.md を見ていない状態にする）。
    await openHumanTab(ARRANGE_PLAIN_REL);
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    assert.strictEqual(
      arrangeTabs().filter(isPlain).length,
      1,
      "plain.md のタブが1枚でない（前提が崩れている）",
    );
    const reopened = layoutTabs(await getEditorState()).find((t) => t.path === ARRANGE_PLAIN_REL);
    assert.ok(reopened, "開き直した plain.md が get_editor_state に無い");
    assert.strictEqual(
      reopened.own,
      undefined,
      "人間が開き直したタブに own が立っている（閉じても忘れていない）",
    );

    const result = await arrangeEditors("close-own");

    assert.ok(
      arrangeTabs().some(isPlain),
      `人間が開き直したタブが閉じた: ${arrangeTabLabels().join(", ")}`,
    );
    // 候補に入っていない ―― 断った理由も無い。
    assert.deepStrictEqual(
      result,
      { done: true, closed: 0 },
      `結果が違う: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **人間が先に開いていた文書は、show_code しても own にならない**（D53 仕組み）。
   *
   * 所有の鍵は URI であってタブではない。人間が `sample.ts` を自分の列に開いている
   * ところへエージェントが同じファイルを `show_code` すると舞台に2枚目ができ、
   * 記録だけで決めると人間の1枚目まで own になって `close-own` が閉じる。
   * own を決めるのは観測の側の `isOwnTab` で、**記録にあり、かつ窓にその文書のタブが
   * ちょうど1枚**のときだけ own（2枚以上なら人間が関わっている。閉じない側に倒す）。
   * `isOwnTab` は vscode を値 import しているので、ここでしか言えない。
   *
   * 人間が見ているのは別のファイル（`keep.md`）にしてある ―― 見ていれば床1 で残るので、
   * 「記録しなかったから残った」を言えなくなる。
   * 対照を同じ呼び出しに入れてある ―― 人間が開いていなかった `plain.md` は**閉じる**。
   * これが無いと、`close-own` が丸ごと死んでいても「2枚とも残った」は真になる。
   */
  test("人間が先に開いていたファイルを show_code しても、どちらの1枚も own にならない", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    const sampleUri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const isSample = (tab: vscode.Tab | undefined): boolean =>
      tab?.input instanceof vscode.TabInputText &&
      tab.input.uri.toString() === sampleUri.toString();
    const sampleTabs = (): vscode.Tab[] => arrangeTabs().filter(isSample);

    // 人間が sample.ts を自分の列に開き（人間として、フォーカスごと）、別のファイルへ移る。
    await vscode.window.showTextDocument(sampleUri, {
      viewColumn: 1,
      preserveFocus: false,
      preview: false,
    });
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    assert.strictEqual(sampleTabs().length, 1, "人間の sample.ts が1枚でない（前提が崩れている）");

    // エージェントが同じ sample.ts と、人間が開いていない plain.md を同じ呼び出しで開く。
    await showCode([
      { path: SAMPLE_REL, lines: { start: 1, end: 1 } },
      { path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } },
    ]);
    // **2枚目が実際にできたことを主張する。** できていなければ、この検査は
    // 「人間の1枚が own にならない」を何も言っていない（同じ1枚を見ているだけ）。
    await waitFor("sample.ts が2枚になる", () => sampleTabs().length === 2);
    await waitFor("plain.md が開く", () => arrangeTabLabels().includes("plain.md"));
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが変わった（床1 と区別できない）",
    );

    // `get_editor_state`: sample.ts はどちらの1枚にも own が立たず、plain.md には立つ。
    const state = layoutTabs(await getEditorState());
    const sampleStates = state.filter((t) => t.path === SAMPLE_REL);
    assert.strictEqual(sampleStates.length, 2, `sample.ts が2枚見えない: ${JSON.stringify(state)}`);
    for (const t of sampleStates) {
      assert.strictEqual(
        t.own,
        undefined,
        `既に開いていた sample.ts に own が立った: ${JSON.stringify(t)}`,
      );
    }
    assert.strictEqual(
      state.find((t) => t.path === ARRANGE_PLAIN_REL)?.own,
      true,
      "対照: 人間が開いていなかった plain.md が own でない（記録が丸ごと死んでいる）",
    );

    const result = await arrangeEditors("close-own");

    await waitFor("plain.md が消える", () => !arrangeTabLabels().includes("plain.md"));
    assert.strictEqual(
      sampleTabs().length,
      2,
      `sample.ts のタブが閉じた（人間の1枚目か、自分の2枚目）: ${arrangeTabLabels().join(", ")}`,
    );
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["keep.md", "sample.ts", "sample.ts"],
      "残った顔ぶれが違う",
    );
    // 閉じたのは対照の1枚だけ。sample.ts は候補にすら入っていない（断った理由が無い）。
    assert.deepStrictEqual(
      result,
      { done: true, closed: 1 },
      `結果が違う: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **逆の順序: エージェントが先に開いたファイルを、人間が後から自分の列に開いても
   * own にならない**（D53 仕組み）。
   *
   * 前の検査は「人間が先」。こちらは「エージェントが先」で、記録には確かに入っている
   * （記録時点では1枚だった）。own を決めるのは観測の側の `isOwnTab` が数える
   * **枚数**であって、記録の時点の状態ではない ―― 2枚あれば人間が関わっている。
   *
   * 後半の対照は注意: 人間が自分の1枚を閉じると枚数は1に戻るが、**閉じた時点で URI は
   * 記録から消える**（閉じたら忘れる。誰が閉じたかは問わない）ので、残った自分の
   * 1枚も own にならない。だから `closed: 0` のまま ―― 閉じない側に倒れている。
   */
  test("エージェントが先に開いたファイルを人間が後から開いても、どちらの1枚も own にならない", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    const sampleUri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const isSample = (tab: vscode.Tab | undefined): boolean =>
      tab?.input instanceof vscode.TabInputText &&
      tab.input.uri.toString() === sampleUri.toString();
    const sampleTabs = (): vscode.Tab[] => arrangeTabs().filter(isSample);

    // 人間が keep.md を見ている。エージェントが sample.ts を舞台に開く（記録される）。
    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("sample.ts が開く", () => sampleTabs().length === 1);
    // 前提: この時点では own（1枚しか無い）。これが無いと「記録されなかった」でも緑になる。
    assert.strictEqual(
      layoutTabs(await getEditorState()).find((t) => t.path === SAMPLE_REL)?.own,
      true,
      "開いた直後の sample.ts が own でない（前提が崩れている）",
    );

    // 人間が同じ sample.ts を自分の列に（人間として、フォーカスごと）開き、keep.md に戻る。
    await vscode.window.showTextDocument(sampleUri, {
      viewColumn: 1,
      preserveFocus: false,
      preview: false,
    });
    await waitFor("sample.ts が2枚になる", () => sampleTabs().length === 2);
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );

    const state = layoutTabs(await getEditorState());
    const sampleStates = state.filter((t) => t.path === SAMPLE_REL);
    assert.strictEqual(sampleStates.length, 2, `sample.ts が2枚見えない: ${JSON.stringify(state)}`);
    for (const t of sampleStates) {
      assert.strictEqual(
        t.own,
        undefined,
        `2枚ある sample.ts に own が立った: ${JSON.stringify(t)}`,
      );
    }

    const result = await arrangeEditors("close-own");

    assert.strictEqual(
      sampleTabs().length,
      2,
      `sample.ts のタブが閉じた: ${arrangeTabLabels().join(", ")}`,
    );
    assert.deepStrictEqual(
      result,
      { done: true, closed: 0 },
      `結果が違う: ${JSON.stringify(result)}`,
    );

    // 対照: 人間が自分の1枚（列1のほう）を閉じる → 枚数は1に戻るが、閉じた時点で
    // URI は忘れられているので、残った自分の1枚も own でない。閉じない側に倒れる。
    const humanCopy = vscode.window.tabGroups.all
      .find((g) => g.viewColumn === 1)
      ?.tabs.find(isSample);
    assert.ok(humanCopy, "列1の sample.ts が見つからない（前提が崩れている）");
    assert.ok(await vscode.window.tabGroups.close(humanCopy, true), "人間の1枚を閉じられなかった");
    await waitFor("sample.ts が1枚に戻る", () => sampleTabs().length === 1);
    assert.strictEqual(
      layoutTabs(await getEditorState()).find((t) => t.path === SAMPLE_REL)?.own,
      undefined,
      "人間が1枚閉じたら、残った1枚が own に戻った（閉じても忘れていない）",
    );
    const after = await arrangeEditors("close-own");
    assert.strictEqual(sampleTabs().length, 1, "残った sample.ts が閉じた");
    assert.deepStrictEqual(
      after,
      { done: true, closed: 0 },
      `対照の結果が違う: ${JSON.stringify(after)}`,
    );
  });

  /**
   * **人間が動かしたタブは人間のものになる**（D53 / §C2）。
   *
   * VS Code はタブの移動を「閉じて開き直す」としてモデル化する ―― 別の列へ動かすと
   * `onDidChangeTabs` の `closed` が発火し、記録は消える。これは欠陥ではなく意図した
   * 意味である: 人間が自分の列へ引き寄せたタブは、人間が自分のものにした。
   * ここでは `closed` が実際に発火することまで観測する（発火しなければ、この検査は
   * 「動かしたら忘れる」を何も言っていない）。
   *
   * 残った証拠は `withheld` が**無い**こと ―― 候補にすら入っていない（own でない）。
   * 人間が見ているのは別のファイル（`keep.md`）にしてある。
   */
  test("人間が動かしたタブは人間のものになる（D53）", async () => {
    await closeEverythingForArrange();
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    const sampleUri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const isSample = (tab: vscode.Tab | undefined): boolean =>
      tab?.input instanceof vscode.TabInputText &&
      tab.input.uri.toString() === sampleUri.toString();
    const sampleTabs = (): vscode.Tab[] => arrangeTabs().filter(isSample);

    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("sample.ts が舞台に開く", () => sampleTabs().length === 1);
    const stageGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some(isSample));
    assert.ok(stageGroup, "舞台の列が見つからない");
    assert.notStrictEqual(stageGroup.viewColumn, 1, "舞台が列1に開いた（前提が崩れている）");
    // 前提: 動かす前は own。これが無いと「最初から own でない」でも緑になる。
    assert.strictEqual(
      layoutTabs(await getEditorState()).find((t) => t.path === SAMPLE_REL)?.own,
      true,
      "動かす前の sample.ts が own でない（前提が崩れている）",
    );

    // **人間が舞台のタブを自分の列（列1）へ動かす。** そのタブをアクティブにしてから
    // 左のグループへ移す。移動で `closed` が発火することを数える。
    let closedEvents = 0;
    const listener = vscode.window.tabGroups.onDidChangeTabs((e) => {
      closedEvents += e.closed.filter(isSample).length;
    });
    try {
      await vscode.window.showTextDocument(sampleUri, {
        viewColumn: stageGroup.viewColumn,
        preserveFocus: false,
      });
      await waitFor("人間が舞台の sample.ts を見ている", () =>
        isSample(vscode.window.tabGroups.activeTabGroup.activeTab),
      );
      await vscode.commands.executeCommand("workbench.action.moveEditorToLeftGroup");
      await waitFor(
        "sample.ts が列1に移る",
        () =>
          vscode.window.tabGroups.all.find((g) => g.viewColumn === 1)?.tabs.some(isSample) === true,
      );
    } finally {
      listener.dispose();
    }
    // **実測を固定する。** 移動は close+open としてモデル化されている。
    assert.strictEqual(closedEvents, 1, `移動で closed が1回発火しなかった: ${closedEvents} 回`);
    assert.strictEqual(
      sampleTabs().length,
      1,
      "移動で sample.ts が増えた／消えた（前提が崩れている）",
    );

    // 人間は keep.md に戻る（見ていれば床1 で残るので、区別がつかなくなる）。
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    assert.strictEqual(
      layoutTabs(await getEditorState()).find((t) => t.path === SAMPLE_REL)?.own,
      undefined,
      "人間が動かしたタブに own が立っている",
    );

    const result = await arrangeEditors("close-own");

    assert.strictEqual(
      sampleTabs().length,
      1,
      `人間が動かしたタブが閉じた: ${arrangeTabLabels().join(", ")}`,
    );
    assert.deepStrictEqual(
      result,
      { done: true, closed: 0 },
      `結果が違う: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **人間が起こしたレイアウトの合流で own は消える**（D53 / §C2）。人間がコマンドパレットから
   * 「2列」を選ぶと、舞台の列3が列2に畳まれ、そこにあったタブは close+open で別の列へ移り、
   * 記録から消える ―― 人間が動かしたタブは人間のもの。
   *
   * **エージェント自身が `arrange_editors two-columns` で起こした合流は逆で、own を保つ**
   * （「プリセットは人間の列を巻き込まない」の節にある）。同じ close 事象で区別が
   * つかないので、区別は「誰が呼んだか」でしか付かない: ここは VS Code のコマンドを
   * **人間として直接**叩き、`arrange_editors` を通さない。
   *
   * 以前は 2列を `single-column` で畳んでいたが、それは人間の列1に舞台を流し込む
   * 操作で、D55-2で断られるようになった。人間の列を巻き込まない合流
   * （人間1 ＋ 舞台2・3 → 2列で列3が列2へ）で同じ量を見る。
   * 動かなかった側（列2）は own のまま閉じる ―― 「消えた」の対照である。
   */
  test("人間が起こしたレイアウトの合流で列が畳まれたタブは own でなくなる", async () => {
    await closeEverythingForArrange();
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが1つに戻る", () => tabGroupCount() === 1);
    await openHumanTab(ARRANGE_KEEP_REL);
    await showCode(
      [
        { path: ARRANGE_PLAIN_REL, lines: { start: 1, end: 1 } },
        { path: ARRANGE_OTHER_REL, lines: { start: 1, end: 1 } },
      ],
      "split",
    );
    await waitFor("列が 人間1 + 舞台2 = 3 になる", () => tabGroupCount() === 3);
    // 列3に居るほうが「動く」タブ、列2に居るほうが「動かない」タブ。順序は決め打ちせず観測する。
    const columnOf = (rel: string): number | undefined =>
      visibleEditorFor(vscode.Uri.joinPath(workspaceRoot(), rel))?.viewColumn;
    const movedRel = columnOf(ARRANGE_PLAIN_REL) === 3 ? ARRANGE_PLAIN_REL : ARRANGE_OTHER_REL;
    const stayedRel = movedRel === ARRANGE_PLAIN_REL ? ARRANGE_OTHER_REL : ARRANGE_PLAIN_REL;
    assert.strictEqual(columnOf(movedRel), 3, "舞台が列3に開いていない（前提が崩れている）");
    assert.strictEqual(columnOf(stayedRel), 2, "舞台が列2に開いていない（前提が崩れている）");
    const movedUri = vscode.Uri.joinPath(workspaceRoot(), movedRel);
    const isMoved = (tab: vscode.Tab | undefined): boolean =>
      tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === movedUri.toString();
    for (const rel of [movedRel, stayedRel]) {
      assert.strictEqual(
        layoutTabs(await getEditorState()).find((t) => t.path === rel)?.own,
        true,
        `合流前の ${rel} が own でない（前提が崩れている）`,
      );
    }

    let closedEvents = 0;
    const listener = vscode.window.tabGroups.onDidChangeTabs((e) => {
      closedEvents += e.closed.filter(isMoved).length;
    });
    try {
      // **人間として**叩く（`arrange_editors` ではない）。エージェント経由なら面が記録し直す。
      await vscode.commands.executeCommand("workbench.action.editorLayoutTwoColumns");
      await waitFor("2列に畳まれる", () => tabGroupCount() === 2);
    } finally {
      listener.dispose();
    }
    assert.strictEqual(closedEvents, 1, `合流で closed が1回発火しなかった: ${closedEvents} 回`);
    assert.ok(arrangeTabs().some(isMoved), "合流で動いたタブが消えた（前提が崩れている）");
    // 人間が見ているのは keep.md にする。
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    const after = layoutTabs(await getEditorState());
    assert.strictEqual(
      after.find((t) => t.path === movedRel)?.own,
      undefined,
      "人間の合流で動いたタブに own が立っている（人間が動かしたタブは人間のもの）",
    );
    // 対照: 動かなかった側は own のまま（合流が「記録を全部消す」のではないこと）。
    assert.strictEqual(
      after.find((t) => t.path === stayedRel)?.own,
      true,
      "動かなかったタブの own が消えた",
    );
    const result = await arrangeEditors("close-own");
    assert.ok(arrangeTabs().some(isMoved), "合流で動いたタブが閉じた");
    assert.deepStrictEqual(
      result,
      { done: true, closed: 1 },
      `結果が違う（動かなかった own の1枚だけが閉じるはず）: ${JSON.stringify(result)}`,
    );
  });

  /**
   * **配置を変える語は、実機でも1枚も閉じない。**
   *
   * 5語すべてに当てる ―― 1語だけを見ていると、他の語が
   * 閉じるコマンドに対応づけられていても緑になる。`done: true` も一緒に
   * 見る（**通るべきものが通ること**。実機に無いコマンド名なら false になる）。
   *
   * 人間（タブは全部列1）が居るまま 1→2→3→2→4 列と枠を作る。`two-rows` は 3→2 で
   * 減るが、人間が列1なので通る（D55-2 の安全側の実機）。`single-column` は
   * 語彙から消えた（4→1 は必ず人間の列に合流する語だった）。
   */
  test("配置を変える5語は、実機でもタブを1枚も閉じない", async () => {
    await closeEverythingForArrange();
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが1つに戻る", () => tabGroupCount() === 1);
    await openHumanTab(ARRANGE_PLAIN_REL);
    await openHumanTab(ARRANGE_KEEP_REL);
    await waitFor("2枚のタブが開く", () => arrangeTabs().length === 2);
    const before = arrangeTabLabels();
    assert.deepStrictEqual(before, ["keep.md", "plain.md"], "前提が崩れている");

    for (const action of [
      "two-columns",
      "three-columns",
      "two-rows",
      "grid",
      "even-widths",
    ] as const) {
      const result = await arrangeEditors(action);
      assert.strictEqual(result.done, true, `${action} が done: false（実機に無いコマンド名か）`);
      assert.strictEqual(result.closed, 0, `${action} でタブを閉じた`);
      assert.strictEqual(result.withheld, undefined, `${action} で withheld が返った`);
      assert.deepStrictEqual(arrangeTabLabels(), before, `${action} でタブの顔ぶれが変わった`);
    }
    assert.strictEqual(tabGroupCount(), 4, "grid のあとで列が4つでない（前提が崩れている）");
    // 列の構成を戻してから抜ける。道具に1列へ戻す語は無い（`single-column` は消えた）ので、
    // **検査の後始末として** VS Code のコマンドを直接呼ぶ。タブは全部人間の列1にあるので、
    // 失うものは無い。
    await vscode.commands.executeCommand("workbench.action.editorLayoutSingle");
    await waitFor("1列に戻る", () => tabGroupCount() === 1);
  });

  /**
   * **人間が道具の外でタブを閉じた直後に呼んでも、取り違えない。**
   *
   * 面は `listTabs()` のたびに札とタブの対応を作り直し、引けなかった札は
   * 黙って飛ばす。**その「飛ばす」枝は外からは踏めない** ―― 面は呼び出しごとに
   * 作り直される（`arrangeDeps()`）ので、札が呼び出しをまたいで残らない。
   * ここで確かめられるのは、**古い観測を持ち越していないこと**である
   * （持ち越す実装に変えると、ここで別のタブが閉じる）。
   */
  test("外でタブを閉じた直後に呼んでも、別のタブを巻き込まない", async () => {
    await closeEverythingForArrange();
    const doomed = await openHumanTab(ARRANGE_PLAIN_REL);
    await openHumanTab(ARRANGE_KEEP_REL);
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>片づけの検査</p>",
      title: "外で閉じる検査",
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    assert.deepStrictEqual(
      arrangeTabLabels(),
      ["ShowMe: 外で閉じる検査", "keep.md", "plain.md"].sort(),
      "前提が崩れている",
    );

    // **道具の外で**1枚閉じる（人間がしたことに相当する）。
    await vscode.window.showTextDocument(doomed.document, { viewColumn: 1, preview: false });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor("外で閉じたタブが消える", () => !arrangeTabLabels().includes("plain.md"));

    const result = await arrangeEditors("close-own");

    assert.strictEqual(result.done, true, `done が true でない: ${JSON.stringify(result)}`);
    assert.strictEqual(result.closed, 1, `閉じた枚数が1でない: ${JSON.stringify(result)}`);
    await waitFor("パネルのタブが消える", () => panelTab() === undefined);
    assert.deepStrictEqual(arrangeTabLabels(), ["keep.md"], "残るはずのタブが巻き込まれた");
  });
});

/**
 * **エージェントは自分にできることを呼ぶ前に読める**（設計 D56 / C5）。
 *
 * 人間の言葉: 「AI エージェントが、自分ができることを把握できていないのは良くない」。
 * 今までは `arrange_editors` を呼んで `withheld` で断られて初めて分かった。
 *
 * 3欄は `readConfig()` から写すだけなので、**グローバルに立てたら写る**ことと、
 * **既定なら既定の値**であることを実機で見る。設定は必ず `finally` で戻す ――
 * 残すと、この後に走る「既定のまま」の検査が前提から崩れる。
 */
suite("実 VS Code / 信頼モード / list_workspaces は自分にできることを返す", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    // 機能の検査は関門より**手前**の回数制限で断られては意味が無い（空振りの赤）。
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  /** 断られた理由が「設定で切られている」で、**直す鍵**を言っていること。 */
  function refusedBySetting(tool: string, feature: "stage" | "html" | "layout") {
    return (e: unknown) =>
      String(e).includes(`Tool ${tool} is disabled by settings`) &&
      String(e).includes(`showme.${feature}.enabled`);
  }

  test("既定では permissions は両方 false、features は全部 true、disabledTools は空、editorGroup は dedicated（D56 / D74）", async () => {
    // **既定のままであることを主張する。** 立っていたら「既定の」値を見ていない。
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    for (const key of [
      "stage.enabled",
      "html.enabled",
      "html.maxPanels",
      "layout.enabled",
      "stage.editorGroup",
    ]) {
      assertGlobal(key, undefined);
    }
    // 消した鍵が宣言に残っていない（残っていれば `inspect` が defaultValue を返す）。
    assert.strictEqual(
      vscode.workspace.getConfiguration().inspect("showme.tools.disabled")?.defaultValue,
      undefined,
      "showme.tools.disabled がまだ宣言されている（D74）",
    );
    assert.strictEqual(
      vscode.workspace.getConfiguration().inspect("showme.editorGroup")?.defaultValue,
      undefined,
      "showme.editorGroup がまだ宣言されている（D74）",
    );

    const r = await listWorkspaces();
    assert.deepStrictEqual(r.permissions, { closeHumanTabs: false, closeDirtyTabs: false });
    assert.deepStrictEqual(r.features, { stage: true, html: true, layout: true });
    assert.deepStrictEqual(r.disabledTools, []);
    assert.strictEqual(r.editorGroup, "dedicated");
    // パネルの上限の既定は 2（増分6.2 D80。宣言の既定と `readConfig` の既定が同じ1つの値）。
    assert.deepStrictEqual(r.panels, { max: 2 });
    assert.strictEqual(
      vscode.workspace.getConfiguration().inspect("showme.html.maxPanels")?.defaultValue,
      2,
      "showme.html.maxPanels の宣言の既定が 2 でない",
    );
  });

  test("closeHumanTabs を global で立てると permissions に写る", async () => {
    await setLayoutSetting("closeHumanTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      const r = await listWorkspaces();
      assert.strictEqual(r.permissions.closeHumanTabs, true, `写っていない: ${JSON.stringify(r)}`);
      // 触っていない側は動かない（片方を立てたら両方 true になる実装を通さない）。
      assert.strictEqual(r.permissions.closeDirtyTabs, false, `巻き添え: ${JSON.stringify(r)}`);
    } finally {
      await setLayoutSetting("closeHumanTabs", undefined);
    }
    assertLayoutSetting("closeHumanTabs", undefined);
    // 戻したら戻る（設定を毎回読み直している。activate 時の値を握っていない）。
    assert.strictEqual((await listWorkspaces()).permissions.closeHumanTabs, false);
  });

  test("closeDirtyTabs を global で立てると permissions に写る", async () => {
    await setLayoutSetting("closeDirtyTabs", true);
    try {
      assertLayoutSetting("closeDirtyTabs", true);
      const r = await listWorkspaces();
      assert.strictEqual(r.permissions.closeDirtyTabs, true, `写っていない: ${JSON.stringify(r)}`);
      assert.strictEqual(r.permissions.closeHumanTabs, false, `巻き添え: ${JSON.stringify(r)}`);
    } finally {
      await setLayoutSetting("closeDirtyTabs", undefined);
    }
    assertLayoutSetting("closeDirtyTabs", undefined);
  });

  /**
   * **機能を切ると、その機能のツールだけが断られ、一覧に載る**（増分6 D75）。
   *
   * 一覧（`list_workspaces.disabledTools`）と関門（`checkToolGate`）は同じ表
   * `FEATURE_OF_TOOL` から読む。ここでは**両方**を実機で見る ―― 一覧だけ更新されて
   * 関門が古い、の逆も無いこと。対照として、切っていない機能のツールは通る。
   */
  test("html を切ると show_html だけが断られ、disabledTools に載る（D75）", async () => {
    await setGlobal("html.enabled", false);
    try {
      assertGlobal("html.enabled", false);
      const r = await listWorkspaces();
      assert.strictEqual(r.features.html, false, JSON.stringify(r));
      assert.strictEqual(r.features.stage, true, `巻き添え: ${JSON.stringify(r)}`);
      assert.strictEqual(r.features.layout, true, `巻き添え: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(r.disabledTools, ["show_html"], JSON.stringify(r));
      await assert.rejects(
        () =>
          Promise.resolve(
            vscode.commands.executeCommand("showme.test.showHtml", { html: "<p>x</p>" }),
          ),
        refusedBySetting("show_html", "html"),
        "html を切ったのに show_html が断られなかった（あるいは鍵を言わない）",
      );
      // 対照: 他の機能のツールと核は通る。
      const passed = await arrangeEditors("close-own");
      assert.strictEqual(passed.done, true, `layout の道具が巻き添え: ${JSON.stringify(passed)}`);
      await annotateClear();
    } finally {
      await setGlobal("html.enabled", undefined);
    }
    assertGlobal("html.enabled", undefined);
    // 戻したら戻る（設定を毎回読み直している。activate 時の値を握っていない）。
    const back = await listWorkspaces();
    assert.deepStrictEqual(back.disabledTools, []);
    assert.strictEqual(back.features.html, true);
  });

  test("layout を切ると arrange_editors と show_view が断られ、disabledTools に載る（D75）", async () => {
    await setGlobal("layout.enabled", false);
    try {
      assertGlobal("layout.enabled", false);
      const r = await listWorkspaces();
      assert.strictEqual(r.features.layout, false, JSON.stringify(r));
      // 順序は `TOOL_NAMES`（語彙）の順で、設定の並びではない。
      assert.deepStrictEqual(r.disabledTools, ["show_view", "arrange_editors"], JSON.stringify(r));
      await assert.rejects(
        () => arrangeEditors("close-own"),
        refusedBySetting("arrange_editors", "layout"),
        "layout を切ったのに arrange_editors が断られなかった",
      );
      await assert.rejects(
        () =>
          Promise.resolve(
            vscode.commands.executeCommand("showme.test.showView", { action: "hide-panel" }),
          ),
        refusedBySetting("show_view", "layout"),
        "layout を切ったのに show_view が断られなかった",
      );
      // 対照: html の道具は通る（パネルは後で片づける）。
      const html = (await vscode.commands.executeCommand("showme.test.showHtml", {
        html: "<p>layout off</p>",
      })) as { shown?: unknown };
      assert.strictEqual(html.shown, true, `html の道具が巻き添え: ${JSON.stringify(html)}`);
    } finally {
      await setGlobal("layout.enabled", undefined);
    }
    assertGlobal("layout.enabled", undefined);
    assert.deepStrictEqual((await listWorkspaces()).disabledTools, []);
    // 戻したので片づけられる（関門も戻っている）。
    const cleaned = await arrangeEditors("close-own");
    assert.strictEqual(cleaned.done, true, JSON.stringify(cleaned));
  });

  /** いまのタブの集合を、列ごとに。**位置と中身の両方**（増えても動いても違いになる）。 */
  function tabSnapshot(): { column: vscode.ViewColumn; tabs: string[] }[] {
    return vscode.window.tabGroups.all.map((group) => ({
      column: group.viewColumn,
      tabs: group.tabs.map((tab) => tab.label).sort(),
    }));
  }

  /** そのファイルのスポットライト層の塗り（0始まりの行）。 */
  function spotlightLinesOf(visuals: VisualState, uri: vscode.Uri): number[] {
    return visuals.highlightRanges
      .filter((r) => r.uri === uri.toString() && r.layer === "spotlight")
      .map((r) => r.startLine)
      .sort();
  }

  /**
   * **`stage` を切ると `show_code` は印だけ**（増分6 D75 / D76 / §C5）。
   *
   * 位置は解決して返し、塗りはスポットライトに登録するが、**開かない・スクロール
   * しない・列を作らない**。設定が縛るのはエージェントであって人間ではないので、
   * 人間が自分でそのファイルを開くと塗りが見える。ステータスバーには `path:line`
   * が出る（開かない結果を黙らせない）。
   *
   * 「開かない」を言うには開いていないファイルが要る（`MARK_ONLY_RELS`。他の検査と
   * 共有しない）。タブは**列ごとの集合**で前後を比べる ―― 枚数だけでは「別の列に
   * 開いた」が判別しない。
   */
  test("stage を切ると show_note は断られ、show_code は開かずに印だけ付ける（D75 / D76）", async () => {
    const [oneRel, twoRel] = MARK_ONLY_RELS;
    const oneUri = vscode.Uri.joinPath(workspaceRoot(), oneRel);
    const twoUri = vscode.Uri.joinPath(workspaceRoot(), twoRel);
    const openLabels = () => tabSnapshot().flatMap((g) => g.tabs);
    assert.ok(!openLabels().includes("one.md"), "前提が崩れている: mark/one.md が既に開いている");
    assert.ok(!openLabels().includes("two.md"), "前提が崩れている: mark/two.md が既に開いている");
    const before = tabSnapshot();
    const groupsBefore = tabGroupCount();

    await setGlobal("stage.enabled", false);
    try {
      assertGlobal("stage.enabled", false);
      const r = await listWorkspaces();
      assert.strictEqual(r.features.stage, false, JSON.stringify(r));
      assert.deepStrictEqual(r.disabledTools, ["show_note"], JSON.stringify(r));
      await assert.rejects(
        () =>
          Promise.resolve(
            vscode.commands.executeCommand("showme.test.showNote", { text: "stage off" }),
          ),
        refusedBySetting("show_note", "stage"),
        "stage を切ったのに show_note が断られなかった",
      );

      // --- 1本: 解決は返るが、開かない ---
      const resolution = await showOne({ path: oneRel, text: MARK_ONLY_MARKER });
      assert.strictEqual(resolution.match, "one", JSON.stringify(resolution));
      assert.strictEqual(resolution.normalizedPath, oneRel, JSON.stringify(resolution));
      // **結果の形は設定で変えない**（D76: `opened` のような欄は無い。線の語彙のまま）。
      for (const key of Object.keys(resolution)) {
        assert.ok(ALLOWED_RESOLUTION_KEYS.has(key), `結果に余計な欄がある: ${key}`);
      }
      assert.deepStrictEqual(tabSnapshot(), before, "stage を切ったのに show_code がタブを開いた");
      assert.strictEqual(tabGroupCount(), groupsBefore, "stage を切ったのに列が増えた");
      assert.strictEqual(
        visibleEditorFor(oneUri),
        undefined,
        "stage を切ったのにエディタが見えている",
      );

      // 塗りは**登録されている**（見えていないので貼れないが、観測面には出る）。
      const marked = await inspectVisuals();
      assert.ok(
        marked.highlightedUris.includes(oneUri.toString()),
        `印が登録されていない: ${marked.highlightedUris.join(", ")}`,
      );
      assert.deepStrictEqual(
        spotlightLinesOf(marked, oneUri),
        [2],
        JSON.stringify(marked.highlightRanges),
      );
      // ステータスバーに `path:line`（1始まり）。開かない結果の唯一の痕跡。
      assert.ok(
        marked.statusBar.text.includes(`${oneRel}:3`),
        `ステータスバーが印の場所を言っていない: ${marked.statusBar.text}`,
      );
      assert.ok(
        marked.statusBar.text.includes("marked"),
        `ステータスバーが印だと言っていない: ${marked.statusBar.text}`,
      );

      // --- 人間が開く（§C5: 設定は人間を縛らない）→ 塗りが見える ---
      const doc = await vscode.workspace.openTextDocument(oneUri);
      await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
      await waitFor("人間が開いたエディタが見える", () => visibleEditorFor(oneUri) !== undefined);
      const opened = await inspectVisuals();
      assert.deepStrictEqual(
        spotlightLinesOf(opened, oneUri),
        [2],
        `人間が開いたのに塗りが無い: ${JSON.stringify(opened.highlightRanges)}`,
      );
      assert.ok(visibleEditorFor(oneUri), "人間が開いたエディタが消えた");

      // --- split で2本: それでも列は増えず、2本目も開かない ---
      const afterHuman = tabSnapshot();
      const groupsAfterHuman = tabGroupCount();
      const both = await showCode(
        [
          { path: oneRel, text: MARK_ONLY_MARKER },
          { path: twoRel, text: MARK_ONLY_MARKER },
        ],
        "split",
      );
      assert.deepStrictEqual(
        both.map((x) => x.match),
        ["one", "one"],
        JSON.stringify(both),
      );
      assert.deepStrictEqual(
        tabSnapshot(),
        afterHuman,
        "split なのに stage を切った show_code がタブを開いた",
      );
      assert.strictEqual(
        tabGroupCount(),
        groupsAfterHuman,
        "split なのに列が増えた（D76: layout は無視）",
      );
      assert.strictEqual(visibleEditorFor(twoUri), undefined, "2本目が見えている");
      const split = await inspectVisuals();
      assert.deepStrictEqual(
        spotlightLinesOf(split, oneUri),
        [2],
        JSON.stringify(split.highlightRanges),
      );
      assert.deepStrictEqual(
        spotlightLinesOf(split, twoUri),
        [2],
        JSON.stringify(split.highlightRanges),
      );
      assert.ok(
        split.statusBar.text.includes(`${twoRel}:3`),
        `ステータスバーが最後の印の場所を言っていない: ${split.statusBar.text}`,
      );
    } finally {
      await setGlobal("stage.enabled", undefined);
      // 人間が開いた1枚を閉じる（他の検査の前提を汚さない）。
      const mine = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === oneUri.toString(),
        );
      if (mine.length > 0) await vscode.window.tabGroups.close(mine);
    }
    assertGlobal("stage.enabled", undefined);
    assert.deepStrictEqual((await listWorkspaces()).disabledTools, []);
    // 戻したら開く（設定を毎回読み直している。activate 時の値を握っていない）。
    const back = await showOne({ path: twoRel, text: MARK_ONLY_MARKER });
    assert.strictEqual(back.match, "one", JSON.stringify(back));
    await waitFor("stage を戻したら開く", () => visibleEditorFor(twoUri) !== undefined);
    await arrangeEditors("close-own");
  });

  /**
   * **ワークスペースの `.vscode/settings.json` では機能を戻せない**（増分6 C4' / 不変条件9）。
   *
   * 3機能の既定は true なので、ワークスペース値が効くとしたら「人間が global で
   * 切ったものを、読ませている OSS が true に戻す」向きである。global で false に
   * してから、ワークスペースに true を置き、それでも断られることを実機で見る。
   *
   * 対照に `editor.tabSize` を同じファイルに入れてある ―― これが効いていなければ、
   * 「断られた」のは設定ファイルが**そもそも読まれていない**からになる（空振りの緑）。
   */
  test("ワークスペースの設定ファイルに layout.enabled: true があっても global の false が勝つ（C4'）", async () => {
    const settingsUri = vscode.Uri.joinPath(workspaceRoot(), ".vscode/settings.json");
    // global の書き込みも `try` の中 ―― 設定ファイルの書き込みで落ちたとき、
    // global の false が後の検査に漏れないように、`finally` が必ず戻す。
    try {
      await setGlobal("layout.enabled", false);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), ".vscode"));
      await vscode.workspace.fs.writeFile(
        settingsUri,
        Buffer.from(
          `${JSON.stringify(
            { "editor.tabSize": 3, "showme.layout.enabled": true, "showme.html.enabled": true },
            null,
            2,
          )}\n`,
          "utf8",
        ),
      );
      await waitFor(
        "ワークスペースの設定ファイルが読まれる",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          3,
      );
      assertGlobal("layout.enabled", false);
      const r = await listWorkspaces();
      assert.strictEqual(
        r.features.layout,
        false,
        `ワークスペースの設定ファイルが機能を戻した: ${JSON.stringify(r)}`,
      );
      assert.deepStrictEqual(r.disabledTools, ["show_view", "arrange_editors"]);
      await assert.rejects(
        () => arrangeEditors("close-own"),
        refusedBySetting("arrange_editors", "layout"),
        "ワークスペースの設定で arrange_editors が通った（読ませている repo が扉を開けられる）",
      );
    } finally {
      await setGlobal("layout.enabled", undefined);
      // 書けていなくても消せるように（無ければ何もしない）。
      await vscode.workspace.fs.delete(settingsUri, { useTrash: false }).then(undefined, () => {});
      await waitFor(
        "ワークスペースの設定ファイルが消える",
        () =>
          vscode.workspace.getConfiguration().inspect<number>("editor.tabSize")?.workspaceValue ===
          undefined,
      );
    }
    assertGlobal("layout.enabled", undefined);
    assert.deepStrictEqual((await listWorkspaces()).disabledTools, []);
  });

  test("stage.editorGroup を global で active にすると editorGroup に写る（D74 で鍵が移った）", async () => {
    await setGlobal("stage.editorGroup", "active");
    try {
      assertGlobal("stage.editorGroup", "active");
      assert.strictEqual((await listWorkspaces()).editorGroup, "active");
    } finally {
      await setGlobal("stage.editorGroup", undefined);
    }
    assert.strictEqual((await listWorkspaces()).editorGroup, "dedicated");
  });
});

/**
 * **実機で画面を組んでから読む**（設計 D37/D37'/D38）。
 *
 * 単体は偽の観測を渡すので、`vscode.Tab` の**実際の形**（`input` の型、
 * `viewType` の接頭辞、`viewColumn` の番号、可視エディタと `Tab` の対応）は
 * 確かめられない。ここで当てる。
 *
 * 呼び出し予算は毎回戻す。`get_editor_state` は1分に30回で閉じるので、
 * 戻さないと**観測にすら行かずに断られた**結果を「何も返らなかった」と
 * 読むことになる（空振りの緑）。
 */
suite("実 VS Code / 信頼モード / get_editor_state がレイアウトを返す", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("2列に開くと groups が2つ返り、タブが並ぶ", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const a = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL),
    );
    await vscode.window.showTextDocument(a, { viewColumn: 1, preview: false });
    // **`NOTES_REL` は使わない。** この file の前のほうの test が、実体だけを
    // `.env` へ差し替える（realpath 後の再判定の検査）。ここで使うと「普通の
    // ファイル」のつもりが秘匿ファイルになり、可視行が返らない。
    const b = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), EDITOR_STATE_REL),
    );
    await vscode.window.showTextDocument(b, { viewColumn: 2, preview: false });
    await waitFor("2列になる", () => vscode.window.tabGroups.all.length >= 2);

    const state = await getEditorState();
    const groups = layoutGroups(state);
    assert.strictEqual(groups.length, 2, JSON.stringify(groups));
    const paths = layoutTabs(state).map((t) => t.path);
    assert.ok(paths.includes(SAMPLE_REL), `${SAMPLE_REL} が返らない: ${JSON.stringify(paths)}`);
    assert.ok(
      paths.includes(EDITOR_STATE_REL),
      `${EDITOR_STATE_REL} が返らない: ${JSON.stringify(paths)}`,
    );
    // 列の番号は VS Code のものをそのまま返す（1始まり）。
    assert.deepStrictEqual(
      groups.map((g) => g.viewColumn),
      [1, 2],
      "列の番号が VS Code の並びと違う",
    );
    assert.strictEqual(
      groups.filter((g) => g.isActive === true).length,
      1,
      `アクティブな列がちょうど1つでない: ${JSON.stringify(groups)}`,
    );
    // **可視行は普通のファイルでは返る。** これが返らない実装だと、下の
    // 「秘匿ファイルでは返らない」は何も言わない（空振りの緑）。
    const sampleTab = layoutTabs(state).find((t) => t.path === SAMPLE_REL);
    assert.ok(sampleTab, "対照のタブが見つからない");
    assert.ok(
      sampleTab.visibleLines !== undefined,
      `普通のファイルの可視行が返らない: ${JSON.stringify(sampleTab)}`,
    );
  });

  test("自分が出した webview に own が立つ（D41 の viewType 照合が実機で効く）", async () => {
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>x</p>",
      title: "レイアウトの検査",
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);

    // **実機の `viewType` を直接、完全一致で確かめる。** `isOwnTab`（`slotOfViewType`）は
    // 「素の値か `mainThreadWebview-` 接頭辞つきの値」の完全一致で判定しているので、
    // VS Code が接頭辞を変えたときは所有判定が黙って外れる ―― それをここで赤くする。
    const tab = panelTab();
    assert.ok(tab, "パネルのタブが見つからない");
    const input = tab.input;
    assert.ok(input instanceof vscode.TabInputWebview, "パネルが TabInputWebview でない");
    // 実機で観測した値を記録に残す。
    console.log(`[測定] webview の viewType: ${input.viewType}`);
    assert.strictEqual(
      input.viewType,
      "mainThreadWebview-showme.view",
      `viewType が実測値と違う（own-view-type.ts の接頭辞が実機とずれた）: ${input.viewType}`,
    );

    const state = await getEditorState();
    const own = layoutTabs(state).filter((t) => t.own === true);
    assert.strictEqual(own.length, 1, `own が1枚でない: ${JSON.stringify(layoutTabs(state))}`);
    const ownTab = own[0];
    assert.ok(ownTab, "own のタブが取り出せない");
    assert.strictEqual(ownTab.kind, "webview");
    // **人間の画面に出ている見出しをそのまま返す。** 拡張は
    // `panelTitle()` で `ShowMe: ` を頭に付けるので、エージェントが送った題
    // そのものではない ―― エージェントと人間が同じ文字列を指せることが要件で、
    // ここが食い違うと「どのパネルを閉じるか」の相談が噛み合わなくなる。
    assert.strictEqual(ownTab.label, "ShowMe: レイアウトの検査");
    // 枠は既定の 1（C5 / D61。2枚のときは `panel-slots.test.ts`）。
    assert.strictEqual(
      ownTab.slot,
      1,
      `own の webview に slot: 1 が付いていない: ${JSON.stringify(ownTab)}`,
    );
    // 自分のパネルでも中身の口は開かない。
    assert.strictEqual(ownTab.path, undefined, "webview に path が付いた");
    assert.strictEqual(ownTab.visibleLines, undefined, "webview に可視行が付いた");
  });

  test("秘匿ファイルは名前が出て、可視行が出ない（D37 / §1.4）", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // **実在の `.env`** を開く（fixture が `SECRET=...` を書いてある）。
    // 偽の観測ではなく、VS Code が実際に持つタブと可視エディタで見る。
    const env = vscode.Uri.joinPath(workspaceRoot(), ENV_REL);
    const doc = await vscode.workspace.openTextDocument(env);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
    // **可視エディタとして開いていることを確かめてから問う。** 開いていなければ
    // 「可視行が返らなかった」は伏せたからではなく、そもそも観測が無いからになる。
    assert.ok(editor.visibleRanges.length > 0, "可視範囲が無い（この検査は空振りする）");
    // **対照を同じ条件で並べる。** 別の列に普通のファイルを開く（同じ列に
    // 重ねると、後から開いたほうしか可視エディタにならない）。
    const control = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), EDITOR_STATE_REL),
    );
    await vscode.window.showTextDocument(control, { viewColumn: 2, preview: false });

    const state = await getEditorState();
    const controlTab = layoutTabs(state).find((t) => t.path === EDITOR_STATE_REL);
    assert.ok(controlTab, "対照のタブが返らない");
    assert.ok(
      controlTab.visibleLines !== undefined,
      "対照の普通のファイルで可視行が返らない（この検査は空振りする）",
    );
    const tab = layoutTabs(state).find((t) => t.path === ENV_REL);
    assert.ok(tab !== undefined, "秘匿ファイルのタブが返らなかった（D37 で出すと決めた）");
    assert.strictEqual(tab.label, ENV_REL);
    assert.strictEqual(tab.visibleLines, undefined, "秘匿ファイルの可視行が返った");
    assert.ok(
      !Object.hasOwn(tab, "visibleLines"),
      `秘匿ファイルに visibleLines の鍵が残っている: ${JSON.stringify(tab)}`,
    );
    assert.ok((state.openPaths as string[]).includes(ENV_REL), "openPaths に載っていない（D37）");
    assert.strictEqual(state.selectedText, undefined);
  });

  /**
   * **綴りではなく実体で秘匿を当てる**（不変条件14 の5件目）。
   *
   * VS Code はドキュメントの URI にシンボリックリンクを解決しないまま入れる。
   * `docs/harmless.txt -> .env` を開くと、綴りはワークスペースの中の無害な
   * 名前だが、実体は秘匿ファイルである。レイアウトの側でも同じ関門を通って
   * いなければ、ここで `visibleLines` が返る。
   */
  test("秘匿ファイルへのリンクを開いても、実体で伏せられる", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const link = vscode.Uri.joinPath(workspaceRoot(), SYMLINK_TO_ENV_REL);
    assert.ok(
      fs.existsSync(link.fsPath) && fs.lstatSync(link.fsPath).isSymbolicLink(),
      `リンクが作れていない環境（この検査は成立しない）: ${link.fsPath}`,
    );
    const doc = await vscode.workspace.openTextDocument(link);
    await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });

    const state = await getEditorState();
    const tabs = layoutTabs(state);
    // 綴りの名前ではタブが見つからない ―― 実体の名前に直っているはずである。
    assert.ok(
      !tabs.some((t) => t.path === SYMLINK_TO_ENV_REL),
      `綴りのままのパスが返った: ${JSON.stringify(tabs)}`,
    );
    const resolved = tabs.find((t) => t.path === ENV_REL);
    assert.ok(resolved !== undefined, `実体の名前で返らなかった: ${JSON.stringify(tabs)}`);
    assert.strictEqual(
      resolved.visibleLines,
      undefined,
      "リンク経由で秘匿ファイルの可視行が返った（綴りだけを見ている）",
    );
  });

  test("ワークスペース外のファイル名も可視行も返らない（D37' / §1.4b）", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const outside = vscode.Uri.file(path.join(outsideDirFor(workspaceRoot().fsPath), "secret.txt"));
    const doc = await vscode.workspace.openTextDocument(outside);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: 1, preview: false });
    assert.ok(editor.visibleRanges.length > 0, "可視範囲が無い（この検査は空振りする）");
    // 対照は**別の列**に置く（同じ列に重ねると後のものしか可視にならない）。
    const control = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceRoot(), EDITOR_STATE_REL),
    );
    await vscode.window.showTextDocument(control, { viewColumn: 2, preview: false });

    const state = await getEditorState();
    const tabs = layoutTabs(state);
    const controlTab = tabs.find((t) => t.path === EDITOR_STATE_REL);
    assert.ok(controlTab, "対照のタブが返らない");
    assert.ok(
      controlTab.visibleLines !== undefined,
      "対照の普通のファイルで可視行が返らない（この検査は空振りする）",
    );
    const labels = tabs.map((t) => String(t.label));
    assert.ok(
      !labels.some((l) => l.includes("secret")),
      `外のファイル名が返った: ${labels.join(", ")}`,
    );
    assert.ok(
      labels.includes("(outside workspace)"),
      `置き換えが効いていない: ${labels.join(", ")}`,
    );
    assert.ok(
      !(state.openPaths as string[]).some((p) => p.includes("secret")),
      "openPaths に外のファイルが載った",
    );

    // **名前を伏せるだけでは足りない。** 外のタブは可視行も返さない ――
    // スクロールに連動して動く量なので、繰り返し観測すると行数が決まる。
    // 1枚ずつではなく**すべての列のすべてのタブ**に当てる。
    assert.ok(tabs.length > 0, "タブが1枚も返っていない（この走査は何も言わない）");
    for (const tab of tabs) {
      if (tab.path === undefined) {
        assert.strictEqual(
          tab.visibleLines,
          undefined,
          `path の無いタブに可視行が付いた: ${JSON.stringify(tab)}`,
        );
      }
    }
  });

  test("結果はスキーマを通る", async () => {
    const state = await getEditorState();
    const parsed = getEditorStateResultSchema.safeParse(state);
    assert.ok(parsed.success, JSON.stringify(parsed));
  });
});

/**
 * 文書を見せるだけのコマンドと、MCP 提供者（D62 / B6）。
 *
 * どちらのコマンドも **untitled 文書**を開く。`isUntitled` を見るのは、それが
 * 「他ツールの設定ファイルを書き換えない」（不変条件11）の実機での証拠だから
 * である ―― ファイルに書いていれば `isUntitled` は偽になる。
 *
 * `showTextDocument` はフォーカスを奪うので、各テストの末尾で
 * `revertAndCloseActiveEditor` で閉じる（untitled は未保存なので、`closeAllEditors`
 * だと保存の確認で固まる）。
 */
suite("実 VS Code / 信頼モード / エージェント設定と撤去手順（D62）", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  /** コマンドが開いた untitled 文書を読んで、後始末までする。 */
  async function openUntitledBy(command: string): Promise<{ languageId: string; text: string }> {
    const before = vscode.window.activeTextEditor?.document;
    await vscode.commands.executeCommand(command);
    await waitFor(`${command} が新しい文書を開く`, () => {
      const d = vscode.window.activeTextEditor?.document;
      return d !== undefined && d !== before;
    });
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, "文書が開いていない");
    try {
      assert.ok(doc.isUntitled, `untitled でない（ファイルに書いた？）: ${doc.uri.toString()}`);
      assert.strictEqual(doc.uri.scheme, "untitled");
      return { languageId: doc.languageId, text: doc.getText() };
    } finally {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  }

  test("showAgentConfig が untitled の markdown を開き、実際のブリッジのパスが入っている", async () => {
    const { languageId, text } = await openUntitledBy("showme.showAgentConfig");
    assert.strictEqual(languageId, "markdown");

    // ブリッジのパスが**実在する**（宣言と実体の一致）。Copilot の JSON 断片から
    // 値として読む ―― 部分一致ではなく、人間が写すそのものを検査する。
    const copilot = /```json\n(\{[\s\S]*?\})\n```/.exec(text);
    assert.ok(copilot?.[1], "Copilot CLI の JSON 断片が読めない");
    const parsed = JSON.parse(copilot[1]) as {
      mcpServers: { showme: { command: string; args: string[] } };
    };
    const bridgePath = parsed.mcpServers.showme.args[0];
    assert.ok(bridgePath, "ブリッジのパスが無い");
    assert.ok(bridgePath.endsWith(`${path.sep}bridge${path.sep}index.js`), bridgePath);
    assert.ok(fs.existsSync(bridgePath), `ブリッジが無い: ${bridgePath}`);
    // 拡張のインストール先の中にある（別の場所を指していない）。
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    assert.strictEqual(bridgePath, path.join(ext.extensionPath, "bridge", "index.js"));

    // 許可リストに arrange_editors は無く、他は全部ある（B6）。**値で**見る。
    const allowBlock = /```json\n(\[[\s\S]*?\n\])\n```/.exec(text);
    assert.ok(allowBlock?.[1], "許可リストの断片が読めない");
    const allow = JSON.parse(allowBlock[1]) as string[];
    assert.ok(!allow.includes("mcp__showme__arrange_editors"), allow.join(", "));
    assert.ok(allow.length >= 9, `許可リストが短すぎる: ${allow.length}`);
    for (const name of allow) assert.ok(name.startsWith("mcp__showme__"), name);
    // 自分で足す方法は本文にある。
    assert.ok(text.includes('"mcp__showme__arrange_editors"'), "足し方が書いていない");
    assert.ok(!/npx\s+-y/.test(text), "npx の断片がある（S12）");
  });

  test("teardown が untitled の markdown を開き、実際の実行時ディレクトリが入っている", async () => {
    const { languageId, text } = await openUntitledBy("showme.teardown");
    assert.strictEqual(languageId, "markdown");
    // 拡張がソケットと登録ファイルを置く場所は、テスト側で同じ関数から独立に出す
    // （`readOwnRegistration` と同じ形）。**両候補とも**載っていること。
    const dirs = runtimeDirCandidates(process.env, os.tmpdir(), processUid(process));
    assert.ok(dirs.length >= 1);
    for (const dir of dirs) assert.ok(text.includes(dir), `実行時ディレクトリが無い: ${dir}`);
    assert.ok(text.includes(`code --uninstall-extension ${EXTENSION_ID}`));
    assert.ok(text.includes("claude mcp remove showme"));
    assert.ok(text.includes("SHOWME_SOCK"));
  });

  test("MCP 提供者が登録され、ブリッジのパスを返す", async () => {
    const defs = await mcpDefinitions();
    assert.strictEqual(defs.length, 1);
    const def = defs[0];
    assert.ok(def);
    assert.strictEqual(def.command, "node");
    assert.strictEqual(def.args.length, 1);
    const bridgePath = def.args[0];
    assert.ok(bridgePath);
    assert.ok(bridgePath.endsWith(`${path.sep}bridge${path.sep}index.js`), bridgePath);
    assert.ok(fs.existsSync(bridgePath), `ブリッジが無い: ${bridgePath}`);
    // 文書に書いたパスと**同じ値**（同じ式から作っている。不変条件14）。
    const { text } = await openUntitledBy("showme.showAgentConfig");
    assert.ok(text.includes(bridgePath), "文書のパスと提供者のパスが違う");
  });
});

/**
 * **タブとパネルを動かす**（増分5 D59 / D55-1）。
 *
 * 人間の言葉:「うーんタブの移動も出来ないの？」。`single-column` が人間の列に流し込んだ
 * ものを戻す手が無かった（所見4c）。
 *
 * 単体は偽の面に作り物の `ArrangeTab` を渡すので、次の5つは1件も確かめられていない:
 *
 *   1. 「開いてから閉じる」で、**未保存の内容が失われない**か（逆順なら飛ぶ）
 *   2. 列をまたぐ移動で VS Code が `closed` を発火して own が消えるのを、
 *      面の再記録が本当に打ち消しているか（動かしたあとも `own: true` で、`close-own` で閉じるか）
 *   3. `path` が面の観測した正準名と実機で一致するか（`get_editor_state` の `path` で指せるか）
 *   4. `gather-own` が人間の列を**本当に**触らないか（空いた列を VS Code が閉じるところまで）
 *   5. 題（label）で指せないこと ―― `sample.ts` と題したパネルは `move-tab { path: src/sample.ts }` で動かない
 *
 * 材料は `move/` 配下に作り、この節で消す（他の節のファイルを使わない ―― `arrange/` の節と同じ理由）。
 */
const MOVE_DIR = "move";
const MOVE_A_REL = `${MOVE_DIR}/a.md`;
const MOVE_B_REL = `${MOVE_DIR}/b.md`;
const MOVE_KEEP_REL = `${MOVE_DIR}/keep.md`;
const MOVE_HUMAN_REL = `${MOVE_DIR}/human.md`;
const MOVE_DIRTY_REL = `${MOVE_DIR}/dirty.txt`;

suite("実 VS Code / 信頼モード / タブとパネルを動かす（D59 / D55-1）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), MOVE_DIR));
    await writeArrangeFile(MOVE_A_REL, "# a\n\n自分が開くファイル A\n");
    await writeArrangeFile(MOVE_B_REL, "# b\n\n自分が開くファイル B\n");
    await writeArrangeFile(MOVE_KEEP_REL, "# keep\n\n人間が今見ているファイル\n");
    await writeArrangeFile(MOVE_HUMAN_REL, "# human\n\n人間が開いている（見ていない）ファイル\n");
    await writeArrangeFile(MOVE_DIRTY_REL, "original\n");
  });

  suiteTeardown(async () => {
    await closeEverythingForArrange();
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), MOVE_DIR), {
      recursive: true,
      useTrash: false,
    });
  });

  setup(async () => {
    await vscode.commands.executeCommand("showme.test.resetRateLimits");
    await closeEverythingForArrange();
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor("編集グループが1つに戻る", () => tabGroupCount() === 1);
  });

  teardown(async () => {
    await setLayoutSetting("closeHumanTabs", undefined);
    await setLayoutSetting("closeDirtyTabs", undefined);
    assertLayoutSetting("closeHumanTabs", undefined);
    assertLayoutSetting("closeDirtyTabs", undefined);
    await closeEverythingForArrange();
  });

  const uriOf = (rel: string): vscode.Uri => vscode.Uri.joinPath(workspaceRoot(), rel);

  /** その文書のテキストタブが載っている列（無ければ undefined、2枚以上なら最初の1枚）。 */
  function columnOf(rel: string): number | undefined {
    const key = uriOf(rel).toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) {
          return group.viewColumn;
        }
      }
    }
    return undefined;
  }

  function tabCountOf(rel: string): number {
    const key = uriOf(rel).toString();
    return arrangeTabs().filter(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key,
    ).length;
  }

  /** 人間が列1で keep.md を見ていて、自分が列2に A と B を開いた状態（列2は2枚なので、1枚動かしても畳まれない）。 */
  async function humanInOneAndOwnInTwo(): Promise<void> {
    await openHumanTab(MOVE_KEEP_REL);
    await showCode([{ path: MOVE_A_REL, lines: { start: 1, end: 1 } }]);
    await showCode([{ path: MOVE_B_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("列が2つになる", () => tabGroupCount() === 2);
    assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が列1でない（前提）");
    assert.strictEqual(columnOf(MOVE_A_REL), 2, "自分の a.md が列2でない（前提）");
    assert.strictEqual(columnOf(MOVE_B_REL), 2, "自分の b.md が列2でない（前提）");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが keep.md でない（前提）",
    );
  }

  /**
   * **いちばん重い主張: 未保存のタブを動かしても中身が失われない**（D59 の仕組み）。
   *
   * 「開いてから閉じる」の順序が守られていることの証拠は、動かしたあとも
   * `document.isDirty` が真で、`getText()` に編集が残っていること。逆順（閉じてから開く）
   * だと文書が一度閉じて編集が飛び、開き直した文書は保存済みの中身になる。
   */
  test("未保存の自分のタブを動かしても、未保存のまま中身が残る（開いてから閉じる）", async () => {
    await openHumanTab(MOVE_KEEP_REL);
    // B を先に開く ―― 列2に2枚あれば、1枚動かしても列2は畳まれない（畳まれると列3が
    // 列2に繰り上がり、「列3に移った」が言えない）。後に開いた dirty.txt が列2で可視になる。
    await showCode([{ path: MOVE_B_REL, lines: { start: 1, end: 1 } }]);
    await showCode([{ path: MOVE_DIRTY_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("列が2つになる", () => tabGroupCount() === 2);
    const dirtyUri = uriOf(MOVE_DIRTY_REL);
    const editor = visibleEditorFor(dirtyUri);
    assert.ok(editor, "自分が開いたエディタが可視でない（前提）");
    const marker = "未保存の変更 MOVE_DIRTY_MARKER\n";
    const applied = await editor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), marker),
    );
    assert.ok(applied, "編集が当たっていない（前提）");
    assert.ok(editor.document.isDirty, "未保存にできていない（前提）");
    assert.strictEqual(columnOf(MOVE_DIRTY_REL), 2, "dirty.txt が列2でない（前提）");

    const result = await arrangeEditors("move-tab", { path: MOVE_DIRTY_REL, toColumn: 3 });

    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 1 }, JSON.stringify(result));
    await waitFor("dirty.txt が列3に移る", () => columnOf(MOVE_DIRTY_REL) === 3);
    assert.strictEqual(tabCountOf(MOVE_DIRTY_REL), 1, "dirty.txt のタブが1枚でない（元が残った）");
    // **中身が残っている。** 同じ `TextDocument` のまま（閉じて開き直していない）。
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === dirtyUri.toString(),
    );
    assert.ok(doc, "dirty.txt の文書が閉じた（未保存が飛んだ）");
    assert.strictEqual(doc.isDirty, true, "動かしたら未保存でなくなった（文書が一度閉じた）");
    assert.ok(doc.getText().includes(marker), "動かしたら編集が消えた");
    assert.strictEqual(doc, editor.document, "文書の実体が変わった（閉じて開き直している）");
    // 人間の列は無傷。
    assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が動いた");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間の居る列が変わった",
    );
  });

  test("動かしたあとも own のまま（再記録）。続けて close-own で閉じる", async () => {
    await humanInOneAndOwnInTwo();
    const before = layoutTabs(await getEditorState()).find((t) => t.path === MOVE_A_REL);
    assert.strictEqual(before?.own, true, "動かす前に own でない（前提）");

    const result = await arrangeEditors("move-tab", { path: MOVE_A_REL, toColumn: 3 });
    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 1 }, JSON.stringify(result));
    await waitFor("a.md が列3に移る", () => columnOf(MOVE_A_REL) === 3);
    assert.strictEqual(tabCountOf(MOVE_A_REL), 1, "a.md のタブが1枚でない");

    // **列をまたぐ移動は `closed` を発火して own を消す**。面が再記録して
    // いなければ、ここで own が消えている。
    const after = layoutTabs(await getEditorState()).find((t) => t.path === MOVE_A_REL);
    assert.strictEqual(after?.own, true, "動かしたら own が消えた（再記録が効いていない）");

    const closed = await arrangeEditors("close-own");
    await waitFor(
      "自分の2枚が消える",
      () => tabCountOf(MOVE_A_REL) === 0 && tabCountOf(MOVE_B_REL) === 0,
    );
    assert.deepStrictEqual(closed, { done: true, closed: 2 }, JSON.stringify(closed));
    assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が巻き込まれた");
  });

  test("既定では人間のタブは動かない（human-tabs-not-allowed）。closeHumanTabs なら動く", async () => {
    await humanInOneAndOwnInTwo();
    // 人間がもう1枚開き、keep.md に戻る（human.md は見ていない → 床1 ではなく reach で断られる）。
    await openHumanTab(MOVE_HUMAN_REL);
    await openHumanTab(MOVE_KEEP_REL);
    await waitFor(
      "人間が keep.md を見ている",
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === "keep.md",
    );
    assert.strictEqual(columnOf(MOVE_HUMAN_REL), 1, "human.md が列1でない（前提）");

    const refused = await arrangeEditors("move-tab", { path: MOVE_HUMAN_REL, toColumn: 2 });
    assert.deepStrictEqual(
      refused,
      { done: true, closed: 0, moved: 0, withheld: ["human-tabs-not-allowed"] },
      JSON.stringify(refused),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(columnOf(MOVE_HUMAN_REL), 1, "既定で人間のタブが動いた");

    // 対照: 設定を立てれば同じ呼び出しが通る。
    await setLayoutSetting("closeHumanTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      const allowed = await arrangeEditors("move-tab", { path: MOVE_HUMAN_REL, toColumn: 2 });
      assert.deepStrictEqual(allowed, { done: true, closed: 0, moved: 1 }, JSON.stringify(allowed));
      await waitFor("human.md が列2に移る", () => columnOf(MOVE_HUMAN_REL) === 2);
      assert.strictEqual(tabCountOf(MOVE_HUMAN_REL), 1, "human.md のタブが1枚でない");
      // 人間のタブを動かしても own にはならない（人間のものは人間のもの）。
      const moved = layoutTabs(await getEditorState()).find((t) => t.path === MOVE_HUMAN_REL);
      assert.strictEqual(moved?.own, undefined, "人間のタブを動かしたら own になった");
    } finally {
      await setLayoutSetting("closeHumanTabs", undefined);
    }
  });

  test("人間が見ているタブは、自分のものでも動かない（床1 / viewing-tab）", async () => {
    await humanInOneAndOwnInTwo();
    // 人間として a.md を見る（列2で、フォーカスごと）。
    await vscode.window.showTextDocument(uriOf(MOVE_A_REL), {
      viewColumn: 2,
      preserveFocus: false,
      preview: false,
    });
    await waitFor("人間が a.md を見ている", () => {
      const viewing = vscode.window.tabGroups.activeTabGroup.activeTab;
      return (
        viewing?.input instanceof vscode.TabInputText &&
        viewing.input.uri.toString() === uriOf(MOVE_A_REL).toString()
      );
    });
    assert.strictEqual(tabCountOf(MOVE_A_REL), 1, "a.md が2枚ある（前提）");

    const result = await arrangeEditors("move-tab", { path: MOVE_A_REL, toColumn: 3 });
    assert.deepStrictEqual(
      result,
      { done: true, closed: 0, moved: 0, withheld: ["viewing-tab"] },
      JSON.stringify(result),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(columnOf(MOVE_A_REL), 2, "人間が見ているタブが動いた");
    assert.strictEqual(tabGroupCount(), 2, "列が増えた（動かしている）");
  });

  test("人間の列（列1）への移動は既定で断る（human-column-target）。closeHumanTabs なら通る", async () => {
    await humanInOneAndOwnInTwo();

    const refused = await arrangeEditors("move-tab", { path: MOVE_A_REL, toColumn: 1 });
    assert.deepStrictEqual(
      refused,
      { done: false, closed: 0, moved: 0, withheld: ["human-column-target"] },
      JSON.stringify(refused),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(columnOf(MOVE_A_REL), 2, "既定で人間の列にタブが流れ込んだ");

    await setLayoutSetting("closeHumanTabs", true);
    try {
      assertLayoutSetting("closeHumanTabs", true);
      const allowed = await arrangeEditors("move-tab", { path: MOVE_A_REL, toColumn: 1 });
      assert.deepStrictEqual(allowed, { done: true, closed: 0, moved: 1 }, JSON.stringify(allowed));
      await waitFor("a.md が列1に移る", () => columnOf(MOVE_A_REL) === 1);
      assert.strictEqual(tabCountOf(MOVE_A_REL), 1, "a.md のタブが1枚でない");
      // **実測: 開いたタブはその列でアクティブになる**（`preserveFocus: true` はフォーカスを
      // 動かさないだけで、列の中の前面は開いたものに変わる）。人間の列に動かせば keep.md は
      // その後ろに隠れる ―― だから人間の列への移動は `closeHumanTabs`（人間の面に触ってよい）
      // でしか通さない。人間の居る列と keep.md のタブそのものは無傷であること。
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.viewColumn,
        1,
        "人間の居る列が変わった",
      );
      assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が消えた／動いた");
      assert.strictEqual(
        vscode.window.tabGroups.activeTabGroup.activeTab?.label,
        "a.md",
        "（実測の記録）人間の列に開いたタブが前面になっていない",
      );
    } finally {
      await setLayoutSetting("closeHumanTabs", undefined);
    }
  });

  test("toColumn が列数+1 を超えると invalid-request で、何も動かない", async () => {
    await humanInOneAndOwnInTwo();
    await assert.rejects(
      async () => arrangeEditors("move-tab", { path: MOVE_A_REL, toColumn: 9 }),
      (e: unknown) => String(e).includes("toColumn"),
      "飛び番の列が通った",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(tabGroupCount(), 2, "断ったのに列が増えた");
    assert.strictEqual(columnOf(MOVE_A_REL), 2, "断ったのに動いた");
  });

  test("move-panel で自分の webview が動く", async () => {
    await humanInOneAndOwnInTwo();
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>動かす検査</p>",
      title: "動かす検査",
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    const from = panelColumn();
    assert.ok(typeof from === "number" && from > 1, `パネルが人間の列に開いた: ${String(from)}`);
    assert.notStrictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab,
      panelTab(),
      "人間がパネルを見ている（床1 で断られる）",
    );

    const result = await arrangeEditors("move-panel", { toColumn: 3 });
    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 1 }, JSON.stringify(result));
    await waitFor("パネルが列3に移る", () => panelColumn() === 3);
    // `get_editor_state` からも同じ列に見える（動かした結果はここで読む、が正しい使い方）。
    const groups = layoutGroups(await getEditorState());
    const webviewGroup = groups.find((g) =>
      g.tabs.some((t) => t.kind === "webview" && t.own === true),
    );
    assert.strictEqual(
      webviewGroup?.viewColumn,
      3,
      `get_editor_state でパネルが列3に無い: ${JSON.stringify(groups)}`,
    );
    assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が動いた");
  });

  /**
   * **`gather-own` は自分のものを舞台の最初の列に集め、人間の列に触れない**（D55-1）。
   * `single-column` の後継。空いた列は VS Code が閉じる（`closeEmptyGroups` 既定）。
   */
  test("gather-own で列2・3に散った自分のタブとパネルが列2に集まり、列3は消え、人間の列1は無傷", async () => {
    await openHumanTab(MOVE_KEEP_REL);
    await showCode(
      [
        { path: MOVE_A_REL, lines: { start: 1, end: 1 } },
        { path: MOVE_B_REL, lines: { start: 1, end: 1 } },
      ],
      "split",
    );
    await waitFor("列が3つになる", () => tabGroupCount() === 3);
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>集める検査</p>",
      title: "集める検査",
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    // パネルを列3へ（own を列2・3の両方に散らす）。
    if (panelColumn() !== 3) {
      const moved = await arrangeEditors("move-panel", { toColumn: 3 });
      assert.strictEqual(moved.moved, 1, `パネルを列3に置けない: ${JSON.stringify(moved)}`);
      await waitFor("パネルが列3に居る", () => panelColumn() === 3);
    }
    // **前提: own が2つ以上の列に散っている。** 散っていなければ「集まった」は空振りする。
    const ownColumns = new Set([columnOf(MOVE_A_REL), columnOf(MOVE_B_REL), panelColumn()]);
    assert.ok(ownColumns.size >= 2, `own が散っていない（前提）: ${[...ownColumns].join(",")}`);
    assert.ok(!ownColumns.has(1), "own が人間の列に居る（前提）");
    assert.strictEqual(columnOf(MOVE_KEEP_REL), 1, "人間の keep.md が列1でない（前提）");
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間が列1に居ない（前提）",
    );
    const inColumnTwoBefore = [columnOf(MOVE_A_REL), columnOf(MOVE_B_REL), panelColumn()].filter(
      (c) => c === 2,
    ).length;
    const expectedMoved = 3 - inColumnTwoBefore;

    const result = await arrangeEditors("gather-own");

    assert.deepStrictEqual(
      result,
      { done: true, closed: 0, moved: expectedMoved },
      `結果が違う: ${JSON.stringify(result)}`,
    );
    await waitFor("列3が消える（空になった列を VS Code が閉じる）", () => tabGroupCount() === 2);
    assert.strictEqual(columnOf(MOVE_A_REL), 2, "a.md が列2に無い");
    assert.strictEqual(columnOf(MOVE_B_REL), 2, "b.md が列2に無い");
    assert.strictEqual(panelColumn(), 2, "パネルが列2に無い");
    assert.strictEqual(tabCountOf(MOVE_A_REL), 1, "a.md が2枚ある");
    assert.strictEqual(tabCountOf(MOVE_B_REL), 1, "b.md が2枚ある");
    // 人間の列は無傷: keep.md だけが列1にあり、人間は列1を見たまま。
    const humanGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === 1);
    assert.deepStrictEqual(
      humanGroup?.tabs.map((t) => t.label),
      ["keep.md"],
      "人間の列に何かが流れ込んだ、または消えた",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間の居る列が変わった",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "keep.md",
      "人間が見ているタブが変わった",
    );
    // 集めたあとも own（続けて close-own で片づけられる）。
    const owns = layoutTabs(await getEditorState()).filter((t) => t.own === true);
    assert.strictEqual(owns.length, 3, `集めたあと own が3つでない: ${JSON.stringify(owns)}`);
  });

  /**
   * **人間が右端の列に居て、own がその左に散っていても、1回で集まる**（レビュー I3）。
   *
   * own を動かして左の列が空くと VS Code が閉じ、列が繰り上がる。集め先を最初に1回だけ
   * 決めて使い続けると、2枚目はまた「右端の外側」に新しい列を作り、ばらけたまま終わる。
   * 面は1枚ごとに新しい観測で集め先を決め直す（同じ純関数）。
   */
  test("人間が右端に居て own が左に散っていても、gather-own 1回で1列に集まる", async () => {
    await openHumanTab(MOVE_KEEP_REL);
    await showCode(
      [
        { path: MOVE_A_REL, lines: { start: 1, end: 1 } },
        { path: MOVE_B_REL, lines: { start: 1, end: 1 } },
      ],
      "split",
    );
    await waitFor("列が3つになる", () => tabGroupCount() === 3);
    // 人間が右端（列4）に移り、列1の keep.md を閉じる → 列1が閉じて繰り上がり、
    // own が列1・2、人間が列3 になる。
    await vscode.window.showTextDocument(uriOf(MOVE_HUMAN_REL), {
      viewColumn: 4,
      preserveFocus: false,
      preview: false,
    });
    await waitFor("人間が列4に居る", () => vscode.window.tabGroups.activeTabGroup.viewColumn === 4);
    const keepTab = arrangeTabs().find(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === uriOf(MOVE_KEEP_REL).toString(),
    );
    assert.ok(keepTab, "keep.md のタブが無い（前提）");
    assert.ok(await vscode.window.tabGroups.close(keepTab, true), "keep.md を閉じられない（前提）");
    await waitFor("列1が閉じて3列に繰り上がる", () => tabGroupCount() === 3);
    // **前提: 人間が右端で、own はその左に別々の列。** これが崩れていると、この検査は
    // 「収束する」を何も言わない（最初の集め先だけで足りる場面になる）。
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      3,
      "人間が右端（列3）に居ない（前提）",
    );
    assert.strictEqual(columnOf(MOVE_A_REL), 1, "a.md が列1でない（前提）");
    assert.strictEqual(columnOf(MOVE_B_REL), 2, "b.md が列2でない（前提）");
    const ownBefore = layoutTabs(await getEditorState()).filter((t) => t.own === true).length;
    assert.strictEqual(ownBefore, 2, "own が2枚でない（前提）");

    const result = await arrangeEditors("gather-own");

    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 2 }, JSON.stringify(result));
    await waitFor("空いた列が閉じて2列になる", () => tabGroupCount() === 2);
    // **1列に集まっている。** 最初の集め先を使い続けると a.md と b.md が別の列に残る。
    assert.strictEqual(
      columnOf(MOVE_A_REL),
      2,
      `a.md が列2に無い: ${String(columnOf(MOVE_A_REL))}`,
    );
    assert.strictEqual(
      columnOf(MOVE_B_REL),
      2,
      `b.md が列2に無い: ${String(columnOf(MOVE_B_REL))}`,
    );
    assert.strictEqual(tabCountOf(MOVE_A_REL), 1, "a.md が2枚ある");
    assert.strictEqual(tabCountOf(MOVE_B_REL), 1, "b.md が2枚ある");
    // 人間の列は無傷（human.md だけ。人間は自分の列を見たまま）。
    const humanGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === 1);
    assert.deepStrictEqual(
      humanGroup?.tabs.map((t) => t.label),
      ["human.md"],
      "人間の列に何かが流れ込んだ、または消えた",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.viewColumn,
      1,
      "人間の居る列が変わった",
    );
    assert.strictEqual(
      vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      "human.md",
      "人間が見ているタブが変わった",
    );
    const ownAfter = layoutTabs(await getEditorState()).filter((t) => t.own === true).length;
    assert.strictEqual(ownAfter, 2, "集めたあと own が消えた");
  });

  /**
   * **題（label）では指せない**（D41 / D59）。`sample.ts` と題したパネルは
   * `move-tab { path: "src/sample.ts" }` で動かない ―― 動くのはテキストの `sample.ts` である。
   */
  test("sample.ts と題したパネルは move-tab { path: src/sample.ts } では動かない（タブはパスで指す）", async () => {
    await openHumanTab(MOVE_KEEP_REL);
    await showCode([{ path: SAMPLE_REL, lines: { start: 1, end: 1 } }]);
    await showCode([{ path: MOVE_B_REL, lines: { start: 1, end: 1 } }]);
    await waitFor("列が2つになる", () => tabGroupCount() === 2);
    await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>題の偽装</p>",
      title: path.basename(SAMPLE_REL),
    });
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    const panel = panelTab();
    assert.ok(panel, "パネルが無い");
    // **前提: 題が本当に sample.ts を名乗っている。** 名乗れていなければこの検査は何も言わない。
    assert.ok(
      panel.label.includes(path.basename(SAMPLE_REL)),
      `パネルの題が sample.ts を含まない: ${panel.label}`,
    );
    const panelBefore = panelColumn();
    assert.strictEqual(panelBefore, 2, `パネルが列2に無い（前提）: ${String(panelBefore)}`);
    assert.strictEqual(columnOf(SAMPLE_REL), 2, "sample.ts が列2に無い（前提）");

    const result = await arrangeEditors("move-tab", { path: SAMPLE_REL, toColumn: 3 });

    assert.deepStrictEqual(result, { done: true, closed: 0, moved: 1 }, JSON.stringify(result));
    await waitFor("テキストの sample.ts が列3に移る", () => columnOf(SAMPLE_REL) === 3);
    assert.strictEqual(panelColumn(), 2, "題が同じパネルが動いた（題で指している）");
    assert.strictEqual(tabCountOf(SAMPLE_REL), 1, "sample.ts が2枚ある");
  });
});
