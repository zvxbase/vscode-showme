import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";

/**
 * 拡張ホストの中で走る側の入口。
 *
 * どちらの節を走らせるかは runTest.ts が `extensionTestsEnv` で渡す。
 * 既定を "trusted" にしない ―― 既定を持たせると、環境変数の受け渡しが
 * 壊れたときに制限モードの回が黙って信頼モードの節を走らせ、両方 PASS したまま
 * 「制限モードで確かめた」と言えてしまう。分からないなら落ちる。
 */
/**
 * macOS では窓を前面に出してから走らせる。
 *
 * runTest.ts は VS Code の実行ファイルを子プロセスとして直接起動する。macOS ではそうして起動した
 * アプリは前面（アクティブなアプリ）にならず、`window.state.focused` が最後まで false のままになる
 * （実測: GitHub の macOS の CI で、選択を返す検査が全部 `not-focused` で落ちた）。人間の選択を
 * 返すかどうかは窓が前面にあるかで決まる（D95・`editor-surface.ts`）ので、前面でない窓では
 * 「返らない」を確かめる検査しか意味を持たない。Linux（xvfb）と Windows では起動した窓がそのまま
 * 前面になる。`workbench.action.focusWindow` は macOS では `app.focus({ steal: true })` で
 * アプリごと前面に出す（VS Code の main）。出なかったときは理由を出力に残して先へ進む ――
 * 前面を前提にする検査は、自分の assert で落ちる。
 */
