import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import {
  bundledPackages,
  licensePolicyViolations,
  renderNotices,
} from "../../scripts/release/third-party-notices.mjs";

/**
 * 拡張本体と**ブリッジの両方**を束ねる。
 *
 * ブリッジは拡張に同梱する（設計書 D26 / 「npm を配布
 * 経路にしない」）。同梱していないのに runbook が同梱前提の手順を案内して
 * いたので、手順どおりにやると必ず動かなかった（`vsce ls` で bridge を含む
 * ファイルは 0 件だった）。
 */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // 束に入った第三者パッケージを THIRD-PARTY-NOTICES.txt に導くため（下）
  metafile: true,
};

const extension = await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  // "vscode" は拡張ホストが実行時に渡す特別なモジュール。束ねてはいけない。
  external: ["vscode"],
});

// ブリッジがエージェントに名乗る版は、拡張の package.json の1か所から埋め込む（mcp-server.ts）
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const bridge = await build({
  ...common,
  define: { __SHOWME_VERSION__: JSON.stringify(version) },
  entryPoints: ["../bridge/src/index.ts"],
  outfile: "bridge/index.js",
  // ブリッジは素の node が起動する別プロセスなので、依存（MCP SDK・zod・
  // protocol）ごと束ねる。束ねないと VSIX の中に node_modules を入れる話に
  // なり、それは「npm を配布経路にしない」を回り道で破ることになる。
  external: [],
});

/**
 * 束ねると各パッケージの LICENSE ファイルは配布物から落ちる。MIT / ISC / BSD はどれも
 * 「配布物に著作権表示と条件を含めよ」と求める（BSD は「バイナリ形式の再配布では同梱文書に
 * 再現せよ」と明記）。**何を束ねたかを決めているのはこのビルド**なので、一覧もここで
 * metafile から導く（手で持つと、依存が増えた瞬間にずれる）。
 * 許可していないライセンスが入ったらビルドを止める ―― 配ってよいかは人が決める。
 */
const pkgs = bundledPackages([extension.metafile, bridge.metafile], process.cwd());
const violations = licensePolicyViolations(pkgs);
if (violations.length > 0) {
  throw new Error(`third-party license policy:\n  ${violations.join("\n  ")}`);
}
writeFileSync("THIRD-PARTY-NOTICES.txt", renderNotices(pkgs));
