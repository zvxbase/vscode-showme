import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo, Socket } from "node:net";

/**
 * egress の**受信側**。2C の完了条件（設計書 §4.4）の観測点。
 *
 * ## なぜ http だけでは足りないか
 *
 * 増分2B の画像 egress の検査は、最初の版が `http://127.0.0.1` だけを待ち受けていた。
 * ところがワークベンチ側の CSP の `img-src` は `https:` を許して `http:` を許さない
 * ―― つまり**危険な実装に差し替えても検査は緑のまま**だった。ログが空であることは、
 * **その宛先とその scheme に実際に届きうる**ことを確かめていない限り、何も言っていない。
 *
 * だからここは3つを数える:
 *
 * 1. http の要求
 * 2. https の要求
 * 3. **裸の TCP 接続**（TLS 握手に至らなかったものも含む）
 *
 * 3つ目が要るのは、`preconnect` のように**要求を出さずに繋ぐだけ**の経路があるからで、
 * 加えて自己署名証明書を拒否したブラウザは要求まで進まない ―― それでも
 * 「出て行こうとした」ことは接続の時点で確定している。
 */

/** 観測した1件。**内容は記録しない**（我々の検査自体を漏洩の面にしない）。 */
export interface EgressHit {
  kind: "http-request" | "https-request" | "tcp-connect";
  scheme: "http" | "https";
  /** 要求のときだけ。パスの先頭 200 文字（どの攻撃が通ったかを見分けるため）。 */
  path?: string;
}

export interface EgressReceiver {
  readonly httpPort: number;
  readonly httpsPort: number;
  /** これまでに観測したもの。 */
  hits(): readonly EgressHit[];
  /** 数え直す（判別確認の前後で使う）。 */
  reset(): void;
  close(): Promise<void>;
}

/**
 * https 側は**平文の TCP サーバ**にしてある。証明書を用意しない。
 *
 * 自己署名の証明書を作っても Chromium は握手を拒否するので、どのみち要求は
 * 完了しない。**我々が数えたいのは「繋ぎに来たか」**であって中身ではないので、
 * 接続を数えられれば足りる。鍵をリポジトリに置かずに済むという副産物もある
 * （使い道が検査だけでも、置いてある鍵は次に読む人には区別が付かない）。
 */
export async function startEgressReceiver(): Promise<EgressReceiver> {
  const hits: EgressHit[] = [];

  const countConnection = (scheme: "http" | "https") => (socket: Socket) => {
    hits.push({ kind: "tcp-connect", scheme });
    // 握手が成立しなくても接続は数えた。相手を待たせない。
    socket.on("error", () => {});
  };

  const httpServer = http.createServer((req, res) => {
    hits.push({ kind: "http-request", scheme: "http", path: (req.url ?? "").slice(0, 200) });
    res.writeHead(204).end();
  });
  httpServer.on("connection", countConnection("http"));

  const httpsServer = net.createServer(countConnection("https"));

  const listen = (server: http.Server | net.Server): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

  const httpPort = await listen(httpServer);
  const httpsPort = await listen(httpsServer);

  return {
    httpPort,
    httpsPort,
    hits: () => [...hits],
    reset: () => {
      hits.length = 0;
    },
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
        new Promise<void>((resolve) => httpsServer.close(() => resolve())),
      ]);
    },
  };
}
