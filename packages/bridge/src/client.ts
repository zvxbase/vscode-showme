import * as net from "node:net";
import {
  WIRE_PROTOCOL_VERSION,
  type WireRequestInput,
  type WireResponse,
  responseSchema,
} from "@zvx/vscode-showme-protocol";

/**
 * 接続を確立するまでの猶予。
 *
 * 一律 2 秒だった v1 は、devcontainer 起動直後や大規模ワークスペースの
 * 拡張ホスト起動中に偽陰性を出した（設計書 §6.3）。接続と応答で分ける。
 */
export const CONNECT_TIMEOUT_MS = 2000;

/** 要求を投げてから応答が返るまでの猶予。 */
export const CALL_TIMEOUT_MS = 5000;

/**
 * 1応答として受け取る最大バイト数。
 *
 * 拡張側の行長上限（`packages/extension/src/server.ts` の `MAX_LINE_BYTES`）と
 * 同じ値。同一 uid の別プロセスが拡張のふりをして繋がりうる以上、受け側にも
 * 上限が要る（無いと改行を送らないまま無限に食わせられる）。
 */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * VS Code に届かなかった。**再試行してよい**失敗。
 *
 * `stale` で2種類を区別する。混ぜると再試行が壊れる（実測: 混ぜていたせいで
 * ウィンドウが1つのとき再試行が一度も起きなかった）。
 *
 * - `stale: true` — ソケットにそもそも触れなかった（ENOENT / 接続拒否）。
 *   登録ファイルが死骸なので、**その候補を外して**別を探す。同じパスへ
 *   投げ直しても同じ答えしか返らない
 * - `stale: false` — 繋がった、あるいは繋がりかけたが答えが返らなかった。
 *   拡張ホストが起動中なだけかもしれないので、**同じウィンドウへもう一度**。
 *   設計書 §6.3 が「5秒＋再試行1回」と言っているのはこちら
 */
export class NoWindowError extends Error {
  readonly stale: boolean;

  constructor(message: string, options: { stale?: boolean } = {}) {
    super(message);
    this.name = "NoWindowError";
    this.stale = options.stale ?? false;
  }
}

/**
 * 届いたが、線上の約束を守っていない応答だった。
 *
 * **再試行しない**失敗。同じ相手が同じ壊れ方を繰り返すだけで、
 * 「もう一度聞けば直る」たぐいの失敗ではない。
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface CallOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** 検査用の継ぎ目。既定は `net.createConnection`。 */
  createConnection?: (socketPath: string) => net.Socket;
}

/**
 * 1回の呼び出しにつき1本の接続を張り、1行送って1行受け取って閉じる。
 *
 * 接続を使い回さない。拡張は同時接続を1本に絞って2本目を人間に見せる設計
 * （設計書 §3.5）なので、握りっぱなしにすると「エージェントが1本占有している」
 * という状態が常態化して、可視化が意味を失う。
 */
export function callExtension(
  socketPath: string,
  token: string,
  request: WireRequestInput,
  options: CallOptions = {},
): Promise<WireResponse> {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const createConnection = options.createConnection ?? ((p: string) => net.createConnection(p));

  return new Promise<WireResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    // 期限は2段。接続が立つまでは接続用の短い期限、立ったら応答用の期限に
    // 差し替える。同時に走らせないので、控えは1つでよい。
    let timer: NodeJS.Timeout | undefined;

    // 成否にかかわらず、必ず1度だけ決着させて必ずソケットを畳む。
    // 決着後に届く close / error は無視する（resolve 済みの Promise を
    // reject しても静かに無視されるだけなので、そこに頼らない）。
    const settle = (error: Error | undefined, value?: WireResponse): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
    };

    timer = setTimeout(() => {
      settle(
        new NoWindowError(
          `Connection to the VS Code socket was not established within ${connectTimeoutMs}ms: ${socketPath}`,
        ),
      );
    }, connectTimeoutMs);

    socket.on("connect", () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(new NoWindowError(`No response from VS Code within ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      // ハンドシェイクと要求は1回の write にまとめる。分けても意味は同じだが、
      // 分けたときだけ「hello の直後に切られる」という中間状態を作ってしまう。
      const hello = JSON.stringify({ protocolVersion: WIRE_PROTOCOL_VERSION, token });
      socket.write(`${hello}\n${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      if (settled) return;
      // Buffer のまま繋ぐ。チャンクごとに toString すると、マルチバイト文字が
      // 境界で割れたときに黙って壊れる。
      received = Buffer.concat([received, chunk]);
      const nl = received.indexOf(0x0a);
      if (nl < 0) {
        if (received.length > MAX_RESPONSE_BYTES) {
          settle(
            new ProtocolError(`Response from VS Code is too long (over ${MAX_RESPONSE_BYTES}B)`),
          );
        }
        return;
      }
      // 2行目以降は読まない。1要求1応答で閉じる。
      const line = received.subarray(0, nl).toString("utf8");
      try {
        settle(undefined, parseResponse(line, request.id));
      } catch (e) {
        // イベントハンドラの中で投げると Promise ではなくプロセスに届く。
        settle(e instanceof Error ? e : new ProtocolError(String(e)));
      }
    });

    socket.on("error", (e) => {
      // 触れもしなかった。登録ファイルが死骸だと見て、この候補は外す。
      settle(
        new NoWindowError(`Cannot connect to the VS Code socket: ${e.message}`, { stale: true }),
      );
    });

    socket.on("close", () => {
      settle(new NoWindowError("The connection to VS Code was closed before a response arrived"));
    });
  });
}

/**
 * 応答の1行を線上のスキーマに当てる。
 *
 * `id` の一致もここで見る。1接続1要求なので普段はずれようがないが、
 * ずれた応答を黙って受け取ると「別の要求の答え」をエージェントに手渡す
 * 経路が1本できる。
 */
function parseResponse(line: string, expectedId: string): WireResponse {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new ProtocolError("Response from VS Code is not JSON");
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProtocolError(
      `Response from VS Code does not match the wire schema: ${parsed.error.message}`,
    );
  }
  if (parsed.data.id !== expectedId) {
    throw new ProtocolError(
      `Response id from VS Code does not match the request (request ${expectedId} / response ${parsed.data.id})`,
    );
  }
  return parsed.data;
}
