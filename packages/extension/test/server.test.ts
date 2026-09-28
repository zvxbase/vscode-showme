import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  HANDSHAKE_REFUSALS,
  MAX_HANDSHAKE_LINE_BYTES,
  MAX_HTML_CHARS,
  MAX_WIRE_LINE_BYTES,
  WIRE_PROTOCOL_VERSION,
  type WindowsAclIo,
  clientProofLine,
  currentUserSid,
  helloLine,
  lockPrivateDir,
  newHandshakeNonce,
  parseServerProofLine,
  privateDirVerdict,
  readSddl,
  socketPathLength,
  verifyServerProof,
} from "@zvx/vscode-showme-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ANSWERED_LINGER_MS,
  type ConnectionObserver,
  SECOND_CONNECTION_REASON,
  ShowMeSocketServer,
  ToolError,
  cleanStaleRegistrations,
  prepareRuntimeDir,
  prepareRuntimeDirPosix,
  writeRegistrationFile,
} from "../src/server.js";
import { WindowRoleState } from "../src/window-role-state.js";

/**
 * `node:fs` を素通しで包み、writeFileSync だけを任意に失敗させられるようにする。
 *
 * `vi.spyOn(fs, ...)` は node の組み込みモジュールでは "Cannot redefine property"
 * になる（実測）。start() が listen に成功したあとで失敗する経路は、こうして
 * 注入しないと単体では作れない。既定は素通しなので、他のテストの振る舞いは変わらない。
 */
const writeHook = vi.hoisted(() => ({
  fail: undefined as ((file: unknown, data: unknown) => never) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (writeHook.fail !== undefined) writeHook.fail(args[0], args[1]);
      return actual.writeFileSync(...args);
    },
  };
});

const onWindows = process.platform === "win32";

/**
 * 一時ディレクトリを作る親。
 *
 * - Windows: 自分で作って締めた（本人と SYSTEM だけの）フォルダ。実行時ディレクトリの親は
 *   「他人が中に作れない」ことを確かめられる（D104）ので、ランナーの `TEMP` の ACL に結果を
 *   預けない
 * - macOS: `/tmp` の下の短い名前。`$TMPDIR`（`/var/folders/…`）の下では、ソケットのパスが
 *   `sun_path` の上限（104 バイト）を超えうる（D108）
 * - Linux: 今までどおり `os.tmpdir()`
 */
let testBase: string | undefined;
beforeAll(async () => {
  if (onWindows) {
    testBase = fs.mkdtempSync(path.join(os.tmpdir(), "sx-"));
    await lockPrivateDir(testBase, await currentUserSid());
  } else if (process.platform === "darwin") {
    testBase = fs.mkdtempSync("/tmp/sx-");
  }
});
afterAll(() => {
  if (testBase !== undefined) fs.rmSync(testBase, { recursive: true, force: true });
});

const made: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(testBase ?? os.tmpdir(), "showme-test-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 登録ファイルの第一候補（＝ソケットを置いたディレクトリの分）。
 *
 * `registryPaths` は候補ごとに1つある（設計書 §2A.6）。候補を1つしか
 * 渡していないテストは、そのまま先頭を見ればよい。
 */
function registryOf(info: { registryPaths: readonly string[] }): string {
  const first = info.registryPaths[0];
  expect(first, "登録ファイルが1つも書かれていない").toBeTruthy();
  return String(first);
}

/**
 * 実機（windows-latest）で測った形の SDDL（`packages/protocol` の検査と同じもの）。既定の
 * `%TEMP%` は本人・SYSTEM・Administrators だけ（ランナーは RID 500 なので本人が `LA` で出るが、
 * ここの本人はふつうの利用者なので SID で書く）。
 */
const WIN_SELF = "S-1-5-21-3162555376-3447873500-144036907-1003";
const WIN_DEFAULT_TEMP = `D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${WIN_SELF})`;
const WIN_SHARED_PARENT =
  "D:AI(A;OICI;0x1301bf;;;BU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)";
const WIN_LOCKED_SELF = `D:PAI(A;OICI;FA;;;${WIN_SELF})(A;OICI;FA;;;SY)`;

/** 偽の Windows の I/O。呼ばれた順を記録し、ディスクには触らない。 */
function fakeWindowsIo(parentSddl: string): { io: WindowsAclIo; calls: string[] } {
  const calls: string[] = [];
  const existing = new Set<string>(["C:\\Users\\u\\AppData\\Local\\Temp"]);
  const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
  const io: WindowsAclIo = {
    currentUserSid: async () => WIN_SELF,
    readSddl: async (p) => {
      calls.push(`readSddl ${p}`);
      return p === "C:\\Users\\u\\AppData\\Local\\Temp" ? parentSddl : WIN_LOCKED_SELF;
    },
    lockPrivateDir: async (p) => {
      calls.push(`lock ${p}`);
    },
    setOwner: async (p) => {
      calls.push(`setOwner ${p}`);
    },
    lstat: (p) => {
      if (!existing.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return dirStat;
    },
    mkdir: (p) => {
      calls.push(`mkdir ${p}`);
      existing.add(p);
    },
  };
  return { io, calls };
}

describe("prepareRuntimeDir: OS ごとの手順に分ける（D104）", () => {
  const winDir = "C:\\Users\\u\\AppData\\Local\\Temp\\vscode-showme-0";

  it("win32 なら ACL の手順（親を確かめ、作って締め、確かめる）を通す", async () => {
    const { io, calls } = fakeWindowsIo(WIN_DEFAULT_TEMP);
    await expect(prepareRuntimeDir(winDir, "win32", io)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "readSddl C:\\Users\\u\\AppData\\Local\\Temp",
      `mkdir ${winDir}`,
      `lock ${winDir}`,
      `readSddl ${winDir}`,
    ]);
  });

  it("win32 で親を他人が書けるなら、TEMP を向け直すよう理由を返して断る（作らない）", async () => {
    const { io, calls } = fakeWindowsIo(WIN_SHARED_PARENT);
    const r = await prepareRuntimeDir(winDir, "win32", io);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("TEMP");
    expect(calls.some((c) => c.startsWith("mkdir"))).toBe(false);
  });

  it.skipIf(onWindows)(
    "win32 以外では ACL の I/O に触らず、POSIX の手順（0700）を通す",
    async () => {
      const { io, calls } = fakeWindowsIo(WIN_DEFAULT_TEMP);
      const dir = path.join(tmpRoot(), "vscode-showme-1000");
      await expect(prepareRuntimeDir(dir, process.platform, io)).resolves.toEqual({ ok: true });
      expect(calls).toEqual([]);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    },
  );
});

describe.runIf(onWindows)("本物の Windows で立つ（D104 / D105）", () => {
  it("start() が名前付きパイプで立ち、登録ファイルを置き、実行時ディレクトリは本人と SYSTEM だけ", async () => {
    const dir = path.join(tmpRoot(), "vscode-showme-0");
    const server = new ShowMeSocketServer([dir], async () => ({ hello: "world" }));
    const info = await server.start();
    try {
      expect(info.socketPath).toMatch(/^\\\\\.\\pipe\\vscode-showme-[0-9a-f]{16}$/);
      expect(fs.existsSync(registryOf(info))).toBe(true);
      expect(path.dirname(registryOf(info))).toBe(dir);
      const verdict = privateDirVerdict(await readSddl(dir), await currentUserSid());
      expect(verdict).toEqual({ ok: true });
      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.ok).toBe(true);
    } finally {
      await server.stop();
    }
    expect(fs.existsSync(registryOf(info))).toBe(false);
  });

  it("親から他人の読み取りが継承されてくる場所でも、作ったディレクトリからは継承を切って私的にする", async () => {
    // ドライブの根の既定（Users の読み取りと CREATOR OWNER が継承される）を写す。読み取りだけなので
    // 親の判定は通る。作った実行時ディレクトリに継承された Users の許可が残れば、トークンが読める。
    const parent = tmpRoot();
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
      [parent, "/grant", "*S-1-5-32-545:(OI)(CI)RX", "*S-1-3-0:(OI)(CI)(IO)F"],
      { windowsHide: true },
    );
    const dir = path.join(parent, "vscode-showme-0");
    const r = await prepareRuntimeDir(dir);
    const sddl = await readSddl(dir);
    expect(r, sddl).toEqual({ ok: true });
    expect(privateDirVerdict(sddl, await currentUserSid()), sddl).toEqual({ ok: true });
  });
});

