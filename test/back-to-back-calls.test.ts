import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callExtension } from "../packages/bridge/src/client.js";
import { type ConnectionObserver, ShowMeSocketServer } from "../packages/extension/src/server.js";
import { currentUserSid, lockPrivateDir } from "../packages/protocol/src/windows-acl-io.js";

/**
 * ブリッジは呼び出しごとに接続を張り直し、拡張は認証済みの接続を同時に1本しか受けない
 * （設計書 §3.5 / D21）。**続けて呼んだ2回目が「2本目の同時接続」として断られてはならない。**
 *
 * Windows の名前付きパイプでは、クライアントが閉じたことをサーバが知るのが遅い（Task 3 で実測）。
 * ブリッジが応答を受け取ってすぐ次の接続を張ると、サーバはまだ前の接続を数えていて断っていた。
 * 本物のクライアント（`callExtension`）と本物のサーバを、本物のソケット / パイプで繋いで確かめる。
 * パッケージ境界をまたぐので、ルートの `test/` に置く。
 *
 * **POSIX ではこの検査は古い振る舞いと新しい振る舞いを見分けない**（UNIX ドメインソケットでは
 * 切断がすぐ届くので、直す前も通っていた。1000 回でも実測で落ちない）。見分けるのは Windows の
 * 名前付きパイプの上だけである。POSIX での守りは `packages/extension/test/server.test.ts` の
 * 「答えを返した接続はサーバが閉じて枠を返す」（1本目を閉じずに2本目を繋ぐ。どの OS でも決定的）。
 */

const onWindows = process.platform === "win32";
const made: string[] = [];

/**
 * 実行時ディレクトリの親。Windows は自分で締めたフォルダ（拡張は他人が中に作れる親を断る。D104）、
 * macOS は `/tmp` の下の短い名前（`sun_path` の上限。D108）。
 */
let base: string | undefined;
beforeAll(async () => {
  if (onWindows) {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
    await lockPrivateDir(base, await currentUserSid());
  } else {
    base = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "bb-"));
  }
});
afterAll(() => {
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
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

describe("続けて呼んでも断られない（本物のクライアントとサーバ）", () => {
  it("20 回続けて呼んで、全部が答えを受け取る", async () => {
    const events = recorder();
    const server = new ShowMeSocketServer(
      [runtimeDir()],
      async () => ({ ok: true }),
      "",
      events.observer,
    );
    const info = await server.start();
    try {
      const results: boolean[] = [];
      for (let i = 0; i < 20; i += 1) {
        const response = await callExtension(info.socketPath, info.token, {
          id: `call-${i}`,
          tool: "list_workspaces",
          args: {},
        });
        results.push(response.ok);
      }
      expect(events.rejected).toEqual([]);
      expect(results).toEqual(Array.from({ length: 20 }, () => true));
      expect(events.accepted).toHaveLength(20);
    } finally {
      await server.stop();
    }
  });
});
