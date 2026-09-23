import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  OUTSIDE_ONLY_NEEDLE,
  SAMPLE_REL,
  SYMLINK_ESCAPE_REL,
  SYMLINK_TO_ENV_REL,
  TS_SYMBOL,
} from "../fixture.js";
import { activateExtension, lendWindow, showCode, waitFor } from "./helpers.js";

/**
 * 増分3B: 指す精度。
 *
 * - 定義・参照が**実機の言語サーバから**引けること
 * - 列を指定すると**装飾の範囲が文字単位になる**こと
 *
 * どちらも実機でしか分からない。プロバイダが動くかは環境の話だし、
 * 装飾の範囲は API から読めないので観測口（`inspectVisuals`）越しに見る。
 */

interface SearchResult {
  match?: unknown;
  locations?: { path: string; line: number; column: number }[];
  reason?: unknown;
}

interface Visuals {
  highlightRanges?: {
    uri: string;
    startLine: number;
    startColumn: number;
    endColumn: number;
    wholeLine: boolean;
    color: string;
  }[];
}

async function reset(): Promise<void> {
  await vscode.commands.executeCommand("showme.test.resetRateLimits");
}

suite("指す精度（増分3B）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(reset);

  test("定義が引ける、あるいは引けない理由が返る", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: SAMPLE_REL, text: TS_SYMBOL },
    })) as SearchResult;

    // **どちらでもよい。** 制限モードでは TS のプロバイダが動かないことを
    // 増分1で測ってある。要点は「例外にならず、閉じた語彙で答えが返る」こと。
    assert.ok(["none", "one", "many"].includes(String(result.match)), JSON.stringify(result));
    if (result.match === "none") {
      assert.ok(
        ["no-provider", "restricted-mode", "not-found"].includes(String(result.reason)),
        `理由が閉じた語彙でない: ${JSON.stringify(result)}`,
      );
    }
  });

  test("返るのは位置だけで、中身は含まれない", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: SAMPLE_REL, text: TS_SYMBOL },
    })) as SearchResult;

    for (const found of result.locations ?? []) {
      assert.deepStrictEqual(
        Object.keys(found).sort(),
        ["column", "line", "path"],
        `位置以外の欄がある: ${JSON.stringify(found)}`,
      );
    }
  });

  test("ワークスペースの外は、実機でも探せない", async () => {
    // **単体テストは面をモックしているので、本物の `language-surface.ts` は
    // ここでしか検査されない。** レビューで見つかった CRITICAL がここだった ――
    // 生のパスが `Uri.joinPath` に渡っていて、`..` が解決されるので
    // ホストの任意のファイルについてプロバイダを呼べた。返る理由が
    // 「開けなかった」と「定義が無い」で分かれるので、**存在を1呼び出しずつ
    // 確かめられた**（S1 が塞ぐはずの無音のオラクル）。
    for (const path of [
      "../../../etc/passwd",
      "/etc/passwd",
      "a/../../../../etc/hosts",
      "../package.json",
    ]) {
      const result = (await vscode.commands.executeCommand("showme.test.findDefinition", {
        location: { path, lines: { start: 1, end: 1 } },
      })) as SearchResult;
      assert.strictEqual(
        result.reason,
        "invalid-path",
        `外に出られた: ${path} -> ${JSON.stringify(result)}`,
      );
    }
  });

  test("外のパスは、存在するかどうかで答えが変わらない（オラクルにならない）", async () => {
    // **同じ理由が返ることが要点。** 「存在するものは not-found、しないものは
    // no-provider」だと、そこから存在を読める。
    const existing = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: "../../../etc/passwd", lines: { start: 1, end: 1 } },
    })) as SearchResult;
    const missing = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: "../../../etc/definitely-not-here-9f2a", lines: { start: 1, end: 1 } },
    })) as SearchResult;
    assert.strictEqual(existing.reason, missing.reason);
    assert.strictEqual(existing.reason, "invalid-path");
  });

  test("シンボリックリンクで外に出られない（綴りは無害、実体は外）", async () => {
    // **これがレビューで見つかった2件目の CRITICAL。** 字面の `..` を塞いでも、
    // 中に置かれたリンクは `normalizeWorkspaceRelative` も `isRedactedPath` も
    // 通ってしまう（名前に `..` は無く、除外パターンにも当たらない）。
    // 止められるのは realpath を取る側だけである。
    //
    // しかも `text` の走査は**中身の部分一致**を答えるので、これは存在の
    // オラクルより強く、**外のファイルの内容を1文字列ずつ確かめられる**。
    const result = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: SYMLINK_ESCAPE_REL, text: OUTSIDE_ONLY_NEEDLE },
    })) as SearchResult;
    assert.strictEqual(
      result.reason,
      "invalid-path",
      `リンク経由で外を読めた: ${JSON.stringify(result)}`,
    );
  });

  test("リンク経由でも、中身の有無で答えが変わらない（内容のオラクルにしない）", async () => {
    // 「当たれば A、外れれば B」だと、そこから中身を読める。
    const hit = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: SYMLINK_ESCAPE_REL, text: OUTSIDE_ONLY_NEEDLE },
    })) as SearchResult;
    const miss = (await vscode.commands.executeCommand("showme.test.findDefinition", {
      location: { path: SYMLINK_ESCAPE_REL, text: "this-string-is-not-there-8c31" },
    })) as SearchResult;
    assert.strictEqual(hit.reason, miss.reason);
  });

  test("除外は綴りではなく実体で効く", async () => {
    // `docs/harmless.txt -> .env`。名前は除外パターンに当たらない。
    const result = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: SYMLINK_TO_ENV_REL, text: "SECRET" },
    })) as SearchResult;
    assert.ok(
      result.reason === "excluded-path" || result.reason === "invalid-path",
      `除外パスの実体をリンク経由で読めた: ${JSON.stringify(result)}`,
    );
  });

  test("秘匿パスは実機でも探せない", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: ".env", lines: { start: 1, end: 1 } },
    })) as SearchResult;
    assert.strictEqual(result.reason, "excluded-path");
  });

  test("秘匿の綴りは、存在するかどうかで答えが変わらない", async () => {
    // **関門は realpath の後にしか除外を当てていなかった。** だから `.env`（fixture が
    // 書いてあるので実在）は `excluded-path`、`.env.nope`（不在。`.env.*` も既定で秘匿）は
    // `invalid-path` と答えが割れ、秘匿ファイルの存在を1本ずつ確かめられた。
    // 単体で実測して赤だったので直した。ここは**線上でも**同じ答えになることを見る。
    const existing = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: ".env", lines: { start: 1, end: 1 } },
    })) as SearchResult;
    const missing = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: ".env.nope-9f2a", lines: { start: 1, end: 1 } },
    })) as SearchResult;
    assert.strictEqual(existing.reason, missing.reason, JSON.stringify({ existing, missing }));
    assert.strictEqual(existing.reason, "excluded-path");
  });

  test("show_code でも、秘匿の綴りは存在するかどうかで答えが変わらない", async () => {
    // `find_*` と同じ比較を `show_code` の解決結果にも当てる。こちらは
    // `resolve-location.ts` が綴りで先に落とすので構造的に閉じているが、
    // **線上の観測として同じであること**を検査で固定する（閉じているつもり、を残さない）。
    const [existing] = await showCode([{ path: ".env", lines: { start: 1, end: 1 } }]);
    const [missing] = await showCode([{ path: ".env.nope-9f2a", lines: { start: 1, end: 1 } }]);
    assert.ok(existing && missing);
    assert.strictEqual(existing.match, "none");
    assert.strictEqual(existing.reason, missing.reason, JSON.stringify({ existing, missing }));
    assert.strictEqual(existing.reason, "excluded-path");
  });

  test("正確な件数を返さない", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.findReferences", {
      location: { path: SAMPLE_REL, text: TS_SYMBOL },
    })) as SearchResult;
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("total"), serialized);
    assert.ok(!serialized.includes("truncated"), serialized);
  });

  test("列を指定すると装飾の範囲が文字単位になる", async () => {
    await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [{ path: SAMPLE_REL, lines: { start: 1, end: 1, startColumn: 2, endColumn: 6 } }],
    });
    await waitFor("文字単位の装飾が貼られる", async () => {
      const visuals = (await vscode.commands.executeCommand(
        "showme.test.inspectVisuals",
      )) as Visuals;
      return (visuals.highlightRanges ?? []).some((r) => !r.wholeLine);
    });

    const visuals = (await vscode.commands.executeCommand("showme.test.inspectVisuals")) as Visuals;
    const inline = (visuals.highlightRanges ?? []).find((r) => !r.wholeLine);
    assert.ok(inline !== undefined, JSON.stringify(visuals));
    assert.strictEqual(inline.startColumn, 2);
    assert.strictEqual(inline.endColumn, 6);
  });

  test("列を省いた指定は今までどおり行全体", async () => {
    await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [{ path: SAMPLE_REL, lines: { start: 2, end: 2 } }],
    });
    await waitFor("行全体の装飾が貼られる", async () => {
      const visuals = (await vscode.commands.executeCommand(
        "showme.test.inspectVisuals",
      )) as Visuals;
      return (visuals.highlightRanges ?? []).some((r) => r.wholeLine);
    });

    const visuals = (await vscode.commands.executeCommand("showme.test.inspectVisuals")) as Visuals;
    const whole = (visuals.highlightRanges ?? []).find((r) => r.wholeLine);
    assert.ok(whole !== undefined, JSON.stringify(visuals));
    assert.strictEqual(whole.startColumn, 0);
  });
});

