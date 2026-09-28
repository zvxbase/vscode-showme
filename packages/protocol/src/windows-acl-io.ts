import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { type AclVerdict, noForeignCreateVerdict, privateDirVerdict } from "./windows-acl.js";

/**
 * Windows の実行時ディレクトリの DACL を読む・締める I/O と、それを使う手順（D104）。
 *
 * 判定そのものは `windows-acl.ts` の純関数で、ここは「SDDL をどう手に入れるか」と「どの順に
 * 確かめるか」だけを持つ。**拡張とブリッジが同じ `verifyRuntimeDirWindows` を通す**（不変条件14）。
 *
 * Node は ACL を読めないので、`icacls /save` に SDDL を書かせる。書き先はファイルではなく自分で
 * listen した名前付きパイプにする ―― 一時ファイルを置く場所の安全さこそが確かめたいものなので、
 * 確かめる前にそこへ書くわけにいかない。
 *
 * 外部コマンドは `%SystemRoot%\System32\` の絶対パスで起動する。`PATH` からは探さない
 * （カレントディレクトリの `icacls.exe` を拾わない）。`shell` は使わず、引数は配列で渡す。
 * 読めない・時間切れ・終了コード非0は、どれも「安全でない」の側に倒す（閉じる側）。
 *
 * `icacls /save` は所有者を出さない。所有者は暗黙に DACL を書き換えられるので、拡張の側は
 * 実行時ディレクトリの所有者を本人にする（作ったものも在ったものも）。ブリッジの側は読むだけで、
 * 親に他人が作れないこと（`noForeignCreateVerdict`）で他人が所有者であることを防ぐ。
 */

/** パイプの接続（`net.Socket` の必要な部分）。 */
export interface PipeSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  destroy(): void;
}

/** パイプのサーバ（`net.Server` の必要な部分）。 */
export interface PipeServerLike {
  listen(pipePath: string, callback: () => void): unknown;
  close(): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** 子プロセス（`ChildProcess` の必要な部分）。 */
export interface ChildLike {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): boolean;
}

export interface SpawnOptionsLike {
  shell: false;
  windowsHide: true;
  stdio: ["ignore", "ignore" | "pipe", "ignore"];
}

/** 差し替えられる I/O。検査は偽物を渡す（Linux の上ではパイプに本当につなげない）。 */
export interface WindowsAclDeps {
  env: () => NodeJS.ProcessEnv;
  spawn: (file: string, args: readonly string[], options: SpawnOptionsLike) => ChildLike;
  createServer: (onConnection: (socket: PipeSocketLike) => void) => PipeServerLike;
  randomHex: () => string;
  /** 1回の外部コマンドの時間の上限。 */
  timeoutMs: number;
}

