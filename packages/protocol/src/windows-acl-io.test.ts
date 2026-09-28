import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type WindowsAclDeps,
  type WindowsAclIo,
  createWindowsAclIo,
  lockPrivateDir,
  parseIcaclsSave,
  parseWhoamiUser,
  prepareRuntimeDirWindows,
  readSddl,
  verifyRuntimeDirWindows,
} from "./windows-acl-io.js";
import { parseDacl } from "./windows-acl.js";

/** 実機（windows-latest、2026-09-28）で icacls /save がパイプに書いたもの。 */
const MEASURED_SAVE = "Temp\r\nD:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)\r\n";
const SELF = "S-1-5-21-3162555376-3447873500-144036907-1003";
const LOCKED_SELF = `D:PAI(A;OICI;FA;;;${SELF})(A;OICI;FA;;;SY)`;
const SHARED_PARENT =
  "D:AI(A;OICI;0x1301bf;;;BU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)";
const LOOSE_DIR = `D:AI(A;OICI;FA;;;${SELF})(A;OICIID;0x1200a9;;;BU)`;

const utf16 = (text: string): Buffer => Buffer.from(text, "utf16le");

describe("parseIcaclsSave（UTF-16LE の2行目が SDDL）", () => {
  it("実機の出力から2行目を取る", () => {
    expect(parseIcaclsSave(utf16(MEASURED_SAVE))).toBe(
      "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
    );
  });

  it("BOM・LF だけの改行でも読む", () => {
    expect(parseIcaclsSave(utf16("\ufeffx\nD:PAI(A;;FA;;;SY)\n"))).toBe("D:PAI(A;;FA;;;SY)");
  });

  it("空・1行だけ・2行目が空・奇数バイトは読めない（閉じる）", () => {
    expect(() => parseIcaclsSave(Buffer.alloc(0))).toThrow(/no output/);
    expect(() => parseIcaclsSave(utf16("Temp\r\n"))).toThrow();
    expect(() => parseIcaclsSave(utf16("Temp\r\n\r\n"))).toThrow();
    expect(() => parseIcaclsSave(Buffer.from([0x54, 0x00, 0x65]))).toThrow();
  });

  it("2つ以上のオブジェクトの出力は読まない（1つのパスを渡したはず）", () => {
    expect(() => parseIcaclsSave(utf16(`${MEASURED_SAVE}Other\r\nD:(A;;FA;;;WD)\r\n`))).toThrow();
  });
});

describe("parseWhoamiUser（whoami /user /fo csv /nh）", () => {
  it("SID を取る", () => {
    expect(parseWhoamiUser(Buffer.from(`"host\\runneradmin","${SELF}"\r\n`))).toBe(SELF);
  });

  it("ごみ・SID の形でない・複数行・欄が多いものは読めない", () => {
    expect(() => parseWhoamiUser(Buffer.from(""))).toThrow();
    expect(() => parseWhoamiUser(Buffer.from("garbage\r\n"))).toThrow();
    expect(() => parseWhoamiUser(Buffer.from('"host\\u","S-1-5-x"\r\n'))).toThrow();
    expect(() =>
      parseWhoamiUser(Buffer.from(`"host\\u","${SELF}"\r\n"host\\v","S-1-5-18"\r\n`)),
    ).toThrow();
    expect(() => parseWhoamiUser(Buffer.from(`"host\\u","${SELF}","S-1-5-18"\r\n`))).toThrow();
  });
});

