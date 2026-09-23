import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ENV_REL, SAMPLE_REL, SYMLINK_TO_ENV_REL } from "../fixture.js";
import {
  activateExtension,
  lendWindow,
  measureDisplayedLength,
  panelColumn,
  panelIsVisible,
  panelTab,
  waitFor,
  workspaceRoot,
} from "./helpers.js";

/**
 * `show_html({ path })` を実機で確かめる（設計 D52 / C4）。
 *
 * 単体テストは判断（関門の戻りだけを見る・読めなければ描き直さない）を見ているが、
 * **`FileSystemWatcher` が本当に保存を拾って描き直すか**は実機でしか分からない。
 * 「投げた」ではなく**いまフレームに入っている長さ**（`measureDisplayedLength`）で見る。
 *
 * trusted / restricted の**両方**で走る（`index.ts`）。読むのは拡張であって
 * 言語機能ではないので、制限モードでも `path` は読めるはずである ―― 「はず」を
 * 両方の回で実測に変える。
 */

const LIVE_REL = "docs/showme-live.html";

interface ShowHtmlResult {
  shown?: unknown;
  droppedDeclarations?: unknown;
}

async function showHtml(args: Record<string, unknown>): Promise<ShowHtmlResult> {
  await vscode.commands.executeCommand("showme.test.resetRateLimits");
  return (await vscode.commands.executeCommand("showme.test.showHtml", args)) as ShowHtmlResult;
}

/** `showme.test.showHtml` が投げた `ToolError` の code。投げなければ undefined。 */
async function showHtmlErrorCode(args: Record<string, unknown>): Promise<string | undefined> {
  try {
    await showHtml(args);
    return undefined;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : `no-code:${String(e)}`;
  }
}

function liveFile(): string {
  return path.join(workspaceRoot().fsPath, LIVE_REL);
}

