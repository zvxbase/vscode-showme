import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WIRE_PROTOCOL_VERSION, type WireRequest } from "@zvx/vscode-showme-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CALL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  NoWindowError,
  ProtocolError,
  callExtension,
} from "./client.js";

const TOKEN = "b".repeat(64);

const request: WireRequest = { id: "req-1", tool: "list_workspaces", args: {} };

const okResult = {
  isTrusted: true,
  capabilities: { symbolResolution: true, terminalEnvInjection: true },
  permissions: { closeHumanTabs: false, closeDirtyTabs: false },
  features: { stage: true, html: true, layout: true },
  disabledTools: [],
  editorGroup: "dedicated",
  panels: { max: 2 },
  otherWindowsListed: false,
};

let dir: string;
let servers: net.Server[];

/** 偽の拡張。1行目(hello)を受け取り、2行目(要求)に `reply` の答えを返す。 */
function fakeExtension(
  reply: (line: string, socket: net.Socket) => void,
  onHello?: (line: string) => void,
): Promise<string> {
  const socketPath = path.join(dir, `fake-${servers.length}.sock`);
  const server = net.createServer((socket) => {
    let buffer = "";
    let sawHello = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!sawHello) {
          sawHello = true;
          onHello?.(line);
          continue;
        }
        reply(line, socket);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-client-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("callExtension", () => {
  it("応答を返す", async () => {
    const socketPath = await fakeExtension((line, socket) => {
      const id = (JSON.parse(line) as { id: string }).id;
      socket.write(`${JSON.stringify({ id, ok: true, result: okResult })}\n`);
    });
    const response = await callExtension(socketPath, TOKEN, request);
    expect(response.ok).toBe(true);
  });

  it("先にハンドシェイクを送る(版とトークン)", async () => {
    let hello = "";
    const socketPath = await fakeExtension(
      (line, socket) => {
        const id = (JSON.parse(line) as { id: string }).id;
        socket.write(`${JSON.stringify({ id, ok: true, result: okResult })}\n`);
      },
      (line) => {
        hello = line;
      },
    );
    await callExtension(socketPath, TOKEN, request);
    expect(JSON.parse(hello)).toEqual({ protocolVersion: WIRE_PROTOCOL_VERSION, token: TOKEN });
  });

  it("要求をそのまま送る", async () => {
    let sent = "";
    const socketPath = await fakeExtension((line, socket) => {
      sent = line;
      const id = (JSON.parse(line) as { id: string }).id;
      socket.write(`${JSON.stringify({ id, ok: true, result: okResult })}\n`);
    });
    await callExtension(socketPath, TOKEN, request);
    expect(JSON.parse(sent)).toEqual(request);
  });

  it("ok:false の応答はそのまま持ち帰る(拒否ではない)", async () => {
    const socketPath = await fakeExtension((line, socket) => {
      const id = (JSON.parse(line) as { id: string }).id;
      socket.write(
        `${JSON.stringify({ id, ok: false, error: { code: "disabled", message: "止めています" } })}\n`,
      );
    });
    const response = await callExtension(socketPath, TOKEN, request);
    expect(response.ok).toBe(false);
    expect(response.ok === false ? response.error.code : "").toBe("disabled");
  });

  it("応答を返さないソケットでも期限内にエラーで戻る(ハングしない)", async () => {
    const socketPath = await fakeExtension(() => {
      // 何も返さない
    });
    const started = Date.now();
    await expect(callExtension(socketPath, TOKEN, request, { callTimeoutMs: 150 })).rejects.toThrow(
      NoWindowError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("繋がらないパスは NoWindowError(起動を止めない失敗)", async () => {
    const dead = path.join(dir, "nobody-here.sock");
    await expect(callExtension(dead, TOKEN, request)).rejects.toThrow(NoWindowError);
  });

  it("接続はできるが応答前に閉じられたら NoWindowError", async () => {
    const socketPath = await fakeExtension((_line, socket) => socket.destroy());
    await expect(callExtension(socketPath, TOKEN, request)).rejects.toThrow(NoWindowError);
  });

  it("id が食い違う応答は拒否する(別の要求の答えを掴まない)", async () => {
    const socketPath = await fakeExtension((_line, socket) => {
      socket.write(`${JSON.stringify({ id: "someone-else", ok: true, result: okResult })}\n`);
    });
    await expect(callExtension(socketPath, TOKEN, request)).rejects.toThrow(ProtocolError);
  });

  it("線上のスキーマに合わない応答は拒否する", async () => {
    const socketPath = await fakeExtension((_line, socket) => {
      socket.write(`${JSON.stringify({ id: "req-1", ok: "yes" })}\n`);
    });
    await expect(callExtension(socketPath, TOKEN, request)).rejects.toThrow(ProtocolError);
  });

  it("JSON でない応答は拒否する", async () => {
    const socketPath = await fakeExtension((_line, socket) => socket.write("not json\n"));
    await expect(callExtension(socketPath, TOKEN, request)).rejects.toThrow(ProtocolError);
  });

  it("長すぎる応答は切る(拡張のふりをした相手にメモリを食わせない)", async () => {
    const socketPath = await fakeExtension((_line, socket) => {
      // 改行を一度も送らないまま上限を超えさせる
      const chunk = "x".repeat(64 * 1024);
      const pump = (): void => {
        if (socket.destroyed) return;
        socket.write(chunk);
        setTimeout(pump, 1);
      };
      pump();
    });
    await expect(
      callExtension(socketPath, TOKEN, request, { callTimeoutMs: 5000 }),
    ).rejects.toThrow(/too long/);
  });

  it("上限は拡張側の行長上限と同じ", () => {
    // 拡張は 256KB で切る(packages/extension/src/server.ts の MAX_LINE_BYTES)。
    // 受け側だけ緩いと、拡張が送れない大きさを待ち続けることになる。
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
  });

  it("応答が2行来ても最初の1行だけを使う", async () => {
    const socketPath = await fakeExtension((_line, socket) => {
      socket.write(`${JSON.stringify({ id: "req-1", ok: true, result: okResult })}\n`);
      socket.write(`${JSON.stringify({ id: "req-1", ok: true, result: { isTrusted: false } })}\n`);
    });
    const response = await callExtension(socketPath, TOKEN, request);
    expect(response.ok === true ? response.result.isTrusted : undefined).toBe(true);
  });

  it("マルチバイト文字がチャンク境界で割れても壊さない", async () => {
    const message = "日本語のメッセージ";
    const socketPath = await fakeExtension((_line, socket) => {
      const payload = Buffer.from(
        `${JSON.stringify({ id: "req-1", ok: false, error: { code: "internal", message } })}\n`,
        "utf8",
      );
      // マルチバイト文字の途中で必ず割れる位置で切る
      const cut = payload.indexOf(Buffer.from("日", "utf8")) + 1;
      socket.write(payload.subarray(0, cut));
      setTimeout(() => socket.write(payload.subarray(cut)), 10);
    });
    const response = await callExtension(socketPath, TOKEN, request);
    expect(response.ok === false ? response.error.message : "").toBe(message);
  });

  it("接続が確立しないときは、応答用ではなく接続用の期限で諦める", async () => {
    // 繋がりも失敗もしないソケット。拡張ホストが起動中で accept まで届かない
    // 状態がこれにあたる。応答期限(長い)ではなく接続期限(短い)が効くこと。
    const stuck = new net.Socket();
    const started = Date.now();
    await expect(
      callExtension("/unused", TOKEN, request, {
        connectTimeoutMs: 50,
        callTimeoutMs: 60_000,
        createConnection: () => stuck,
      }),
    ).rejects.toThrow(/Connection to the VS Code socket was not established/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stuck.destroyed).toBe(true);
  });

  it("既定の期限は tools/list と tools/call で分かれている(設計書 §6.3)", () => {
    expect(CONNECT_TIMEOUT_MS).toBe(2000);
    expect(CALL_TIMEOUT_MS).toBe(5000);
  });
});

describe("NoWindowError の stale", () => {
  it("ソケットに触れもしなかったときは stale（その候補を外す）", async () => {
    const dead = path.join(dir, "nobody-here.sock");
    await expect(callExtension(dead, TOKEN, request)).rejects.toMatchObject({ stale: true });
  });

  it("繋がったが答えが返らないときは stale ではない（同じ窓へもう一度）", async () => {
    const socketPath = await fakeExtension(() => {});
    await expect(
      callExtension(socketPath, TOKEN, request, { callTimeoutMs: 100 }),
    ).rejects.toMatchObject({ stale: false });
  });

  it("接続が確立しないのも stale ではない（拡張ホストが起動中かもしれない）", async () => {
    const stuck = new net.Socket();
    await expect(
      callExtension("/unused", TOKEN, request, {
        connectTimeoutMs: 20,
        callTimeoutMs: 60_000,
        createConnection: () => stuck,
      }),
    ).rejects.toMatchObject({ stale: false });
  });

  it("答えの前に切られたのも stale ではない", async () => {
    const socketPath = await fakeExtension((_line, socket) => socket.destroy());
    await expect(callExtension(socketPath, TOKEN, request)).rejects.toMatchObject({ stale: false });
  });
});
