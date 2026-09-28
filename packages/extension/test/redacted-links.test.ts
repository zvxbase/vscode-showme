import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RedactedLinkIndex,
  SKIPPED_DIRECTORIES,
  collectRedactedInodes,
  isLinkToRedacted,
} from "../src/redacted-links.js";

/**
 * 実際のファイルシステムで確かめる。ハードリンクは realpath で解けないので、
 * 名前ではなく実体（dev:ino）で見分けるしかない。モックした fs では
 * 「同じ実体か」を検査したことにならない。
 */
describe("redacted-links", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    // /tmp 自体がシンボリックリンクの環境（macOS）があるので realpath を取る。
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-links-")));
    root = path.join(base, "workspace");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(root, "src.ts"), "const a = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const statOf = (p: string) => fs.statSync(p, { bigint: true });
  const key = (p: string) => {
    const s = statOf(p);
    return `${s.dev}:${s.ino}`;
  };

  it("秘匿ファイルの実体を集める", () => {
    const result = collectRedactedInodes(root, []);
    expect(result.complete).toBe(true);
    expect(result.inodes.has(key(path.join(root, ".env")))).toBe(true);
    expect(result.inodes.has(key(path.join(root, "src.ts")))).toBe(false);
  });

  it(".env へのハードリンクは秘匿の実体へのリンクと判定する", () => {
    const link = path.join(root, "docs", "notes.txt");
    fs.linkSync(path.join(root, ".env"), link);
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, statOf(link), [])).toBe(true);
  });

  it("普通のファイル同士のハードリンクは判定しない", () => {
    const link = path.join(root, "docs", "copy.ts");
    fs.linkSync(path.join(root, "src.ts"), link);
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, statOf(link), [])).toBe(false);
    expect(index.walkCount).toBe(1);
  });

  it("リンク数1のファイルは歩かずに false", () => {
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, statOf(path.join(root, "src.ts")), [])).toBe(false);
    expect(index.walkCount).toBe(0);
  });

  it("リンク数が2以上で実体の番号が分からない（ino 0）ときは歩かずに true", () => {
    // 実体の番号を返さないファイルシステムでは dev:ino で見分けられない。閉じる側に倒す。
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, { nlink: 2n, dev: 1n, ino: 0n }, [])).toBe(true);
    expect(isLinkToRedacted(index, root, { nlink: 2, dev: 1, ino: 0 }, [])).toBe(true);
    expect(index.walkCount).toBe(0);
    // リンク数1なら番号が無くても名前の判定だけで足りる。
    expect(isLinkToRedacted(index, root, { nlink: 1n, dev: 1n, ino: 0n }, [])).toBe(false);
  });

  it("number の Stats 相当でも判定できる", () => {
    const link = path.join(root, "docs", "notes.txt");
    fs.linkSync(path.join(root, ".env"), link);
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, fs.statSync(link), [])).toBe(true);
  });

  it("node_modules の中の .env は集めない", () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    const inner = path.join(root, "node_modules", "pkg", ".env");
    fs.writeFileSync(inner, "X=1\n");
    const link = path.join(root, "docs", "notes.txt");
    fs.linkSync(inner, link);
    const result = collectRedactedInodes(root, []);
    expect(result.inodes.has(key(inner))).toBe(false);
    expect(isLinkToRedacted(new RedactedLinkIndex(), root, statOf(link), [])).toBe(false);
  });

  it(".git の中も集めない", () => {
    fs.mkdirSync(path.join(root, ".git"));
    const inner = path.join(root, ".git", "id_rsa");
    fs.writeFileSync(inner, "k\n");
    expect(collectRedactedInodes(root, []).inodes.has(key(inner))).toBe(false);
  });

  it("サブディレクトリの秘匿ファイルも集める", () => {
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "credentials"), "c\n");
    expect(
      collectRedactedInodes(root, []).inodes.has(key(path.join(root, "sub", "credentials"))),
    ).toBe(true);
  });

  it("シンボリックリンクはたどらない", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const outsideEnv = path.join(outside, ".env");
    fs.writeFileSync(outsideEnv, "O=1\n");
    fs.symlinkSync(outside, path.join(root, "out"));
    fs.symlinkSync(outsideEnv, path.join(root, "linked.env"));
    const result = collectRedactedInodes(root, []);
    expect(result.complete).toBe(true);
    expect(result.inodes.has(key(outsideEnv))).toBe(false);
  });

  it("歩く項目数の上限で打ち切ると不完全になり、閉じる側に倒す", () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x\n");
    const result = collectRedactedInodes(root, [], { maxEntries: 5 });
    expect(result.complete).toBe(false);

    const link = path.join(root, "docs", "copy.ts");
    fs.linkSync(path.join(root, "src.ts"), link);
    const index = new RedactedLinkIndex({ maxEntries: 5 });
    expect(isLinkToRedacted(index, root, statOf(link), [])).toBe(true);
  });

  it("キャッシュは有効期間内は歩き直さず、過ぎたら歩き直す", () => {
    let now = 1_000;
    const index = new RedactedLinkIndex({ ttlMs: 10_000, now: () => now });
    const link = path.join(root, "docs", "notes.txt");
    fs.linkSync(path.join(root, "src.ts"), link);
    expect(isLinkToRedacted(index, root, statOf(link), [])).toBe(false);
    expect(index.walkCount).toBe(1);

    // 期間内に秘匿ファイルが増えても、まだ歩き直さない。
    const secret = path.join(root, "server.pem");
    fs.writeFileSync(secret, "p\n");
    const link2 = path.join(root, "docs", "cert.txt");
    fs.linkSync(secret, link2);
    now += 9_999;
    expect(isLinkToRedacted(index, root, statOf(link2), [])).toBe(false);
    expect(index.walkCount).toBe(1);

    now += 2;
    expect(isLinkToRedacted(index, root, statOf(link2), [])).toBe(true);
    expect(index.walkCount).toBe(2);
  });

  it("パターンが違えば別の集合として歩く", () => {
    const index = new RedactedLinkIndex();
    index.lookup(root, []);
    index.lookup(root, ["*.secret"]);
    index.lookup(root, []);
    expect(index.walkCount).toBe(2);
  });

  it("追加のパターンも効く", () => {
    const secret = path.join(root, "vault.secret");
    fs.writeFileSync(secret, "s\n");
    const link = path.join(root, "docs", "notes.txt");
    fs.linkSync(secret, link);
    expect(isLinkToRedacted(new RedactedLinkIndex(), root, statOf(link), [])).toBe(false);
    expect(isLinkToRedacted(new RedactedLinkIndex(), root, statOf(link), ["*.secret"])).toBe(true);
  });

  it("ルートが無いときは閉じる側（リンク数が2以上なら true）", () => {
    const link = path.join(root, "docs", "copy.ts");
    fs.linkSync(path.join(root, "src.ts"), link);
    const missing = path.join(base, "missing");
    expect(collectRedactedInodes(missing, []).complete).toBe(false);
    expect(isLinkToRedacted(new RedactedLinkIndex(), missing, statOf(link), [])).toBe(true);
    // リンク数1なら歩かないので false のまま。
    const single = path.join(root, "single.ts");
    fs.writeFileSync(single, "x\n");
    expect(isLinkToRedacted(new RedactedLinkIndex(), missing, statOf(single), [])).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "読めないディレクトリは飛ばし、集合は完全のまま（普通のリンクを巻き添えで拒まない）",
    () => {
      const locked = path.join(root, "locked");
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      const link = path.join(root, "docs", "copy.ts");
      fs.linkSync(path.join(root, "src.ts"), link);
      try {
        const result = collectRedactedInodes(root, []);
        expect(result.complete).toBe(true);
        // 読めたところの秘匿ファイルは集めている。
        expect(result.inodes.has(key(path.join(root, ".env")))).toBe(true);
        expect(isLinkToRedacted(new RedactedLinkIndex(), root, statOf(link), [])).toBe(false);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  it("依存・ビルド・キャッシュのディレクトリには入らない", () => {
    expect([...SKIPPED_DIRECTORIES].sort()).toEqual(
      [".cache", ".git", ".tox", ".venv", "__pycache__", "node_modules", "target", "venv"].sort(),
    );
    const inner: string[] = [];
    for (const dir of SKIPPED_DIRECTORIES) {
      // 深い場所でも名前で飛ばす。
      const d = path.join(root, "sub", dir);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, ".env");
      fs.writeFileSync(f, "X=1\n");
      inner.push(f);
    }
    // 同じ名前の**ファイル**は飛ばさない（ディレクトリだけ）。
    fs.writeFileSync(path.join(root, "target"), "not a dir\n");
    const result = collectRedactedInodes(root, ["target"]);
    expect(result.complete).toBe(true);
    for (const f of inner) expect(result.inodes.has(key(f)), f).toBe(false);
    expect(result.inodes.has(key(path.join(root, "target")))).toBe(true);
    // 飛ばさないディレクトリの中は集める（全部飛ばす実装が緑にならない）。
    fs.mkdirSync(path.join(root, "sub", "config"));
    fs.writeFileSync(path.join(root, "sub", "config", ".env"), "Y=1\n");
    expect(
      collectRedactedInodes(root, []).inodes.has(key(path.join(root, "sub", "config", ".env"))),
    ).toBe(true);
  });

  it("不完全なときだけ onIncomplete をルートで呼ぶ", () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x\n");
    const seen: string[] = [];
    const capped = new RedactedLinkIndex({ maxEntries: 5, onIncomplete: (r) => seen.push(r) });
    expect(capped.lookup(root, []).complete).toBe(false);
    expect(seen).toEqual([root]);
    // キャッシュが効いている間は歩かないので、知らせも増えない。
    capped.lookup(root, []);
    expect(seen).toEqual([root]);
    const full = new RedactedLinkIndex({ onIncomplete: (r) => seen.push(r) });
    expect(full.lookup(root, []).complete).toBe(true);
    expect(seen).toEqual([root]);
  });
});