/** POSIX の手順（所有者と 0700）。Windows の `fs.stat` は ACL を映さないので、そこでは走らせない。 */
describe.skipIf(onWindows)("prepareRuntimeDirPosix", () => {
  it("0700 のディレクトリを作る", () => {
    const dir = path.join(tmpRoot(), "vscode-showme-1000");
    const r = prepareRuntimeDirPosix(dir);
    expect(r.ok).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("既にある 0700 の自分のディレクトリは再利用する", () => {
    const dir = path.join(tmpRoot(), "vscode-showme-1000");
    fs.mkdirSync(dir, { mode: 0o700 });
    expect(prepareRuntimeDirPosix(dir).ok).toBe(true);
  });

  it("シンボリックリンクだったら拒否し、消さない", () => {
    const root = tmpRoot();
    const victim = path.join(root, "victim");
    fs.mkdirSync(victim);
    const dir = path.join(root, "vscode-showme-1000");
    fs.symlinkSync(victim, dir);

    const r = prepareRuntimeDirPosix(dir);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("symlink");
    // 攻撃者の仕掛けも、その先も消さない
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
  });

  it("権限が緩いディレクトリを拒否する", () => {
    const dir = path.join(tmpRoot(), "vscode-showme-1000");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chmodSync(dir, 0o777);
    const r = prepareRuntimeDirPosix(dir);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("mode");
  });
});

describe("cleanStaleRegistrations", () => {
  function registration(dir: string, name: string, pid: number): string {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        protocolVersion: 1,
        workspacePath: "/w",
        pid,
        startedAt: new Date().toISOString(),
        socketPath: path.join(dir, `${name.replace(/\.json$/, "")}.sock`),
        authToken: "0".repeat(64),
      }),
      { mode: 0o600 },
    );
    return file;
  }

  it("死んだプロセスの登録ファイルとソケットを消す", () => {
    const dir = tmpRoot();
    const reg = registration(dir, `${"a".repeat(16)}.json`, 4242);
    const sock = path.join(dir, `${"a".repeat(16)}.sock`);
    fs.writeFileSync(sock, "");

    cleanStaleRegistrations(dir, () => false);

    expect(fs.existsSync(reg)).toBe(false);
    // Windows のソケットは名前付きパイプでディレクトリに残らないので、同じ名前のファイルは
    // ソケットではない ―― 消さない（`socketPathFor` が作る名前だけを消す）。
    expect(fs.existsSync(sock)).toBe(onWindows);
  });

  it("作る関数が作りえない名前（16桁の小文字 hex でない）は、pid が死んでいても触らない", () => {
    const dir = tmpRoot();
    const short = registration(dir, "abc.json", 4242);
    const upper = registration(dir, `${"E".repeat(16)}.json`, 4242);
    cleanStaleRegistrations(dir, () => false);
    expect(fs.existsSync(short)).toBe(true);
    expect(fs.existsSync(upper)).toBe(true);
  });

  it("生きているプロセスの登録ファイルは残す", () => {
    const dir = tmpRoot();
    const reg = registration(dir, `${"b".repeat(16)}.json`, process.pid);
    cleanStaleRegistrations(dir, () => true);
    expect(fs.existsSync(reg)).toBe(true);
  });

  it("既定の生死判定は、自分の pid を生きていると見なす", () => {
    const dir = tmpRoot();
    const alive = registration(dir, `${"c".repeat(16)}.json`, process.pid);
    const dead = registration(dir, `${"d".repeat(16)}.json`, 0x7fffffff);
    cleanStaleRegistrations(dir);
    expect(fs.existsSync(alive)).toBe(true);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it("シンボリックリンクは辿らず、消さない（無検査 unlink は任意ファイル削除・D23）", () => {
    const dir = tmpRoot();
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "secret");
    const link = path.join(dir, `${"e".repeat(16)}.json`);
    fs.symlinkSync(victim, link);

    cleanStaleRegistrations(dir, () => false);

    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("登録ファイルの名前でないものには触らない（ディレクトリ横断もしない）", () => {
    const dir = tmpRoot();
    const other = path.join(dir, "notes.txt");
    // 中身は**掃除の条件を全部満たす**ものにする。非 JSON にすると pid 検査で
    // 先に落ちるので、名前フィルタを外しても緑のままになり、この検査は名前を
    // 騙るだけで何も判別しない（実測でそうなっていた）。
    fs.writeFileSync(other, JSON.stringify({ pid: 4242 }));
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    const nested = path.join(sub, `${"f".repeat(16)}.json`);
    fs.writeFileSync(nested, JSON.stringify({ pid: 4242 }));

    cleanStaleRegistrations(dir, () => false);

    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(sub)).toBe(true);
  });

  it("pid が読めない登録ファイルは消さない（判断できないものは残す）", () => {
    const dir = tmpRoot();
    const broken = path.join(dir, `${"0".repeat(16)}.json`);
    fs.writeFileSync(broken, "not json");
    const noPid = path.join(dir, `${"1".repeat(16)}.json`);
    fs.writeFileSync(noPid, JSON.stringify({ socketPath: "/tmp/x.sock" }));

    cleanStaleRegistrations(dir, () => false);

    expect(fs.existsSync(broken)).toBe(true);
    expect(fs.existsSync(noPid)).toBe(true);
  });

  it("pid 0 を生死判定に渡さない（kill(0) はプロセスグループに飛ぶ）", () => {
    const dir = tmpRoot();
    const zero = path.join(dir, `${"2".repeat(16)}.json`);
    fs.writeFileSync(zero, JSON.stringify({ pid: 0 }));
    const asked: number[] = [];

    cleanStaleRegistrations(dir, (pid) => {
      asked.push(pid);
      return false;
    });

    expect(asked).toEqual([]);
    expect(fs.existsSync(zero)).toBe(true);
  });
});

describe("ShowMeSocketServer", () => {
  it("正しいトークンなら受け付ける", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({ hello: "world" }));
    const info = await server.start();
    try {
      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("パスを知っていてもトークンが違えば拒否する", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      await expect(
        callSocket(info.socketPath, "0".repeat(64), { id: "1", tool: "list_workspaces", args: {} }),
      ).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("ソケットファイルは 0600 である", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      if (process.platform !== "win32") {
        expect(fs.statSync(info.socketPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await server.stop();
    }
  });

  it("登録ファイルにトークンが入り、ソケット名には入らない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      const reg = JSON.parse(fs.readFileSync(registryOf(info), "utf8"));
      expect(reg.authToken).toBe(info.token);
      // パス名からトークンが割り出せないこと
      expect(path.basename(info.socketPath)).not.toContain(info.token);
    } finally {
      await server.stop();
    }
  });

  it("登録ファイルに windowId と役割が載る（既定は預けていない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      const reg = JSON.parse(fs.readFileSync(registryOf(info), "utf8"));
      expect(typeof reg.windowId).toBe("string");
      expect(String(reg.windowId).length).toBeGreaterThan(0);
      // 役割を渡さない呼び出しは「預けていない」に倒す。既定が stage だと、
      // 配線し忘れた窓がブリッジから選ばれてしまう。
      expect(reg.role).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  it("渡した windowId と、そのときの役割を書く", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "window-under-test",
      role: () => "stage",
    });
    const info = await server.start();
    try {
      const reg = JSON.parse(fs.readFileSync(registryOf(info), "utf8"));
      expect(reg.windowId).toBe("window-under-test");
      expect(reg.role).toBe("stage");
    } finally {
      await server.stop();
    }
  });

  it("役割が変わったら登録ファイルを書き直す（メモリだけ変わると、ブリッジは永久に見つけられない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    let role: "stage" | "idle" = "idle";
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => role,
    });
    const info = await server.start();
    try {
      expect(JSON.parse(fs.readFileSync(registryOf(info), "utf8")).role).toBe("idle");

      role = "stage";
      // 書き直さなければ、人間が預けたのにファイルは idle のままになる。
      server.refreshRegistration();
      expect(JSON.parse(fs.readFileSync(registryOf(info), "utf8")).role).toBe("stage");

      role = "idle";
      server.refreshRegistration();
      expect(JSON.parse(fs.readFileSync(registryOf(info), "utf8")).role).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  it("書き直しても、他の項目は動かない（トークンで繋いでいる相手を切らない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    let role: "stage" | "idle" = "idle";
    const server = new ShowMeSocketServer([dir], async () => ({}), "/ws", undefined, {
      windowId: "w1",
      role: () => role,
    });
    const info = await server.start();
    try {
      const before = JSON.parse(fs.readFileSync(registryOf(info), "utf8"));
      role = "stage";
      server.refreshRegistration();
      const after = JSON.parse(fs.readFileSync(registryOf(info), "utf8"));

      expect(after.authToken).toBe(before.authToken);
      expect(after.socketPath).toBe(before.socketPath);
      expect(after.pid).toBe(before.pid);
      expect(after.workspacePath).toBe(before.workspacePath);
      expect(after.protocolVersion).toBe(before.protocolVersion);
      // 起動時刻は「この窓がいつ立ったか」なので、役割を変えるたびに若返らない。
      expect(after.startedAt).toBe(before.startedAt);
    } finally {
      await server.stop();
    }
  });

  it("書き直した後もモードは 0600 のまま（他人に authToken を読ませない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => "stage",
    });
    const info = await server.start();
    try {
      server.refreshRegistration();
      if (process.platform !== "win32") {
        expect(fs.statSync(registryOf(info)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await server.stop();
    }
  });

  it("止めた後の書き直しは登録ファイルを作り直さない（死んだ窓の登録を残さない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => "stage",
    });
    const info = await server.start();
    await server.stop();
    server.refreshRegistration();
    expect(fs.existsSync(registryOf(info))).toBe(false);
  });

  it("start していない間の書き直しは何もしない（start が現在の役割を書く）", () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => "stage",
    });
    // 投げないこと。activate の途中（listen 前）に人間が預けても、start が
    // そのときの役割を書くので、ここで失敗として扱う理由が無い。
    expect(() => server.refreshRegistration()).not.toThrow();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("役割の読み出しが失敗したら預けていない側に倒す", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => {
        throw new Error("役割が読めない");
      },
    });
    const info = await server.start();
    try {
      expect(JSON.parse(fs.readFileSync(registryOf(info), "utf8")).role).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  it("接続を受けたら観測者に伝える（可視化は要件。設計書 §3.5 / D21）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    try {
      await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(events.accepted.length).toBe(1);
      expect(events.rejected).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("接続が切れたら観測者に伝える（伝えないと繋がったままに見える）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    try {
      await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      await vi.waitFor(() => expect(events.disconnected).toEqual([0]));
    } finally {
      await server.stop();
    }
  });

  it("トークンが違う接続は accepted に数えず、切断も通知しない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    try {
      await expect(
        callSocket(info.socketPath, "0".repeat(64), { id: "1", tool: "list_workspaces", args: {} }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(events.rejected).toContain("bad token"));
      expect(events.accepted).toEqual([]);
      expect(events.disconnected).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("start は死んだウィンドウの登録ファイルを掃除する（設計書 §6.2）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    fs.mkdirSync(dir, { mode: 0o700 });
    const stale = path.join(dir, `${"9".repeat(16)}.json`);
    fs.writeFileSync(stale, JSON.stringify({ pid: 0x7fffffff, socketPath: "/tmp/dead.sock" }));

    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      // 掃除しないと、生きているウィンドウが1つでも候補が2つに見え、
      // ブリッジは「ウィンドウが見つかりません」と答えてしまう。
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(registryOf(info))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("listen 後の失敗で、立てたソケットと listen 中のサーバを残さない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    let socketPath = "";
    writeHook.fail = (_file, data) => {
      socketPath = (JSON.parse(String(data)) as { socketPath: string }).socketPath;
      throw new Error("boom: registry write failed");
    };
    try {
      const server = new ShowMeSocketServer([dir], async () => ({}));
      await expect(server.start()).rejects.toThrow("boom");
      expect(socketPath).not.toBe("");
      // 立てたソケットファイルが残ると、次の起動で候補が増え、掃除もできない
      // （this.info が未設定なので stop() は回収できない）。
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
      await expect(connectTo(socketPath)).rejects.toThrow();
    } finally {
      writeHook.fail = undefined;
    }
  });

  it("ToolError のコードを線に載せる（停止中に internal と答えない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => {
      throw new ToolError("disabled", "ShowMe は停止中です");
    });
    const info = await server.start();
    try {
      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("disabled");
      expect(res.error?.message).toBe("ShowMe は停止中です");
    } finally {
      await server.stop();
    }
  });

  it("コードの無い例外は internal のままにする", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => {
      throw new Error("なにか壊れた");
    });
    const info = await server.start();
    try {
      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.error?.code).toBe("internal");
    } finally {
      await server.stop();
    }
  });

  it("接続が生きていても stop() は終わる（deactivate を止めない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    const held = net.createConnection(info.socketPath);
    try {
      await authenticate(held, info.token);
      await vi.waitFor(() => expect(events.accepted.length).toBe(1));

      // net.Server.close() は最後の接続が閉じるまで完了しない。切らずに待つと
      // deactivate() が終わらない（シャットダウンが止まる）。
      await Promise.race([
        server.stop(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("stop() did not finish")), 2000),
        ),
      ]);
      expect(fs.existsSync(registryOf(info))).toBe(false);
    } finally {
      held.destroy();
    }
  });

  it("2本目の同時接続は本当に拒否する（受理したまま拒否と報告しない）", async () => {
    // 「拒否した」とログに出しながら接続を生かしておくと、可視化が事実と
    // 逆を言う。可視化がこの道具の防御である以上（設計書 §3.5 / §5.3 / D21）、
    // そこが嘘をつくのは最も高くつく。
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const handled: string[] = [];
    const server = new ShowMeSocketServer(
      [dir],
      async (req) => {
        handled.push(req.id);
        return {};
      },
      "",
      events.observer,
    );
    const info = await server.start();
    const held = net.createConnection(info.socketPath);
    try {
      await authenticate(held, info.token);
      await vi.waitFor(() => expect(events.accepted.length).toBe(1));

      await expect(
        callSocket(info.socketPath, info.token, { id: "2", tool: "list_workspaces", args: {} }),
      ).rejects.toThrow();

      await vi.waitFor(() => expect(events.rejected).toContain(SECOND_CONNECTION_REASON));
      // 2本目の要求は一度も実行されない。ここが「本当に拒否した」の証拠。
      expect(handled).toEqual([]);
      // 拒否した接続は認証済みとして数えない（数えると切断通知もずれる）。
      expect(events.accepted.length).toBe(1);
      expect(events.disconnected).toEqual([]);
    } finally {
      held.destroy();
      await server.stop();
    }
  });

  it("答えを返した接続はサーバが閉じて枠を返す（クライアントの切断が届くのを待たない）", async () => {
    // ブリッジは呼び出しごとに接続を張り直す。Windows の名前付きパイプでは、クライアントが
    // 閉じたことがサーバに届くのが遅く、続けて呼んだ2回目が「2本目の同時接続」として
    // 断られていた（実測）。ここでは1本目を**クライアントからは閉じずに**2本目を繋ぎ、
    // 切断の届く速さに依らないことを確かめる。
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    const first = openSession(info.socketPath, info.token, [
      { id: "1", tool: "list_workspaces", args: {} },
    ]);
    try {
      const firstLine = await first.firstLine;
      expect(JSON.parse(firstLine).ok).toBe(true);
      // 答えを書く前に枠を返している（答えが届いた時点で数え終わっている）。
      expect(events.disconnected).toEqual([0]);

      const second = await callSocket(info.socketPath, info.token, {
        id: "2",
        tool: "list_workspaces",
        args: {},
      });
      expect(second.ok).toBe(true);
      expect(events.rejected).toEqual([]);
      // 1本目はサーバの側から閉じられている（1接続1要求）。
      await expect(first.ended).resolves.toEqual([firstLine]);
    } finally {
      first.socket.destroy();
      await server.stop();
    }
  });

  it("答えた後も閉じない相手は、少し待ってからサーバが切る（接続を握らせ続けない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    // サーバが握っている接続。相手は既に EOF を受け取っているので、サーバが切っても
    // 相手の側には（書かない限り）何も起きない。見るのはサーバの側である。
    const open = (server as unknown as { sockets: Set<net.Socket> }).sockets;
    const info = await server.start();
    const session = openSession(info.socketPath, info.token, [
      { id: "1", tool: "list_workspaces", args: {} },
    ]);
    try {
      await session.firstLine;
      const answeredAt = Date.now();
      // クライアントは閉じない（allowHalfOpen で FIN を受けても自分の側を開けたまま）。
      expect(open.size).toBe(1);
      await vi.waitFor(() => expect(open.size).toBe(0), {
        timeout: ANSWERED_LINGER_MS + 1500,
        interval: 50,
      });
      // POSIX では相手の半分開いた接続が残るので、切るのは時計（下限も見て、時計が効いたことを
      // 確かめる）。Windows の名前付きパイプは半分だけ開いた状態を持てず、時計より先に閉じる。
      if (!onWindows) {
        expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(ANSWERED_LINGER_MS - 100);
      }
    } finally {
      session.socket.destroy();
      await server.stop();
    }
  });

  it("1本の接続で2つ目の要求は実行しない（1接続1要求）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const handled: string[] = [];
    const server = new ShowMeSocketServer([dir], async (req) => {
      handled.push(req.id);
      return {};
    });
    const info = await server.start();
    const session = openSession(info.socketPath, info.token, [
      { id: "1", tool: "list_workspaces", args: {} },
      { id: "2", tool: "list_workspaces", args: {} },
    ]);
    try {
      const lines = await session.ended;
      expect(lines.map((l) => JSON.parse(l).id)).toEqual(["1"]);
      expect(handled).toEqual(["1"]);
    } finally {
      session.socket.destroy();
      await server.stop();
    }
  });

  it("答えを待っている間は枠を持ったまま（2本目は断る）", async () => {
    // 枠を返すのは答えを書くとき。要求を処理している間に2本目を通すと、可視化の前提
    // （認証済みの接続は同時に1本）が崩れる。
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new ShowMeSocketServer(
      [dir],
      async () => {
        await gate;
        return {};
      },
      "",
      events.observer,
    );
    const info = await server.start();
    const first = openSession(info.socketPath, info.token, [
      { id: "1", tool: "list_workspaces", args: {} },
    ]);
    try {
      await vi.waitFor(() => expect(events.accepted.length).toBe(1));
      await expect(
        callSocket(info.socketPath, info.token, { id: "2", tool: "list_workspaces", args: {} }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(events.rejected).toContain(SECOND_CONNECTION_REASON));
      release();
      expect(JSON.parse(await first.firstLine).ok).toBe(true);
    } finally {
      release();
      first.socket.destroy();
      await server.stop();
    }
  });

  it("1本目が閉じたら2本目を受け付ける（予算は戻る）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    try {
      const first = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(first.ok).toBe(true);
      await vi.waitFor(() => expect(events.disconnected).toEqual([0]));

      const second = await callSocket(info.socketPath, info.token, {
        id: "2",
        tool: "list_workspaces",
        args: {},
      });
      expect(second.ok).toBe(true);
      expect(events.rejected).not.toContain(SECOND_CONNECTION_REASON);
    } finally {
      await server.stop();
    }
  });

  it("ハンドシェイク前で座っているだけの接続は「2本目」を作らない", async () => {
    // 3秒の窓の中で黙って座っているプロセスがあると、生の接続数で数える限り
    // 正規のブリッジの接続が毎回「2本目」と報告される。数えるのは
    // **認証を通った接続**でなければならない。
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    const squatter = net.createConnection(info.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        squatter.on("connect", () => resolve());
        squatter.on("error", reject);
      });

      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.ok).toBe(true);
      expect(events.accepted.length).toBe(1);
      expect(events.rejected).not.toContain(SECOND_CONNECTION_REASON);
    } finally {
      squatter.destroy();
      await server.stop();
    }
  });

  it("チャンク境界で割れたマルチバイト文字を壊さない", async () => {
    // ブリッジ側（client.ts）は「チャンクごとに toString すると黙って壊れる」と
    // 明記して Buffer 連結で直してあるが、拡張側だけ残っていた。日本語の検索
    // 文字列が「日」の途中で割れると、ハンドラは壊れた文字列を受け取り、例外も
    // 出ないまま永久に当たらない検索になる。
    const dir = path.join(tmpRoot(), "rt");
    const seen: string[] = [];
    const server = new ShowMeSocketServer([dir], async (req) => {
      if (req.tool === "show_code") seen.push(req.args.locations[0]?.text ?? "");
      return { resolutions: [] };
    });
    const info = await server.start();
    const needle = "日本語の検索文字列";
    try {
      const payload = Buffer.from(
        `${JSON.stringify({
          id: "1",
          tool: "show_code",
          args: { locations: [{ path: "a.txt", text: needle }] },
        })}\n`,
        "utf8",
      );
      // 「日」の3バイトの途中で必ず割れる位置を選ぶ。
      const at = payload.indexOf(Buffer.from(needle, "utf8")) + 1;
      expect(at).toBeGreaterThan(0);
      await sendInTwoWrites(info.socketPath, info.token, payload, at);
      await vi.waitFor(() => expect(seen.length).toBe(1));
      expect(seen[0]).toBe(needle);
    } finally {
      await server.stop();
    }
  });

  it("行長の上限はバイト数で測る（CJK が3倍通らない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    try {
      // **上限を超える大きさを、上限から導出して作る。** 定数で書くと、
      // 上限を変えたときにこの検査が黙って何も測らなくなる（実際、線の上限を
      // protocol から導出する形に変えたとき、固定の 200,000 文字では
      // 上限を超えなくなってこの検査が落ちた）。
      //
      // UTF-16 コード単位ではなく**バイト数**で測っていることが要点なので、
      // 1 文字 3 バイトの日本語で、バイト数だけが上限を超える量を作る。
      const huge = "あ".repeat(Math.ceil(MAX_WIRE_LINE_BYTES / 3) + 1000);
      expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_WIRE_LINE_BYTES);
      expect(huge.length).toBeLessThan(MAX_WIRE_LINE_BYTES);
      const sock = net.createConnection(info.socketPath);
      await authenticate(sock, info.token);
      // ハンドシェイクを通してから送る。通す前だと MAX_HANDSHAKE_LINE_BYTES の側で
      // 落ちてしまい、行長の上限は一度も効かない。
      await vi.waitFor(() => expect(events.accepted.length).toBe(1));
      sock.write(huge);
      await vi.waitFor(() => expect(events.rejected).toContain("line too long"));
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  it("stop で自分のソケットと登録ファイルを消す", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    await server.stop();
    expect(fs.existsSync(info.socketPath)).toBe(false);
    expect(fs.existsSync(registryOf(info))).toBe(false);
  });

  it("stop は登録ファイルを消してからサーバを閉じる（死んだパイプを指す登録を残す時間を作らない。D111）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    // 閉じる瞬間に登録ファイルが残っていたかを記録する偽の close。本物の close は続けて呼ぶ。
    const inner = (server as unknown as { server: net.Server }).server;
    const realClose = inner.close.bind(inner);
    const seenAtClose: boolean[] = [];
    inner.close = ((cb?: (err?: Error) => void) => {
      seenAtClose.push(info.registryPaths.some((p) => fs.existsSync(p)));
      return realClose(cb);
    }) as typeof inner.close;
    expect(info.registryPaths.every((p) => fs.existsSync(p))).toBe(true);
    await server.stop();
    expect(seenAtClose).toEqual([false]);
  });
});

