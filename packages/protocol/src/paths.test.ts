import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRelative } from "./paths.js";

describe("normalizeWorkspaceRelative", () => {
  it("普通の相対パスはそのまま通す", () => {
    expect(normalizeWorkspaceRelative("src/index.ts")).toBe("src/index.ts");
  });

  it("./ を畳む", () => {
    expect(normalizeWorkspaceRelative("./src/./index.ts")).toBe("src/index.ts");
  });

  it("バックスラッシュ区切りを正規化する", () => {
    expect(normalizeWorkspaceRelative("src\\index.ts")).toBe("src/index.ts");
  });

  it("ワークスペース外に出る相対パスを拒否する", () => {
    expect(normalizeWorkspaceRelative("../../../etc/passwd")).toBeUndefined();
    expect(normalizeWorkspaceRelative("src/../../outside")).toBeUndefined();
  });

  it("絶対パスを拒否する", () => {
    expect(normalizeWorkspaceRelative("/etc/passwd")).toBeUndefined();
    expect(normalizeWorkspaceRelative("C:\\Windows\\system32")).toBeUndefined();
  });

  it("ドライブ相対パス（区切りなし）を拒否する", () => {
    // path.win32.resolve(root, "D:foo") はルートを無視し、D ドライブの cwd に解決する。
    // つまりこれはワークスペース脱出であって、ただの相対パスではない。
    expect(normalizeWorkspaceRelative("D:foo")).toBeUndefined();
    expect(normalizeWorkspaceRelative("C:foo")).toBeUndefined();
    expect(normalizeWorkspaceRelative("c:src/index.ts")).toBeUndefined();
  });

  it("コロンを含むパスは一律で拒否する（NTFS 代替データストリーム対策）", () => {
    // Windows では `.env::$DATA` が `.env` と同じ実体を指すため、
    // 接尾辞ベースの除外リストを迂回できる（`.env` は当たるが `.env::$DATA` は当たらない）。
    // ドライブ相対（`D:foo`）も同じ規則で塞げるので、コロンは位置を問わず拒否する。
    // 失うのはコロンを含む POSIX ファイル名を扱えないことだけで、実害はほぼない。
    expect(normalizeWorkspaceRelative(".env::$DATA")).toBeUndefined();
    expect(normalizeWorkspaceRelative("secret.pem::$DATA")).toBeUndefined();
    expect(normalizeWorkspaceRelative("src/a:b.ts")).toBeUndefined();
    expect(normalizeWorkspaceRelative("ab:cd")).toBeUndefined();
  });

  it("NUL 文字を含むパスを拒否する", () => {
    expect(normalizeWorkspaceRelative("src/index.ts\u0000.png")).toBeUndefined();
  });

  it("空文字を拒否する", () => {
    expect(normalizeWorkspaceRelative("")).toBeUndefined();
  });

  it("セグメント末尾の空白やドットを持つパスを拒否する", () => {
    // Win32 は末尾の空白とドットを剥がすので、".env " は ".env" と同じ実体を開く。
    // 剥がして通すのではなく拒否する（fail-closed）。
    expect(normalizeWorkspaceRelative(".env ")).toBeUndefined();
    expect(normalizeWorkspaceRelative(".env.")).toBeUndefined();
    expect(normalizeWorkspaceRelative("dir /file.ts")).toBeUndefined();
    expect(normalizeWorkspaceRelative("src/index.ts ")).toBeUndefined();
  });

  it("普通のパスは通す", () => {
    expect(normalizeWorkspaceRelative("src/index.ts")).toBe("src/index.ts");
    expect(normalizeWorkspaceRelative("a.b/c.d.ts")).toBe("a.b/c.d.ts");
  });

  it("正規化の結果が . や .. になるものは既にこの検査より前で落ちている", () => {
    // 末尾ドットの検査が "." や ".." を巻き込んでいないことの確認。
    // どちらも undefined になるが、理由は末尾ドットではなく上流の判定である。
    expect(normalizeWorkspaceRelative(".")).toBeUndefined();
    expect(normalizeWorkspaceRelative("..")).toBeUndefined();
    expect(normalizeWorkspaceRelative("a/..")).toBeUndefined();
  });
});
