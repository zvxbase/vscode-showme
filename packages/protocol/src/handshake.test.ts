import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HANDSHAKE_CLIENT_LABEL,
  HANDSHAKE_SERVER_LABEL,
  clientProof,
  clientProofLine,
  helloLine,
  newHandshakeNonce,
  parseClientProofLine,
  parseHelloLine,
  parseServerProofLine,
  serverProof,
  serverProofLine,
  verifyClientProof,
  verifyServerProof,
} from "./handshake.js";
import {
  HANDSHAKE_REFUSALS,
  MAX_HANDSHAKE_LINE_BYTES,
  NONCE_HEX_LENGTH,
  WIRE_PROTOCOL_VERSION,
  clientProofSchema,
  helloSchema,
  serverProofSchema,
} from "./wire.js";

// 低エントロピーの値にする（CI の gitleaks が高エントロピーの hex を秘密と見なす）。
const TOKEN = "c".repeat(64);
const OTHER_TOKEN = "d".repeat(64);
const CLIENT_NONCE = "a".repeat(64);
const SERVER_NONCE = "b".repeat(64);
const THIRD_NONCE = "e".repeat(64);

/**
 * 既知の答え（上の TOKEN / CLIENT_NONCE / SERVER_NONCE で、Python の hmac で別に計算した値）。
 * `createHmac` で組み直した期待値だけだと、同じ誤り（鍵を utf8 で読む・連結の順）を両側で犯しうる。
 */
const EXTENSION_PROOF_KAT = "c998bcf3f3367e2a5d98905a15399916c3cdb9dc87cd99f4658e1dae35144559";
const BRIDGE_PROOF_KAT = "5453be1fb0e70547e42ac725b6cf68421ca4fe32fd5f3ef1a4b528cd8adcc239";

describe("相互認証のハンドシェイク（D111）", () => {
  it("nonce は毎回違う 32 バイトの小文字 hex", () => {
    const a = newHandshakeNonce();
    const b = newHandshakeNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toHaveLength(NONCE_HEX_LENGTH);
    expect(a).not.toBe(b);
  });

  it("サーバの証明は HMAC-SHA256(トークン, サーバのラベル || clientNonce || serverNonce)", () => {
    const expected = createHmac("sha256", Buffer.from(TOKEN, "hex"))
      .update(Buffer.from(`showme-server-v${WIRE_PROTOCOL_VERSION}`, "utf8"))
      .update(Buffer.from(CLIENT_NONCE, "hex"))
      .update(Buffer.from(SERVER_NONCE, "hex"))
      .digest("hex");
    expect(HANDSHAKE_SERVER_LABEL).toBe(`showme-server-v${WIRE_PROTOCOL_VERSION}`);
    expect(serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE)).toBe(expected);
    expect(WIRE_PROTOCOL_VERSION).toBe(2);
    expect(serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE)).toBe(EXTENSION_PROOF_KAT);
  });

  it("クライアントの証明は HMAC-SHA256(トークン, クライアントのラベル || serverNonce || clientNonce)", () => {
    const expected = createHmac("sha256", Buffer.from(TOKEN, "hex"))
      .update(Buffer.from(`showme-client-v${WIRE_PROTOCOL_VERSION}`, "utf8"))
      .update(Buffer.from(SERVER_NONCE, "hex"))
      .update(Buffer.from(CLIENT_NONCE, "hex"))
      .digest("hex");
    expect(HANDSHAKE_CLIENT_LABEL).toBe(`showme-client-v${WIRE_PROTOCOL_VERSION}`);
    expect(clientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE)).toBe(expected);
    expect(clientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE)).toBe(BRIDGE_PROOF_KAT);
  });

  it("向きごとにラベルを分ける（片方の証明をもう片方に流用できない）", () => {
    // nonce を入れ替えても、サーバの証明はクライアントの証明にならない。
    const asServer = serverProof(TOKEN, SERVER_NONCE, CLIENT_NONCE);
    expect(verifyClientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, asServer)).toBe(false);
    const asClient = clientProof(TOKEN, SERVER_NONCE, CLIENT_NONCE);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, asClient)).toBe(false);
    // 同じ nonce の組でも、2つの向きの証明は別の値。
    expect(serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE)).not.toBe(
      clientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE),
    );
  });

  it("正しい証明は通り、トークン・nonce のどれか1つでも違えば落ちる", () => {
    const sp = serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, sp)).toBe(true);
    expect(verifyServerProof(OTHER_TOKEN, CLIENT_NONCE, SERVER_NONCE, sp)).toBe(false);
    expect(verifyServerProof(TOKEN, THIRD_NONCE, SERVER_NONCE, sp)).toBe(false);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, THIRD_NONCE, sp)).toBe(false);

    const cp = clientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE);
    expect(verifyClientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, cp)).toBe(true);
    expect(verifyClientProof(OTHER_TOKEN, CLIENT_NONCE, SERVER_NONCE, cp)).toBe(false);
    // 別の接続（serverNonce が違う）では、盗み見たクライアントの証明は通らない（再送できない）。
    expect(verifyClientProof(TOKEN, CLIENT_NONCE, THIRD_NONCE, cp)).toBe(false);
  });

  it("形の違う証明・トークンは例外にせず false（大文字・短い・非 hex）", () => {
    const sp = serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, sp.toUpperCase())).toBe(false);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, sp.slice(2))).toBe(false);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, `${sp.slice(1)}g`)).toBe(false);
    expect(verifyServerProof(TOKEN, CLIENT_NONCE, SERVER_NONCE, "")).toBe(false);
    // `Buffer.from(x, "hex")` は壊れた hex を黙って切り詰める。形を先に見ないと、短い鍵で照合してしまう。
    expect(verifyServerProof("zz", CLIENT_NONCE, SERVER_NONCE, sp)).toBe(false);
    expect(verifyClientProof(TOKEN.slice(1), CLIENT_NONCE, SERVER_NONCE, sp)).toBe(false);
  });

  it("証明を作る側は、形の違うトークンや nonce で黙って作らない（投げる）", () => {
    expect(() => serverProof("zz", CLIENT_NONCE, SERVER_NONCE)).toThrow();
    expect(() => clientProof(TOKEN, "short", SERVER_NONCE)).toThrow();
  });
});