export interface StatLike {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** 手順が使う I/O。`createWindowsAclIo` が本物を作る。 */
export interface WindowsAclIo {
  readSddl(targetPath: string): Promise<string>;
  currentUserSid(): Promise<string>;
  /** 所有者を本人にしてから、継承を切り、本人と SYSTEM だけに全部を許す。 */
  lockPrivateDir(dir: string, sid: string): Promise<void>;
  /** 所有者だけを本人にする（DACL は変えない）。 */
  setOwner(dir: string, sid: string): Promise<void>;
  /** `fs.lstatSync`。Windows では junction も symlink も `isSymbolicLink()` が真。 */
  lstat(p: string): StatLike;
  /** `fs.mkdirSync`（再帰しない）。 */
  mkdir(p: string): void;
}

/** icacls の出力の上限。1つのオブジェクトの SDDL は数百バイトなので、超えたら何かがおかしい。 */
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const SID_STRING = /^S-1-\d+(?:-\d+)+$/;
const SYSTEM_SID = "S-1-5-18";

const defaultDeps: WindowsAclDeps = {
  env: () => process.env,
  spawn: (file, args, options) => childProcess.spawn(file, [...args], options),
  createServer: (onConnection) => net.createServer(onConnection),
  randomHex: () => randomBytes(8).toString("hex"),
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/**
 * ローカルのドライブの絶対パス（`C:\...`）。UNC（`\\host\...`）は SMB で外の機械に触れ、
 * `\\?\` / `\\.\` はデバイスの名前空間、`C:dir` はそのドライブの現在のディレクトリ、
 * `\dir` は現在のドライブに相対 ―― どれも「どこを確かめたか」が綴りから決まらない。
 */
const LOCAL_DRIVE_PATH = /^[A-Za-z]:\\/;

/** ローカルのドライブの絶対パスでなければ投げる。 */
function assertLocalDrivePath(p: string): void {
  if (!LOCAL_DRIVE_PATH.test(p)) {
    throw new Error(
      `${JSON.stringify(p)} must be an absolute path on a local drive (like C:\\...)`,
    );
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `%SystemRoot%\System32`。`SystemRoot` がドライブ文字から始まる絶対パスでなければ投げる
 * （無い・相対・UNC。UNC だと他の機械の実行ファイルを起動することになる）。
 */
function system32Dir(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot;
  if (root === undefined || !/^[A-Za-z]:\\/.test(root)) {
    throw new Error("SystemRoot is not set to an absolute local path; cannot locate System32");
  }
  return path.win32.join(root, "System32");
}

/**
 * `icacls <path> /save` の出力（UTF-16LE。1行目がオブジェクトの名前、2行目が SDDL）から SDDL を取る。
 * 渡すパスは1つなので、2つ以上のオブジェクトの出力は読まない。
 */
export function parseIcaclsSave(bytes: Buffer): string {
  if (bytes.length === 0) throw new Error("icacls wrote no output");
  if (bytes.length % 2 !== 0) throw new Error("icacls output is not UTF-16LE");
  let text = bytes.toString("utf16le");
  if (text.startsWith("\ufeff")) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 2) {
    throw new Error(`icacls output has ${lines.length} lines; expected an object name and an SDDL`);
  }
  const sddl = (lines[1] as string).trim();
  if (sddl.length === 0) throw new Error("icacls output has an empty SDDL line");
  return sddl;
}

/** `whoami /user /fo csv /nh` の出力（`"host\user","S-1-..."` の1行）から SID を取る。 */
export function parseWhoamiUser(bytes: Buffer): string {
  // 利用者名はコンソールのコードページで出る。SID は ASCII なので、名前の側は latin1 で素通しする。
  const lines = bytes
    .toString("latin1")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 1) throw new Error(`whoami printed ${lines.length} lines; expected 1`);
  const match = /^"[^"]*","([^"]*)"$/.exec(lines[0] as string);
  const sid = match?.[1];
  if (sid === undefined || !SID_STRING.test(sid)) {
    throw new Error("whoami did not print a user SID");
  }
  return sid;
}

/** 外部コマンドを起動し、終了コードと標準出力を返す（上限と時間切れつき）。 */
function run(
  deps: WindowsAclDeps,
  file: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let exited = false;
    let child: ChildLike | undefined;
    const finish = (err: Error | undefined, code: number | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== undefined) {
        if (child !== undefined && !exited) child.kill();
        reject(err);
      } else {
        resolve({ code, stdout: Buffer.concat(chunks) });
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`${path.win32.basename(file)} timed out`)),
      deps.timeoutMs,
    );
    try {
      child = deps.spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(message(err)));
      return;
    }
    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        finish(new Error(`${path.win32.basename(file)} output is too large`));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err) => finish(err));
    // `exit` は標準出力を読み切る前に来うる。`close` は読み切った後。
    child.on("close", (code) => {
      exited = true;
      finish(undefined, code);
    });
  });
}

/**
 * `icacls <target> /save \\.\pipe\showme-acl-<乱数>` の出力を自分のパイプで受け、SDDL を返す。
 * 返すのは「終了コード 0 で終わった」と「パイプの接続が閉じた」の両方がそろってから。
 */
function readSddlWith(deps: WindowsAclDeps, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let icacls: string;
    try {
      assertLocalDrivePath(target);
      icacls = path.win32.join(system32Dir(deps.env()), "icacls.exe");
    } catch (err) {
      reject(err);
      return;
    }
    const pipeName = `\\\\.\\pipe\\showme-acl-${deps.randomHex()}`;
    const chunks: Buffer[] = [];
    const sockets: PipeSocketLike[] = [];
    let size = 0;
    let writer: PipeSocketLike | undefined;
    let writerEnded = false;
    let exitCode: number | null | undefined;
    let child: ChildLike | undefined;
    let settled = false;

    const finish = (err: Error | undefined, sddl?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      for (const s of sockets) s.destroy();
      if (err !== undefined) {
        if (child !== undefined && exitCode === undefined) child.kill();
        reject(err);
      } else {
        resolve(sddl as string);
      }
    };
    const maybeDone = (): void => {
      if (exitCode === undefined) return;
      if (exitCode !== 0) {
        finish(new Error(`icacls exited with code ${exitCode} for ${target}`));
        return;
      }
      // 終了がパイプの終わりより先に届くことがある。書いた分を読み切ってから読む。
      if (!writerEnded) return;
      try {
        finish(undefined, parseIcaclsSave(Buffer.concat(chunks)));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(message(err)));
      }
    };

    const server = deps.createServer((socket) => {
      sockets.push(socket);
      // パイプは Everyone が読み取りで開ける（Node が決める DACL）。他の利用者が先につないで
      // 何も書かずに居座るだけで読めなくなると、拡張が起動できない。だから何も書かない接続は
      // 数えず、待たない。書いた接続はちょうど1つ（2つ書いたなら、どちらが icacls か分からない）。
      socket.on("data", (chunk) => {
        if (writer === undefined) writer = socket;
        else if (writer !== socket) {
          finish(new Error("more than one connection wrote to the icacls pipe"));
          return;
        }
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          finish(new Error("icacls output is too large"));
          return;
        }
        chunks.push(chunk);
      });
      const ended = (): void => {
        if (writer !== socket) return;
        writerEnded = true;
        maybeDone();
      };
      // `end` を出さずに `close` だけで閉じることもある。
      socket.on("end", ended);
      socket.on("close", ended);
      socket.on("error", (err) => {
        // 書いていない接続の失敗は、その接続が消えただけ。
        if (writer === socket) finish(err);
      });
    });
    const timer = setTimeout(() => finish(new Error("icacls timed out")), deps.timeoutMs);
    server.on("error", (err) => finish(err));
    server.listen(pipeName, () => {
      if (settled) return;
      try {
        child = deps.spawn(icacls, [target, "/save", pipeName], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(message(err)));
        return;
      }
      child.on("error", (err) => finish(err));
      child.on("close", (code) => {
        exitCode = code;
        maybeDone();
      });
    });
  });
}

