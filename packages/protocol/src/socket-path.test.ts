import { describe, expect, it } from "vitest";
import {
  SOCKET_SUFFIX_HEX_LENGTH,
  SOCKET_SUFFIX_PATTERN,
  checkRegisteredSocketPath,
  registryFileNameFor,
  registrySuffixOf,
  socketPathByteLimit,
  socketPathFor,
  socketPathLength,
  socketPathTooLong,
} from "./socket-path.js";

const SUFFIX = "0123456789abcdef";
const OTHER = "fedcba9876543210";

describe("socketPathFor（D105）", () => {
  it("Windows は名前付きパイプ（ディレクトリに依らない）", () => {
    expect(
      socketPathFor("C:\\Users\\me\\AppData\\Local\\Temp\\vscode-showme-0", SUFFIX, "win32"),
    ).toBe(`\\\\.\\pipe\\vscode-showme-${SUFFIX}`);
  });

  it("POSIX はディレクトリの下の <接尾辞>.sock", () => {
    expect(socketPathFor("/run/user/1000/vscode-showme", SUFFIX, "linux")).toBe(
      `/run/user/1000/vscode-showme/${SUFFIX}.sock`,
    );
    expect(socketPathFor("/var/folders/x/T/vscode-showme-501/", SUFFIX, "darwin")).toBe(
      `/var/folders/x/T/vscode-showme-501/${SUFFIX}.sock`,
    );
  });

  it("接尾辞が 16 桁の小文字 hex でなければ投げる", () => {
    expect(SOCKET_SUFFIX_HEX_LENGTH).toBe(16);
    expect(SOCKET_SUFFIX_PATTERN.test(SUFFIX)).toBe(true);
    for (const bad of ["", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../x"]) {
      expect(() => socketPathFor("/tmp", bad, "linux"), bad).toThrow();
    }
  });
});

describe("registryFileNameFor（D105）", () => {
  it("<接尾辞>.json。接尾辞の形が違えば投げる", () => {
    expect(registryFileNameFor(SUFFIX)).toBe(`${SUFFIX}.json`);
    expect(() => registryFileNameFor("../x")).toThrow();
  });
});

describe("registrySuffixOf（registryFileNameFor の逆。D105）", () => {
  it("作る関数が作った名前からは、その接尾辞が取れる", () => {
    const suffix = "0123456789abcdef";
    expect(registrySuffixOf(registryFileNameFor(suffix))).toBe(suffix);
  });

  it("作る関数が作りえない名前は undefined（桁数・大文字・拡張子・書きかけ）", () => {
    for (const name of [
      "abc.json",
      `${"a".repeat(17)}.json`,
      `${"A".repeat(16)}.json`,
      `${"a".repeat(16)}.sock`,
      `${"a".repeat(16)}.json.123.tmp`,
      `${"a".repeat(16)}`,
      ".json",
      `x${"a".repeat(16)}.json`,
    ]) {
      expect(registrySuffixOf(name), name).toBeUndefined();
    }
  });
});

describe("checkRegisteredSocketPath（D105）", () => {
  const REG = `${SUFFIX}.json`;

  it("作る関数が作った形は通す（XDG 側・後退先のどちらのディレクトリでも）", () => {
    for (const dir of [
      "/run/user/1000/vscode-showme",
      "/tmp/vscode-showme-1000",
      "/var/folders/x/T/vscode-showme-501",
    ]) {
      expect(checkRegisteredSocketPath(socketPathFor(dir, SUFFIX, "linux"), REG, "linux")).toEqual({
        ok: true,
        socketDir: dir,
      });
    }
    expect(
      checkRegisteredSocketPath(socketPathFor("C:\\t", SUFFIX, "win32"), REG, "win32"),
    ).toEqual({ ok: true, socketDir: undefined });
  });

  it("登録ファイルが見つかったのと別の候補にあるソケットも通す（登録は両候補に複製される。§2A.6）", () => {
    // 拡張に XDG があり、ブリッジには無い: 登録は /tmp/vscode-showme-1000 で見つかるが、
    // ソケットは /run/user/1000/vscode-showme にある。ブリッジはこのディレクトリを構成できない。
    const r = checkRegisteredSocketPath(
      `/run/user/1000/vscode-showme/${SUFFIX}.sock`,
      REG,
      "linux",
    );
    expect(r).toEqual({ ok: true, socketDir: "/run/user/1000/vscode-showme" });
  });

  it("Windows: SMB のパイプ・別の名前・大文字の hex・長さ違い・接尾辞の食い違いは通さない", () => {
    for (const bad of [
      `\\\\host\\pipe\\vscode-showme-${SUFFIX}`,
      `\\\\?\\pipe\\vscode-showme-${SUFFIX}`,
      `\\\\.\\pipe\\other-${SUFFIX}`,
      `\\\\.\\pipe\\vscode-showme-${SUFFIX.toUpperCase()}`,
      `\\\\.\\pipe\\vscode-showme-${SUFFIX}0`,
      `\\\\.\\pipe\\vscode-showme-${SUFFIX.slice(1)}`,
      `\\\\.\\pipe\\vscode-showme-${SUFFIX}\\x`,
      `\\\\.\\pipe\\vscode-showme-${OTHER}`,
      `//./pipe/vscode-showme-${SUFFIX}`,
      `C:\\t\\vscode-showme-0\\${SUFFIX}.sock`,
      "",
    ]) {
      expect(checkRegisteredSocketPath(bad, REG, "win32").ok, bad).toBe(false);
    }
  });

  it("POSIX: 相対・親への脱出・正規形でない・実行時ディレクトリの名前でない・別の拡張子・接尾辞の食い違いは通さない", () => {
    for (const bad of [
      `/tmp/${SUFFIX}.sock`,
      `/home/me/.ssh/${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme/../${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme/../vscode-showme/${SUFFIX}.sock`,
      `/run/user/1000/./vscode-showme/${SUFFIX}.sock`,
      `//run/user/1000/vscode-showme/${SUFFIX}.sock`,
      `/run/user/1000//vscode-showme/${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme/sub/${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme-x/${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme-/${SUFFIX}.sock`,
      `/run/user/1000/xvscode-showme/${SUFFIX}.sock`,
      `/run/user/1000/vscode-showme/${SUFFIX}.json`,
      `/run/user/1000/vscode-showme/${SUFFIX.toUpperCase()}.sock`,
      `/run/user/1000/vscode-showme/${SUFFIX}0.sock`,
      `/run/user/1000/vscode-showme/${OTHER}.sock`,
      `/run/user/1000/vscode-showme/${SUFFIX}.sock/`,
      `run/user/1000/vscode-showme/${SUFFIX}.sock`,
      `vscode-showme/${SUFFIX}.sock`,
      `/vscode-showme/${SUFFIX}.sock\u0000`,
      `\\\\.\\pipe\\vscode-showme-${SUFFIX}`,
      "",
    ]) {
      expect(checkRegisteredSocketPath(bad, REG, "linux").ok, bad).toBe(false);
    }
  });

  it("登録ファイルの名前が <16桁の hex>.json でなければ通さない（ソケットの形が合っていても）", () => {
    const good = `/run/user/1000/vscode-showme/${SUFFIX}.sock`;
    for (const name of [
      "a.json",
      `${SUFFIX}.json.tmp-1-ab`,
      `${SUFFIX.toUpperCase()}.json`,
      `${SUFFIX}.JSON`,
      `${SUFFIX}`,
      `../${SUFFIX}.json`,
    ]) {
      expect(checkRegisteredSocketPath(good, name, "linux").ok, name).toBe(false);
      expect(
        checkRegisteredSocketPath(`\\\\.\\pipe\\vscode-showme-${SUFFIX}`, name, "win32").ok,
        name,
      ).toBe(false);
    }
  });

  it("根の直下の実行時ディレクトリ名も形としては通す（衛生はブリッジが lstat で見る）", () => {
    expect(checkRegisteredSocketPath(`/vscode-showme-0/${SUFFIX}.sock`, REG, "darwin")).toEqual({
      ok: true,
      socketDir: "/vscode-showme-0",
    });
  });
});

describe("socketPathByteLimit（D108）", () => {
  it("darwin 104・linux 108・win32 は上限なし", () => {
    expect(socketPathByteLimit("darwin")).toBe(104);
    expect(socketPathByteLimit("linux")).toBe(108);
    expect(socketPathByteLimit("win32")).toBeUndefined();
  });
});

describe("socketPathTooLong（D108）", () => {
  it("darwin は終端を含めて 104 バイトまで", () => {
    expect(socketPathTooLong(`/${"a".repeat(102)}`, "darwin")).toBe(false); // 103 + NUL = 104
    expect(socketPathTooLong(`/${"a".repeat(103)}`, "darwin")).toBe(true);
  });

  it("linux は終端を含めて 108 バイトまで", () => {
    expect(socketPathTooLong(`/${"a".repeat(106)}`, "linux")).toBe(false); // 107 + NUL = 108
    expect(socketPathTooLong(`/${"a".repeat(107)}`, "linux")).toBe(true);
  });

  it("文字数でなくバイト数で数える", () => {
    // 3 バイトの文字 35 個 = 105 バイト。文字数（36）なら収まるが、バイトでは超える。
    expect(socketPathTooLong(`/${"\u3042".repeat(35)}`, "linux")).toBe(false); // 106 + NUL
    expect(socketPathTooLong(`/${"\u3042".repeat(36)}`, "linux")).toBe(true);
  });

  it("win32 には上限を置かない", () => {
    expect(socketPathTooLong(`\\\\.\\pipe\\${"a".repeat(300)}`, "win32")).toBe(false);
  });
});

/**
 * 判定と理由の文言が同じ数を使う（不変条件14）。拡張の `server.ts` は、長すぎるかの判定と
 * 「何バイトで、上限はいくつか」の文言を、この1つの戻り値から作る。
 */
describe("socketPathLength（D108）", () => {
  it("終端を含むバイト数・上限・判定を1つの戻り値で返す", () => {
    expect(socketPathLength(`/${"a".repeat(103)}`, "darwin")).toEqual({
      bytes: 105,
      limit: 104,
      tooLong: true,
    });
    expect(socketPathLength(`/${"\u3042".repeat(35)}`, "linux")).toEqual({
      bytes: 107,
      limit: 108,
      tooLong: false,
    });
    expect(socketPathLength("\\\\.\\pipe\\x", "win32")).toEqual({
      bytes: 11,
      limit: undefined,
      tooLong: false,
    });
  });

  it("socketPathTooLong と同じ判定", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const n of [100, 102, 103, 106, 107, 200]) {
        const p = `/${"a".repeat(n)}`;
        expect(socketPathLength(p, platform).tooLong, `${platform} ${n}`).toBe(
          socketPathTooLong(p, platform),
        );
      }
    }
  });
});
