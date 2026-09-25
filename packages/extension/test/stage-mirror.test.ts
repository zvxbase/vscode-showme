import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_RESOLVE_BYTES } from "@zvx/vscode-showme-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StageMirror, openJudgedFile } from "../src/stage-mirror.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "../src/stage-uri.js";

const RO = STAGE_SCHEME_READONLY;
const RW = STAGE_SCHEME_EDITABLE;

/**
 * 実際のファイルシステムで確かめる（`read-workspace-file.test.ts` に倣う）。
 * 映しは誰からでも開かれうる口なので、関門で落とすものの答えが**形まで同じ**で
 * あることを `toEqual({ ok: false })` で見る。
 */
describe("StageMirror", () => {
  let base: string;
  let root: string;
  let outside: string;
  let mirror: StageMirror;

  const bytesOf = (s: string) => new TextEncoder().encode(s);

  // base 以下の全エントリ（ファイルの中身・リンク先・ディレクトリ）。書き込みの失敗が
  // 「何も作らず、何も変えなかった」ことを、対象を予想せずに丸ごと比べて確かめる。
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) out[p] = `link:${fs.readlinkSync(p)}`;
        else if (st.isDirectory()) {
          out[p] = "dir";
          walk(p);
        } else out[p] = `file:${fs.readFileSync(p, "latin1")}`;
      }
    };
    walk(dir);
    return out;
  };

  beforeEach(() => {
    // realpath を取るのは /tmp 自体がシンボリックリンクの環境があるため。
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "showme-mirror-")));
    root = path.join(base, "workspace");
    outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "src.ts"), "const a = 1;\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(base, "outside.txt"), "outside-top\n");
    fs.writeFileSync(path.join(outside, "secrets.txt"), "outside\n");
    fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(MAX_RESOLVE_BYTES + 1));
    fs.symlinkSync(path.join(outside, "secrets.txt"), path.join(root, "escape.txt"));
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs", "notes.md"));
    mirror = new StageMirror(
      () => root,
      () => [],
    );
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // 関門・実体の検査で落ちるもの。どれも同じ答えでなければならない。
  const REJECTED: ReadonlyArray<[string, string]> = [
    ["秘匿（実在）", ".env"],
    ["秘匿（不在）", ".env.nope"],
    ["脱出の綴り", "../outside.txt"],
    ["ルート外を指すリンク", "escape.txt"],
    ["秘匿を指すリンク", "docs/notes.md"],
    ["ディレクトリ", "docs"],
    ["不在のファイル", "missing.ts"],
    ["上限+1 バイト", "big.txt"],
  ];

  describe("read", () => {
    it("通常ファイルを bytes で読む", () => {
      const r = mirror.read(RO, "src.ts");
      expect(r.ok).toBe(true);
      if (r.ok) expect(Buffer.from(r.bytes).toString("utf8")).toBe("const a = 1;\n");
      const w = mirror.read(RW, "src.ts");
      if (!w.ok) throw new Error("expected ok");
      expect(Buffer.from(w.bytes).toString("utf8")).toBe("const a = 1;\n");
    });

    for (const [label, rel] of REJECTED) {
      it(`同じ失敗: ${label}`, () => {
        expect(mirror.read(RO, rel)).toEqual({ ok: false });
        expect(mirror.read(RW, rel)).toEqual({ ok: false });
      });
    }

    it("上限ちょうどのファイルは読み切る（読み込みは分割されても全量）", () => {
      const content = Buffer.alloc(MAX_RESOLVE_BYTES, 0x61);
      content[MAX_RESOLVE_BYTES - 1] = 0x7a;
      fs.writeFileSync(path.join(root, "edge.txt"), content);
      const r = mirror.read(RO, "edge.txt");
      if (!r.ok) throw new Error("expected ok");
      expect(r.bytes.length).toBe(MAX_RESOLVE_BYTES);
      expect(Buffer.from(r.bytes).equals(content)).toBe(true);
    });

    it("ワークスペース内の通常ファイルを指すリンクは実体を読む", () => {
      fs.symlinkSync(path.join(root, "src.ts"), path.join(root, "docs", "alias.ts"));
      const r = mirror.read(RO, "docs/alias.ts");
      if (!r.ok) throw new Error("expected ok");
      expect(Buffer.from(r.bytes).toString("utf8")).toBe("const a = 1;\n");
    });

    it("unsaved: showme-ro では未保存の中身を返す", () => {
      const r = mirror.read(RO, "src.ts", "const a = 2;\n");
      if (!r.ok) throw new Error("expected ok");
      expect(Buffer.from(r.bytes).toString("utf8")).toBe("const a = 2;\n");
    });

    it("unsaved: showme-rw では無視してディスクを読む", () => {
      const r = mirror.read(RW, "src.ts", "const a = 2;\n");
      if (!r.ok) throw new Error("expected ok");
      expect(Buffer.from(r.bytes).toString("utf8")).toBe("const a = 1;\n");
    });

    it("unsaved: 関門を通らないパスでは返さない", () => {
      expect(mirror.read(RO, ".env", "LEAK")).toEqual({ ok: false });
      expect(mirror.read(RO, "docs/notes.md", "LEAK")).toEqual({ ok: false });
      expect(mirror.read(RO, "missing.ts", "LEAK")).toEqual({ ok: false });
      expect(mirror.read(RO, "docs", "LEAK")).toEqual({ ok: false });
    });

    it("unsaved: 空文字は空の bytes を返す（ディスクではない）", () => {
      const r = mirror.read(RO, "src.ts", "");
      if (!r.ok) throw new Error("expected ok");
      expect(r.bytes.length).toBe(0);
    });

    it("unsaved: 上限を超えるファイルでは返さない", () => {
      expect(mirror.read(RO, "big.txt", "small")).toEqual({ ok: false });
    });

    it("unsaved: 未保存の中身そのものが上限を超えれば失敗", () => {
      expect(mirror.read(RO, "src.ts", "a".repeat(MAX_RESOLVE_BYTES + 1))).toEqual({ ok: false });
      // 上限ちょうどは通る（境界の両側を見る）
      const r = mirror.read(RO, "src.ts", "a".repeat(MAX_RESOLVE_BYTES));
      expect(r.ok).toBe(true);
    });

    it("追加の秘匿パターンを毎回読む", () => {
      let patterns: string[] = [];
      const m = new StageMirror(
        () => root,
        () => patterns,
      );
      expect(m.read(RO, "src.ts").ok).toBe(true);
      patterns = ["src.ts"];
      expect(m.read(RO, "src.ts")).toEqual({ ok: false });
    });
  });

  describe("stat", () => {
    it("通常ファイルの大きさと時刻を返す", () => {
      const s = mirror.stat(RO, "src.ts");
      if (!s.ok) throw new Error("expected ok");
      const real = fs.statSync(path.join(root, "src.ts"));
      expect(s.size).toBe(real.size);
      // 実装は bigint の ns から ms に直す。number の stat とは丸めだけが違いうる。
      expect(s.mtime).toBeCloseTo(real.mtimeMs, 3);
      expect(s.ctime).toBeCloseTo(real.ctimeMs, 3);
    });

    it("書けるファイルでは readonly はスキームで決まる", () => {
      const ro = mirror.stat(RO, "src.ts");
      const rw = mirror.stat(RW, "src.ts");
      if (!ro.ok || !rw.ok) throw new Error("expected ok");
      expect(ro.readonly).toBe(true);
      expect(rw.readonly).toBe(false);
    });

    it("showme-rw はハードリンクを持つファイルを readonly と報告する（write の拒否と同じ判断）", () => {
      fs.linkSync(path.join(root, "src.ts"), path.join(root, "hard.ts"));
      for (const rel of ["src.ts", "hard.ts"]) {
        const rw = mirror.stat(RW, rel);
        if (!rw.ok) throw new Error("expected ok");
        expect(rw.readonly).toBe(true);
      }
    });

    it("showme-rw はディスクの権限で書けないファイルを readonly と報告する", () => {
      // root は権限を無視して書けてしまうので、この検査は成り立たない
      if (process.getuid?.() === 0 || process.platform === "win32") return;
      fs.chmodSync(path.join(root, "src.ts"), 0o444);
      const rw = mirror.stat(RW, "src.ts");
      if (!rw.ok) throw new Error("expected ok");
      expect(rw.readonly).toBe(true);
    });

    it("showme-ro で unsaved が渡れば size はその utf8 バイト数", () => {
      const s = mirror.stat(RO, "src.ts", "\u3042\u3044");
      if (!s.ok) throw new Error("expected ok");
      expect(s.size).toBe(6);
      // showme-rw は unsaved を無視してディスクの大きさ
      const w = mirror.stat(RW, "src.ts", "\u3042\u3044");
      if (!w.ok) throw new Error("expected ok");
      expect(w.size).toBe(fs.statSync(path.join(root, "src.ts")).size);
    });

    it("unsaved が上限を超えれば stat も失敗（read と同じ判断）", () => {
      expect(mirror.stat(RO, "src.ts", "a".repeat(MAX_RESOLVE_BYTES + 1))).toEqual({ ok: false });
    });

    it("追加の秘匿パターンは stat と write にも効く", () => {
      const m = new StageMirror(
        () => root,
        () => ["src.ts"],
      );
      expect(m.stat(RO, "src.ts")).toEqual({ ok: false });
      expect(m.write(RW, "src.ts", bytesOf("x"))).toEqual({ ok: false, reason: "not-found" });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
    });

    it("bump() の前後で mtime が増える", () => {
      const before = mirror.stat(RO, "src.ts");
      mirror.bump();
      const after = mirror.stat(RO, "src.ts");
      if (!before.ok || !after.ok) throw new Error("expected ok");
      expect(after.mtime).toBeGreaterThan(before.mtime);
    });

    it("bump() は showme-rw の mtime を変えない（ディスクの mtime そのまま）", () => {
      // rw はディスクの素通し。版を足すと、無関係な編集のたびに rw の mtime が動き、
      // VS Code の保存時の比較が「ファイルの方が新しい」と誤って衝突を出す。
      const before = mirror.stat(RW, "src.ts");
      mirror.bump();
      mirror.bump();
      const after = mirror.stat(RW, "src.ts");
      if (!before.ok || !after.ok) throw new Error("expected ok");
      expect(after.mtime).toBe(before.mtime);
      expect(after.mtime).toBeCloseTo(fs.statSync(path.join(root, "src.ts")).mtimeMs, 3);
    });

    for (const [label, rel] of REJECTED) {
      it(`同じ失敗: ${label}`, () => {
        expect(mirror.stat(RO, rel)).toEqual({ ok: false });
        expect(mirror.stat(RW, rel)).toEqual({ ok: false });
      });
    }
  });

  describe("write", () => {
    it("showme-rw で既存ファイルに書ける", () => {
      expect(mirror.write(RW, "src.ts", bytesOf("const b = 2;\n"))).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const b = 2;\n");
    });

    it("短く書き直すと残りが切り詰められる", () => {
      expect(mirror.write(RW, "src.ts", bytesOf("x"))).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("x");
    });

    it("showme-ro は readonly で、ファイルは変わらない", () => {
      expect(mirror.write(RO, "src.ts", bytesOf("nope"))).toEqual({
        ok: false,
        reason: "readonly",
      });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
    });

    it("ワークスペース内の通常ファイルを指すリンク越しは実体に書く（リンクは残る）", () => {
      fs.symlinkSync(path.join(root, "src.ts"), path.join(root, "docs", "alias.ts"));
      expect(mirror.write(RW, "docs/alias.ts", bytesOf("via link\n"))).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("via link\n");
      expect(fs.lstatSync(path.join(root, "docs", "alias.ts")).isSymbolicLink()).toBe(true);
    });

    const NOT_FOUND = { ok: false, reason: "not-found" };

    for (const [label, rel] of REJECTED) {
      it(`not-found で何も変わらない: ${label}`, () => {
        const before = snapshot(base);
        expect(mirror.write(RW, rel, bytesOf("x"))).toEqual(NOT_FOUND);
        expect(snapshot(base)).toEqual(before);
      });
    }

    it("showme-ro はパスを問わず同じ readonly（関門より先にスキームで決まる）", () => {
      expect(mirror.write(RO, ".env", bytesOf("x"))).toEqual(
        mirror.write(RO, "src.ts", bytesOf("x")),
      );
      expect(mirror.write(RO, ".env.nope", bytesOf("x"))).toEqual({
        ok: false,
        reason: "readonly",
      });
    });

    it("上限を超える bytes は関門より先に too-large で、ファイルは変わらない", () => {
      const big = new Uint8Array(MAX_RESOLVE_BYTES + 1);
      expect(mirror.write(RW, "src.ts", big)).toEqual({ ok: false, reason: "too-large" });
      expect(mirror.write(RW, ".env", big)).toEqual({ ok: false, reason: "too-large" });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
    });

    const NOT_WRITABLE = { ok: false, reason: "not-writable" };

    it("ハードリンクを持つファイルには書かず not-writable（読むのは可）", () => {
      fs.linkSync(path.join(root, "src.ts"), path.join(root, "hard.ts"));
      expect(mirror.write(RW, "src.ts", bytesOf("x"))).toEqual(NOT_WRITABLE);
      expect(mirror.write(RW, "hard.ts", bytesOf("x"))).toEqual(NOT_WRITABLE);
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
      expect(mirror.read(RO, "hard.ts").ok).toBe(true);
    });

    it("ディスクの権限で書けないファイルは not-writable で、ファイルは変わらない", () => {
      // root は権限を無視して開けてしまうので、この検査は成り立たない
      if (process.getuid?.() === 0 || process.platform === "win32") return;
      fs.chmodSync(path.join(root, "src.ts"), 0o444);
      expect(mirror.write(RW, "src.ts", bytesOf("x"))).toEqual(NOT_WRITABLE);
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
    });

    it("秘匿の実体へのハードリンクは読めるものと同じ not-writable（関門の後の理由）", () => {
      // 関門は名前で判断する。秘匿でない名前のハードリンクは関門を通り read で読める
      // （中身は既に明かされている）ので、not-writable が新しく語ることは無い。
      fs.linkSync(path.join(root, ".env"), path.join(root, "docs", "env-alias.txt"));
      expect(mirror.read(RW, "docs/env-alias.txt").ok).toBe(true);
      expect(mirror.write(RW, "docs/env-alias.txt", bytesOf("x"))).toEqual(NOT_WRITABLE);
      expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(mirror.write(RW, ".env", bytesOf("x"))).toEqual(NOT_FOUND);
    });

    it("不在のファイルは not-found で、作らない", () => {
      expect(mirror.write(RW, "new.ts", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.existsSync(path.join(root, "new.ts"))).toBe(false);
      expect(mirror.write(RW, ".env.nope", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.existsSync(path.join(root, ".env.nope"))).toBe(false);
    });

    it(".env は not-found で、変わらない", () => {
      expect(mirror.write(RW, ".env", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    });

    it("秘匿を指すリンクは not-found で、実体は変わらない", () => {
      expect(mirror.write(RW, "docs/notes.md", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    });

    it("脱出リンク・脱出の綴りは not-found で、外のファイルは変わらない", () => {
      expect(mirror.write(RW, "escape.txt", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.readFileSync(path.join(outside, "secrets.txt"), "utf8")).toBe("outside\n");
      expect(mirror.write(RW, "../outside.txt", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.readFileSync(path.join(base, "outside.txt"), "utf8")).toBe("outside-top\n");
    });

    it("ディレクトリは not-found で、中は変わらない", () => {
      expect(mirror.write(RW, "docs", bytesOf("x"))).toEqual(NOT_FOUND);
      expect(fs.statSync(path.join(root, "docs")).isDirectory()).toBe(true);
    });
  });

  /**
   * 関門の判定と開く瞬間の間に差し替えられた場合（TOCTOU）。関門は realPath を
   * 返すので、正規の経路では realPath そのものがリンクであることはない。だから
   * 開く口 `openJudgedFile` を直接呼び、「判定した実体の stat」と「開くパス」を
   * わざとずらして渡す ―― 差し替えが起きた後の状態をそのまま作る、いちばん素直な形。
   */
  describe("openJudgedFile（判定した実体だけを開く）", () => {
    const RDWR = fs.constants.O_RDWR;

    it("判定した実体そのものは開ける", () => {
      const p = path.join(root, "src.ts");
      const r = openJudgedFile(p, fs.statSync(p, { bigint: true }), RDWR);
      if (!r.ok) throw new Error("expected ok");
      fs.closeSync(r.fd);
    });

    it("最後の要素がリンクに差し替わっていれば開かない（O_NOFOLLOW）", () => {
      if (process.platform === "win32") return;
      // リンク先は判定した実体と同じ inode。dev/ino の比較では見分けられないので、
      // これが落ちるのは O_NOFOLLOW が効いているときだけである。
      const target = path.join(root, "src.ts");
      const link = path.join(root, "swapped.ts");
      fs.symlinkSync(target, link);
      expect(openJudgedFile(link, fs.statSync(target, { bigint: true }), RDWR)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });

    it("別の実体に差し替わっていれば開かない（dev/ino の比較）", () => {
      // 親ディレクトリの差し替えは O_NOFOLLOW では防げない。開いた fd の inode が
      // 判定したものと違うことで落とす。
      const judged = fs.statSync(path.join(root, "src.ts"), { bigint: true });
      expect(openJudgedFile(path.join(outside, "secrets.txt"), judged, RDWR)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });

    it("FIFO に差し替わっていても止まらずに失敗する", () => {
      if (process.platform === "win32") return;
      const fifo = path.join(root, "pipe");
      execFileSync("mkfifo", [fifo]);
      const judged = fs.statSync(path.join(root, "src.ts"), { bigint: true });
      expect(openJudgedFile(fifo, judged, fs.constants.O_RDONLY)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });

    it("ディレクトリに差し替わっていれば not-found（EISDIR）", () => {
      const judged = fs.statSync(path.join(root, "src.ts"), { bigint: true });
      expect(openJudgedFile(path.join(root, "docs"), judged, RDWR)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });

    it("読み手のいない FIFO を書き込みで開いても not-found（ENXIO）", () => {
      if (process.platform === "win32") return;
      const fifo = path.join(root, "pipe-w");
      execFileSync("mkfifo", [fifo]);
      const judged = fs.statSync(path.join(root, "src.ts"), { bigint: true });
      expect(openJudgedFile(fifo, judged, fs.constants.O_WRONLY)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });

    it("判定の後に上限を超えて育っていれば開かない", () => {
      const p = path.join(root, "src.ts");
      const judged = fs.statSync(p, { bigint: true });
      fs.writeFileSync(p, "a".repeat(MAX_RESOLVE_BYTES + 1));
      expect(openJudgedFile(p, judged, RDWR)).toEqual({ ok: false, reason: "not-found" });
    });
  });

  describe("ルートが undefined", () => {
    it("read / stat / write はすべて失敗", () => {
      const m = new StageMirror(
        () => undefined,
        () => [],
      );
      expect(m.read(RO, "src.ts")).toEqual({ ok: false });
      expect(m.read(RO, "src.ts", "unsaved")).toEqual({ ok: false });
      expect(m.stat(RW, "src.ts")).toEqual({ ok: false });
      expect(m.write(RW, "src.ts", bytesOf("x"))).toEqual({ ok: false, reason: "not-found" });
      expect(fs.readFileSync(path.join(root, "src.ts"), "utf8")).toBe("const a = 1;\n");
    });

    it("ルートは毎回読む（後から変わりうる）", () => {
      const current: { root: string | undefined } = { root: undefined };
      const m = new StageMirror(
        () => current.root,
        () => [],
      );
      expect(m.read(RO, "src.ts")).toEqual({ ok: false });
      current.root = root;
      expect(m.read(RO, "src.ts").ok).toBe(true);
    });
  });
});