// ---- 偽の spawn / パイプ ----

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeServer extends EventEmitter {
  listenedAt: string | undefined;
  closed = false;
  constructor(readonly onConnection: (socket: FakeSocket) => void) {
    super();
  }
  listen(pipePath: string, cb: () => void): void {
    this.listenedAt = pipePath;
    queueMicrotask(cb);
  }
  close(): void {
    this.closed = true;
  }
  /** icacls がつないで書いて閉じる。 */
  connectAndWrite(chunks: Buffer[]): FakeSocket {
    const socket = new FakeSocket();
    this.onConnection(socket);
    for (const c of chunks) socket.emit("data", c);
    socket.emit("end");
    return socket;
  }
  /** 誰かが読み取りだけで開き、何も書かない（Everyone は FR を持つ）。`end` 無しに閉じることもある。 */
  connectSilently(): FakeSocket {
    const socket = new FakeSocket();
    this.onConnection(socket);
    return socket;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Spawned {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

interface Harness {
  deps: Partial<WindowsAclDeps>;
  servers: FakeServer[];
  spawned: Spawned[];
}

/** `onSpawn` が「プロセスが何をするか」を演じる。 */
function harness(
  onSpawn: (s: Spawned, server: FakeServer | undefined) => void,
  env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" },
): Harness {
  const servers: FakeServer[] = [];
  const spawned: Spawned[] = [];
  const deps: Partial<WindowsAclDeps> = {
    env: () => env,
    randomHex: () => "0123456789abcdef",
    timeoutMs: 50,
    createServer: (onConnection) => {
      const server = new FakeServer(onConnection as (s: FakeSocket) => void);
      servers.push(server);
      return server;
    },
    spawn: (file, args, options) => {
      const child = new FakeChild();
      const s = { file, args, options: options as Record<string, unknown>, child };
      spawned.push(s);
      queueMicrotask(() => onSpawn(s, servers[servers.length - 1]));
      return child;
    },
  };
  return { deps, servers, spawned };
}

describe("readSddl（偽の icacls とパイプ）", () => {
  it("System32 の icacls を配列の引数で起動し、パイプの出力の2行目を返す", async () => {
    const h = harness((s, server) => {
      server?.connectAndWrite([utf16(MEASURED_SAVE)]);
      s.child.emit("close", 0, null);
    });
    const io = createWindowsAclIo(h.deps);
    await expect(io.readSddl("C:\\t\\x")).resolves.toBe(
      "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
    );
    const [s] = h.spawned;
    expect(s?.file).toBe("C:\\Windows\\System32\\icacls.exe");
    expect(s?.args).toEqual(["C:\\t\\x", "/save", "\\\\.\\pipe\\showme-acl-0123456789abcdef"]);
    expect(s?.options.shell).not.toBe(true);
    expect(s?.options.windowsHide).toBe(true);
    expect(h.servers[0]?.listenedAt).toBe("\\\\.\\pipe\\showme-acl-0123456789abcdef");
    expect(h.servers[0]?.closed).toBe(true);
  });

  it("出力が細切れでも、終了がパイプの終わりより先でも、両方そろってから返す", async () => {
    const h = harness((s, server) => {
      s.child.emit("close", 0, null);
      const bytes = utf16(MEASURED_SAVE);
      setTimeout(() => server?.connectAndWrite([bytes.subarray(0, 7), bytes.subarray(7)]), 5);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).resolves.toMatch(/^D:/);
  });

  it("終了コードが 0 でない（存在しないパス = 2、出力 0 バイト）なら断る", async () => {
    const h = harness((s) => s.child.emit("close", 2, null));
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\missing")).rejects.toThrow(/exit/);
    expect(h.servers[0]?.closed).toBe(true);
  });

  it("出力が来ずに終了コード 0 なら、時間切れで断る", async () => {
    const h = harness((s) => s.child.emit("close", 0, null));
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow();
  });

  it("起動の失敗は断る", async () => {
    const h = harness((s) => s.child.emit("error", new Error("spawn ENOENT")));
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow(/ENOENT/);
    expect(h.servers[0]?.closed).toBe(true);
  });

  it("何も書かずに閉じた接続は数えず、待たない（他人が読み取りで先につないでも読める）", async () => {
    const h = harness((s, server) => {
      const silent = server?.connectSilently();
      silent?.emit("end");
      silent?.emit("close");
      server?.connectAndWrite([utf16(MEASURED_SAVE)]);
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).resolves.toMatch(/^D:/);
  });

  it("開いたまま何も書かない接続も待たない。end 無しの close でも終わりとみなす", async () => {
    let held: FakeSocket | undefined;
    const h = harness((s, server) => {
      held = server?.connectSilently();
      const icacls = server?.connectSilently();
      icacls?.emit("data", utf16(MEASURED_SAVE));
      icacls?.emit("close");
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).resolves.toMatch(/^D:/);
    // 終わったら開いたままの接続も切る
    expect(held?.destroyed).toBe(true);
  });

  it("書いた接続が2つあれば断る（どちらが icacls か分からない）", async () => {
    const h = harness((s, server) => {
      server?.connectAndWrite([utf16("x\r\nD:(A;;FA;;;SY)\r\n")]);
      server?.connectAndWrite([utf16(MEASURED_SAVE)]);
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow(/connection/);
  });

  it("書いた接続が終わる前に別の接続が書いても断る", async () => {
    const h = harness((s, server) => {
      const a = server?.connectSilently();
      const b = server?.connectSilently();
      a?.emit("data", utf16("x\r\n"));
      b?.emit("data", utf16("y\r\n"));
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow(/connection/);
  });

  it("64 KiB を超える出力は断り、プロセスを止める", async () => {
    const h = harness((s, server) => {
      server?.connectAndWrite([Buffer.alloc(40 * 1024), Buffer.alloc(40 * 1024)]);
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow(/too large/);
    expect(h.spawned[0]?.child.killed).toBe(true);
  });

  it("時間切れは断り、プロセスを止め、サーバを閉じる", async () => {
    const h = harness(() => {
      // 何もしない（icacls が固まった）
    });
    await expect(createWindowsAclIo(h.deps).readSddl("C:\\t")).rejects.toThrow(/timed out/);
    expect(h.spawned[0]?.child.killed).toBe(true);
    expect(h.servers[0]?.closed).toBe(true);
  });

  it("SystemRoot が無い・絶対パスでない・UNC なら起動せずに断る（PATH からは探さない）", async () => {
    for (const env of [
      {},
      { SystemRoot: "Windows" },
      { SystemRoot: "\\\\host\\share\\Windows" },
      { SystemRoot: "" },
    ] as NodeJS.ProcessEnv[]) {
      const h = harness(() => {}, env);
      const io = createWindowsAclIo(h.deps);
      await expect(io.readSddl("C:\\t")).rejects.toThrow(/SystemRoot/);
      await expect(io.currentUserSid()).rejects.toThrow(/SystemRoot/);
      await expect(io.lockPrivateDir("C:\\t", SELF)).rejects.toThrow(/SystemRoot/);
      expect(h.spawned).toEqual([]);
    }
  });
});

const BAD_PATHS = [
  "\\\\host\\share\\dir",
  "\\\\?\\C:\\dir",
  "\\\\.\\C:\\dir",
  "C:dir",
  "\\run\\dir",
  "C:/dir",
  "relative\\dir",
  "",
];

describe("パスの形（ローカルのドライブの絶対パスだけ）", () => {
  it("readSddl / setOwner / lockPrivateDir は起動せずに断る", async () => {
    for (const bad of BAD_PATHS) {
      const h = harness((s) => s.child.emit("close", 0, null));
      const io = createWindowsAclIo(h.deps);
      await expect(io.readSddl(bad), bad).rejects.toThrow(/local drive/);
      await expect(io.setOwner(bad, SELF), bad).rejects.toThrow(/local drive/);
      await expect(io.lockPrivateDir(bad, SELF), bad).rejects.toThrow(/local drive/);
      expect(h.spawned, bad).toEqual([]);
    }
  });

  it("ふつうのドライブの絶対パス（空白・日本語を含む）は通る", async () => {
    for (const good of ["C:\\t", "d:\\a b\\テスト\\vscode-showme-0"]) {
      const h = harness((s) => s.child.emit("close", 0, null));
      await createWindowsAclIo(h.deps).setOwner(good, SELF);
      expect(h.spawned[0]?.args[0]).toBe(good);
    }
  });
});

describe("currentUserSid（whoami。覚える）", () => {
  it("System32 の whoami を起動して SID を返し、2回目は起動しない", async () => {
    const h = harness((s) => {
      s.child.stdout.emit("data", Buffer.from(`"host\\u","${SELF}"\r\n`));
      s.child.emit("close", 0, null);
    });
    const io = createWindowsAclIo(h.deps);
    await expect(io.currentUserSid()).resolves.toBe(SELF);
    await expect(io.currentUserSid()).resolves.toBe(SELF);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.file).toBe("C:\\Windows\\System32\\whoami.exe");
    expect(h.spawned[0]?.args).toEqual(["/user", "/fo", "csv", "/nh"]);
  });

  it("失敗は覚えない（次の呼び出しでやり直す）", async () => {
    let calls = 0;
    const h = harness((s) => {
      calls++;
      if (calls === 1) {
        s.child.emit("close", 1, null);
        return;
      }
      s.child.stdout.emit("data", Buffer.from(`"host\\u","${SELF}"\r\n`));
      s.child.emit("close", 0, null);
    });
    const io = createWindowsAclIo(h.deps);
    await expect(io.currentUserSid()).rejects.toThrow();
    await expect(io.currentUserSid()).resolves.toBe(SELF);
    expect(h.spawned).toHaveLength(2);
  });

  it("時間切れは断り、プロセスを止める", async () => {
    const h = harness(() => {});
    await expect(createWindowsAclIo(h.deps).currentUserSid()).rejects.toThrow(/timed out/);
    expect(h.spawned[0]?.child.killed).toBe(true);
  });

  it("64 KiB を超える出力は断り、プロセスを止める", async () => {
    const h = harness((s) => {
      s.child.stdout.emit("data", Buffer.alloc(40 * 1024));
      s.child.stdout.emit("data", Buffer.alloc(40 * 1024));
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).currentUserSid()).rejects.toThrow(/too large/);
    expect(h.spawned[0]?.child.killed).toBe(true);
  });

  it("ごみの出力は断る", async () => {
    const h = harness((s) => {
      s.child.stdout.emit("data", Buffer.from("INFO: nothing\r\n"));
      s.child.emit("close", 0, null);
    });
    await expect(createWindowsAclIo(h.deps).currentUserSid()).rejects.toThrow();
  });
});

describe("lockPrivateDir / setOwner", () => {
  it("所有者を本人にしてから、継承を切り、本人と SYSTEM だけに全部を許す", async () => {
    const h = harness((s) => s.child.emit("close", 0, null));
    await createWindowsAclIo(h.deps).lockPrivateDir("C:\\t\\d", SELF);
    expect(h.spawned.map((s) => s.file)).toEqual([
      "C:\\Windows\\System32\\icacls.exe",
      "C:\\Windows\\System32\\icacls.exe",
    ]);
    expect(h.spawned[0]?.args).toEqual(["C:\\t\\d", "/setowner", `*${SELF}`]);
    expect(h.spawned[1]?.args).toEqual([
      "C:\\t\\d",
      "/inheritance:r",
      "/grant:r",
      `*${SELF}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
    ]);
  });

  it("setOwner は所有者だけを変える", async () => {
    const h = harness((s) => s.child.emit("close", 0, null));
    await createWindowsAclIo(h.deps).setOwner("C:\\t\\d", SELF);
    expect(h.spawned.map((s) => s.args)).toEqual([["C:\\t\\d", "/setowner", `*${SELF}`]]);
  });

  it("終了コードが 0 でなければ断る（所有者の変更で落ちたら DACL に進まない）", async () => {
    const h = harness((s) => s.child.emit("close", 5, null));
    const io = createWindowsAclIo(h.deps);
    await expect(io.lockPrivateDir("C:\\t", SELF)).rejects.toThrow(/code 5/);
    expect(h.spawned).toHaveLength(1);
    await expect(io.setOwner("C:\\t", SELF)).rejects.toThrow(/code 5/);
  });

  it("SID の形でないものは起動せずに断る", async () => {
    const h = harness((s) => s.child.emit("close", 0, null));
    const io = createWindowsAclIo(h.deps);
    await expect(io.lockPrivateDir("C:\\t", "Everyone")).rejects.toThrow(/SID/);
    await expect(io.lockPrivateDir("C:\\t", `${SELF}:F *S-1-1-0`)).rejects.toThrow(/SID/);
    await expect(io.setOwner("C:\\t", "Everyone")).rejects.toThrow(/SID/);
    expect(h.spawned).toEqual([]);
  });
});

// ---- 判断の流れ（偽の I/O） ----

type Entry = "dir" | "file" | "link";

interface FakeIo extends WindowsAclIo {
  locked: string[];
  owned: string[];
  made: string[];
}

function fakeIo(
  entries: Record<string, Entry>,
  sddl: Record<string, string>,
  options: { mkdirEexist?: boolean; setOwnerFails?: boolean } = {},
): FakeIo {
  const locked: string[] = [];
  const owned: string[] = [];
  const made: string[] = [];
  const io: FakeIo = {
    locked,
    owned,
    made,
    readSddl: async (p) => {
      const s = sddl[p];
      if (s === undefined) throw new Error(`icacls exited with code 2 for ${p}`);
      return s;
    },
    currentUserSid: async () => SELF,
    lockPrivateDir: async (p, sid) => {
      expect(sid).toBe(SELF);
      locked.push(p);
      sddl[p] = LOCKED_SELF;
    },
    setOwner: async (p, sid) => {
      expect(sid).toBe(SELF);
      if (options.setOwnerFails) throw new Error(`icacls exited with code 5 for ${p}`);
      owned.push(p);
    },
    lstat: (p) => {
      const e = entries[p];
      if (e === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      return { isDirectory: () => e === "dir", isSymbolicLink: () => e === "link" };
    },
    mkdir: (p) => {
      if (options.mkdirEexist) {
        // 競争: 見たときは無く、作ろうとしたら在った
        entries[p] = "dir";
        sddl[p] = LOOSE_DIR;
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
      }
      made.push(p);
      entries[p] = "dir";
      sddl[p] = SHARED_PARENT; // 作った直後は親から継承した緩い DACL
    },
  };
  return io;
}

const PARENT = "C:\\Users\\me\\AppData\\Local\\Temp";
const DIR = `${PARENT}\\vscode-showme-0`;

describe("prepareRuntimeDirWindows（拡張）", () => {
  it("無ければ作って締め、ok", async () => {
    const io = fakeIo({ [PARENT]: "dir" }, { [PARENT]: LOCKED_SELF });
    await expect(prepareRuntimeDirWindows(DIR, io)).resolves.toEqual({ ok: true });
    expect(io.made).toEqual([DIR]);
    expect(io.locked).toEqual([DIR]);
    // 作ったものは lockPrivateDir が所有者ごと締める
    expect(io.owned).toEqual([]);
  });

  it("在るなら締め直さない。緩ければ断る（消さない）", async () => {
    const io = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOOSE_DIR },
    );
    const r = await prepareRuntimeDirWindows(DIR, io);
    expect(r.ok).toBe(false);
    expect(io.locked).toEqual([]);
    expect(io.made).toEqual([]);
  });

  it("在って締まっていれば、締め直さずに ok", async () => {
    const io = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOCKED_SELF },
    );
    await expect(prepareRuntimeDirWindows(DIR, io)).resolves.toEqual({ ok: true });
    expect(io.locked).toEqual([]);
    // DACL は変えないが、所有者は本人にする（所有者は暗黙に DACL を書き換えられる）
    expect(io.owned).toEqual([DIR]);
  });

  it("在るものの所有者を本人にできなければ断る", async () => {
    const io = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOCKED_SELF },
      { setOwnerFails: true },
    );
    const r = await prepareRuntimeDirWindows(DIR, io);
    expect(r.ok ? "" : r.reason).toMatch(/owner/);
    expect(io.locked).toEqual([]);
  });

  it("作る競争で EEXIST なら、在るものとして確かめる（締めない）", async () => {
    const io = fakeIo({ [PARENT]: "dir" }, { [PARENT]: LOCKED_SELF }, { mkdirEexist: true });
    const r = await prepareRuntimeDirWindows(DIR, io);
    expect(r.ok).toBe(false);
    expect(io.locked).toEqual([]);
    expect(io.owned).toEqual([DIR]);
  });

  it("親に他人が作れるなら、作らずに TEMP / TMP の理由で断る", async () => {
    const io = fakeIo({ [PARENT]: "dir" }, { [PARENT]: SHARED_PARENT });
    const r = await prepareRuntimeDirWindows(DIR, io);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/TEMP.*TMP.*only you can write/s);
    expect(io.made).toEqual([]);
  });

  it("親が無い・親が junction / symlink なら断る", async () => {
    const missing = fakeIo({}, {});
    expect((await prepareRuntimeDirWindows(DIR, missing)).ok).toBe(false);
    const link = fakeIo({ [PARENT]: "link" }, { [PARENT]: LOCKED_SELF });
    const r = await prepareRuntimeDirWindows(DIR, link);
    expect(r.ok ? "" : r.reason).toMatch(/symbolic link or junction/);
    expect(link.made).toEqual([]);
  });

  it("実行時ディレクトリが junction / symlink・ファイルなら断る", async () => {
    for (const kind of ["link", "file"] as const) {
      const io = fakeIo(
        { [PARENT]: "dir", [DIR]: kind },
        { [PARENT]: LOCKED_SELF, [DIR]: LOCKED_SELF },
      );
      const r = await prepareRuntimeDirWindows(DIR, io);
      expect(r.ok).toBe(false);
      expect(io.locked).toEqual([]);
      // junction の先の所有者を変えに行かない
      expect(io.owned).toEqual([]);
    }
  });

  it("SDDL が読めない・SID が取れないなら断る（例外を投げない）", async () => {
    const unreadable = fakeIo({ [PARENT]: "dir", [DIR]: "dir" }, { [PARENT]: LOCKED_SELF });
    expect((await prepareRuntimeDirWindows(DIR, unreadable)).ok).toBe(false);
    const noSid = fakeIo({ [PARENT]: "dir" }, { [PARENT]: LOCKED_SELF });
    noSid.currentUserSid = async () => {
      throw new Error("whoami failed");
    };
    const r = await prepareRuntimeDirWindows(DIR, noSid);
    expect(r.ok ? "" : r.reason).toMatch(/whoami failed/);
  });
});

describe("手順とパスの形", () => {
  it("ローカルのドライブの絶対パスでなければ、何にも触らずに断る（TEMP のせいにしない）", async () => {
    for (const bad of BAD_PATHS) {
      const io = fakeIo({}, {});
      const touched: string[] = [];
      io.lstat = (p) => {
        touched.push(p);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      };
      io.readSddl = async (p) => {
        touched.push(p);
        return LOCKED_SELF;
      };
      for (const r of [
        await prepareRuntimeDirWindows(bad, io),
        await verifyRuntimeDirWindows(bad, io),
      ]) {
        expect(r.ok, bad).toBe(false);
        const reason = r.ok ? "" : r.reason;
        expect(reason, bad).toMatch(/absolute path on a local drive/);
        expect(reason, bad).not.toMatch(/TEMP/);
      }
      expect(touched, bad).toEqual([]);
      expect(io.made, bad).toEqual([]);
    }
  });

  it("空白・日本語を含むドライブの絶対パスは通る", async () => {
    const parent = "C:\\Users\\me\\showme テスト x";
    const dir = `${parent}\\vscode-showme-0`;
    const io = fakeIo({ [parent]: "dir" }, { [parent]: LOCKED_SELF });
    await expect(prepareRuntimeDirWindows(dir, io)).resolves.toEqual({ ok: true });
  });
});

describe("verifyRuntimeDirWindows（拡張とブリッジが共有。読むだけ）", () => {
  it("締まっていれば ok", async () => {
    const io = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOCKED_SELF },
    );
    await expect(verifyRuntimeDirWindows(DIR, io)).resolves.toEqual({ ok: true });
    // 読むだけ（ブリッジの側）
    expect(io.owned).toEqual([]);
    expect(io.locked).toEqual([]);
  });

  it("無ければ作らずに断る", async () => {
    const io = fakeIo({ [PARENT]: "dir" }, { [PARENT]: LOCKED_SELF });
    expect((await verifyRuntimeDirWindows(DIR, io)).ok).toBe(false);
    expect(io.made).toEqual([]);
    expect(io.locked).toEqual([]);
  });

  it("親が共有・緩い・junction なら断る", async () => {
    const shared = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: SHARED_PARENT, [DIR]: LOCKED_SELF },
    );
    const r1 = await verifyRuntimeDirWindows(DIR, shared);
    expect(r1.ok ? "" : r1.reason).toMatch(/TEMP/);
    const loose = fakeIo(
      { [PARENT]: "dir", [DIR]: "dir" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOOSE_DIR },
    );
    expect((await verifyRuntimeDirWindows(DIR, loose)).ok).toBe(false);
    const link = fakeIo(
      { [PARENT]: "dir", [DIR]: "link" },
      { [PARENT]: LOCKED_SELF, [DIR]: LOCKED_SELF },
    );
    expect((await verifyRuntimeDirWindows(DIR, link)).ok).toBe(false);
  });
});

// ---- 本物（Windows だけ） ----

describe.runIf(process.platform === "win32")("本物の icacls / whoami（Windows）", () => {
  const made: string[] = [];
  const fresh = (prefix = "showme-acl-"): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of made.splice(0)) {
      // 締めたディレクトリも本人が全部を持つので消せる
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  const icacls = (...args: string[]): void => {
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
      args,
      {
        windowsHide: true,
      },
    );
  };

  /** 所有者の SID（検査でだけ PowerShell を使う。icacls /save は所有者を出さない）。 */
  const ownerOf = (dir: string): string => {
    const env: NodeJS.ProcessEnv = { ...process.env, SHOWME_ACL_TARGET: dir };
    // Node の親が PowerShell 7 だと、その PSModulePath が Windows PowerShell 5.1 を壊す
    for (const k of Object.keys(env)) if (k.toLowerCase() === "psmodulepath") delete env[k];
    return execFileSync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[IO.Directory]::GetAccessControl($env:SHOWME_ACL_TARGET).GetOwner([Security.Principal.SecurityIdentifier]).Value",
      ],
      { env, windowsHide: true, encoding: "utf8" },
    ).trim();
  };

  it("os.tmpdir() の SDDL は D: で始まる", async () => {
    await expect(readSddl(os.tmpdir())).resolves.toMatch(/^D:/);
  });

  it("存在しないパスは読めない（閉じる）", async () => {
    await expect(readSddl(path.join(fresh(), "missing"))).rejects.toThrow();
  });

  it("自分で締めた親の下に作って締めると ok、DACL は本人と SYSTEM だけ", async () => {
    const io = createWindowsAclIo();
    const sid = await io.currentUserSid();
    const parent = fresh();
    await lockPrivateDir(parent, sid);
    const dir = path.join(parent, "vscode-showme-0");
    await expect(prepareRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });
    await expect(verifyRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });

    const sddl = await readSddl(dir);
    expect(sddl.startsWith("D:P")).toBe(true);
    const dacl = parseDacl(sddl);
    const trusted = new Set([sid, "SY", "S-1-5-18"]);
    // RID 500 の本人は icacls が LA と書く
    if (sid.endsWith("-500")) trusted.add("LA");
    const sids = (dacl?.aces ?? []).map((a) => a?.sid);
    expect(sids.length).toBeGreaterThan(0);
    for (const s of sids) expect(trusted.has(s as string), `${s} in ${sddl}`).toBe(true);

    expect(ownerOf(dir)).toBe(sid);

    // 2回目は在るものとして確かめる（締め直さない）
    await expect(prepareRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });
  });

  it("在るディレクトリは DACL を変えずに所有者だけを本人にする", async () => {
    const io = createWindowsAclIo();
    const sid = await io.currentUserSid();
    const parent = fresh();
    await lockPrivateDir(parent, sid);
    const dir = path.join(parent, "vscode-showme-0");
    fs.mkdirSync(dir);
    await lockPrivateDir(dir, sid);
    // 所有者を Administrators に移しておく（runner は管理者なので移せる）
    icacls(dir, "/setowner", "*S-1-5-32-544");
    expect(ownerOf(dir)).toBe("S-1-5-32-544");
    const before = await readSddl(dir);
    await expect(prepareRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });
    expect(ownerOf(dir)).toBe(sid);
    expect(await readSddl(dir)).toBe(before);
  });

  it("Users に変更を許した親の下では、親の判定で断る", async () => {
    const parent = fresh();
    icacls(parent, "/grant", "*S-1-5-32-545:(OI)(CI)M");
    const dir = path.join(parent, "vscode-showme-0");
    const r = await prepareRuntimeDirWindows(dir);
    expect(r.ok ? "" : r.reason).toMatch(/TEMP/);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await verifyRuntimeDirWindows(dir)).ok).toBe(false);
  });

  it("junction の実行時ディレクトリは断る", async () => {
    const io = createWindowsAclIo();
    const sid = await io.currentUserSid();
    const parent = fresh();
    await lockPrivateDir(parent, sid);
    const target = path.join(parent, "target");
    fs.mkdirSync(target);
    await lockPrivateDir(target, sid);
    const junction = path.join(parent, "vscode-showme-0");
    // 所有者を本人以外にしておく（junction の先の所有者を変えに行けば、それが見える）
    icacls(target, "/setowner", "*S-1-5-32-544");
    const targetSddl = await readSddl(target);
    fs.symlinkSync(target, junction, "junction");
    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true);
    expect((await prepareRuntimeDirWindows(junction)).ok).toBe(false);
    expect((await verifyRuntimeDirWindows(junction)).ok).toBe(false);
    expect(await readSddl(target)).toBe(targetSddl);
    expect(ownerOf(target)).toBe("S-1-5-32-544");
  });

  it("空白と日本語を含む親の下でも作って締めて ok", async () => {
    const io = createWindowsAclIo();
    const sid = await io.currentUserSid();
    const parent = fresh("showme テスト ");
    await lockPrivateDir(parent, sid);
    const dir = path.join(parent, "vscode-showme-0");
    await expect(prepareRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });
    await expect(verifyRuntimeDirWindows(dir)).resolves.toEqual({ ok: true });
    expect(ownerOf(dir)).toBe(sid);
  });

  it("icacls より先に誰かがパイプを読み取りで開いて居座っても読める", async () => {
    let held: number | undefined;
    const io = createWindowsAclIo({
      // icacls を起動する直前に、同じパイプを読み取りだけで開く（Everyone が持つ FR と同じ）
      spawn: (file, args, options) => {
        held = fs.openSync(args[2] as string, "r");
        return childProcess.spawn(file, [...args], options);
      },
    });
    try {
      await expect(io.readSddl(os.tmpdir())).resolves.toMatch(/^D:/);
      expect(held).toBeTypeOf("number");
    } finally {
      if (held !== undefined) fs.closeSync(held);
    }
  });
});