interface WireResponseShape {
  ok: boolean;
  error?: { code: string; message: string };
}

/**
 * ブリッジの側のハンドシェイク（D111）を、クライアントの証明を書くところまで進める。
 *
 * **拡張の証明は確かめない。** 検査の相手は拡張の側で、間違ったトークンを持つクライアント
 * （総当たりの相手）は拡張の証明を確かめずに進んでくる。そのクライアントは自分のトークンで
 * 証明を作るので、拡張がそれを無言で切ることを見られる。拡張の証明を確かめる側の検査は
 * `test/mutual-auth.test.ts`（本物のクライアント）と `helloの証明` の検査にある。
 *
 * `after` はクライアントの証明と**同じ write** で書く（ブリッジと同じ）。`split` なら2回に分ける。
 * 解けたときは、拡張の証明の行を読み終えて自分の証明を書いた後である（この関数が付けた
 * `data` の聞き手は外してある）。
 */
function authenticate(
  sock: net.Socket,
  token: string,
  after = "",
  options: { split?: boolean; clientNonce?: string } = {},
): Promise<{ clientNonce: string; serverNonce: string; proofLine: string }> {
  const clientNonce = options.clientNonce ?? newHandshakeNonce();
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      sock.off("data", onData);
      sock.off("close", onClose);
      const proof = parseServerProofLine(buf.subarray(0, nl).toString("utf8"));
      if (proof === undefined) {
        reject(new Error(`not a server proof: ${buf.subarray(0, nl).toString("utf8")}`));
        return;
      }
      const proofLine = clientProofLine(token, clientNonce, proof.serverNonce);
      if (options.split === true) {
        sock.write(`${proofLine}\n`);
        if (after !== "") setTimeout(() => sock.write(after), 20);
      } else {
        sock.write(`${proofLine}\n${after}`);
      }
      resolve({ clientNonce, serverNonce: proof.serverNonce, proofLine });
    };
    const onClose = (): void => reject(new Error("closed before the server proof"));
    const start = (): void => {
      sock.on("data", onData);
      sock.on("close", onClose);
      sock.write(`${helloLine(clientNonce)}\n`);
    };
    sock.on("error", reject);
    if (sock.connecting) sock.once("connect", start);
    else start();
  });
}

