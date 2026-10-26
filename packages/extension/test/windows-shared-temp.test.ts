import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  currentUserSid,
  lockPrivateDir,
  runtimeDirCandidates,
  verifyRuntimeDirWindows,
} from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ShowMeSocketServer } from "../src/server.js";

/**
 * エージェントのサンドボックスが `%TEMP%` に他の主体の「変更」を継承つきで足した状況
 * （Codex の Windows サンドボックスの `CodexSandboxUsers:(OI)(CI)(M)`）を本物の Windows で作り、
 * 判定を緩めずに `%LOCALAPPDATA%` の候補で立つことを確かめる（D125）。
 *
 * 他の主体には組み込みの Users（S-1-5-32-545）を使う。サンドボックスのグループと同じく、信頼しない主体である。
 */
const onWindows = process.platform === "win32";
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const made: string[] = [];

function fresh(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "showme-shared-temp-"));
  made.push(d);
  return d;
}

afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.runIf(onWindows)("%TEMP% に他の主体の変更があっても %LOCALAPPDATA% で立つ（D125）", () => {
  // icacls を十数回起動するので、既定の 5 秒では混んだ runner で足りなくなりうる。
  it(
    "候補の並びで %TEMP% だけが落ち、登録は %LOCALAPPDATA% の側にだけ書かれ、ブリッジの判定も同じ",
    { timeout: 30_000 },
    async () => {
      const sid = await currentUserSid();
      const local = fresh();
      await lockPrivateDir(local, sid);
      const temp = fresh();
      await lockPrivateDir(temp, sid);
      execFileSync(path.join(SYSTEM32, "icacls.exe"), [temp, "/grant", "*S-1-5-32-545:(OI)(CI)M"], {
        windowsHide: true,
      });

      const dirs = runtimeDirCandidates({ LOCALAPPDATA: local }, temp, 0, "win32");
      expect(dirs).toEqual([path.join(local, "vscode-showme"), path.join(temp, "vscode-showme-0")]);

      const server = new ShowMeSocketServer(dirs, async () => ({}));
      const info = await server.start();
      try {
        expect(info.registryPaths.map((p) => path.dirname(p))).toEqual([dirs[0]]);
        expect(info.unprepared.map((u) => u.dir)).toEqual([dirs[1]]);
        expect(info.unprepared[0]?.reason).toContain(`icacls "${temp}"`);
        expect(fs.existsSync(dirs[1] as string)).toBe(false);
        // ブリッジが通す関数でも、同じ答え（不変条件14）
        await expect(verifyRuntimeDirWindows(dirs[0] as string)).resolves.toEqual({ ok: true });
        // 親の確認が先なので、在らないからではなく親の DACL で断られている
        const v = await verifyRuntimeDirWindows(dirs[1] as string);
        const reason = v.ok ? "" : v.reason;
        expect(reason).toContain("Other users can create or replace entries in");
        expect(reason).toContain(`icacls "${temp}"`);
      } finally {
        await server.stop();
      }
    },
  );
});
