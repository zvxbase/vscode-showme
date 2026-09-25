import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptWorkspacePath } from "../src/workspace-path-gate.js";

/**
 * パスの関門。**この repo が4回別々に書いた境界**を1つにしたもの。
 *
 * 実ファイルシステムの上で検査する ―― シンボリックリンクは実体が無いと作れないし、
 * 「綴りは通るが実体は外」を偽物で作ると、検査したいことが検査できない。
 */

const made: string[] = [];
function tmpWorkspace(): { root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "showme-gate-"));
  made.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "notes.md"), "ok\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");
  fs.writeFileSync(path.join(outside, "target.txt"), "outside\n", "utf8");
  return { root, outside };
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("acceptWorkspacePath", () => {
  it("普通のパスは通り、正準名と実体を返す", () => {
    const { root } = tmpWorkspace();
    const verdict = acceptWorkspacePath(root, "docs/notes.md", []);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.canonical).toBe("docs/notes.md");
    expect(fs.readFileSync(verdict.realPath, "utf8")).toBe("ok\n");
  });

  it("綴りで外に出るものは落ちる", () => {
    const { root } = tmpWorkspace();
    for (const p of ["../outside/target.txt", "/etc/passwd", "a/../../b", "docs/../../x"]) {
      expect(acceptWorkspacePath(root, p, []), p).toEqual({ ok: false, reason: "invalid-path" });
    }
  });

  it("**実体が外を指すシンボリックリンクも落ちる**（綴りは無害）", () => {
    const { root, outside } = tmpWorkspace();
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "docs", "innocent.txt"));
    // 名前に `..` は無く、除外パターンにも当たらない。realpath だけが止められる。
    expect(acceptWorkspacePath(root, "docs/innocent.txt", [])).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("**除外は綴りではなく実体で効く**", () => {
    const { root } = tmpWorkspace();
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs", "harmless.txt"));
    expect(acceptWorkspacePath(root, "docs/harmless.txt", [])).toEqual({
      ok: false,
      reason: "excluded-path",
    });
  });

  it("除外パスを直に指しても落ちる", () => {
    const { root } = tmpWorkspace();
    expect(acceptWorkspacePath(root, ".env", [])).toEqual({ ok: false, reason: "excluded-path" });
  });

  it("設定で足したパターンも効く", () => {
    const { root } = tmpWorkspace();
    expect(acceptWorkspacePath(root, "docs/notes.md", ["docs/**"])).toEqual({
      ok: false,
      reason: "excluded-path",
    });
  });

  it("存在しないものと外にあるものは、同じ答えになる", () => {
    // **分けると、そこから存在を読める**（S1 と同じ形の無音のオラクル）。
    const { root } = tmpWorkspace();
    const missing = acceptWorkspacePath(root, "docs/no-such-file.md", []);
    const outsideOne = acceptWorkspacePath(root, "../outside/target.txt", []);
    expect(missing).toEqual(outsideOne);
    expect(missing).toEqual({ ok: false, reason: "invalid-path" });
  });

  it("ルートが無ければ落ちる", () => {
    expect(acceptWorkspacePath(undefined, "docs/notes.md", [])).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("中間ディレクトリのリンクも辿る", () => {
    const { root, outside } = tmpWorkspace();
    fs.symlinkSync(outside, path.join(root, "docs", "linked-dir"));
    expect(acceptWorkspacePath(root, "docs/linked-dir/target.txt", [])).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });
});

describe("秘匿の綴りは、存在を問わず同じ答え（無音のオラクルを作らない）", () => {
  // **仮説:** 関門は realpath の**後**にしか除外を当てていないので、
  // `.env` が存在すれば `excluded-path`、無ければ `invalid-path` と答えが割れる。
  // 割れれば、エージェントは秘匿ファイルの存在を1本ずつ確かめられる
  // （S1 と同じ形の無音のオラクル）。`symbol-prefetch.ts` / `annotate.ts` は
  // 綴りに先に当てて realpath を避けているが、関門だけがそうしていなかった。
  it("存在する .env と存在しない .env.missing で reason が同じ", () => {
    const { root } = tmpWorkspace();
    expect(fs.existsSync(path.join(root, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".env.missing"))).toBe(false);
    const exists = acceptWorkspacePath(root, ".env", []);
    const missing = acceptWorkspacePath(root, ".env.missing", []); // `.env.*` も既定で秘匿
    expect(exists.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(missing).toEqual(exists);
    expect(exists).toEqual({ ok: false, reason: "excluded-path" });
  });

  it("秘匿の綴りでは realpath を呼ばない（ルートが無くても excluded-path で返る）", () => {
    // `canonicalizeWorkspacePath` は差し替えられないので、存在しないディレクトリを
    // root にして「realpath が投げても excluded-path で返る」ことで代替する。
    // realpath を先に当てていれば、ここは invalid-path になる。
    const r = acceptWorkspacePath("/nonexistent-root-showme-issue-17", ".env", []);
    expect(r).toEqual({ ok: false, reason: "excluded-path" });
  });

  it("設定で足したパターンの綴りにも realpath を当てない", () => {
    const r = acceptWorkspacePath("/nonexistent-root-showme-issue-17", "docs/secret.md", [
      "docs/**",
    ]);
    expect(r).toEqual({ ok: false, reason: "excluded-path" });
  });
});

/**
 * **関門の外で正準化を呼んでいない**ことの構文レベルの検出。
 *
 * `canonicalizeWorkspacePath` を関門の外で import する＝境界を別に書いている
 * （不変条件14 の形。この repo は同じ境界を4箇所で別々に書き、書くたびに1段ずつ
 * 抜けた）。次に足された入口が同じことをしたら、ここで落ちる。
 *
 * 見るのは**出荷される側**（`packages/extension/src`）である。検査は本物の
 * ファイルシステムに当てたいので `canonicalizeWorkspacePath` を直に呼んでよい。
 */
describe("関門の外で canonicalizeWorkspacePath を import していない（D63）", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");
  /** 関門そのものと、その実装。この2つだけが正準化を直に呼んでよい。 */
  const ALLOWED = new Set(["workspace-path-gate.ts", "canonical-path.ts"]);
  /**
   * **モジュール指定子**に当てる（名前ではなく）。名前 `canonicalizeWorkspacePath` に
   * 当てると、`import * as cp from "../canonical-path.js"` や `await import(...)` で
   * すり抜ける（レビューで実測）。`canonical-path` を指す import / export / 動的 import の
   * どれも拾う。コメントで言及することは禁じない（理由を書けなくなる）。
   */
  const IMPORTS_CANONICALIZER =
    /(?:from\s*|import\s*\(\s*|export\s+\*\s+from\s*)["'][^"']*canonical-path(?:\.js)?["']/;

  const walk = (dir: string, into: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, into);
        continue;
      }
      if (full.endsWith(".ts")) into.push(full);
    }
  };

  it("src/ に関門以外で import しているファイルが無い", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.has(path.basename(file))) continue;
      if (IMPORTS_CANONICALIZER.test(fs.readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("検査が実際にファイルを読んでいる（空振りの緑を見分ける）", () => {
    // **0件でも「違反は無い」は真になる。** 食わせた件数を主張する。
    expect(fs.existsSync(SRC_ROOT), `${SRC_ROOT} が無い。上の検査は何も読んでいない`).toBe(true);
    const files: string[] = [];
    walk(SRC_ROOT, files);
    // 関門と実装の両方が走査に入っている（許可リストが空振りしていない）。
    for (const name of ALLOWED) {
      expect(
        files.some((f) => path.basename(f) === name),
        `${name} が走査に無い`,
      ).toBe(true);
    }
    // 関門以外のファイルも読んでいる（許可リストだけを見て緑になっていない）。
    expect(files.filter((f) => !ALLOWED.has(path.basename(f))).length).toBeGreaterThan(10);
    // 実装は実際に正準化を import している（検出器が本物の import 文に当たる）。
    expect(
      IMPORTS_CANONICALIZER.test(
        fs.readFileSync(path.join(SRC_ROOT, "workspace-path-gate.ts"), "utf8"),
      ),
    ).toBe(true);
  });

  it("検出器は import 文に当たり、コメントの言及には当たらない", () => {
    expect(
      IMPORTS_CANONICALIZER.test(
        'import { canonicalizeWorkspacePath } from "./canonical-path.js";',
      ),
    ).toBe(true);
    expect(
      IMPORTS_CANONICALIZER.test(
        'import { canonicalizeWorkspacePath } from "../canonical-path.js";',
      ),
    ).toBe(true);
    expect(
      IMPORTS_CANONICALIZER.test(
        'import {\n  type CanonicalTarget,\n  canonicalizeWorkspacePath,\n} from "./canonical-path.js";',
      ),
    ).toBe(true);
    // 言及だけ（`language-surface.ts` のコメントがこの形）。
    expect(IMPORTS_CANONICALIZER.test("// `canonicalizeWorkspacePath` を直に呼んでいて")).toBe(
      false,
    );
    // 関門の口を import するのは正しい形。
    expect(
      IMPORTS_CANONICALIZER.test('import { acceptWorkspacePath } from "./workspace-path-gate.js";'),
    ).toBe(false);
  });
});

/**
 * **判定した実体を開く口（`openJudgedFile`）を映しの外で使っていない**ことの検出。
 *
 * `openJudgedFile` は「関門が返した realPath と、それを stat した値」を受け取る前提で、
 * 自分では関門を当てない。映しの外から任意のパスで呼べば、関門を通らない読み書きの
 * 口がもう1つ増える（不変条件14 の形）。使ってよいのは `stage-mirror.ts` だけ。
 * テストは `test/` にあって `src/` の走査に入らないので、許可に数えない。
 */
describe("openJudgedFile を stage-mirror.ts の外で使っていない", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");
  const ALLOWED = new Set(["stage-mirror.ts"]);
  /** 名前に当てる（import の形は問わない。再 export や別名 import も拾う）。 */
  const USES_OPENER = /\bopenJudgedFile\b/;

  const walk = (dir: string, into: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, into);
        continue;
      }
      if (full.endsWith(".ts")) into.push(full);
    }
  };

  it("src/ に stage-mirror.ts 以外で名前を出しているファイルが無い", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const offenders = files.filter(
      (f) => !ALLOWED.has(path.basename(f)) && USES_OPENER.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("検査が実際にファイルを読んでいる（空振りの緑を見分ける）", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const mirror = files.find((f) => path.basename(f) === "stage-mirror.ts");
    expect(mirror, "stage-mirror.ts が走査に無い").toBeDefined();
    // 検出器は本物の定義に当たる（名前が変わったら、ここが先に落ちる）。
    expect(USES_OPENER.test(fs.readFileSync(mirror as string, "utf8"))).toBe(true);
    expect(files.filter((f) => !ALLOWED.has(path.basename(f))).length).toBeGreaterThan(10);
  });
});
