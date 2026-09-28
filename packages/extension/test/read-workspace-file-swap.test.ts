import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentFile, readWorkspaceFile } from "../src/read-workspace-file.js";

/**
 * 関門が判定した後、読む前に実体を差し替えられた場合（TOCTOU）。中のファイルも、外と同じく
 * 「判定した実体だけを開く」口（`stage-mirror.ts`）で読む ―― パスで読み直すと、
 * - 秘匿ファイルへのリンクに差し替えられたとき、その中身が `show_html` に描かれ、解決器に渡る
 * - FIFO に差し替えられたとき、読み手の無い open で拡張のホストが止まる
 *
 * 差し替えは、関門の答えが出た**後**、読む側が実体を stat した**直後**（開く直前）に起こす。
 * 関門の入口を本物で包んで「答えが出た」ことを印し、`node:fs` の stat / lstat を素通しで包んで、
 * 印の後の最初の stat の直後に1回だけ差し替える（`vi.spyOn(fs, …)` は組み込みモジュールでは
 * 使えない）。判定は本物のまま、判定・読む側の確認のどちらの後にも差し替えが起きたことになる。
 */
const swap = vi.hoisted(() => ({
  armed: false,
  run: undefined as (() => void) | undefined,
}));
vi.mock("../src/workspace-path-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workspace-path-gate.js")>();
  return {
    ...actual,
    acceptWorkspacePath: (...args: Parameters<typeof actual.acceptWorkspacePath>) => {
      const verdict = actual.acceptWorkspacePath(...args);
      if (swap.run !== undefined) swap.armed = true;
      return verdict;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const afterStat =
    <F extends (...a: never[]) => unknown>(fn: F) =>
    (...args: unknown[]) => {
      const result = (fn as unknown as (...a: unknown[]) => unknown)(...args);
      if (swap.armed && swap.run !== undefined) {
        const run = swap.run;
        swap.run = undefined;
        swap.armed = false;
        run();
      }
      return result;
    };
  const wrapped = {
    ...actual,
    statSync: afterStat(actual.statSync),
    lstatSync: afterStat(actual.lstatSync),
  };
  return { ...wrapped, default: wrapped };
});

const pol = { patterns: [], blockLinksToRedacted: true };
let base: string;
let root: string;
let writer: ChildProcess | undefined;
beforeEach(() => {
  swap.run = undefined;
  swap.armed = false;
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-swap-")));
  root = path.join(base, "workspace");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "page.html"), "<p>ok</p>\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
});
afterEach(() => {
  swap.run = undefined;
  writer?.kill();
  writer = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

/** 関門が `page.html` を受け入れ、読む側がそれを stat した直後（開く前）に `replace` を走らせる。 */
function swapAfterJudge(replace: (p: string) => void): void {
  const p = path.join(root, "page.html");
  swap.run = () => replace(p);
}

describe("中のファイルは判定した実体だけを読む（差し替え）", () => {
  it("対照: 差し替えが無ければ読める（両方の口）", () => {
    expect(readWorkspaceFile(root, "page.html", pol)).toBe("<p>ok</p>\n");
    expect(readAgentFile(root, "page.html", pol)).toBe("<p>ok</p>\n");
  });

  it("秘匿ファイルへのリンクに差し替えられても、秘匿の中身を読まない", () => {
    if (process.platform === "win32") return; // ファイルのシンボリックリンクに権限が要る
    for (const read of [readWorkspaceFile, readAgentFile]) {
      fs.writeFileSync(path.join(root, "page.html"), "<p>ok</p>\n");
      swapAfterJudge((p) => {
        fs.rmSync(p);
        fs.symlinkSync(path.join(root, ".env"), p);
      });
      const got = read(root, "page.html", pol);
      expect(got, read.name).toBeUndefined();
      expect(fs.lstatSync(path.join(root, "page.html")).isSymbolicLink()).toBe(true);
      fs.rmSync(path.join(root, "page.html"));
    }
  });

  it("別の通常ファイルに差し替えられても読まない（dev / ino の照合）", () => {
    swapAfterJudge((p) => {
      // 先に別の名前で作ってから差し替える（消してから作ると、空いた inode 番号がそのまま
      // 使い回されうる。それは dev / ino では見分けられない ―― 別の実体ではなく「同じ番号」）。
      const staged = path.join(root, "staged.tmp");
      fs.copyFileSync(path.join(root, ".env"), staged);
      fs.renameSync(staged, p);
    });
    expect(readWorkspaceFile(root, "page.html", pol)).toBeUndefined();
  });

  it("FIFO に差し替えられても止まらずに読めない", () => {
    // Windows には mkfifo が無い（名前付きパイプはファイルの名前空間に作れない）。
    if (process.platform === "win32") return;
    swapAfterJudge((p) => {
      fs.rmSync(p);
      execFileSync("mkfifo", [p]);
      // 退行して読み手が止まる実装になったとき、検査ごと固まらないように、少し後で書き手が
      // 開いて閉じる（止まっていた読み手は空の中身を受け取り、undefined でないので落ちる）。
      writer = spawn("sh", ["-c", `sleep 3; : > '${p}'`], { stdio: "ignore" });
    });
    const started = Date.now();
    expect(readWorkspaceFile(root, "page.html", pol)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