describe("ハンドシェイクの行", () => {
  it("hello は版と clientNonce だけで、トークンを含まない", () => {
    const line = helloLine(CLIENT_NONCE);
    expect(JSON.parse(line)).toEqual({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      clientNonce: CLIENT_NONCE,
    });
    expect(helloSchema.safeParse(JSON.parse(line)).success).toBe(true);
    expect(line).not.toContain("token");
  });

  it("サーバの行とクライアントの行はそれぞれのスキーマを通り、トークンを含まない", () => {
    const s = serverProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE);
    expect(serverProofSchema.safeParse(JSON.parse(s)).success).toBe(true);
    expect(s).not.toContain(TOKEN);
    const c = clientProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE);
    expect(clientProofSchema.safeParse(JSON.parse(c)).success).toBe(true);
    expect(c).not.toContain(TOKEN);
  });

  it("parseHelloLine: 正しい hello・版違い・壊れた行を分ける", () => {
    expect(parseHelloLine(helloLine(CLIENT_NONCE))).toEqual({
      kind: "ok",
      clientNonce: CLIENT_NONCE,
    });
    // v1 のブリッジはトークンを生で送ってくる。版違いとして扱い、理由を返せるようにする。
    expect(parseHelloLine(JSON.stringify({ protocolVersion: 1, token: TOKEN }))).toEqual({
      kind: "version-mismatch",
    });
    expect(
      parseHelloLine(
        JSON.stringify({ protocolVersion: WIRE_PROTOCOL_VERSION + 1, clientNonce: CLIENT_NONCE }),
      ),
    ).toEqual({ kind: "version-mismatch" });
    expect(parseHelloLine("not json")).toEqual({ kind: "malformed" });
    expect(parseHelloLine("[]")).toEqual({ kind: "malformed" });
    expect(
      parseHelloLine(JSON.stringify({ protocolVersion: WIRE_PROTOCOL_VERSION, clientNonce: "x" })),
    ).toEqual({ kind: "malformed" });
    // 同じ版で余計な鍵（トークンなど）を持つものは受けない（strict）。
    expect(
      parseHelloLine(
        JSON.stringify({
          protocolVersion: WIRE_PROTOCOL_VERSION,
          clientNonce: CLIENT_NONCE,
          token: TOKEN,
        }),
      ),
    ).toEqual({ kind: "malformed" });
  });

  it("parseServerProofLine / parseClientProofLine は形の違う行で undefined", () => {
    expect(parseServerProofLine(serverProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE))).toEqual({
      serverNonce: SERVER_NONCE,
      proof: serverProof(TOKEN, CLIENT_NONCE, SERVER_NONCE),
    });
    expect(parseServerProofLine("{}")).toBeUndefined();
    expect(parseServerProofLine("nope")).toBeUndefined();
    expect(parseClientProofLine(clientProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE))).toEqual({
      proof: clientProof(TOKEN, CLIENT_NONCE, SERVER_NONCE),
    });
    expect(parseClientProofLine(JSON.stringify({ proof: "A".repeat(64) }))).toBeUndefined();
  });
});

describe("ハンドシェイクの予算（D27 を両端で1箇所に）", () => {
  it("どの行も上限に収まる（上限は正しい相手を切らない）", () => {
    const lines = [
      helloLine(CLIENT_NONCE),
      serverProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE),
      clientProofLine(TOKEN, CLIENT_NONCE, SERVER_NONCE),
      // 認証の前にサーバが返しうる理由の行（D28）もブリッジが同じ上限で読む。
      ...Object.values(HANDSHAKE_REFUSALS).map((message) =>
        JSON.stringify({ id: "", ok: false, error: { code: "invalid-request", message } }),
      ),
    ];
    for (const line of lines) {
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_HANDSHAKE_LINE_BYTES);
    }
  });

  it("上限は未認証の相手にメモリを積ませない大きさ（4 KiB）", () => {
    expect(MAX_HANDSHAKE_LINE_BYTES).toBe(4096);
  });
});
