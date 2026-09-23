import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **英語化は「直した」で終わらせない。残っていないことを検査で言う**（設計 D58）。
 *
 * エージェントに読ませる文字列は英語のみ、人間に読ませる文字列は英語の原文を
 * 鍵にして `vscode.l10n` で日本語にする。どちらの経路でも、**`.ts` のソースには
 * 日本語の文字列リテラルが残らない**。残っていたら、それは翻訳漏れか、
 * l10n を通さずに直書きした人間向けの文字列である。
 *
 * コメント・`describe` / `it` の名前・`docs/` は日本語のまま（この repo の文体）。
 * だからコメントを剥がし、`*.test.ts` を外し、**文字列リテラルの中だけ**を見る。
 *
 * **例外を許す仕組みは無い。** 作ると次の人が使う。
 */

/** ひらがな・カタカナ・CJK 統合漢字。 */
const JAPANESE = /[぀-ヿ一-鿿]/;

/**
 * ソースから「文字列リテラルの中身」だけを取り出す。
 *
 * 正規表現でコメントを剥がすと、文字列の中の `//` や `/*` で剥がし過ぎる。
 * 小さな走査器で状態（コード / 行コメント / ブロックコメント / 文字列 /
 * テンプレート）を持ち、テンプレートの `${ … }` の中は再びコードとして読む。
 *
 * 正規表現リテラル（`/…/`）は文字列ではないので拾わない。ただし中に引用符が
 * あると文字列の始まりに見えるので、直前の字で「除算ではなく正規表現の始まり」を
 * 判定して読み飛ばす。
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  // テンプレートの `${` の入れ子。各要素はその `${` の中で開いた `{` の数。
  const templateDepth: number[] = [];
  let i = 0;
  const n = source.length;

  /** `/` が正規表現の始まりか（直前の意味のある字で判定する常套手段）。 */
  function regexStartsAt(pos: number): boolean {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(source[j] as string)) j--;
    if (j < 0) return true;
    const prev = source[j] as string;
    if (/[A-Za-z0-9_$)\]]/.test(prev)) {
      // `return /x/` のような予約語の直後は正規表現。識別子なら除算。
      const word = source.slice(Math.max(0, j - 10), j + 1).match(/[A-Za-z_$]+$/)?.[0];
      return word === "return" || word === "typeof" || word === "case" || word === "in";
    }
    return true;
  }

  function readTemplate(): void {
    // 開き ` の直後から呼ばれる。閉じ ` か `${` まで読む。
    let text = "";
    while (i < n) {
      const c = source[i] as string;
      if (c === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.push(text);
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        out.push(text);
        i += 2;
        templateDepth.push(0);
        return;
      }
      text += c;
      i++;
    }
    out.push(text);
  }

  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let text = "";
      i++;
      while (i < n && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
        } else {
          text += source[i];
          i++;
        }
      }
      i++;
      out.push(text);
      continue;
    }
    if (c === "`") {
      i++;
      readTemplate();
      continue;
    }
    if (templateDepth.length > 0) {
      const top = templateDepth.length - 1;
      if (c === "{") {
        templateDepth[top] = (templateDepth[top] as number) + 1;
        i++;
        continue;
      }
      if (c === "}") {
        if (templateDepth[top] === 0) {
          // `${ … }` が閉じた。テンプレートの続きを読む。
          templateDepth.pop();
          i++;
          readTemplate();
          continue;
        }
        templateDepth[top] = (templateDepth[top] as number) - 1;
        i++;
        continue;
      }
    }
    if (c === "/" && regexStartsAt(i)) {
      // 正規表現リテラル。`[…]` の中の `/` は終わりではない。
      i++;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        const r = source[i] as string;
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/** `*.test.ts` を除く `.ts`。`dist` / `out` は src の下に無いが、念のため飛ばす。 */
function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      out.push(...tsSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const repoRoot = path.resolve(__dirname, "../../..");
const packagesDir = path.join(repoRoot, "packages");
const extensionDir = path.join(packagesDir, "extension");

/** `packages/*\/src` のうち実在するもの。 */
function sourceRoots(): string[] {
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(packagesDir, e.name, "src"))
    .filter((p) => fs.existsSync(p));
}

describe("ソースに日本語の文字列リテラルが無い（D58）", () => {
  const roots = sourceRoots();
  const files = roots.flatMap((root) => tsSources(root));

  it("走査根が3つあり、走査対象が実際に見つかっている", () => {
    // 0件でも「全部英語」に見えてしまう。検査器が空振りしていないことを先に確かめる。
    const names = roots.map((r) => path.basename(path.dirname(r))).sort();
    expect(names).toEqual(["bridge", "extension", "protocol"]);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join("protocol", "src", "tools.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it("走査器が文字列リテラルだけを取り出せる", () => {
    // 「1件も無い」を信用する前に、判定が本当に当たることを確かめる（両方向）。
    expect(stringLiterals('const a = "日本語";')).toEqual(["日本語"]);
    expect(stringLiterals("const a = '日本語';")).toEqual(["日本語"]);
    expect(stringLiterals("const a = `日本語 ${x} 続き`;")).toEqual(["日本語 ", " 続き"]);
    expect(stringLiterals('const a = `外 ${f("中")} 外`;')).toEqual(["外 ", "中", " 外"]);
    expect(stringLiterals("const a = `${ {a: 1}.a } 後`;")).toEqual(["", " 後"]);
    // コメントは剥がれる（文字列の中の `//` は剥がさない）
    expect(stringLiterals('// 日本語\nconst a = "x"; // 日本語\n/* 日本語 */')).toEqual(["x"]);
    expect(stringLiterals('const u = "http://例";')).toEqual(["http://例"]);
    expect(stringLiterals('const a = "/* 中 */";')).toEqual(["/* 中 */"]);
    // 正規表現リテラルは文字列ではない（中の引用符で文字列を開かない）
    expect(stringLiterals('const r = /["\']/; const s = "後";')).toEqual(["後"]);
    expect(stringLiterals("const r = /[぀-ヿ一-鿿]/; const s = 'x';")).toEqual(["x"]);
    expect(stringLiterals("const r = a / b / c; const s = 'x';")).toEqual(["x"]);
    expect(stringLiterals("return /x\"y/.test(s) ? 'a' : 'b';")).toEqual(["a", "b"]);
    // エスケープを越えて閉じない
    expect(stringLiterals('const a = "a\\"日";')).toEqual(['a\\"日']);
  });

  it("*.test.ts を除く packages/*/src/**/*.ts のどれにも、日本語を含む文字列リテラルが無い", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = stringLiterals(fs.readFileSync(file, "utf8")).filter((s) => JAPANESE.test(s));
      if (hits.length > 0) offenders.push(`${path.relative(repoRoot, file)} (${hits.length})`);
    }
    expect(
      offenders,
      `日本語の文字列リテラルが残っている（エージェント向けは英語に、人間向けは l10n.ts の t() に）:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * 人間向けの文字列は `t("英語の原文")` を通り、`bundle.l10n.ja.json` が原文→日本語を持つ。
 * 鍵が食い違うと、VS Code は黙って原文（英語）を出す ―― 翻訳漏れは画面でしか気づけない。
 * `package.json` の `%key%` も同じで、`package.nls*.json` に無い鍵は `%key%` のまま表示される。
 */
describe("l10n の鍵が揃っている（D58）", () => {
  const bundlePath = path.join(extensionDir, "l10n", "bundle.l10n.ja.json");
  const nlsPath = path.join(extensionDir, "package.nls.json");
  const nlsJaPath = path.join(extensionDir, "package.nls.ja.json");

  function readKeys(file: string): string[] {
    return Object.keys(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>).sort();
  }

  /**
   * 文字列リテラルの綴りを値に戻す。`"…"` は JSON と同じ。`'…'` は biome が
   * `"` を含む文字列に選ぶ形なので（エスケープが少ない側の引用符を使う）、
   * 中の `\'` を戻し `"` を守ってから JSON として読む。
   */
  function literalValue(literal: string): string {
    if (literal.startsWith('"')) return JSON.parse(literal) as string;
    const inner = literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return JSON.parse(`"${inner}"`) as string;
  }

  /** `t("…")` / `t('…')` の第1引数。テンプレートは l10n の鍵にできないので数えない。 */
  function tCallKeys(): string[] {
    const keys = new Set<string>();
    for (const file of tsSources(path.join(extensionDir, "src"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g)) {
        keys.add(literalValue(m[1] as string));
      }
    }
    return [...keys].sort();
  }

  it("鍵の取り出しは単一引用符の文字列も値に戻せる（biome は \" を含む文字列に ' を選ぶ）", () => {
    expect(literalValue('"a b"')).toBe("a b");
    expect(literalValue("'say \"hi\"'")).toBe('say "hi"');
    expect(literalValue("'it\\'s'")).toBe("it's");
  });

  it('bundle.l10n.ja.json の鍵と、ソースの t("…") の第1引数の集合が一致する', () => {
    // Task 3 が作るまで赤。`it.skip` にしない ―― 存在しないことも検査の結果である。
    expect(fs.existsSync(bundlePath), `${bundlePath} が無い`).toBe(true);
    const bundleKeys = readKeys(bundlePath);
    const sourceKeys = tCallKeys();
    expect(sourceKeys.length).toBeGreaterThan(0);
    expect(bundleKeys).toEqual(sourceKeys);
  });

  it("package.nls.ja.json の鍵が package.nls.json と一致し、package.json の %key% と揃う", () => {
    expect(fs.existsSync(nlsPath), `${nlsPath} が無い`).toBe(true);
    expect(fs.existsSync(nlsJaPath), `${nlsJaPath} が無い`).toBe(true);
    const nlsKeys = readKeys(nlsPath);
    expect(nlsKeys.length).toBeGreaterThan(0);
    expect(readKeys(nlsJaPath)).toEqual(nlsKeys);

    const manifest = fs.readFileSync(path.join(extensionDir, "package.json"), "utf8");
    const referenced = [
      ...new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1])),
    ].sort();
    expect(referenced).toEqual(nlsKeys);
  });
});
