import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTED_PATTERNS, isRedactedPath } from "./redaction.js";

describe("isRedactedPath", () => {
  it("既定リストの秘匿ファイルを弾く", () => {
    expect(isRedactedPath(".env", [])).toBe(true);
    expect(isRedactedPath(".env.local", [])).toBe(true);
    expect(isRedactedPath("config/server.pem", [])).toBe(true);
    expect(isRedactedPath("keys/id_rsa", [])).toBe(true);
  });

  it("普通のソースは通す", () => {
    expect(isRedactedPath("src/index.ts", [])).toBe(false);
    expect(isRedactedPath("README.md", [])).toBe(false);
  });

  it("追加パターンを効かせる", () => {
    expect(isRedactedPath("secrets/token.txt", ["secrets/**"])).toBe(true);
  });

  it("加算専用: 追加パターンで既定リストを無効化できない", () => {
    // 空配列を渡しても .env は依然として除外される
    expect(isRedactedPath(".env", [])).toBe(true);
    // 既定と衝突する「許可」を渡しても覆らない
    expect(isRedactedPath(".env", ["src/**"])).toBe(true);
  });

  it("既定リストは凍結されている", () => {
    expect(Object.isFrozen(DEFAULT_REDACTED_PATTERNS)).toBe(true);
  });

  it("連続するグロブスターでも破滅的バックトラックを起こさない", () => {
    // 素朴な実装では `.*` が隣り合い、マッチしない入力に対して指数時間になる。
    // 実測でグロブスター8個・55.7 秒。単一スレッドの拡張ホストが固まる。
    const evil = `${"**/".repeat(12)}*.pem`;
    const deepPath = `${"a/".repeat(40)}x.txt`;
    const started = Date.now();
    expect(isRedactedPath(deepPath, [evil])).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("紛らわしいが秘匿でないファイルを誤って弾かない", () => {
    // グロブがアンカーされていること（部分文字列一致に退化していないこと）の確認。
    // 弾く方向のテストばかりだと、この退化に気づけない。
    expect(isRedactedPath("src/environment.ts", [])).toBe(false);
    expect(isRedactedPath("src/keychain.ts", [])).toBe(false);
    expect(isRedactedPath("docs/idea_rsa_notes.md", [])).toBe(false);
    expect(isRedactedPath("src/envelope.ts", [])).toBe(false);
    // credentials* は "credentials" のリテラル前置を要求するので、"credential-" は当たらない
    expect(isRedactedPath("test/credential-helper.test.ts", [])).toBe(false);
    // 逆に、本物は当たること
    expect(isRedactedPath("credentials.json", [])).toBe(true);
  });
  it("大文字小文字が違っても秘匿とみなす（大小を区別しないファイルシステム対策）", () => {
    // macOS の APFS 既定と Windows の NTFS は区別しない。区別すると .ENV で迂回できる。
    expect(isRedactedPath(".ENV", [])).toBe(true);
    expect(isRedactedPath("server.PEM", [])).toBe(true);
    expect(isRedactedPath("keys/ID_RSA", [])).toBe(true);
    expect(isRedactedPath("CREDENTIALS.json", [])).toBe(true);
    expect(isRedactedPath(".NpmRc", [])).toBe(true);
  });
});
