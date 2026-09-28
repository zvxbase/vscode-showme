import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ClientProof,
  NONCE_HEX_LENGTH,
  PROOF_HEX_LENGTH,
  type ServerProof,
  TOKEN_HEX_LENGTH,
  WIRE_PROTOCOL_VERSION,
  clientProofSchema,
  helloSchema,
  serverProofSchema,
} from "./wire.js";

/**
 * ブリッジと拡張の相互認証（増分11 D111）。**両端がこの関数を通す**（不変条件14）。
 *
 * v1 のブリッジは、登録の `socketPath` に繋いだ直後に hello でトークンを生で送り、同じ write で
 * 要求も送っていた。Windows の名前付きパイプの名前はマシン全体で共有され列挙できるので、拡張が
 * 登録を消さずに死んだ後（クラッシュ・kill・再起動）に別の利用者が同じ名前のパイプを作ると、
 * トークンと要求を受け取り、偽の答え（人間の選択など）を返せた。ブリッジは相手がトークンを
 * 持っていることを確かめていなかった。
 *
 * いまは次の3行で、どちらの側もトークンそのものを線に乗せずに、相手がトークンを持つことを確かめる:
 *
 * 1. ブリッジ → 拡張: `{ protocolVersion, clientNonce }`
 * 2. 拡張 → ブリッジ: `{ serverNonce, proof: HMAC(トークン, サーバのラベル || clientNonce || serverNonce) }`
 * 3. ブリッジ → 拡張: `{ proof: HMAC(トークン, クライアントのラベル || serverNonce || clientNonce) }` と要求
 *
 * - **向きごとにラベルを分ける**（片方の証明をもう片方の証明として使い回せない）。ラベルは同じ長さで、
 *   nonce も固定長なので、連結の区切りは曖昧にならない
 * - ブリッジは 2 を確かめてから 3 を送る。確かめられなければ要求を送らない
 * - 拡張は 3 を確かめてから要求を読む。落ちたら今までの誤ったトークンと同じく**無言で**切る（D28）
 * - 同じ接続の serverNonce は拡張が毎回作るので、盗み見た 3 を別の接続で使い回せない
 * - 照合は定数時間（`timingSafeEqual`）。形（小文字 hex・長さ）は照合の前に見る
 */

export const HANDSHAKE_SERVER_LABEL = `showme-server-v${WIRE_PROTOCOL_VERSION}`;
export const HANDSHAKE_CLIENT_LABEL = `showme-client-v${WIRE_PROTOCOL_VERSION}`;

const HEX = /^[0-9a-f]*$/;

function isLowerHex(value: string, length: number): boolean {
  return value.length === length && HEX.test(value);
}

/** 1回の接続で使う nonce（32 バイトの乱数の hex）。 */
export function newHandshakeNonce(): string {
  return randomBytes(NONCE_HEX_LENGTH / 2).toString("hex");
}

/**
 * HMAC-SHA256(トークン, ラベル || first || second)。
 *
 * **形の違う入力で黙って作らない。** `Buffer.from(x, "hex")` は壊れた hex を黙って切り詰めるので、
 * 形を見ずに作ると、短い鍵や短い nonce で証明ができてしまう。
 */
function mac(label: string, token: string, first: string, second: string): Buffer {
  if (!isLowerHex(token, TOKEN_HEX_LENGTH)) throw new Error("token is not 64 lowercase hex");
  if (!isLowerHex(first, NONCE_HEX_LENGTH) || !isLowerHex(second, NONCE_HEX_LENGTH)) {
    throw new Error("nonce is not 64 lowercase hex");
  }
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(Buffer.from(label, "utf8"))
    .update(Buffer.from(first, "hex"))
    .update(Buffer.from(second, "hex"))
    .digest();
}

/** 拡張がブリッジに見せる証明。 */
export function serverProof(token: string, clientNonce: string, serverNonce: string): string {
  return mac(HANDSHAKE_SERVER_LABEL, token, clientNonce, serverNonce).toString("hex");
}

/** ブリッジが拡張に見せる証明。nonce の順もサーバの証明と逆にする。 */
export function clientProof(token: string, clientNonce: string, serverNonce: string): string {
  return mac(HANDSHAKE_CLIENT_LABEL, token, serverNonce, clientNonce).toString("hex");
}

/** 定数時間で比べる。形が違う入力は例外にせず false（相手の入力で投げない）。 */
function sameProof(
  expected: () => Buffer,
  token: string,
  clientNonce: string,
  serverNonce: string,
  given: string,
): boolean {
  if (!isLowerHex(given, PROOF_HEX_LENGTH)) return false;
  if (!isLowerHex(token, TOKEN_HEX_LENGTH)) return false;
  if (!isLowerHex(clientNonce, NONCE_HEX_LENGTH) || !isLowerHex(serverNonce, NONCE_HEX_LENGTH)) {
    return false;
  }
  const want = expected();
  const got = Buffer.from(given, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** ブリッジが、繋いだ相手（拡張のはず）の証明を確かめる。 */
export function verifyServerProof(
  token: string,
  clientNonce: string,
  serverNonce: string,
  proof: string,
): boolean {
  return sameProof(
    () => mac(HANDSHAKE_SERVER_LABEL, token, clientNonce, serverNonce),
    token,
    clientNonce,
    serverNonce,
    proof,
  );
}

/** 拡張が、繋いできた相手（ブリッジのはず）の証明を確かめる。 */
export function verifyClientProof(
  token: string,
  clientNonce: string,
  serverNonce: string,
  proof: string,
): boolean {
  return sameProof(
    () => mac(HANDSHAKE_CLIENT_LABEL, token, serverNonce, clientNonce),
    token,
    clientNonce,
    serverNonce,
    proof,
  );
}

/** 1. ブリッジが送る hello の行（改行を含まない）。 */
export function helloLine(clientNonce: string): string {
  return JSON.stringify({ protocolVersion: WIRE_PROTOCOL_VERSION, clientNonce });
}

/** 2. 拡張が返す証明の行（改行を含まない）。 */
export function serverProofLine(token: string, clientNonce: string, serverNonce: string): string {
  return JSON.stringify({ serverNonce, proof: serverProof(token, clientNonce, serverNonce) });
}

/** 3. ブリッジが要求の前に送る証明の行（改行を含まない）。 */
export function clientProofLine(token: string, clientNonce: string, serverNonce: string): string {
  return JSON.stringify({ proof: clientProof(token, clientNonce, serverNonce) });
}

export type HelloVerdict =
  | { kind: "ok"; clientNonce: string }
  /** 版が違う（v1 のブリッジを含む）。認証と無関係なので理由を返してよい（D28） */
  | { kind: "version-mismatch" }
  | { kind: "malformed" };

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** 拡張が hello の行を読む。 */
export function parseHelloLine(line: string): HelloVerdict {
  const json = parseJson(line);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { kind: "malformed" };
  }
  const version = (json as { protocolVersion?: unknown }).protocolVersion;
  if (typeof version === "number" && version !== WIRE_PROTOCOL_VERSION) {
    return { kind: "version-mismatch" };
  }
  const hello = helloSchema.safeParse(json);
  return hello.success
    ? { kind: "ok", clientNonce: hello.data.clientNonce }
    : { kind: "malformed" };
}

/** ブリッジが拡張の証明の行を読む。形が違えば undefined。 */
export function parseServerProofLine(line: string): ServerProof | undefined {
  const parsed = serverProofSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : undefined;
}

/** 拡張がブリッジの証明の行を読む。形が違えば undefined。 */
export function parseClientProofLine(line: string): ClientProof | undefined {
  const parsed = clientProofSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : undefined;
}