/** 変化が**起きない**ことを見る待ち。起きたら即座に落とす（黙って待ち切らない）。 */
async function assertLengthStays(before: number, label: string, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = await measureDisplayedLength();
    assert.strictEqual(now, before, `${label}: 表示の長さが変わった（${before} → ${now}）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function removeLiveFile(): void {
  try {
    fs.unlinkSync(liveFile());
  } catch {
    // 無ければそれでよい。
  }
}

suite("show_html の path（D52 / C4）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(() => {
    removeLiveFile();
  });

  teardown(() => {
    removeLiveFile();
  });

  test("ファイルを描き、保存のたびに描き直す（C4）。中身は返らない", async () => {
    fs.writeFileSync(liveFile(), "<p>v1</p>", "utf8");
    const result = await showHtml({ path: LIVE_REL });
    assert.strictEqual(result.shown, true);
    assert.strictEqual(result.droppedDeclarations, 0);
    // **中身は返らない**（不変条件2）。鍵は2つだけ。
    assert.deepStrictEqual(Object.keys(result).sort(), ["droppedDeclarations", "shown"]);
    // 既定のタイトルはファイル名。
    await waitFor("パネルが開く", () => panelTab() !== undefined);
    assert.strictEqual(panelTab()?.label, "ShowMe: showme-live.html");

    // **先に前の長さを主張する**（0 なら空振り）。
    const first = await measureDisplayedLength();
    assert.ok(first > 0, `初回の表示が空（${first}）`);

    // ファイルを**大きく**書き換える。エージェントは何も呼ばない。
    const bigger = `<p>v2</p><ul>${"<li>育てた図の1行</li>".repeat(40)}</ul>`;
    fs.writeFileSync(liveFile(), bigger, "utf8");
    await waitFor("保存で描き直る", async () => (await measureDisplayedLength()) > first);
  });

  test("再描画も同じサニタイザを通る（egress は落ちる）", async () => {
    fs.writeFileSync(liveFile(), "<p>clean</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    const first = await measureDisplayedLength();
    assert.ok(first > 0);

    // 落ちる属性を足した、**より長い**中身。落ちても（style の分は残るので）長さは増える。
    // 落ちなかったら、さらに長くなる ―― どちらでも「描き直った」は真になるので、
    // 落ちたことは長さの上限で見る。
    const evilAttr = ' onclick="alert(1)"';
    const withEvil = `<p${evilAttr}>clean</p><p>${"x".repeat(200)}</p>`;
    fs.writeFileSync(liveFile(), withEvil, "utf8");
    await waitFor("描き直る", async () => (await measureDisplayedLength()) > first);
    // 対照: 同じ中身から onclick を抜いて inline で出したときと**同じ長さ**になる。
    // 属性が残っていれば `evilAttr.length` だけ長い。
    const grown = await measureDisplayedLength();
    await showHtml({ html: withEvil.replace(evilAttr, "") });
    const control = await measureDisplayedLength();
    assert.strictEqual(grown, control, "再描画で onclick が落ちていない（長さが対照と違う）");
  });

  test("消えたら描き直さない（そのまま）", async () => {
    fs.writeFileSync(liveFile(), "<p>stay</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    const before = await measureDisplayedLength();
    assert.ok(before > 0);

    fs.unlinkSync(liveFile());
    await assertLengthStays(before, "削除");
  });

  test("アトミック保存（削除→作成）でも見張りは生きていて、作成で描き直る", async () => {
    // temp に書いて rename で差し替える編集器は、見張りから見ると delete → create に
    // なりうる。delete で見張りを畳むと、この形の保存の1回目で表示が黙って止まる
    // （安全側の検査は全部緑のまま機能だけが死ぬ向き）。delete は他の出来事と同じ
    // 「変わった」として扱い、読めるようになった時点で描き直す。
    fs.writeFileSync(liveFile(), "<p>atomic</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    const first = await measureDisplayedLength();
    assert.ok(first > 0, `初回の表示が空（${first}）`);

    fs.unlinkSync(liveFile());
    assert.ok(!fs.existsSync(liveFile()), "削除できていない");
    fs.writeFileSync(liveFile(), `<p>atomic</p><p>${"w".repeat(300)}</p>`, "utf8");
    await waitFor("削除→作成で描き直る", async () => (await measureDisplayedLength()) > first);
  });

  test("シンボリックリンクで .env に差し替えられても描き直さない（関門を通り直す）", async () => {
    fs.writeFileSync(liveFile(), "<p>stay</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    const before = await measureDisplayedLength();
    assert.ok(before > 0);

    fs.unlinkSync(liveFile());
    fs.symlinkSync(path.join(workspaceRoot().fsPath, ENV_REL), liveFile());
    // **差し替えられたことを主張する**（差し替えに失敗していたら検査が空振りする）。
    assert.ok(
      fs.lstatSync(liveFile()).isSymbolicLink(),
      "シンボリックリンクに差し替えられていない",
    );
    assert.ok(fs.readFileSync(liveFile(), "utf8").includes("SECRET"), "リンク先が .env でない");
    await assertLengthStays(before, "リンク差し替え");
  });

  test("再描画はパネルを前面に出さない（人間が同じ列で見ているタブを奪わない）", async () => {
    fs.writeFileSync(liveFile(), "<p>quiet</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    const first = await measureDisplayedLength();
    assert.ok(first > 0);
    const column = panelColumn();
    assert.ok(column !== undefined, "パネルの列が見つからない");
    assert.strictEqual(panelIsVisible(), true, "出した直後にパネルが見えていない");

    // **同じ列に**別のエディタを出して webview を隠す（人間がタブを切り替えた形）。
    const uri = vscode.Uri.joinPath(workspaceRoot(), SAMPLE_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
    await waitFor("パネルが隠れる", () => !panelIsVisible());

    // 保存する。中身は届く（retainContextWhenHidden で隠れた webview も postMessage を受ける）が、
    // パネルは前に出ない。
    fs.writeFileSync(liveFile(), `<p>quiet</p><p>${"q".repeat(300)}</p>`, "utf8");
    await waitFor("隠れたまま描き直る", async () => (await measureDisplayedLength()) > first);
    // 描き直った**後**も、人間のタブが前面のまま。
    assert.strictEqual(panelIsVisible(), false, "保存でパネルが前面に出た");
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
    const active = group?.activeTab?.input;
    assert.ok(
      active instanceof vscode.TabInputText && active.uri.toString() === uri.toString(),
      "人間が開いたタブが前面でなくなった",
    );
    // 少し待っても変わらない（描き直しの後追いで reveal が来ない）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(panelIsVisible(), false, "遅れてパネルが前面に出た");
  });

  test("glob の記号を含む名前は描くが見張らない（1ファイルより広い集合を見張らない）", async () => {
    const starRel = "docs/star*.html";
    const star = path.join(workspaceRoot().fsPath, starRel);
    const siblingRel = "docs/sibling-9c1e.html";
    const sibling = path.join(workspaceRoot().fsPath, siblingRel);
    try {
      fs.writeFileSync(star, "<p>star</p>", "utf8");
      const result = await showHtml({ path: starRel });
      assert.strictEqual(result.shown, true);
      const before = await measureDisplayedLength();
      assert.ok(before > 0);
      // そのファイル自身を書き換えても描き直らない（見張っていない）。
      fs.writeFileSync(star, `<p>star</p><p>${"s".repeat(300)}</p>`, "utf8");
      await assertLengthStays(before, "glob 名のファイルの保存");
      // `docs/*.html` として張っていれば、隣のファイルの作成でも再描画が走る
      // （閉包は star を読み直すので長さが増える）。それも起きない。
      fs.writeFileSync(sibling, "<p>sibling</p>", "utf8");
      await assertLengthStays(before, "隣のファイルの作成");
    } finally {
      for (const f of [star, sibling]) {
        try {
          fs.unlinkSync(f);
        } catch {
          // 無ければそれでよい。
        }
      }
    }
  });

  test("読めないパスは excluded-path の1つで断る。.env と .env.nope は同じ答え", async () => {
    const existing = await showHtmlErrorCode({ path: ENV_REL });
    const missing = await showHtmlErrorCode({ path: ".env.nope-9f2a" });
    assert.strictEqual(existing, "excluded-path");
    assert.strictEqual(missing, existing, JSON.stringify({ existing, missing }));
    // 無いファイル・外へ出るパス・.env へのリンクも、全部同じ答え。
    assert.strictEqual(await showHtmlErrorCode({ path: "docs/nope-8c31.html" }), "excluded-path");
    assert.strictEqual(await showHtmlErrorCode({ path: "../outside.html" }), "excluded-path");
    assert.strictEqual(await showHtmlErrorCode({ path: SYMLINK_TO_ENV_REL }), "excluded-path");
  });

  test("html で出し直すと見張りが止まる", async () => {
    fs.writeFileSync(liveFile(), "<p>watched</p>", "utf8");
    await showHtml({ path: LIVE_REL });
    assert.ok((await measureDisplayedLength()) > 0);

    await showHtml({ html: "<p>inline</p>" });
    const inline = await measureDisplayedLength();
    assert.ok(inline > 0);

    // 見張りが残っていれば、これで描き直って長さが変わる。
    fs.writeFileSync(liveFile(), `<p>watched</p><p>${"y".repeat(300)}</p>`, "utf8");
    await assertLengthStays(inline, "html で出し直した後の保存");
  });

  test("path でもう一度出すと、前の見張りは止まり新しいファイルに付く", async () => {
    const otherRel = "docs/showme-live-2.html";
    const other = path.join(workspaceRoot().fsPath, otherRel);
    try {
      fs.writeFileSync(liveFile(), "<p>first</p>", "utf8");
      fs.writeFileSync(other, "<p>second</p>", "utf8");
      await showHtml({ path: LIVE_REL });
      await showHtml({ path: otherRel });
      const before = await measureDisplayedLength();
      assert.ok(before > 0);

      // 古いほうを書き換えても描き直らない。
      fs.writeFileSync(liveFile(), `<p>first</p><p>${"z".repeat(300)}</p>`, "utf8");
      await assertLengthStays(before, "古いファイルの保存");
      // 新しいほうを書き換えると描き直る。
      fs.writeFileSync(other, `<p>second</p><p>${"z".repeat(300)}</p>`, "utf8");
      await waitFor(
        "新しいファイルの保存で描き直る",
        async () => (await measureDisplayedLength()) > before,
      );
    } finally {
      try {
        fs.unlinkSync(other);
      } catch {
        // 無ければそれでよい。
      }
    }
  });
});