function callSocket(socketPath: string, token: string, req: unknown): Promise<WireResponseShape> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 3000);
    // 答えの行を読む聞き手は、ハンドシェイクを終えてから付ける（拡張の証明の行を答えと読まない）。
    // 要求は `authenticate` の中で書くが、答えが届くのは解けた後のイベントループの回である。
    const onAnswer = (d: Buffer): void => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        sock.end();
        resolve(JSON.parse(line));
      }
    };
    // 証明と要求を**2回の write** に分ける（ブリッジは1回。`callSocketOneWrite` と比べる）。
    authenticate(sock, token, `${JSON.stringify(req)}\n`, { split: true }).then(
      () => sock.on("data", onAnswer),
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      reject(new Error("closed"));
    });
  });
}

/**
 * ハンドシェイクの後、行をクライアントの証明と1回の write で送り、受け取った行を集める。
 * **クライアントからは閉じない**（サーバが閉じたかどうかを見るため）。`ended` はサーバが
 * 閉じたときに、ハンドシェイクの後に受け取った全行で解ける。
 */
function openSession(
  socketPath: string,
  token: string,
  lines: readonly unknown[],
): { socket: net.Socket; firstLine: Promise<string>; ended: Promise<string[]> } {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  let buf = "";
  const received: string[] = [];
  let onFirst: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => {
    onFirst = resolve;
  });
  const ended = new Promise<string[]>((resolve, reject) => {
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
  const handshake = authenticate(
    socket,
    token,
    lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  );
  handshake.catch(() => {});
  void handshake.then(() => socket.on("data", onData));
  const onData = (d: Buffer): void => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      received.push(line);
      if (received.length === 1) onFirst(line);
    }
  };
  return { socket, firstLine, ended };
}