suite("見せる表現（増分3C）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(reset);

  test("色を指定すると装飾にその色が使われる", async () => {
    await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [{ path: SAMPLE_REL, lines: { start: 1, end: 1 }, color: "green" }],
    });
    await waitFor("緑の装飾が貼られる", async () => {
      const visuals = (await vscode.commands.executeCommand(
        "showme.test.inspectVisuals",
      )) as Visuals;
      return (visuals.highlightRanges ?? []).some((r) => r.color === "green");
    });
  });

  test("色を指定しなければ既定（yellow）", async () => {
    await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [{ path: SAMPLE_REL, lines: { start: 2, end: 2 } }],
    });
    await waitFor("既定の色で貼られる", async () => {
      const visuals = (await vscode.commands.executeCommand(
        "showme.test.inspectVisuals",
      )) as Visuals;
      return (visuals.highlightRanges ?? []).some((r) => r.color === "yellow");
    });
  });

  test("1回の show_code で色を混ぜられる", async () => {
    // **意味づけは呼ぶ側がする。** 機構は「別々の色で描ける」ことだけを保証する。
    await vscode.commands.executeCommand("showme.test.showCode", {
      locations: [
        { path: SAMPLE_REL, lines: { start: 1, end: 1 }, color: "red" },
        { path: SAMPLE_REL, lines: { start: 3, end: 3 }, color: "blue" },
      ],
    });
    await waitFor("2色が同時に貼られる", async () => {
      const visuals = (await vscode.commands.executeCommand(
        "showme.test.inspectVisuals",
      )) as Visuals;
      const colors = new Set((visuals.highlightRanges ?? []).map((r) => r.color));
      return colors.has("red") && colors.has("blue");
    });
  });

  test("画面操作は閉じた語彙で通る", async () => {
    for (const action of ["show-explorer", "hide-panel", "hide-sidebar"] as const) {
      const result = (await vscode.commands.executeCommand("showme.test.showView", {
        action,
      })) as { done?: unknown };
      assert.strictEqual(result.done, true, action);
    }
  });

  test("エクスプローラでファイルの場所を示せる", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: SAMPLE_REL,
    })) as { done?: unknown };
    assert.strictEqual(result.done, true);
  });

  test("語彙に無い操作は受け付けない", async () => {
    // **任意のコマンド名を渡せないことが境界である。**
    await assert.rejects(async () => {
      await vscode.commands.executeCommand("showme.test.showView", {
        action: "workbench.action.terminal.new",
      });
    });
    await assert.rejects(async () => {
      await vscode.commands.executeCommand("showme.test.showView", {
        action: "hide-sidebar",
        extra: 1,
      });
    });
  });

  test("除外パスはツリーに出せない（4箇所目の同じ欠陥）", async () => {
    // **ここは以前、綴りの正規化しか通していなかった。** `.env` を指定すると
    // ツリーに出せた ―― 他のツールが全部落とすパスである。
    // しかもハンドラのコメントには「他のツールと同じ関数で正規化する」と
    // 書いてあった。**コメントが事実と違っていた。**
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: ".env",
    })) as { done?: unknown };
    assert.strictEqual(result.done, false, "除外パスをツリーに出せた");
  });

  test("存在しない秘匿パスも、存在するものと同じ答え（done: false）", async () => {
    // `show_view` は真偽しか返さないので、ここで答えが割れる余地はもともと無いが、
    // `.env.nope` が `.env` と同じ経路（関門）で落ちていることを線上で固定する。
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: ".env.nope-9f2a",
    })) as { done?: unknown };
    assert.strictEqual(result.done, false, "存在しない秘匿パスで例外や true が返った");
  });

  test("実体が外を指すリンクもツリーに出せない", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: SYMLINK_ESCAPE_REL,
    })) as { done?: unknown };
    assert.strictEqual(result.done, false, "リンク経由で外をツリーに出せた");
  });

  test("除外パスを指すリンクもツリーに出せない", async () => {
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: SYMLINK_TO_ENV_REL,
    })) as { done?: unknown };
    assert.strictEqual(result.done, false, "リンク経由で除外パスをツリーに出せた");
  });

  test("ワークスペースの外はツリーに出せない", async () => {
    // **`done: false` であって例外ではない。** 外にある / 除外 / コマンドが
    // 失敗した、が全部同じ答えになる ―― 分けるとそこから形を読める。
    const result = (await vscode.commands.executeCommand("showme.test.showView", {
      action: "reveal-in-explorer",
      path: "../outside.txt",
    })) as { done?: unknown };
    assert.strictEqual(result.done, false);
  });
});

