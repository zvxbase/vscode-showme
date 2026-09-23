#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SOCKET_ENV_VAR } from "@zvx/vscode-showme-protocol";
import { NoWindowError, callExtension } from "./client.js";
import {
  type RegistryEntry,
  defaultRuntimeDirs,
  describeSelectionFailure,
  describeUnsafeRuntimeDir,
  nodeRegistryFileSystem,
  readRegistryEntries,
  selectWindow,
} from "./discover.js";
import { createSocketInvoker } from "./invoke.js";
import { createShowMeServer } from "./mcp-server.js";

/**
 * 繋ぐウィンドウを決める。呼び出しのたびにやり直す。
 *
 * 起動時に1度だけ決めない。VS Code は**ブリッジより後に立ち上がりうる**し、
 * ウィンドウの再読み込みでソケットが変わる。1度掴んだら離さない作りにすると、
 * 「一度失敗したセッションは二度と繋がらない」ことになる。
 */
function resolveWindow(exclude: readonly string[]): RegistryEntry {
  const read = readRegistryEntries(defaultRuntimeDirs(), nodeRegistryFileSystem);

  const selection = selectWindow(read.entries, {
    // $SHOWME_SOCK は主経路ではない（制限モードで死に、tmux でも伝播しない）。
    // 役割で絞った後の同点解決にだけ効く（設計書 §2A.5）。
    // workspace_path はエージェント入力なので、ここでは渡さない。
    sock: process.env[SOCKET_ENV_VAR],
    exclude,
  });
  if (selection.ok) return selection.entry;

  // 衛生検査に落ちた候補があって、なお1件も読めなかったのなら、それが理由である。
  // 読めた候補があるなら、落ちた候補は繋がらない原因ではない（そちらを名指しすると、
  // /tmp に先回りするだけで「安全ではありません」を出し続けられる）。
  const blocked = read.entries.length === 0 ? read.unsafe[0] : undefined;
  if (blocked !== undefined) {
    throw new NoWindowError(describeUnsafeRuntimeDir(blocked.reason, blocked.dir));
  }
  throw new NoWindowError(describeSelectionFailure(selection, read));
}

/**
 * 起動する。
 *
 * **ここでソケットにも登録ファイルにも触らない。** MCP サーバの起動が詰まると
 * エージェント本体の起動が詰まる（設計書 §6.3）。VS Code が居るかどうかは
 * `tools/call` の中で初めて調べる。だから VS Code 不在でも起動は成功し、
 * `tools/list` は既定の一覧を返す。
 */
async function main(): Promise<void> {
  const server = createShowMeServer(
    createSocketInvoker({
      resolveWindow,
      call: (entry, request) => callExtension(entry.socketPath, entry.authToken, request),
      newId: randomUUID,
    }),
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  // stdout は JSON-RPC 専用。診断は必ず stderr へ。
  process.stderr.write(`vscode-showme-bridge failed to start: ${String(e)}\n`);
  process.exit(1);
});
