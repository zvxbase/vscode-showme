import * as path from "node:path";
import Mocha from "mocha";

/**
 * 拡張ホストの中で走る側の入口。
 *
 * どちらの節を走らせるかは runTest.ts が `extensionTestsEnv` で渡す。
 * 既定を "trusted" にしない ―― 既定を持たせると、環境変数の受け渡しが
 * 壊れたときに制限モードの回が黙って信頼モードの節を走らせ、両方 PASS したまま
 * 「制限モードで確かめた」と言えてしまう。分からないなら落ちる。
 */
export function run(): Promise<void> {
  const mode = process.env.SHOWME_TEST_MODE;
  if (mode !== "trusted" && mode !== "restricted" && mode !== "locale-ja") {
    return Promise.reject(
      new Error(
        `SHOWME_TEST_MODE が trusted / restricted / locale-ja のどれでもない: ${String(mode)}`,
      ),
    );
  }

  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  if (mode === "locale-ja") {
    // `--locale=ja` の回（runLocaleJa.ts）。**日本語になることだけ**を見る。振る舞いの
    // 検査は trusted / restricted の回が持ち、その件数（161 / 91）をこの回で増やさない。
    mocha.addFile(path.resolve(__dirname, "./locale-ja.test.js"));
    return runMocha(mocha);
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