/** 本物（または偽物の部品）で I/O を組む。本人の SID はこの組ごとに1回だけ取って覚える。 */
export function createWindowsAclIo(overrides: Partial<WindowsAclDeps> = {}): WindowsAclIo {
  const deps: WindowsAclDeps = { ...defaultDeps, ...overrides };
  let sidPromise: Promise<string> | undefined;

  const runIcacls = (args: readonly string[]) =>
    run(deps, path.win32.join(system32Dir(deps.env()), "icacls.exe"), args);

  /**
   * 所有者は DACL に書かれていなくても、暗黙に DACL を読み書きできる（READ_CONTROL と WRITE_DAC）。
   * `icacls /save` は所有者を出さないので、確かめる代わりに本人にしてしまう。
   */
  const setOwner = async (dir: string, sid: string): Promise<void> => {
    // 引数は配列で渡すので shell の解釈は無いが、icacls 自身が `*<sid>:<権利>` を読むので形を確かめる。
    if (!SID_STRING.test(sid)) throw new Error(`Not a valid SID string: ${sid}`);
    assertLocalDrivePath(dir);
    const { code } = await runIcacls([dir, "/setowner", `*${sid}`]);
    if (code !== 0) {
      throw new Error(`icacls exited with code ${code} while setting the owner of ${dir}`);
    }
  };

  return {
    readSddl: (targetPath) => readSddlWith(deps, targetPath),

    currentUserSid: () => {
      if (sidPromise === undefined) {
        const p = (async () => {
          const whoami = path.win32.join(system32Dir(deps.env()), "whoami.exe");
          const { code, stdout } = await run(deps, whoami, ["/user", "/fo", "csv", "/nh"]);
          if (code !== 0) throw new Error(`whoami exited with code ${code}`);
          return parseWhoamiUser(stdout);
        })();
        sidPromise = p;
        // 失敗は覚えない。一時的な失敗で、そのプロセスの間ずっと断り続けないように。
        p.catch(() => {
          if (sidPromise === p) sidPromise = undefined;
        });
      }
      return sidPromise;
    },

    lockPrivateDir: async (dir, sid) => {
      assertLocalDrivePath(dir);
      await setOwner(dir, sid);
      const { code } = await runIcacls([
        dir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        `*${SYSTEM_SID}:(OI)(CI)F`,
      ]);
      if (code !== 0) throw new Error(`icacls exited with code ${code} while locking ${dir}`);
    },

    setOwner,

    lstat: (p) => fs.lstatSync(p),
    mkdir: (p) => {
      fs.mkdirSync(p);
    },
  };
}

const defaultIo = createWindowsAclIo();

/** `icacls /save` で SDDL を読む（本物）。 */
export function readSddl(targetPath: string): Promise<string> {
  return defaultIo.readSddl(targetPath);
}

/** 本人の SID（本物。1プロセスで1回だけ取って覚える。失敗は覚えない）。 */
export function currentUserSid(): Promise<string> {
  return defaultIo.currentUserSid();
}

/** 所有者を本人にしてから、継承を切り、本人と SYSTEM だけに全部を許す（本物）。 */
export function lockPrivateDir(dir: string, sid: string): Promise<void> {
  return defaultIo.lockPrivateDir(dir, sid);
}

type Existing = StatLike | undefined;

