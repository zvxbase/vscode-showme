import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_RESOLVE_BYTES, isRedactedPath } from "@zvx/vscode-showme-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgentFile, readWorkspaceFile } from "../src/read-workspace-file.js";

/**
 * 実際のファイルシステムで確かめる。ここで塞いでいるのは
 * 「判定した文字列と、実際に読む実体がずれる」経路なので、
 * モックした fs では検査にならない。
 */
describe("readWorkspaceFile", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    // realpath を取るのは /tmp 自体がシンボリックリンクの環境があるため
    // （macOS の /tmp -> /private/tmp）。取らないと相対計算が常に外れる。
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-read-")));
    root = path.join(base, "workspace");
    outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "src.ts"), "const a = 1;\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(outside, "secrets.txt"), "outside\n");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it("ワークスペース内の通常ファイルを読む", () => {
    expect(readWorkspaceFile(root, "src.ts", { patterns: [], blockLinksToRedacted: true })).toBe(
      "const a = 1;\n",
    );
  });

  it("存在しないファイルは undefined", () => {
    expect(
      readWorkspaceFile(root, "missing.ts", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("ディレクトリは undefined", () => {
    expect(
      readWorkspaceFile(root, "docs", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("シンボリックリンク経由でワークスペース外に出られない", () => {
    fs.symlinkSync(path.join(outside, "secrets.txt"), path.join(root, "link.txt"));
    expect(
      readWorkspaceFile(root, "link.txt", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("ディレクトリのシンボリックリンク越しでも外に出られない", () => {
    fs.symlinkSync(outside, path.join(root, "out"));
    expect(
      readWorkspaceFile(root, "out/secrets.txt", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("realpath の後にも除外判定を当てる（C1 の残り半分）", () => {
    // 除外判定はエージェントが渡した生の文字列に対して行われる。実体は
    // realpath の後に決まる。両者が違うものを見ていると、判定を通り抜けた
    // 綴りで別の実体を読める（設計書 §4.1 ⑤）。
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs", "notes.md"));

    // 前段の関門（生文字列に対する判定）はこの綴りを通す
    expect(isRedactedPath("docs/notes.md", [])).toBe(false);
    // それでも読めない
    expect(
      readWorkspaceFile(root, "docs/notes.md", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
    // 同じ場所の普通のファイルは読めるので、単に何も読めていないのではない
    fs.writeFileSync(path.join(root, "docs", "real.md"), "hello\n");
    expect(
      readWorkspaceFile(root, "docs/real.md", { patterns: [], blockLinksToRedacted: true }),
    ).toBe("hello\n");
  });

  it("追加パターンも realpath の後の名前に当たる", () => {
    fs.writeFileSync(path.join(root, "vault.txt"), "TOP\n");
    fs.symlinkSync(path.join(root, "vault.txt"), path.join(root, "docs", "ok.md"));
    expect(
      readWorkspaceFile(root, "docs/ok.md", { patterns: [], blockLinksToRedacted: true }),
    ).toBe("TOP\n");
    expect(
      readWorkspaceFile(root, "docs/ok.md", {
        patterns: ["vault.txt"],
        blockLinksToRedacted: true,
      }),
    ).toBeUndefined();
  });

  it("大文字小文字を変えた綴りでも除外に当たる", () => {
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs", "x.md"));
    expect(
      readWorkspaceFile(root, "docs/x.md", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("上限を超えるファイルは読まない", () => {
    const big = path.join(root, "big.txt");
    fs.writeFileSync(big, "a".repeat(MAX_RESOLVE_BYTES + 1));
    expect(
      readWorkspaceFile(root, "big.txt", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("ルート自身は読めない", () => {
    expect(
      readWorkspaceFile(root, ".", { patterns: [], blockLinksToRedacted: true }),
    ).toBeUndefined();
  });

  it("先頭が .. の名前を持つ普通のファイルは読める", () => {
    // path.relative の結果を "..".startsWith で判定すると、この名前が
    // 脱出と誤判定される。
    fs.writeFileSync(path.join(root, "..hidden.txt"), "dots\n");
    expect(
      readWorkspaceFile(root, "..hidden.txt", { patterns: [], blockLinksToRedacted: true }),
    ).toBe("dots\n");
  });
});

/**
 * 外のファイル（D102）を読んでよい口は、位置を解決する `readAgentFile`（`show_code` / `annotate`）
 * だけ。`readWorkspaceFile`（`show_html` の `path` が使う）はワークスペースの中だけのまま ――
 * 設定がオンでも外の絶対パスは読まない（設定がオフのときと同じく「読めない」）。
 */
describe("外のファイルを読む口は分ける（D102）", () => {
  let base: string;
  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-read-out-")));
    fs.mkdirSync(path.join(base, "ws"));
    fs.writeFileSync(path.join(base, "page.html"), "<p>outside</p>\n");
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const on = { patterns: [], blockLinksToRedacted: true, allowOutsideWorkspace: true };
  const off = { patterns: [], blockLinksToRedacted: true };

  it("readWorkspaceFile は設定がオンでも外の絶対パスを読まない（オフと同じ答え）", () => {
    const abs = path.join(base, "page.html");
    expect(readWorkspaceFile(path.join(base, "ws"), abs, on)).toBeUndefined();
    expect(readWorkspaceFile(path.join(base, "ws"), abs, off)).toBeUndefined();
  });

  it("readAgentFile は設定がオンなら外を読み、オフなら読まない", () => {
    const abs = path.join(base, "page.html");
    expect(readAgentFile(path.join(base, "ws"), abs, on)).toBe("<p>outside</p>\n");
    expect(readAgentFile(path.join(base, "ws"), abs, off)).toBeUndefined();
  });
});

describe("外を読む口（readAgentFile）を使うのは位置の解決だけ", () => {
  it("src/ で名前を出しているのは read-workspace-file.ts・show-code.ts・annotate.ts だけ", () => {
    const SRC = path.resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    const users = files
      .filter((f) => /\breadAgentFile\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    expect(users).toEqual(["annotate.ts", "read-workspace-file.ts", "show-code.ts"]);
  });
});