function recorder(): {
  observer: ConnectionObserver;
  accepted: (number | undefined)[];
  rejected: string[];
  disconnected: number[];
} {
  const accepted: (number | undefined)[] = [];
  const rejected: string[] = [];
  const disconnected: number[] = [];
  return {
    accepted,
    rejected,
    disconnected,
    observer: {
      onAccepted: (pid) => accepted.push(pid),
      onRejected: (reason) => rejected.push(reason),
      onDisconnected: (remaining) => disconnected.push(remaining),
    },
  };
}

/** ハンドシェイクの後、payload を `at` バイト目で2回に分けて書く（チャンク境界を作るため）。 */
async function sendInTwoWrites(
  socketPath: string,
  token: string,
  payload: Buffer,
  at: number,
): Promise<void> {
  const sock = net.createConnection(socketPath);
  await authenticate(sock, token);
  sock.write(payload.subarray(0, at));
  // 同じイベントループの回で続けて書くと 1 チャンクに合流しうる。
  await new Promise((resolve) => setTimeout(resolve, 20));
  sock.write(payload.subarray(at));
}

function connectTo(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.on("connect", () => {
      sock.destroy();
      resolve();
    });
    sock.on("error", (e) => reject(e));
  });
}

/**
 * 拡張と同じ組み立て（`WindowRoleState` ＋ `ShowMeSocketServer`）で、
 * 人間の1クリックが登録ファイルまで届くことを見る。
 *
 * 部品はそれぞれ検査してあるが、**繋ぎ方を間違えると全部緑のまま届かない**:
 * 役割を値で渡す・購読を繋ぎ忘れる・通知の前に書く、のどれでも「人間には
 * 預けたように見えて、エージェントからは見えない窓」になる。extension.ts は
 * vscode を値 import するので単体では読めない。ここで組み立てだけを写す。
 */
