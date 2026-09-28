import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityUnverifiable } from "../src/file-identity.js";
import { readWorkspaceFile } from "../src/read-workspace-file.js";
import { RedactedLinkIndex, isLinkToRedacted } from "../src/redacted-links.js";
import { StageMirror, openJudgedFile, readAcceptedOutsideFile } from "../src/stage-mirror.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "../src/stage-uri.js";
import { acceptWorkspacePath } from "../src/workspace-path-gate.js";

/**
 * 実体の番号（ino）が 0 のファイルシステム（SMB など）では、dev / ino の一致で差し替えを見る検査が
 * 0 == 0 で何でも一致する。**番号が 0 なら開かない・受け入れない**（D107）。判定は
 * `identityUnverifiable` 1つで、秘匿ファイルへのハードリンクの照合（`redacted-links.ts`）と同じもの。
 *
 * 本物の SMB を CI で用意できないので、`node:fs` の stat の答えだけ番号を 0 に書き換える
 * （`vi.spyOn(fs, …)` は組み込みモジュールでは使えない。`server.test.ts` と同じく素通しで包む）。
 */
const zeroIno = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const zeroed = <T extends object>(st: T): T => {
    if (!zeroIno.on || st === undefined) return st;
    const copy = Object.create(Object.getPrototypeOf(st)) as T;
    Object.assign(copy, st);
    const ino = (st as { ino: unknown }).ino;
    (copy as { ino: unknown }).ino = typeof ino === "bigint" ? 0n : 0;
    return copy;
  };
  const wrapStat =
    <F extends (...a: never[]) => unknown>(fn: F) =>
    (...args: unknown[]) =>
      zeroed((fn as unknown as (...a: unknown[]) => object)(...args));
  const wrapped = {
    ...actual,
    statSync: wrapStat(actual.statSync),
    lstatSync: wrapStat(actual.lstatSync),
    fstatSync: wrapStat(actual.fstatSync),
  };
  return { ...wrapped, default: wrapped };
});

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  zeroIno.on = false;
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-ino0-")));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "a.txt"), "inside\n");
  fs.writeFileSync(path.join(outside, "b.txt"), "outside\n");
});
afterEach(() => {
  zeroIno.on = false;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("identityUnverifiable", () => {
  it("番号が 0 のときだけ真（bigint でも number でも）", () => {
    expect(identityUnverifiable({ ino: 0n })).toBe(true);
    expect(identityUnverifiable({ ino: 0 })).toBe(true);
    expect(identityUnverifiable({ ino: 1n })).toBe(false);
    expect(identityUnverifiable({ ino: 2n ** 63n })).toBe(false);
    expect(identityUnverifiable({ ino: 42 })).toBe(false);
  });

  it("秘匿ファイルへのハードリンクの照合も同じ判定（番号が 0 のリンクは閉じる側）", () => {
    const index = new RedactedLinkIndex();
    expect(isLinkToRedacted(index, root, { nlink: 2n, dev: 1n, ino: 0n }, [])).toBe(true);
  });
});

describe("番号が 0 のファイルシステム（D107）", () => {
  it("openJudgedFile: 判定した実体も開いた実体も番号 0 なら開かない（0 == 0 で一致させない）", () => {
    const p = path.join(root, "a.txt");
    const real = fs.statSync(p, { bigint: true });
    // 対照: 番号があれば開ける。
    const ok = openJudgedFile(p, real, fs.constants.O_RDONLY);
    if (!ok.ok) throw new Error("expected ok");
    fs.closeSync(ok.fd);

    zeroIno.on = true;
    const judged = fs.statSync(p, { bigint: true });
    expect(judged.ino).toBe(0n);
    expect(openJudgedFile(p, judged, fs.constants.O_RDONLY)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("関門: 外の実体の番号が 0 なら invalid-path（開く側で同一性を確かめられない）", () => {
    const abs = path.join(outside, "b.txt");
    const allow = { patterns: [], blockLinksToRedacted: true, allowOutsideWorkspace: true };
    const home = path.join(base, "home");
    expect(acceptWorkspacePath(root, abs, allow, { home }).ok).toBe(true);
    zeroIno.on = true;
    expect(acceptWorkspacePath(root, abs, allow, { home })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("外の読み: 関門の答えの番号が 0 なら読まない", () => {
    const realPath = path.join(outside, "b.txt");
    const st = fs.lstatSync(realPath, { bigint: true });
    expect(readAcceptedOutsideFile({ realPath, dev: String(st.dev), ino: String(st.ino) })).toBe(
      "outside\n",
    );
    zeroIno.on = true;
    expect(readAcceptedOutsideFile({ realPath, dev: String(st.dev), ino: "0" })).toBeUndefined();
  });

  it("関門: 中のファイルも番号が 0 なら invalid-path（映し・show_html の読み・解決器が同じ答え）", () => {
    const pol = { patterns: [], blockLinksToRedacted: true };
    expect(acceptWorkspacePath(root, "a.txt", pol).ok).toBe(true);
    expect(readWorkspaceFile(root, "a.txt", pol)).toBe("inside\n");
    zeroIno.on = true;
    expect(acceptWorkspacePath(root, "a.txt", pol)).toEqual({ ok: false, reason: "invalid-path" });
    expect(readWorkspaceFile(root, "a.txt", pol)).toBeUndefined();
    // ディレクトリは開いて読まない（同一性の照合が無い）。エクスプローラーの口は今までどおり。
    fs.mkdirSync(path.join(root, "d"));
    expect(acceptWorkspacePath(root, "d", pol).ok).toBe(true);
  });

  it("映し: 中のファイルでも番号が 0 なら読めない（形は他の失敗と同じ）", () => {
    const mirror = new StageMirror(
      () => root,
      () => ({ patterns: [], blockLinksToRedacted: true }),
    );
    expect(mirror.read(STAGE_SCHEME_READONLY, "a.txt").ok).toBe(true);
    expect(mirror.stat(STAGE_SCHEME_READONLY, "a.txt").ok).toBe(true);
    zeroIno.on = true;
    expect(mirror.read(STAGE_SCHEME_READONLY, "a.txt")).toEqual({ ok: false });
    expect(mirror.stat(STAGE_SCHEME_READONLY, "a.txt")).toEqual({ ok: false });
    expect(mirror.write(STAGE_SCHEME_EDITABLE, "a.txt", new TextEncoder().encode("x"))).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("inside\n");
  });
});
