import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProtocolError, callExtension } from "../packages/bridge/src/client.js";
import {
  describeSelectionFailure,
  parseRegistryEntry,
  selectWindow,
} from "../packages/bridge/src/discover.js";
import { type ConnectionObserver, ShowMeSocketServer } from "../packages/extension/src/server.js";
import {
  HANDSHAKE_REFUSALS,
  WIRE_PROTOCOL_VERSION,
  newHandshakeNonce,
  parseHelloLine,
} from "../packages/protocol/src/index.js";
import { currentUserSid, lockPrivateDir } from "../packages/protocol/src/windows-acl-io.js";

/**
 * **本物のブリッジ（`callExtension`）と本物の拡張（`ShowMeSocketServer`）を、本物のソケット /
 * 名前付きパイプで繋いで、相互認証（増分11 D111）を確かめる。** パッケージ境界をまたぐので
 * ルートの `test/` に置く（Windows の単体のジョブでも走り、そこでは名前付きパイプの上で測る）。
 *
 * 守りたいのは次の筋書き: 拡張が登録を消さずに死ぬ → 登録は誰も listen していない名前を指す →
 * Windows ではパイプの名前がマシン全体で共有されるので、別の誰かが同じ名前でパイプを作る →
 * ブリッジが繋ぐ。v1 のブリッジは繋いだ直後にトークンと要求を送り、返ってきた答えを信じた。
 *
 * 偽の相手（横取りしたパイプ）は、**トークンを知らないことを除けば本物の拡張と同じ手順**を踏む
 * （hello を protocol の `parseHelloLine` で読み、決まった形の証明の行を返す）。偽物が手順の手前で
 * 止まっていると、ブリッジが「手順の違い」で断ったのか「証明の誤り」で断ったのかが分からない
 * （不変条件14 の10件目）。
 */

const onWindows = process.platform === "win32";
const made: string[] = [];

let base: string | undefined;
beforeAll(async () => {
  if (onWindows) {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ma-"));
    await lockPrivateDir(base, await currentUserSid());
  } else {
    base = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "ma-"));
  }
});
afterAll(() => {
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
});
const listening: net.Server[] = [];
afterEach(async () => {
  for (const s of listening.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function runtimeDir(): string {
  const root = fs.mkdtempSync(path.join(String(base), "r-"));
  made.push(root);
  return path.join(root, "vscode-showme-0");
}

function recorder(): { observer: ConnectionObserver; rejected: string[]; accepted: number[] } {
  const rejected: string[] = [];
  const accepted: number[] = [];
  return {
    rejected,
    accepted,
    observer: {
      onAccepted: () => accepted.push(1),
      onRejected: (reason) => rejected.push(reason),
      onDisconnected: () => {},
    },
  };
}

const request = { id: "req-1", tool: "list_workspaces" as const, args: {} };

/**
 * 登録を横取りした相手。`socketPath` で listen し、hello を本物と同じ関数で読んで、
 * トークンを知らないので**でたらめな証明**を返す（あるいは偽の答えを先に返す）。
 * 受け取ったバイトを全部控える。
 */
function squat(
  socketPath: string,
  firstLine: (clientNonce: string) => string,
): Promise<{ received: Buffer[]; afterHello: Buffer[] }> {
  const received: Buffer[] = [];
  const afterHello: Buffer[] = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let sawHello = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      if (sawHello) {
        afterHello.push(Buffer.from(chunk));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      sawHello = true;
      const rest = buf.subarray(nl + 1);
      if (rest.length > 0) afterHello.push(Buffer.from(rest));
      const hello = parseHelloLine(buf.subarray(0, nl).toString("utf8"));
      if (hello.kind !== "ok") {
        socket.destroy();
        return;
      }
      socket.write(`${firstLine(hello.clientNonce)}\n`);
    });
  });
  listening.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve({ received, afterHello }));
  });
}