describe("役割の変化が登録ファイルに届く（拡張の配線と同じ組み立て）", () => {
  it("トグル1回で、ファイルの役割が stage になる", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const roleState = new WindowRoleState();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: roleState.windowId,
      role: () => roleState.current(),
    });
    const subscription = roleState.onChange(() => server.refreshRegistration());
    const info = await server.start();
    try {
      const read = () => JSON.parse(fs.readFileSync(registryOf(info), "utf8"));
      expect(read().role).toBe("idle");
      expect(read().windowId).toBe(roleState.windowId);

      roleState.toggle();
      // 通知が飛ぶ順序も見ている: 役割を置く前に通知すると、ここで idle が残る。
      expect(read().role).toBe("stage");

      roleState.toggle();
      expect(read().role).toBe("idle");
    } finally {
      subscription.dispose();
      roleState.dispose();
      await server.stop();
    }
  });
});

/**
 * 登録ファイルの置き換えは**原子的**であること（レビュー N1）。
 *
 * `writeFileSync` は truncate → write なので、書いている最中の中身は空か
 * 途中までになる。2A でこの書き込みは「窓ごとに1回」から「役割を切り替える
 * たび」に変わり、露出窓が増えた。読み手が書きかけを掴むと登録は黙って消え、
 * **人間がまさに今ステータスバーを押した直後に「ステータスバーをクリック
 * してください」**と出る ―― 原因を消す言葉になる。
 *
 * 「壊れた JSON を読ませてみる」では、通ったのが偶然かどうかを判別できない。
 * **inode を見る**: 同じファイルを truncate して書き直せば inode は変わらず、
 * 別名で書いて rename すれば必ず変わる。この2つは実装の違いそのものである。
 */
describe("登録ファイルの置き換えは原子的である", () => {
  it("書き直すと inode が変わる（in-place の truncate ではない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => "stage",
    });
    const info = await server.start();
    try {
      const file = registryOf(info);
      // bigint で読む。NTFS のファイル番号は 2^53 を超えうる（number では丸まって同じに見えうる）。
      const before = fs.statSync(file, { bigint: true }).ino;
      server.refreshRegistration();
      const after = fs.statSync(file, { bigint: true }).ino;
      expect(after).not.toBe(before);
    } finally {
      await server.stop();
    }
  });

  it("書き終えたディレクトリに中間ファイルを残さない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}), "", undefined, {
      windowId: "w1",
      role: () => "stage",
    });
    await server.start();
    try {
      for (let i = 0; i < 5; i += 1) server.refreshRegistration();
      const names = fs.readdirSync(dir).sort();
      expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
      // 登録1件 ＋ ソケット1本だけ。
      expect(names.filter((n) => n.endsWith(".json"))).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("rename の前に落ちて残った中間ファイルは、死んだ pid のものだけ掃除する", () => {
    const dir = path.join(tmpRoot(), "rt");
    fs.mkdirSync(dir, { mode: 0o700 });
    const dead = path.join(dir, `${"a".repeat(16)}.json.tmp-2147483647-0123456789ab`);
    const mine = path.join(dir, `${"b".repeat(16)}.json.tmp-${process.pid}-0123456789ab`);
    fs.writeFileSync(dead, "{}", { mode: 0o600 });
    fs.writeFileSync(mine, "{}", { mode: 0o600 });

    cleanStaleRegistrations(dir, (pid) => pid === process.pid);

    expect(fs.existsSync(dead)).toBe(false);
    // いままさに書いている途中のものを消さない。
    expect(fs.existsSync(mine)).toBe(true);
  });
});

/**
 * クライアントの証明と要求を**1回の `write`** で送る。**ブリッジの実装がこれである**
 * （`client.ts`。v1 では hello と要求を1回で書いていた。D111 で hello は先に1人で送り、
 * 拡張の証明を確かめてから「証明＋要求」を1回で書く）。
 *
 * 既存の `callSocket` は2回に分けて書いていた。だから「大きい要求が無言で切られる」
 * 欠陥は、**単体テストが全部緑のまま出荷された**（実地で踏んで初めて分かった）。
 * 配送の分かれ方に答えが依存しないことは、両方の書き方で測って初めて言える。
 */
function callSocketOneWrite(
  socketPath: string,
  token: string,
  req: unknown,
): Promise<WireResponseShape | "closed"> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 5000);
    const onAnswer = (d: Buffer): void => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        sock.end();
        resolve(JSON.parse(line));
      }
    };
    authenticate(sock, token, `${JSON.stringify(req)}\n`).then(
      () => sock.on("data", onAnswer),
      () => {
        clearTimeout(timer);
        resolve("closed");
      },
    );
    sock.on("error", () => {
      clearTimeout(timer);
      resolve("closed");
    });
    sock.on("close", () => {
      clearTimeout(timer);
      if (buf === "") resolve("closed");
    });
  });
}

/** 改行を1つも含まない生バイト列を送る（＝丸ごと hello 行の候補になる）。 */
function sendRawWithoutNewline(
  socketPath: string,
  bytes: number,
): Promise<WireResponseShape | "closed"> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 5000);
    sock.on("connect", () => sock.write("a".repeat(bytes)));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve("closed");
    });
    sock.on("close", () => {
      clearTimeout(timer);
      if (buf === "") resolve("closed");
    });
  });
}

