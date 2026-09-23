import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SOCKET_ENV_VAR, processUid, runtimeDirCandidates, runtimeDirPath } from "./runtime-dir.js";

/**
 * **期待値の区切り文字は `path` が決める。** 実装は `path.join` を使っており、それは
 * `process.platform` に束縛される（`runtime-dir.ts` の注記のとおり、ブリッジと拡張が
 * 必ず同じ OS にいるので契約上の問題ではない）。ここに `"/tmp/..."` と POSIX で
 * 書き下すと、**検査だけが Windows で落ちる**（2026-09-23 に CI で実測: 11 件）。
 * そこで期待値も `path.join` で組み、この検査が主張するのは区切り文字ではなく
 * **どちらの枝を選ぶか・基底名・uid の埋め込み・正規化**であることを明示する。
 */
const at = (dir: string, name: string): string => path.join(dir, name);

describe("runtimeDirPath", () => {
  it("XDG_RUNTIME_DIR があればその下を使う", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/tmp", 1000)).toBe(
      at("/run/user/1000", "vscode-showme"),
    );
  });

  it("XDG_RUNTIME_DIR が無ければ tmpdir に uid 付きの決定的な名前を使う", () => {
    expect(runtimeDirPath({}, "/tmp", 1000)).toBe(at("/tmp", "vscode-showme-1000"));
  });

  it("XDG_RUNTIME_DIR が空文字なら無いものとして扱う", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "" }, "/tmp", 1000)).toBe(
      at("/tmp", "vscode-showme-1000"),
    );
  });

  it("XDG_RUNTIME_DIR が相対パスなら信用せず tmpdir に落ちる", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "relative/path" }, "/tmp", 1000)).toBe(
      at("/tmp", "vscode-showme-1000"),
    );
  });

  it("両端が同じ入力から同じ答えを出す（決定的である）", () => {
    const a = runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/501" }, "/var/folders/x", 501);
    const b = runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/501" }, "/var/folders/x", 501);
    expect(a).toBe(b);
  });

  it("XDG_RUNTIME_DIR の末尾スラッシュは path.join が正規化する", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/1000/" }, "/tmp", 1000)).toBe(
      at("/run/user/1000", "vscode-showme"),
    );
  });

  it("XDG_RUNTIME_DIR に .. が含まれていても拒否せず正規化する（安全境界はここではなく下流の fstat/uid/mode 検査＝設計書 D22）", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/1000/../../etc" }, "/tmp", 1000)).toBe(
      at("/run/etc", "vscode-showme"),
    );
  });

  it("uid が -1（Windows で process.getuid が無く os.userInfo().uid が実際に返す非正準値）でも決定的である", () => {
    expect(runtimeDirPath({}, "/tmp", -1)).toBe(at("/tmp", "vscode-showme--1"));
  });
});

describe("runtimeDirCandidates", () => {
  it("読み取り候補は XDG と tmpdir の両方を返す", () => {
    expect(runtimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/tmp", 1000)).toEqual([
      at("/run/user/1000", "vscode-showme"),
      at("/tmp", "vscode-showme-1000"),
    ]);
  });

  it("XDG が無ければ tmpdir だけ", () => {
    expect(runtimeDirCandidates({}, "/tmp", 1000)).toEqual([at("/tmp", "vscode-showme-1000")]);
  });

  it("重複した候補は1つに畳む", () => {
    // XDG が無い / 相対で信用できないとき、書き込み先と後退先は同じ場所になる。
    // 畳まないと readdir が同じディレクトリを2度走査し、同じ窓が2つに見える。
    expect(runtimeDirCandidates({}, "/tmp", 1000)).toHaveLength(1);
    expect(runtimeDirCandidates({ XDG_RUNTIME_DIR: "" }, "/tmp", 1000)).toHaveLength(1);
    expect(runtimeDirCandidates({ XDG_RUNTIME_DIR: "relative/path" }, "/tmp", 1000)).toHaveLength(
      1,
    );
  });

  it("XDG が tmpdir を指しても、後退先とは別の場所なので2つ返す", () => {
    // /tmp/vscode-showme（XDG 由来）と /tmp/vscode-showme-1000（後退先）は別物。
    expect(runtimeDirCandidates({ XDG_RUNTIME_DIR: "/tmp" }, "/tmp", 1000)).toEqual([
      at("/tmp", "vscode-showme"),
      at("/tmp", "vscode-showme-1000"),
    ]);
  });

  it("先頭の候補は必ず書き込み先と一致する", () => {
    // ブリッジは候補を順に走査する。書き込み先が先頭でないと、
    // 生きている窓より古い後退先の登録を先に拾いうる。
    const cases: ReadonlyArray<{ XDG_RUNTIME_DIR?: string }> = [
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      { XDG_RUNTIME_DIR: "/run/user/1000/" },
      {},
      { XDG_RUNTIME_DIR: "" },
      { XDG_RUNTIME_DIR: "relative/path" },
    ];
    for (const env of cases) {
      expect(runtimeDirCandidates(env, "/tmp", 1000)[0]).toBe(runtimeDirPath(env, "/tmp", 1000));
    }
  });

  it("書き込み先は従来どおり1つ", () => {
    expect(runtimeDirPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/tmp", 1000)).toBe(
      at("/run/user/1000", "vscode-showme"),
    );
  });

  it("両端が同じ入力から同じ候補列を出す（決定的である）", () => {
    const a = runtimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/501" }, "/var/folders/x", 501);
    const b = runtimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/501" }, "/var/folders/x", 501);
    expect(a).toEqual(b);
  });
});

describe("SOCKET_ENV_VAR", () => {
  it("拡張が注入し、ブリッジが読む環境変数の名前を1箇所で定義する", () => {
    // 拡張(注入する側)とブリッジ(読む側)は別プロセスなので、名前が2箇所に
    // 書かれていると片方を直したときに黙って疎通しなくなる。
    expect(SOCKET_ENV_VAR).toBe("SHOWME_SOCK");
  });

  it("VSCODE_ 接頭辞を持たない(sanitizeProcessEnvironment の削除対象なので・設計書 Y2)", () => {
    expect(SOCKET_ENV_VAR.startsWith("VSCODE_")).toBe(false);
  });
});

describe("processUid", () => {
  it("getuid があればその値を使う", () => {
    expect(processUid({ getuid: () => 1000 })).toBe(1000);
  });

  it("getuid が無ければ 0 を使う(両端で同じ値になることが目的)", () => {
    // os.userInfo().uid は Windows で -1 を返すが、片方がそれを使うと
    // ディレクトリ名がすれ違う。無いときの値をここで1つに決める。
    expect(processUid({})).toBe(0);
  });
});
