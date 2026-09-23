import {
  type ToolName,
  type WireRequestInput,
  type WireResponse,
  requestSchema,
} from "@zvx/vscode-showme-protocol";
import { NoWindowError } from "./client.js";
import type { RegistryEntry } from "./discover.js";
import type { ToolInvoker } from "./mcp-server.js";

/**
 * 1回のツール呼び出しで拡張に当たる回数。
 *
 * 設計書 §6.3 の「`tools/call` は 5秒＋再試行1回」。
 */
export const CALL_ATTEMPTS = 2;

export interface InvokerDeps {
  /** 繋ぐウィンドウを決める。届かなかった候補は `exclude` で渡される。 */
  resolveWindow: (exclude: readonly string[]) => RegistryEntry;
  /** 線に書く。渡るのは**広告面の形**（transform 前）であって、検証した出力ではない。 */
  call: (entry: RegistryEntry, request: WireRequestInput) => Promise<WireResponse>;
  newId: () => string;
}

/**
 * 発見・接続・再試行をまとめて、ツール1回分の呼び出しにする。
 *
 * I/O は注入する。ここに入っているのは「いつもう一度当たるか」という判断だけで、
 * それは実測で一度壊した箇所（届かない種類を区別せずに候補から外していたので、
 * ウィンドウが1つのとき再試行が一度も起きなかった）。純粋な形にして検査に晒す。
 */
export function createSocketInvoker(deps: InvokerDeps): ToolInvoker {
  /**
   * 直前の呼び出しの尻尾。**呼び出しを直列にする。**
   *
   * エージェントは複数のツール呼び出しを並行して投げてくる（Claude Code は
   * 1つの応答に複数の `tool_use` を載せる）。ブリッジは呼び出しごとに接続を
   * 張り直すので、並行に投げると2本目が拡張の同時接続制限（1本・設計書 §3.5 /
   * D21）に当たって拒否される ―― 攻撃でも何でもない、正規の呼び出しが。
   *
   * 失敗しても列は進める（`catch` して void にする）。1回失敗した呼び出しが
   * 以降の呼び出しを全部道連れにするのは、最も直しにくい壊れ方である。
   */
  let tail: Promise<void> = Promise.resolve();

  return (tool: ToolName, args: unknown): Promise<unknown> => {
    const mine = tail.then(() => invokeOnce(deps, tool, args));
    tail = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };
}

/** 1回分。発見・接続・再試行はここに閉じている。 */
async function invokeOnce(deps: InvokerDeps, tool: ToolName, args: unknown): Promise<unknown> {
  // 線上の形の唯一の定義元は protocol。ブリッジが組み立て直さない
  // （拡張も同じスキーマで再検証する。信頼境界はブリッジではなくソケットなので、
  // 二重に見るのが正しい）。
  //
  // **線に乗せるのは広告面の形（transform 前）。検証はするが、送るのは生の envelope。**
  // `requestSchema.parse` の出力は transform 後（`show_html` なら `{ kind, slot }` 入り）で、
  // それを線に書くと拡張の `requestSchema.safeParse` の `.strict()` が `kind` を知らない
  // 鍵として落とし、`{ html }` も `{ path }` も**1度も届かない**。`run → invokeOnce`
  // の二重 parse を消したとき、同じ二重 parse が `invokeOnce → 拡張` に1段ずれただけだった
  // （実機で見つかった。合成検査が偽の `call` で止まっていて、線の向こうの parse を
  // 組んでいなかった）。**transform は各側でちょうど1回**: ブリッジはここで、拡張は入口で。
  const envelope = { id: deps.newId(), tool, args };
  requestSchema.parse(envelope);
  // 通ったので `envelope` は入力型を満たす（zod は入力を返さないので、ここで名指しする）。
  const request = envelope as WireRequestInput;

  const exclude: string[] = [];
  let undelivered: NoWindowError | undefined;

  for (let attempt = 1; attempt <= CALL_ATTEMPTS; attempt += 1) {
    let entry: RegistryEntry;
    try {
      entry = deps.resolveWindow(exclude);
    } catch (e) {
      // 候補が尽きたなら、言うべきは「候補が尽きた」ではなく「届かなかった」
      // ほう（そちらだけが直せる情報を持っている）。1回目なら発見の診断を返す。
      throw undelivered ?? e;
    }

    try {
      const response = await deps.call(entry, request);
      if (response.ok) return response.result;
      // 拡張が意図して拒否した答え。もう一度聞いても同じなので繰り返さない。
      throw new Error(
        `VS Code refused the request (${response.error.code}): ${response.error.message}`,
      );
    } catch (e) {
      if (!(e instanceof NoWindowError)) throw e;
      undelivered = e;
      // 触れもしなかった候補だけを外す。答えが返らなかっただけの相手は、
      // 拡張ホストが起動中かもしれないので同じ相手にもう一度当たる。
      if (e.stale) exclude.push(entry.socketPath);
    }
  }

  throw undelivered ?? new NoWindowError("The request did not reach any VS Code window");
}