async function bringWindowToFront(timeoutMs: number, when: string): Promise<boolean> {
  if (process.platform !== "darwin" || vscode.window.state.focused) return true;
  await vscode.commands.executeCommand("workbench.action.focusWindow");
  const deadline = Date.now() + timeoutMs;
  while (!vscode.window.state.focused && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const focused = vscode.window.state.focused;
  console.log(`[showme] macOS: 窓を前面に出した後の window.state.focused = ${focused}（${when}）`);
  return focused;
}

/**
 * macOS では、各検査の前にも窓を前面に戻す（ルートの beforeEach）。
 *
 * 最初に1度前面に出しても、GitHub の macOS の runner では実行の途中で窓が前面から外れることがある
 * （実測: 走り出しの後で選択を返す検査が16件 `not-focused` で落ちた。run 36589919048）。
 * 前面を戻すのは検査の**前**だけで、検査の中の前提（`window.state.focused` の assert）は弱めない ――
 * 3秒待っても前面にならなければ、出力に残して検査に進み、前面を前提にする検査は自分の assert で落ちる。
 * 前面にあるときは何もしない（コマンドも呼ばない）。
 */
function refocusBeforeEachTestOnDarwin(mocha: Mocha): void {
  if (process.platform !== "darwin") return;
  mocha.suite.beforeEach("macOS: 窓を前面に戻す", async function () {
    await bringWindowToFront(3_000, this.currentTest?.fullTitle() ?? "beforeEach");
  });
}

export async function run(): Promise<void> {
  const mode = process.env.SHOWME_TEST_MODE;
  if (mode !== "trusted" && mode !== "restricted" && mode !== "locale-ja") {
    return Promise.reject(
      new Error(
        `SHOWME_TEST_MODE が trusted / restricted / locale-ja のどれでもない: ${String(mode)}`,
      ),
    );
  }

  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  // 開発中に一部の検査だけを走らせる口（`SHOWME_TEST_GREP`。検査名の部分一致）。既定は全部。
  const grep = process.env.SHOWME_TEST_GREP;
  if (grep !== undefined && grep !== "") {
    // 絞ったことを出力に残す（全部走ったと読み違えない）。
    console.log(
      `[showme] SHOWME_TEST_GREP=${JSON.stringify(grep)}: 名前が一致する検査だけを走らせる`,
    );
    mocha.grep(grep);
  }
  await bringWindowToFront(10_000, "起動の直後");
  refocusBeforeEachTestOnDarwin(mocha);
  if (mode === "locale-ja") {
    // `--locale=ja` の回（runLocaleJa.ts）。**日本語になることだけ**を見る。振る舞いの
    // 検査は trusted / restricted の回が持ち、この回では増やさない。
    mocha.addFile(path.resolve(__dirname, "./locale-ja.test.js"));
    return runMocha(mocha);
  }
  if (mode === "trusted" && process.platform === "win32") {
    // ネイティブの Windows の信頼の回だけ: 実行時ディレクトリの DACL が本人と trusted だけであること
    // （D104 / D110）。ほかの検査が登録やパイプを増やす前に見るので、最初に置く。
    mocha.addFile(path.resolve(__dirname, "./windows.test.js"));
  }
  mocha.addFile(path.resolve(__dirname, `./${mode}.test.js`));
  // 増分2C の前提測定（webview / CSP / 名前なしドキュメント）。**両方の回で走らせる。**
  // 測っている量はどれも信頼の有無に依らないはずだが、「依らないはず」は推定である。
  // 両方で走らせておけば、制限モードで webview が立たない・CSP のふるまいが違うと
  // いった食い違いが、後から探しに行かなくても同じ実行の中で見える。
  mocha.addFile(path.resolve(__dirname, "./spike-2c.test.js"));

  // egress の実測（2C Task 6）。**両方の回で走らせる。** 制限モードで webview が
  // 立たないなら、その回は「攻撃が届かない」ではなく「入れ物が無い」で緑になる ――
  // それを見分けるために、この検査は最初に「受信サーバ自体は届く」を確かめ、
  // 判別確認3件で「わざと壊したら届く」ことも確かめる。どれかが制限モードで
  // 落ちるなら、そのモードでは webview が使えないという結果である。
  mocha.addFile(path.resolve(__dirname, "./egress.test.js"));
  mocha.addFile(path.resolve(__dirname, "./show-note.test.js"));
  mocha.addFile(path.resolve(__dirname, "./limits.test.js"));
  mocha.addFile(path.resolve(__dirname, "./precision.test.js"));
  // `show_html({ path })` の見張り（D52 / C4）。**両方の回で走らせる。** 読むのは拡張で
  // あって言語機能ではないので制限モードでも読めるはず ―― 「はず」を実測に変える。
  mocha.addFile(path.resolve(__dirname, "./show-html-path.test.js"));
  // パネル2枚目（`slot`。D61 / C5）。**両方の回で走らせる** ―― 「制限モードでも2枚」は推定。
  mocha.addFile(path.resolve(__dirname, "./panel-slots.test.js"));
  // 映しの FileSystemProvider（D81）。**両方の回で走らせる** ―― 登録と関門は
  // 信頼の有無に依らないはずだが、制限モードで provider が使えるかは実測する。
  mocha.addFile(path.resolve(__dirname, "./stage-mirror.test.js"));
  // 秘匿ファイルへのハードリンク（D91）。**両方の回で走らせる** ―― 関門も観測も信頼の有無に
  // 依らないはずだが、制限モードでも同じ答えになるかは実測する。
  mocha.addFile(path.resolve(__dirname, "./redacted-links.test.js"));
  // 舞台を映しで開く（D84 / D85）。**両方の回で走らせる** ―― 位置は `text` で渡すので
  // 言語機能に依らない。制限モードで映しの編集器が開けるかは実測する。
  mocha.addFile(path.resolve(__dirname, "./stage-tabs.test.js"));
  // 道具の列を避ける（D90）。**両方の回で走らせる** ―― ターミナルや他の拡張の webview を
  // 編集器の領域に置けるか、制限モードでも同じ列を選ぶかは実測する。
  mocha.addFile(path.resolve(__dirname, "./stage-avoid.test.js"));
  // 人間の列も使う配置（D93 / D94）。**両方の回で走らせる**（制限モードの回は既定の2件だけ）。
  mocha.addFile(path.resolve(__dirname, "./stage-shared.test.js"));
  // エージェントのタブの定義・参照（D88）。**両方の回で走らせる** ―― 制限モードでは TS が動かないので
  // 「代理が何も返さず例外にならない」だけを見る。
  mocha.addFile(path.resolve(__dirname, "./stage-language.test.js"));
  // ワークスペースの外のファイル（D101 / D102）。**両方の回で走らせる**（制限モードの回は主要な2本）。
  mocha.addFile(path.resolve(__dirname, "./outside-workspace.test.js"));
  mocha.addFile(path.resolve(__dirname, "./onboarding.test.js"));
  // 映しのタブの定義・参照が TS 自身の結果と重なるか（D88 の前提の実測）。**信頼の回だけ** ――
  // 制限モードでは TS が何も返さないので、重なりを測る対象が無い。
  if (mode === "trusted") {
    mocha.addFile(path.resolve(__dirname, "./stage-language-measure.test.js"));
  }

  return runMocha(mocha);
}

function runMocha(mocha: Mocha): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) =>
        failures > 0 ? reject(new Error(`${failures} 件のテストが落ちた`)) : resolve(),
      );
    } catch (e) {
      reject(e);
    }
  });
}
