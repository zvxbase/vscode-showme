import type { WireRequestInput, WireResponse } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { NoWindowError, ProtocolError } from "./client.js";
import type { RegistryEntry } from "./discover.js";
import { CALL_ATTEMPTS, createSocketInvoker } from "./invoke.js";

const alpha: RegistryEntry = {
  protocolVersion: 1,
  workspacePath: "/w/alpha",
  pid: 1,
  startedAt: "2026-09-09T00:00:00Z",
  socketPath: "/rt/a.sock",
  authToken: "a".repeat(64),
  windowId: "win-alpha",
  role: "stage",
};
const beta: RegistryEntry = {
  ...alpha,
  workspacePath: "/w/beta",
  socketPath: "/rt/b.sock",
  windowId: "win-beta",
};

const listResult = {
  isTrusted: true,
  capabilities: { symbolResolution: true, terminalEnvInjection: true },
  permissions: { closeHumanTabs: false, closeDirtyTabs: false },
  features: { stage: true, html: true, layout: true },
  disabledTools: [],
  editorGroup: "dedicated",
  avoidToolColumns: false,
  panels: { max: 2 },
  otherWindowsListed: false,
};

function ok(request: WireRequestInput, result: Record<string, unknown>): WireResponse {
  return { id: request.id, ok: true, result };
}

/** 候補を順に返す発見器。呼ばれるたびに exclude を記録する。 */
function windows(entries: readonly RegistryEntry[], seenExcludes: string[][]) {
  return (exclude: readonly string[]): RegistryEntry => {
    seenExcludes.push([...exclude]);
    const usable = entries.filter((e) => !exclude.includes(e.socketPath));
    const first = usable[0];
    if (first === undefined) throw new NoWindowError("候補が尽きました");
    return first;
  };
}

describe("createSocketInvoker", () => {
  it("応答が返ればその結果を返す", async () => {
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => ok(request, listResult),
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).resolves.toEqual(listResult);
  });

  it("呼び出しを直列にする（拡張は同時接続を1本しか受け付けない）", async () => {
    // エージェントは複数のツール呼び出しを**並行して**投げてくる（Claude Code は
    // 1つの応答に複数の tool_use を載せる）。ブリッジは呼び出しごとに接続を
    // 張り直すので、直列にしないと2本目が拡張に拒否される
    // （packages/extension/src/server.ts の MAX_AUTHED_CONNECTIONS）。
    let inFlight = 0;
    let maxInFlight = 0;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return ok(request, listResult);
      },
      newId: () => "id-1",
    });

    await Promise.all([invoke("list_workspaces", {}), invoke("list_workspaces", {})]);
    expect(maxInFlight).toBe(1);
  });

  it("直列にしても、失敗した呼び出しが後続を道連れにしない", async () => {
    let calls = 0;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => {
        calls += 1;
        // 1回目の呼び出し（2回当たる）は必ず落ちる。
        if (calls <= CALL_ATTEMPTS) throw new NoWindowError("届かない");
        return ok(request, listResult);
      },
      newId: () => "id-1",
    });

    const first = invoke("list_workspaces", {});
    const second = invoke("list_workspaces", {});
    await expect(first).rejects.toThrow(NoWindowError);
    await expect(second).resolves.toEqual(listResult);
  });

  it("線上のスキーマに通した要求を送る（id 付き・ツール名つき）", async () => {
    let sent: WireRequestInput | undefined;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => {
        sent = request;
        return ok(request, listResult);
      },
      newId: () => "id-1",
    });
    await invoke("show_code", { locations: [{ path: "src/a.ts", text: "x" }] });
    expect(sent).toEqual({
      id: "id-1",
      tool: "show_code",
      args: { locations: [{ path: "src/a.ts", text: "x" }] },
    });
  });

  it("線上のスキーマに合わない引数は送る前に落ちる", async () => {
    let called = false;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => {
        called = true;
        return ok(request, listResult);
      },
      newId: () => "id-1",
    });
    await expect(invoke("show_code", { locations: [], pattern: ".*" })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("答えが返らないときは同じウィンドウへもう一度当たる（設計書 §6.3 の再試行1回）", async () => {
    // ここが実測で壊れていた箇所。ウィンドウが1つのとき、再試行が
    // 一度も起きずに5秒で諦めていた。
    const tried: string[] = [];
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (entry) => {
        tried.push(entry.socketPath);
        throw new NoWindowError("応答がありません", { stale: false });
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow(NoWindowError);
    expect(tried).toEqual(["/rt/a.sock", "/rt/a.sock"]);
  });

  it("当たる回数は上限まで（際限なく繰り返さない）", async () => {
    let calls = 0;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async () => {
        calls += 1;
        throw new NoWindowError("応答がありません", { stale: false });
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow(NoWindowError);
    expect(calls).toBe(CALL_ATTEMPTS);
  });

  it("死んでいたソケットは候補から外して選び直す", async () => {
    const excludes: string[][] = [];
    const tried: string[] = [];
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha, beta], excludes),
      call: async (entry, request) => {
        tried.push(entry.socketPath);
        if (entry.socketPath === alpha.socketPath) {
          throw new NoWindowError("繋がりません", { stale: true });
        }
        return ok(request, listResult);
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).resolves.toEqual(listResult);
    expect(tried).toEqual(["/rt/a.sock", "/rt/b.sock"]);
    expect(excludes).toEqual([[], ["/rt/a.sock"]]);
  });

  it("拡張が拒否したら再試行しない（同じ答えが返るだけ）", async () => {
    let calls = 0;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async (_entry, request) => {
        calls += 1;
        return { id: request.id, ok: false, error: { code: "disabled", message: "止めています" } };
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow(/disabled/);
    expect(calls).toBe(1);
  });

  it("線上の約束を破った応答も再試行しない", async () => {
    let calls = 0;
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async () => {
        calls += 1;
        throw new ProtocolError("id が違います");
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow(ProtocolError);
    expect(calls).toBe(1);
  });

  it("1回目の発見に失敗したら、その診断をそのまま返す", async () => {
    const invoke = createSocketInvoker({
      resolveWindow: () => {
        throw new NoWindowError("実行時ディレクトリがありません");
      },
      call: async (_entry, request) => ok(request, listResult),
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow("実行時ディレクトリがありません");
  });

  it("候補が尽きたときは「届かなかった」理由のほうを返す", async () => {
    // 「候補が尽きました」より「繋がりません」のほうが直せる情報を持つ。
    const invoke = createSocketInvoker({
      resolveWindow: windows([alpha], []),
      call: async () => {
        throw new NoWindowError("繋がりません: ENOENT", { stale: true });
      },
      newId: () => "id-1",
    });
    await expect(invoke("list_workspaces", {})).rejects.toThrow("ENOENT");
  });
});
