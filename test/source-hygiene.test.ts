import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 自分たちのソースに不可視文字が混入していないことの検査。
 *
 * このリポジトリは既に2回これで壊れている:
 *   1. ファイル書き込みが NUL のエスケープ列ではなく生の 0x00 バイトを書き、
 *      git がファイルをバイナリ扱いにした（差分もレビューも blame も効かなくなる）
 *   2. ブロックコメントの早期終了を避ける回避策として、ゼロ幅スペースが入った
 *
 * エージェント由来のテキストからは双方向オーバーライド文字を除去する設計に
 * なっている（設計書 §4.4 / Trojan Source）。同じ基準を自分たちのソースにも
 * 当てる。読む人と実行される内容が食い違う余地を、こちら側にも作らない。
 *
 * 判定は正規表現ではなくコードポイントで書く。正規表現リテラルに制御文字を
 * 書くと、その並び自体が禁止対象になって検査器が自分自身を告発する
 * （実際に一度そうなった）。
 */

/** 許すもの: 改行・復帰・タブ。それ以外の C0 制御文字と DEL は許さない。 */
function isControlChar(code: number): boolean {
  if (code === 0x0a || code === 0x0d || code === 0x09) return false;
  return code < 0x20 || code === 0x7f;
}

/** ゼロ幅スペース / ZWNJ / ZWJ / 語結合子 / BOM。 */
function isZeroWidthChar(code: number): boolean {
  return (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff;
}

/** 双方向の埋め込み・上書き・隔離（Trojan Source）。 */
function isBidiOverrideChar(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

const CHECKS: ReadonlyArray<readonly [string, (code: number) => boolean]> = [
  ["制御文字", isControlChar],
  ["ゼロ幅文字", isZeroWidthChar],
  ["双方向オーバーライド", isBidiOverrideChar],
];

function containsAny(text: string, predicate: (code: number) => boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    if (predicate(text.charCodeAt(i))) return true;
  }
  return false;
}

/** 走査しないディレクトリ。生成物と外部由来のもの。 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".vscode-test",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "out-test",
]);

/** 我々が書いてコミットするテキスト。設定ファイルと文書も含める。 */
const SCANNED_EXTENSIONS: readonly string[] = [".ts", ".js", ".mjs", ".json", ".md"];

/**
 * 走査しない**場所**（名前ではなく道）。
 *
 * `packages/extension/bridge/` は esbuild が束ねた生成物で、中身は依存
 * ライブラリのコードである。名前で飛ばすと（`SKIPPED_DIRS` に "bridge" を
 * 足すと）、我々が書いている `packages/bridge/` まで走査対象から消える。
 * この検査は「我々が書いてコミットするテキスト」に当てるものなので、
 * 消してよいのは生成物のほうだけである。
 */
const SKIPPED_PATHS: ReadonlySet<string> = new Set(["packages/extension/bridge"]);

function sourceFiles(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      if (SKIPPED_PATHS.has(path.relative(repoRoot, full))) continue;
      out.push(...sourceFiles(full, repoRoot));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe("ソースの衛生", () => {
  // 走査根はリポジトリのルート。これは protocol の不変条件ではなくリポジトリ全体の
  // 不変条件なので、パッケージの中に置かない（置くと「protocol のテストが extension の
  // ソースを読んで赤くなる」という、責務のねじれた失敗の仕方をする）。
  const repoRoot = path.resolve(__dirname, "..");
  const files = sourceFiles(repoRoot, repoRoot);

  it("走査対象のファイルが実際に見つかっている", () => {
    // 0件でも「全部きれい」に見えてしまう。検査器が空振りしていないことを先に確かめる。
    // 走査根が黙って狭まったときに気づけるよう、下限は実際の件数から離しすぎない。
    expect(files.length).toBeGreaterThan(20);
  });

  it("パッケージの外の設定ファイルも走査対象に入っている", () => {
    // 走査根がパッケージの中に戻ったら、この2件が消えて赤くなる。
    const relative = files.map((file) => path.relative(repoRoot, file));
    expect(relative).toContain("package.json");
    // 両方の repo にある README.md で見る
    expect(relative).toContain("README.md");
  });

  it("生成物だけを外し、同じ名前の本物のソースは外さない", () => {
    // "bridge" という**名前**で飛ばすと、我々が書いている packages/bridge/ まで
    // 走査対象から消える。外れているのは生成物 packages/extension/bridge/ だけ
    // であることを、両方の実在で確かめる。
    const relative = files.map((file) => path.relative(repoRoot, file));
    expect(relative).toContain(path.join("packages", "bridge", "src", "index.ts"));
    expect(
      relative.some((file) => file.startsWith(path.join("packages", "extension", "bridge"))),
    ).toBe(false);
  });

  it("検査器が実際に不可視文字を捕まえられる", () => {
    // 「1件も無い」を信用する前に、判定が本当に当たることを確かめる。
    expect(containsAny("a\u0000b", isControlChar)).toBe(true);
    expect(containsAny("a\u001fb", isControlChar)).toBe(true);
    expect(containsAny("a\u200bb", isZeroWidthChar)).toBe(true);
    expect(containsAny("a\ufeffb", isZeroWidthChar)).toBe(true);
    expect(containsAny("a\u202eb", isBidiOverrideChar)).toBe(true);

    // 普通のソースは当たらない
    expect(containsAny("const a = 1;\n\tconst b = 2;\r\n", isControlChar)).toBe(false);
    expect(containsAny("日本語のコメントも通る", isZeroWidthChar)).toBe(false);
    expect(containsAny("// 全角の　空白は対象外", isBidiOverrideChar)).toBe(false);
  });

  for (const [label, predicate] of CHECKS) {
    it(`どのソースにも${label}が含まれない`, () => {
      const offenders = files.filter((file) =>
        containsAny(fs.readFileSync(file, "utf8"), predicate),
      );
      expect(offenders.map((file) => path.relative(repoRoot, file))).toEqual([]);
    });
  }
});
