import * as net from "node:net";
import {
  HANDSHAKE_REFUSALS,
  MAX_HANDSHAKE_LINE_BYTES,
  type WireRequestInput,
  type WireResponse,
  clientProofLine,
  helloLine,
  newHandshakeNonce,
  parseServerProofLine,
  responseSchema,
  verifyServerProof,
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
  /**
   * この接続先を書いた登録ファイル。相手がトークンを持つと証明できなかったとき、人間に消すファイルを
   * 名指す（D111）。窓の再読み込みでは、死んだ窓の残した登録は消えない。
   */
  registryFile?: string | undefined;
  /** 検査用の継ぎ目。既定は `net.createConnection`。 */
  createConnection?: (socketPath: string) => net.Socket;
}

/**
 * 1回の呼び出しにつき1本の接続を張り、ハンドシェイクの後に1行送って1行受け取って閉じる。
 *
 * 接続を使い回さない。拡張は同時接続を1本に絞って2本目を人間に見せる設計
 * （設計書 §3.5）なので、握りっぱなしにすると「エージェントが1本占有している」
 * という状態が常態化して、可視化が意味を失う。
 *
 * **相手がトークンを持つことを確かめるまで、要求を送らない**（増分11 D111。手順は protocol の
 * `handshake.ts`）。hello（clientNonce だけ）を送り、拡張の証明を `verifyServerProof` で確かめてから、
 * こちらの証明と要求を1回の write で送る。確かめられなければ `ProtocolError`（再試行しない）。
 * 登録が死骸で、同じ名前のパイプを別の誰かが作っていても、トークンも要求も渡らず、偽の答えも
 * 受け取らない。
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
    /** 拡張の証明を確かめたか。確かめるまでは要求を送らず、届く行は証明として読む。 */
    let proven = false;
    const clientNonce = newHandshakeNonce();
    // 期限は2段。接続が立つまでは接続用の短い期限、立ったら応答用の期限に
    // 差し替える。同時に走らせないので、控えは1つでよい。ハンドシェイクは応答用の期限に含める。
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
      socket.write(`${helloLine(clientNonce)}\n`);
    });

    socket.on("data", (chunk) => {
      if (settled) return;
      // Buffer のまま繋ぐ。チャンクごとに toString すると、マルチバイト文字が
      // 境界で割れたときに黙って壊れる。
      received = Buffer.concat([received, chunk]);
      const nl = received.indexOf(0x0a);
      if (nl < 0) {
        // 証明を確かめる前の相手には、ハンドシェイクの上限（拡張と同じ値。D27）しか積ませない。
        if (!proven && received.length > MAX_HANDSHAKE_LINE_BYTES) {
          settle(
            new ProtocolError(
              `Handshake from ${socketPath} is too long (over ${MAX_HANDSHAKE_LINE_BYTES}B); not sending the request`,
            ),
          );
        } else if (received.length > MAX_RESPONSE_BYTES) {
          settle(
            new ProtocolError(`Response from VS Code is too long (over ${MAX_RESPONSE_BYTES}B)`),
          );
        }
        return;
      }
      const line = received.subarray(0, nl).toString("utf8");
      if (!proven) {
        if (nl > MAX_HANDSHAKE_LINE_BYTES) {
          settle(
            new ProtocolError(
              `Handshake from ${socketPath} is too long (over ${MAX_HANDSHAKE_LINE_BYTES}B); not sending the request`,
            ),
          );
          return;
        }
        const verdict = checkServerProof(
          line,
          token,
          clientNonce,
          socketPath,
          options.registryFile,
        );
        if (verdict instanceof ProtocolError) {
          settle(verdict);
          return;
        }
        received = received.subarray(nl + 1);
        // 拡張は証明を書いたら、こちらの証明を受け取るまで何も書かない。先に届いたバイトは
        // 答えではありえない（読むと「要求を送る前に書かれた答え」を受け取ることになる）。
        if (received.length > 0) {
          settle(
            new ProtocolError(
              `The process listening at ${socketPath} sent data before the handshake finished; not sending the request`,
            ),
          );
          return;
        }
        proven = true;
        // 証明と要求は1回の write にまとめる。分けたときだけ「証明の直後に切られる」という
        // 中間状態ができる（拡張の側の予算は D27 で行ごとに数えるので、まとめても同じ答えになる）。
        const proofLine = clientProofLine(token, clientNonce, verdict.serverNonce);
        socket.write(`${proofLine}\n${JSON.stringify(request)}\n`);
        return;
      }
      // 2行目以降は読まない。1要求1応答で閉じる。
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

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(Object.values(HANDSHAKE_REFUSALS));

/**
 * 拡張の証明の行を確かめる。通れば serverNonce（こちらの証明に使う）、通らなければ返すエラー。
 *
 * 証明の代わりに**理由の行**（D28。認証と無関係な切断）が来ることがある。その言葉は、
 * protocol の `HANDSHAKE_REFUSALS` のどれかと一致するときだけエージェントに見せる ――
 * 相手はまだ拡張だと分かっていないので、任意の文をそのまま渡すと、横取りした相手の書いた文が
 * 拡張の言葉としてエージェントに届く。
 */
function checkServerProof(
  line: string,
  token: string,
  clientNonce: string,
  socketPath: string,
  registryFile: string | undefined,
): { serverNonce: string } | ProtocolError {
  const proof = parseServerProofLine(line);
  if (proof !== undefined) {
    if (verifyServerProof(token, clientNonce, proof.serverNonce, proof.proof)) {
      return { serverNonce: proof.serverNonce };
    }
  } else {
    const refusal = knownRefusal(line);
    if (refusal !== undefined)
      return new ProtocolError(`VS Code refused the connection: ${refusal}`);
  }
  // 窓の再読み込みを勧めない。再読み込みした窓は新しい名前で登録し直すだけで、ここで繋いだ古い
  // 登録は残り、呼ぶたびに同じ失敗になる（死んだ窓の pid が別のプロセスに再利用されていると、
  // pid の生死でも外れない）。
  const file =
    registryFile === undefined
      ? "the registration file for this address in the ShowMe runtime directory"
      : `the registration file ${registryFile}`;
  return new ProtocolError(
    [
      `The process listening at ${socketPath} did not prove that it holds this window's token, `,
      "so the request was not sent. Another process is answering on that name: the registration is ",
      "probably left over from a VS Code window that is no longer running. If no open VS Code window ",
      `uses it, delete ${file}; reloading a window does not remove it.`,
    ].join(""),
  );
}

function knownRefusal(line: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success || parsed.data.ok) return undefined;
  const message = parsed.data.error.message;
  return KNOWN_REFUSALS.has(message) ? message : undefined;
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