/** 無ければ `undefined`。それ以外の失敗は投げる。 */
function lstatIfExists(io: WindowsAclIo, p: string): Existing {
  try {
    return io.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** 手順 1・2: 親が在り、reparse point でなく、他人がその中に作れないこと。 */
async function checkParent(io: WindowsAclIo, dir: string, sid: string): Promise<AclVerdict> {
  const parent = path.win32.dirname(dir);
  assertLocalDrivePath(parent);
  const st = lstatIfExists(io, parent);
  if (st === undefined) {
    return { ok: false, reason: `The parent directory ${parent} does not exist` };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      reason: `The parent directory ${parent} is a symbolic link or junction`,
    };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: `The parent directory ${parent} is not a directory` };
  }
  const verdict = noForeignCreateVerdict(await io.readSddl(parent), sid);
  if (!verdict.ok) {
    const advice =
      "TEMP/TMP points at a folder other users can write; point TEMP and TMP at a folder only you can write.";
    return {
      ok: false,
      reason: `Other users can create or replace entries in ${parent} (${verdict.reason}). ${advice}`,
    };
  }
  return { ok: true };
}

/** 手順 3 の後半・4: 実行時ディレクトリが本物のディレクトリで、本人と trusted だけが触れること。 */
async function checkDir(io: WindowsAclIo, dir: string, sid: string): Promise<AclVerdict> {
  const shape = await checkDirShape(io, dir);
  if (!shape.ok) return shape;
  const verdict = privateDirVerdict(await io.readSddl(dir), sid);
  if (!verdict.ok) {
    return { ok: false, reason: `The runtime directory ${dir} is not private: ${verdict.reason}` };
  }
  return { ok: true };
}

/** 実行時ディレクトリが在り、reparse point でないディレクトリであること。 */
async function checkDirShape(io: WindowsAclIo, dir: string): Promise<AclVerdict> {
  const st = lstatIfExists(io, dir);
  if (st === undefined) {
    return { ok: false, reason: `The runtime directory ${dir} does not exist` };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      reason: `The runtime directory ${dir} is a symbolic link or junction`,
    };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: `The runtime directory ${dir} is not a directory` };
  }
  return { ok: true };
}

/** 例外を「安全でない」に変える（呼び出し側は理由を出して断るだけにする）。 */
async function closedOnError(dir: string, step: () => Promise<AclVerdict>): Promise<AclVerdict> {
  // 形で落ちるのは TEMP の問題とは限らない（XDG_RUNTIME_DIR の綴りなど）。パスだけを名指す。
  if (!LOCAL_DRIVE_PATH.test(dir)) {
    return {
      ok: false,
      reason: `The runtime directory path ${JSON.stringify(dir)} must be an absolute path on a local drive (like C:\\...)`,
    };
  }
  try {
    return await step();
  } catch (err) {
    return { ok: false, reason: `Could not verify the runtime directory: ${message(err)}` };
  }
}

/**
 * 実行時ディレクトリが安全かを確かめる（読むだけ。作らない・締めない）。
 * 拡張とブリッジが同じこの関数を通す（不変条件14）。
 */
export function verifyRuntimeDirWindows(
  dir: string,
  io: WindowsAclIo = defaultIo,
): Promise<AclVerdict> {
  return closedOnError(dir, async () => {
    const sid = await io.currentUserSid();
    const parent = await checkParent(io, dir, sid);
    if (!parent.ok) return parent;
    return checkDir(io, dir, sid);
  });
}

/**
 * 拡張の側。親を確かめ、実行時ディレクトリが無ければ作って締め、確かめる。
 * **在るなら締め直さない**（POSIX と同じ ―― 緩いものを黙って直すと、緩いものを断る検査が
 * 無効になる）。何も消さない。
 */
export function prepareRuntimeDirWindows(
  dir: string,
  io: WindowsAclIo = defaultIo,
): Promise<AclVerdict> {
  return closedOnError(dir, async () => {
    const sid = await io.currentUserSid();
    const parent = await checkParent(io, dir, sid);
    if (!parent.ok) return parent;
    let created = false;
    if (lstatIfExists(io, dir) === undefined) {
      try {
        io.mkdir(dir);
        created = true;
      } catch (err) {
        // 見てから作るまでの間に誰かが作った。作ったのは自分ではないので、在るものとして確かめる。
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    if (created) {
      await io.lockPrivateDir(dir, sid);
    } else {
      // 在るものの DACL は変えない。reparse point の先の所有者を変えに行かないよう、先に形を確かめる。
      const shape = await checkDirShape(io, dir);
      if (!shape.ok) return shape;
      try {
        await io.setOwner(dir, sid);
      } catch (err) {
        return {
          ok: false,
          reason: `Could not make the current user the owner of the runtime directory ${dir}: ${message(err)}`,
        };
      }
    }
    return checkDir(io, dir, sid);
  });
}