describe("ハンドシェイクの終わりは1箇所で決まる（不変条件14 の4件目）", () => {
  /** 20 KiB の要求。宣言上の上限（MAX_HTML_CHARS = 256 KiB）よりずっと小さい。 */
  const bigRequest = {
    id: "1",
    tool: "show_html" as const,
    args: { html: `<p>${"x".repeat(20_000)}</p>` },
  };

  it("証明と要求を1回の write で送っても、要求本文が予算に算入されない", async () => {
    // **これが実地で踏んだ欠陥。** 拡張は未認証中の「累計バイト数」を数えていたので、
    // 1回の write で送られた hello + request がまるごと未認証扱いになり、
    // 宣言の 1/67（約 3.9 KiB）で無言切断されていた。
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({ ok: true }));
    const info = await server.start();
    try {
      const res = await callSocketOneWrite(info.socketPath, info.token, bigRequest);
      expect(res, "1回の write で大きい要求を送ったら無言で切られた").not.toBe("closed");
      expect((res as WireResponseShape).ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("1回の write と2回の write で同じ答えになる", async () => {
    // **不変条件14 の要求そのもの。** 配送の分かれ方に答えが依存しない。
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({ ok: true }));
    const info = await server.start();
    try {
      const one = await callSocketOneWrite(info.socketPath, info.token, bigRequest);
      const two = await callSocket(info.socketPath, info.token, bigRequest);
      expect(one).not.toBe("closed");
      expect((one as WireResponseShape).ok).toBe(two.ok);
    } finally {
      await server.stop();
    }
  });

  it("改行を1つも送らずに 4096 B を超えたら切られる（守りが消えていない）", async () => {
    // 案A で消し飛ばしやすいのがここ。**必ず残す。**
    const dir = path.join(tmpRoot(), "rt");
    const rec = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", rec.observer);
    const info = await server.start();
    try {
      const res = await sendRawWithoutNewline(info.socketPath, 5000);
      expect(res).not.toBe(undefined);
      expect(rec.rejected).toContain("handshake too large");
    } finally {
      await server.stop();
    }
  });
});

describe("拒否の理由を返すのは、認証と無関係なときだけ（設計 D28）", () => {
  it("大きすぎる要求には理由が返ってから切られる", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      const res = await sendRawWithoutNewline(info.socketPath, 5000);
      expect(res, "無言で切られた（原因に到達する手段が無い）").not.toBe("closed");
      expect((res as WireResponseShape).ok).toBe(false);
      expect((res as WireResponseShape).error?.code).toBe("invalid-request");
    } finally {
      await server.stop();
    }
  });

  it("トークンが違うときは無言のまま切る（当否を教えない）", async () => {
    // **ここに理由を返してはならない。** 「大きすぎた」と「トークンが違う」を
    // 区別できると、総当たりの相手に「形式は合っている」を教えることになる。
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    try {
      const res = await callSocketOneWrite(info.socketPath, "0".repeat(64), {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res, "トークン不一致に理由を返している").toBe("closed");
    } finally {
      await server.stop();
    }
  });
});

/** 生の接続で1行書き、返ってきた最初の行（あるいは "closed"）を受け取る。接続は開けたまま返す。 */
function writeAndReadLine(
  socketPath: string,
  payload: string,
  waitMs = 3000,
): Promise<{ socket: net.Socket; line: string | "closed" | "silent" }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buf = "";
    let done = false;
    const finish = (line: string | "closed" | "silent"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ socket, line });
    };
    const timer = setTimeout(() => finish("silent"), waitMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    });
    socket.on("error", () => finish("closed"));
    socket.on("close", () => finish("closed"));
  });
}

