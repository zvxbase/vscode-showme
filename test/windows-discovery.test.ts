import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callExtension } from "../packages/bridge/src/client.js";
import { discoverRegistry, selectWindow } from "../packages/bridge/src/discover.js";
import { ShowMeSocketServer } from "../packages/extension/src/server.js";
import { currentUserSid, lockPrivateDir } from "../packages/protocol/src/windows-acl-io.js";

/**
 * ネイティブの Windows で、拡張が書いた登録をブリッジが見つけて繋がる（D104 のブリッジ側）。
 *
 * 本物の icacls / whoami で候補の DACL を確かめ（`discoverRegistry`）、本物の名前付きパイプに
 * 本物のクライアントで繋ぐ。拡張とブリッジの**間の契約**なので、ルートの `test/` に置く。
 */
describe.runIf(process.platform === "win32")("Windows: 登録を見つけて繋がる（本物の DACL）", () => {
  let base: string;
  beforeAll(async () => {
    // 他人が中に作れない親（拡張は、そうでない親の下には立たない）。
    base = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    await lockPrivateDir(base, await currentUserSid());
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("拡張が立てた窓を見つけ、選び、呼べる", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(base, "a-")), "vscode-showme-0");
    const server = new ShowMeSocketServer([dir], async () => ({ ok: true }), "C:\\w", undefined, {
      windowId: "win-under-test",
      role: () => "stage",
    });
    const info = await server.start();
    try {
      const read = await discoverRegistry([dir]);
      expect(read.unsafe).toEqual([]);
      expect(read.entries.map((e) => e.windowId)).toEqual(["win-under-test"]);
      const selection = selectWindow(read.entries, {});
      expect(selection.ok).toBe(true);
      if (!selection.ok) return;
      expect(selection.entry.socketPath).toBe(info.socketPath);
      const response = await callExtension(selection.entry.socketPath, selection.entry.authToken, {
        id: "1",
        tool: "list_workspaces",
        args: {},
      });
      expect(response.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("他人（Everyone）が読める実行時ディレクトリは読まず、理由を持ち帰る", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(base, "b-")), "vscode-showme-0");
    const server = new ShowMeSocketServer([dir], async () => ({ ok: true }), "C:\\w", undefined, {
      windowId: "win-loose",
      role: () => "stage",
    });
    await server.start();
    try {
      // 立った後で緩める（拡張は立つ前に確かめるので、緩いものの下には立たない）。
      const icacls = path.win32.join(String(process.env.SystemRoot), "System32", "icacls.exe");
      execFileSync(icacls, [dir, "/grant", "*S-1-1-0:(OI)(CI)R"]);
      const read = await discoverRegistry([dir]);
      expect(read.entries).toEqual([]);
      expect(read.unsafe.map((u) => u.dir)).toEqual([dir]);
    } finally {
      await server.stop();
    }
  });
});