suite("観測したパスも実体で見る（4回目のレビューで見つかった）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(reset);

  test("実体が外を指すリンクを開いても、位置も選択も返らない", async () => {
    // **増分3の修正は「エージェントが送るパス」だけを見ていた。**
    // `get_editor_state` のパスは **VS Code 自身**が持つもので、VS Code は
    // ドキュメントの URI にリンクを解決しないまま入れる。だから綴りは
    // ワークスペースの中に見え、除外判定もその綴りに当たっていた ――
    // 人間がそこで選択すれば、**実体の中身が `selectedText` に載った**。
    const uri = vscode.Uri.file(
      `${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}/${SYMLINK_ESCAPE_REL}`,
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, 10);

    const state = (await vscode.commands.executeCommand("showme.test.getEditorState")) as {
      activePath?: unknown;
      cursor?: unknown;
      selection?: unknown;
      selectedText?: unknown;
      visibleLines?: unknown;
    };

    // リンクの実体はワークスペースの外なので、**そもそも中の話にならない**。
    assert.strictEqual(state.activePath, undefined, JSON.stringify(state));
    assert.strictEqual(state.cursor, undefined);
    assert.strictEqual(state.selection, undefined);
    assert.strictEqual(state.selectedText, undefined);
    assert.strictEqual(state.visibleLines, undefined);
  });

  test("実体が除外パスのリンクを開いても、中身は返らない", async () => {
    const uri = vscode.Uri.file(
      `${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}/${SYMLINK_TO_ENV_REL}`,
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, 6);

    const state = (await vscode.commands.executeCommand("showme.test.getEditorState")) as {
      activePath?: unknown;
      cursor?: unknown;
      selectedText?: unknown;
    };

    // 綴り（docs/harmless.txt）では除外に当たらない。**実体（.env）で当てる。**
    assert.strictEqual(state.cursor, undefined, JSON.stringify(state));
    assert.strictEqual(state.selectedText, undefined);
    // 除外パスは「開いていること」までは伝える（設計書 §3.1）。名前は実体のもの。
    if (state.activePath !== undefined) {
      assert.strictEqual(state.activePath, ".env", JSON.stringify(state));
    }
  });

  test("普通のファイルは今までどおり観測できる（全部落とす実装が緑にならない）", async () => {
    const uri = vscode.Uri.file(
      `${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}/${SAMPLE_REL}`,
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    const state = (await vscode.commands.executeCommand("showme.test.getEditorState")) as {
      activePath?: unknown;
    };
    assert.strictEqual(state.activePath, SAMPLE_REL, JSON.stringify(state));
  });
});
