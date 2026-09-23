import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_HTML_CHARS, MAX_WIRE_LINE_BYTES } from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectionObserver,
  SECOND_CONNECTION_REASON,
  ShowMeSocketServer,
  ToolError,
  cleanStaleRegistrations,
  prepareRuntimeDir,
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

const made: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "showme-test-"));
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

describe("prepareRuntimeDir", () => {
  it("0700 のディレクトリを作る", () => {
    const dir = path.join(tmpRoot(), "vscode-showme-1000");
    const r = prepareRuntimeDir(dir);
    expect(r.ok).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("既にある 0700 の自分のディレクトリは再利用する", () => {
    const dir = path.join(tmpRoot(), "vscode-showme-1000");
    fs.mkdirSync(dir, { mode: 0o700 });
    expect(prepareRuntimeDir(dir).ok).toBe(true);
  });

  it("シンボリックリンクだったら拒否し、消さない", () => {
    const root = tmpRoot();
    const victim = path.join(root, "victim");
    fs.mkdirSync(victim);
    const dir = path.join(root, "vscode-showme-1000");
    fs.symlinkSync(victim, dir);

    const r = prepareRuntimeDir(dir);
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
    const r = prepareRuntimeDir(dir);
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
    expect(fs.existsSync(sock)).toBe(false);
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
      await new Promise<void>((resolve, reject) => {
        held.on("connect", () => {
          held.write(`${JSON.stringify({ protocolVersion: 1, token: info.token })}\n`);
          resolve();
        });
        held.on("error", reject);
      });
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
      await new Promise<void>((resolve, reject) => {
        held.on("connect", () => {
          held.write(`${JSON.stringify({ protocolVersion: 1, token: info.token })}\n`);
          resolve();
        });
        held.on("error", reject);
      });
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
        `${JSON.stringify({ protocolVersion: 1, token: info.token })}\n${JSON.stringify({
          id: "1",
          tool: "show_code",
          args: { locations: [{ path: "a.txt", text: needle }] },
        })}\n`,
        "utf8",
      );
      // 「日」の3バイトの途中で必ず割れる位置を選ぶ。
      const at = payload.indexOf(Buffer.from(needle, "utf8")) + 1;
      expect(at).toBeGreaterThan(0);
      await sendInTwoWrites(info.socketPath, payload, at);
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
      await new Promise<void>((resolve, reject) => {
        sock.on("connect", () => {
          sock.write(`${JSON.stringify({ protocolVersion: 1, token: info.token })}\n`);
          resolve();
        });
        sock.on("error", reject);
      });
      // ハンドシェイクを通してから送る。通す前だと MAX_HANDSHAKE_BYTES の側で
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
});

interface WireResponseShape {
  ok: boolean;
  error?: { code: string; message: string };
}

function callSocket(socketPath: string, token: string, req: unknown): Promise<WireResponseShape> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 3000);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ protocolVersion: 1, token })}\n`);
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        sock.end();
        resolve(JSON.parse(line));
      }
    });
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

/** payload を `at` バイト目で2回に分けて書く（チャンク境界を作るため）。 */
function sendInTwoWrites(socketPath: string, payload: Buffer, at: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.on("connect", () => {
      sock.write(payload.subarray(0, at));
      // 同じイベントループの回で続けて書くと 1 チャンクに合流しうる。
      setTimeout(() => {
        sock.write(payload.subarray(at));
        resolve();
      }, 20);
    });
    sock.on("error", reject);
  });
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
      const before = fs.statSync(file).ino;
      server.refreshRegistration();
      const after = fs.statSync(file).ino;
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
 * hello と要求を**1回の `write`** で送る。**ブリッジの実装がこれである**
 * （`client.ts`: 「分けても意味は同じ」というコメントとともに1回で書いている）。
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
    sock.on("connect", () => {
      const hello = JSON.stringify({ protocolVersion: 1, token });
      sock.write(`${hello}\n${JSON.stringify(req)}\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        sock.end();
        resolve(JSON.parse(line));
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

  it("hello と要求を1回の write で送っても、要求本文が予算に算入されない", async () => {
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