describe("相互認証（D111）: 本物のブリッジと本物の拡張", () => {
  it("正しいトークンなら通る（ブリッジは拡張の証明を、拡張はブリッジの証明を確かめる）", async () => {
    const events = recorder();
    const server = new ShowMeSocketServer(
      [runtimeDir()],
      async () => ({ ok: true }),
      "",
      events.observer,
    );
    const info = await server.start();
    try {
      const response = await callExtension(info.socketPath, info.token, request);
      expect(response.ok).toBe(true);
      expect(events.accepted).toHaveLength(1);
      expect(events.rejected).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("違うトークンのブリッジは、拡張の証明を確かめられずに要求を送らない（拡張も要求を実行しない）", async () => {
    const events = recorder();
    const handled: string[] = [];
    const server = new ShowMeSocketServer(
      [runtimeDir()],
      async (req) => {
        handled.push(req.id);
        return { ok: true };
      },
      "",
      events.observer,
    );
    const info = await server.start();
    try {
      await expect(callExtension(info.socketPath, "0".repeat(64), request)).rejects.toThrow(
        ProtocolError,
      );
      expect(handled).toEqual([]);
      expect(events.accepted).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("死んだ窓のパイプ名を横取りした相手には、トークンも要求も渡らず、偽の答えも受け取らない", async () => {
    // 本物の拡張を立てて止める。登録（socketPath と token）はブリッジの手元に残っているとする。
    const server = new ShowMeSocketServer([runtimeDir()], async () => ({ ok: true }));
    const info = await server.start();
    const registration = fs.readFileSync(String(info.registryPaths[0]), "utf8");
    await server.stop();
    const entry = parseRegistryEntry(registration);
    expect(entry?.authToken).toBe(info.token);

    // 同じ名前で listen する（Windows ではマシン全体の名前、POSIX では同じパス）。
    // 形は本物の証明の行と同じ（serverNonce と 64 桁の hex）で、トークンを知らないので中身はでたらめ。
    const fake = await squat(info.socketPath, () =>
      JSON.stringify({ serverNonce: newHandshakeNonce(), proof: newHandshakeNonce() }),
    );
    await expect(callExtension(info.socketPath, info.token, request)).rejects.toThrow(
      /did not prove that it holds this window's token/,
    );
    const all = Buffer.concat(fake.received).toString("utf8");
    expect(all, "hello は届いている（手順の手前で止まっていない）").toContain("clientNonce");
    expect(all).not.toContain(info.token);
    expect(all).not.toContain("list_workspaces");
    expect(Buffer.concat(fake.afterHello).length).toBe(0);
  });

  it("横取りした相手が証明の代わりに偽の答え（人間の選択など）を返しても、ブリッジは受け取らない", async () => {
    const server = new ShowMeSocketServer([runtimeDir()], async () => ({ ok: true }));
    const info = await server.start();
    await server.stop();
    const forged = JSON.stringify({
      id: request.id,
      ok: true,
      result: { isTrusted: true, capabilities: {}, permissions: {} },
    });
    const fake = await squat(info.socketPath, () => forged);
    await expect(callExtension(info.socketPath, info.token, request)).rejects.toThrow(
      ProtocolError,
    );
    expect(Buffer.concat(fake.afterHello).length).toBe(0);
  });

  it("拡張の版違いの理由（D28）はブリッジを通ってエージェントに届く言葉になる", async () => {
    // 本物の拡張は v1 の hello に決まった理由を返す。その行をそのまま返す相手に本物のブリッジを繋ぐ。
    const server = new ShowMeSocketServer([runtimeDir()], async () => ({ ok: true }));
    const info = await server.start();
    let refusal = "";
    try {
      refusal = await new Promise<string>((resolve, reject) => {
        const sock = net.createConnection(info.socketPath);
        let buf = "";
        sock.on("connect", () =>
          sock.write(`${JSON.stringify({ protocolVersion: 1, token: info.token })}\n`),
        );
        sock.on("data", (d) => {
          buf += d.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) resolve(buf.slice(0, nl));
        });
        sock.on("error", reject);
      });
    } finally {
      await server.stop();
    }
    expect(refusal).toContain(HANDSHAKE_REFUSALS.versionMismatch);
    await squat(info.socketPath, () => refusal);
    await expect(callExtension(info.socketPath, info.token, request)).rejects.toThrow(
      HANDSHAKE_REFUSALS.versionMismatch,
    );
  });

  it("登録の版が違えば、ブリッジは繋ぐ前に「同じ版にして窓を再読み込み」と言う", async () => {
    const server = new ShowMeSocketServer([runtimeDir()], async () => ({ ok: true }));
    const info = await server.start();
    try {
      const entry = parseRegistryEntry(fs.readFileSync(String(info.registryPaths[0]), "utf8"));
      expect(entry?.protocolVersion).toBe(WIRE_PROTOCOL_VERSION);
      if (entry === undefined) return;
      const old = { ...entry, protocolVersion: WIRE_PROTOCOL_VERSION - 1, role: "stage" as const };
      const selection = selectWindow([old], {});
      expect(selection.ok).toBe(false);
      if (selection.ok) return;
      expect(selection.reason).toBe("version-mismatch");
      expect(describeSelectionFailure(selection, { dirs: ["x"], present: true })).toContain(
        "reload the VS Code window",
      );
    } finally {
      await server.stop();
    }
  });
});