describe("相互認証（D111）: トークンを線に乗せず、どちらの側も相手がトークンを持つことを確かめる", () => {
  it("hello に拡張が証明を返す。証明はトークンで確かめられ、トークンそのものは乗っていない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    const clientNonce = newHandshakeNonce();
    const { socket, line } = await writeAndReadLine(info.socketPath, `${helloLine(clientNonce)}\n`);
    try {
      expect(line).not.toBe("closed");
      expect(line).not.toContain(info.token);
      const proof = parseServerProofLine(String(line));
      expect(proof, `証明の形でない: ${line}`).toBeDefined();
      if (proof === undefined) return;
      expect(verifyServerProof(info.token, clientNonce, proof.serverNonce, proof.proof)).toBe(true);
      // 別のトークンでは確かめられない（ブリッジが別の窓の拡張を本物と取り違えない）。
      expect(verifyServerProof("0".repeat(64), clientNonce, proof.serverNonce, proof.proof)).toBe(
        false,
      );
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it("形の整った hello が届くまで、拡張は何も書かない", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const info = await server.start();
    // 改行の無い途中までの hello。拡張は何も書かずに待つ。
    const partial = helloLine(newHandshakeNonce()).slice(0, 20);
    const { socket, line } = await writeAndReadLine(info.socketPath, partial, 300);
    try {
      expect(line).toBe("silent");
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it("壊れた hello は無言で切る（証明を返さない）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    const garbage = JSON.stringify({ protocolVersion: WIRE_PROTOCOL_VERSION, clientNonce: "x" });
    const { socket, line } = await writeAndReadLine(info.socketPath, `${garbage}\n`);
    try {
      expect(line).toBe("closed");
      expect(events.rejected).toContain("bad token");
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it("v1 の hello（トークンを生で送る）には版違いの理由を返して切る（D28: 認証と無関係）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const handled: string[] = [];
    const server = new ShowMeSocketServer(
      [dir],
      async (req) => {
        handled.push(req.id);
        return {};
      },
      "",
      events.observer,
    );
    const info = await server.start();
    const v1 = `${JSON.stringify({ protocolVersion: 1, token: info.token })}\n${JSON.stringify({
      id: "1",
      tool: "list_workspaces",
      args: {},
    })}\n`;
    const { socket, line } = await writeAndReadLine(info.socketPath, v1);
    try {
      expect(line).not.toBe("closed");
      const res = JSON.parse(String(line)) as WireResponseShape;
      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe(HANDSHAKE_REFUSALS.versionMismatch);
      expect(events.rejected).toContain("protocol version mismatch");
      // トークンが正しくても v1 の形では要求は実行されない。
      expect(handled).toEqual([]);
      expect(events.accepted).toEqual([]);
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it("盗み見たクライアントの証明は、別の接続では通らない（serverNonce が接続ごとに違う）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const handled: string[] = [];
    const server = new ShowMeSocketServer(
      [dir],
      async (req) => {
        handled.push(req.id);
        return {};
      },
      "",
      events.observer,
    );
    const info = await server.start();
    try {
      // 1本目: 正しいブリッジ。証明の行を控える（線を盗み見た相手が見られるもの）。
      const first = net.createConnection(info.socketPath);
      const captured = await authenticate(
        first,
        info.token,
        `${JSON.stringify({ id: "1", tool: "list_workspaces", args: {} })}\n`,
      );
      await vi.waitFor(() => expect(handled).toEqual(["1"]));
      first.destroy();

      // 2本目: 同じ clientNonce で hello を送り、控えた証明をそのまま再送する。
      const replay = await new Promise<string | "closed">((resolve) => {
        const sock = net.createConnection(info.socketPath);
        let buf = "";
        let sentProof = false;
        sock.on("connect", () => sock.write(`${helloLine(captured.clientNonce)}\n`));
        sock.on("data", (d) => {
          buf += d.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          if (!sentProof) {
            sentProof = true;
            const proof = parseServerProofLine(buf.slice(0, nl));
            // 拡張は新しい serverNonce を作る。
            expect(proof?.serverNonce).not.toBe(captured.serverNonce);
            buf = buf.slice(nl + 1);
            sock.write(
              `${captured.proofLine}\n${JSON.stringify({ id: "2", tool: "list_workspaces", args: {} })}\n`,
            );
            return;
          }
          resolve(buf.slice(0, nl));
        });
        sock.on("error", () => resolve("closed"));
        sock.on("close", () => resolve("closed"));
      });
      expect(replay).toBe("closed");
      expect(handled).toEqual(["1"]);
      expect(events.rejected).toContain("bad token");
    } finally {
      await server.stop();
    }
  });

  it("クライアントの証明の行も認証前の上限で測る（改行なしで 4096 B を超えたら理由を返す）", async () => {
    const dir = path.join(tmpRoot(), "rt");
    const events = recorder();
    const server = new ShowMeSocketServer([dir], async () => ({}), "", events.observer);
    const info = await server.start();
    const sock = net.createConnection(info.socketPath);
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buf = "";
        let proofSeen = false;
        sock.on("connect", () => sock.write(`${helloLine(newHandshakeNonce())}\n`));
        sock.on("data", (d) => {
          buf += d.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          if (!proofSeen) {
            proofSeen = true;
            buf = buf.slice(nl + 1);
            sock.write("a".repeat(MAX_HANDSHAKE_LINE_BYTES + 1));
            return;
          }
          resolve(buf.slice(0, nl));
        });
        sock.on("error", reject);
      });
      expect((JSON.parse(line) as WireResponseShape).error?.message).toBe(
        HANDSHAKE_REFUSALS.handshakeTooLarge,
      );
      expect(events.rejected).toContain("handshake too large");
    } finally {
      sock.destroy();
      await server.stop();
    }
  });
});

describe("スキーマを通る入力は線も通る（不変条件14 の5件目）", () => {
  it("上限いっぱいの日本語 HTML が線で落ちない", async () => {
    // **これが逆向きの検査である。** 既存の「行長の上限はバイト数で測る」は
    // 大きすぎる入力が**正しく落ちる**ことしか見ていなかった。
    // スキーマが通した入力が線で落ちる、という向きは誰も測っていなかった。
    //
    // 日本語は UTF-8 で 1 文字 3 バイト。以前の 256 KiB では
    // `"あ".repeat(262144)`（= MAX_HTML_CHARS ちょうど）が 786,480 B になり、
    // **スキーマを通ったのに線で切られて**いた。
    const html = `<p>${"あ".repeat(50_000)}</p>`;
    const line = JSON.stringify({ id: "1", tool: "show_html", args: { html } });
    expect(Buffer.byteLength(line)).toBeGreaterThan(150_000);

    const dir = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([dir], async () => ({ ok: true }));
    const info = await server.start();
    try {
      const res = await callSocketOneWrite(info.socketPath, info.token, {
        id: "1",
        tool: "show_html",
        args: { html },
      });
      expect(res, "スキーマを通る日本語の入力が線で落ちた").not.toBe("closed");
      expect((res as WireResponseShape).ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("線の上限はプロトコルの最大フィールドから導出されている", () => {
    // 独立に決めた値だと、片方を変えたときにもう片方が置き去りになる。
    // **最悪の1文字（制御文字の \uXXXX = 6 バイト）**を見込んでいること。
    expect(MAX_WIRE_LINE_BYTES).toBeGreaterThan(MAX_HTML_CHARS * 3);
  });
});

/**
 * ソケットのパスが `sun_path` に収まらない候補は、その候補の失敗にする（D108）。
 *
 * 収まらないと listen は黙って切り詰めた名前で立ち、続く chmod が ENOENT になる（macOS の実測）。
 * 理由の出ない ENOENT では、人間は何を直せばよいか分からない。
 */
describe.skipIf(onWindows)("長すぎるソケットのパス（D108）", () => {
  /** `<dir>/<16桁>.sock` が 108 バイト（Linux）も 104 バイト（macOS）も超えるディレクトリ。 */
  function longDir(): string {
    const root = tmpRoot();
    const dir = path.join(root, "d".repeat(Math.max(1, 120 - root.length)));
    expect(Buffer.byteLength(path.join(dir, `${"0".repeat(16)}.sock`))).toBeGreaterThan(108);
    return dir;
  }

  it("候補が1つで長すぎるなら、長さと上限と向け直し先を理由にして断る（listen しない）", async () => {
    const dir = longDir();
    const server = new ShowMeSocketServer([dir], async () => ({}));
    const err = await server.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    await server.stop();
    expect(err).toBeInstanceOf(Error);
    const text = String((err as Error).message);
    expect(text).toMatch(/socket path is \d+ bytes, over the \d+-byte limit/);
    // 文言の数は、判定に使った測定そのもの（数え直さない。不変条件14）
    const m = /socket path is (\d+) bytes, over the (\d+)-byte limit of this OS: (\S+)\./.exec(
      text,
    );
    const measured = socketPathLength(m?.[3] ?? "", process.platform);
    expect([Number(m?.[1]), Number(m?.[2])]).toEqual([measured.bytes, measured.limit]);
    expect(measured.tooLong).toBe(true);
    expect(text).toContain(dir);
    expect(text).toContain("TMPDIR");
    // ソケットも登録ファイルも置かない（置いても誰も繋げない）。
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("先頭の候補が長すぎるなら、次の候補にソケットを置き、登録ファイルは両方に書く", async () => {
    const long = longDir();
    const short = path.join(tmpRoot(), "rt");
    const server = new ShowMeSocketServer([long, short], async () => ({ hello: "world" }));
    const info = await server.start();
    try {
      expect(path.dirname(info.socketPath)).toBe(short);
      // 先頭はソケットのあるディレクトリの分（`ServerInfo.registryPaths` の約束）。
      expect(info.registryPaths.map((p) => path.dirname(p))).toEqual([short, long]);
      for (const reg of info.registryPaths) {
        expect(JSON.parse(fs.readFileSync(reg, "utf8")).socketPath).toBe(info.socketPath);
      }
      const res = await callSocket(info.socketPath, info.token, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(res.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

/**
 * 登録ファイルの rename は、Windows では読み手やウイルス対策が開いている間 EPERM / EBUSY /
 * EACCES で落ちうる（D109）。短く数回やり直す。POSIX の rename は開いているファイルでも
 * 置き換えられるので、やり直さない（今までどおり1回で投げる）。
 */
describe("登録ファイルの rename のやり直し（D109）", () => {
  function failingRename(codes: string[]): {
    rename: (from: string, to: string) => void;
    calls: () => number;
  } {
    let n = 0;
    return {
      rename: (from, to) => {
        const code = codes[n];
        n += 1;
        if (code !== undefined) throw Object.assign(new Error(code), { code });
        fs.renameSync(from, to);
      },
      calls: () => n,
    };
  }

  it("win32 では EPERM / EBUSY / EACCES の後にやり直して置き換える", () => {
    const dir = tmpRoot();
    const target = path.join(dir, `${"a".repeat(16)}.json`);
    const r = failingRename(["EPERM", "EBUSY", "EACCES"]);
    const slept: number[] = [];
    writeRegistrationFile(target, '{"x":1}', {
      platform: "win32",
      rename: r.rename,
      sleep: (ms) => slept.push(ms),
    });
    expect(fs.readFileSync(target, "utf8")).toBe('{"x":1}');
    expect(r.calls()).toBe(4);
    expect(slept).toHaveLength(3);
    expect(fs.readdirSync(dir)).toEqual([path.basename(target)]);
  });

  it("win32 でもやり直しには上限があり、尽きたら投げて中間ファイルを消す", () => {
    const dir = tmpRoot();
    const target = path.join(dir, `${"b".repeat(16)}.json`);
    const r = failingRename(Array.from({ length: 50 }, () => "EBUSY"));
    expect(() =>
      writeRegistrationFile(target, "{}", { platform: "win32", rename: r.rename, sleep: () => {} }),
    ).toThrow("EBUSY");
    expect(r.calls()).toBeGreaterThan(1);
    expect(r.calls()).toBeLessThanOrEqual(10);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("win32 でも、それ以外の失敗（ENOENT など）はやり直さない", () => {
    const dir = tmpRoot();
    const target = path.join(dir, `${"c".repeat(16)}.json`);
    const r = failingRename(["ENOENT"]);
    expect(() =>
      writeRegistrationFile(target, "{}", { platform: "win32", rename: r.rename, sleep: () => {} }),
    ).toThrow("ENOENT");
    expect(r.calls()).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("win32 以外ではやり直さない（1回で投げ、中間ファイルを消す）", () => {
    const dir = tmpRoot();
    const target = path.join(dir, `${"d".repeat(16)}.json`);
    const r = failingRename(["EPERM"]);
    expect(() =>
      writeRegistrationFile(target, "{}", { platform: "linux", rename: r.rename, sleep: () => {} }),
    ).toThrow("EPERM");
    expect(r.calls()).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
