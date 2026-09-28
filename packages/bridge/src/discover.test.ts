import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WIRE_PROTOCOL_VERSION,
  processUid,
  runtimeDirCandidates,
} from "@zvx/vscode-showme-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DirState,
  type RegistryEntry,
  type RegistryFileSystem,
  createNodeRegistryFileSystem,
  defaultRuntimeDirs,
  describeSelectionFailure,
  describeUnsafeRuntimeDir,
  discoverRegistry,
  ownedAndPrivate,
  parseRegistryEntry,
  posixRegistryFileSystem,
  readRegistryEntries,
  scanRegistry,
  selectWindow,
} from "./discover.js";

const TOKEN = "a".repeat(64);

const alpha: RegistryEntry = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  workspacePath: "/w/alpha",
  pid: process.pid,
  startedAt: "2026-09-09T00:00:00Z",
  socketPath: "/rt/a.sock",
  authToken: TOKEN,
  windowId: "win-alpha",
  role: "stage",
};
const beta: RegistryEntry = {
  ...alpha,
  workspacePath: "/w/beta",
  socketPath: "/rt/b.sock",
  startedAt: "2026-09-09T01:00:00Z",
  windowId: "win-beta",
};
/** 預けられていない窓。既定はこちら（設計書 §2A.1）。 */
const idle: RegistryEntry = { ...alpha, role: "idle" };

function chosen(entries: readonly RegistryEntry[], hints: Parameters<typeof selectWindow>[1]) {
  const selection = selectWindow(entries, hints);
  return selection.ok ? selection.entry.socketPath : undefined;
}

function failure(entries: readonly RegistryEntry[], hints: Parameters<typeof selectWindow>[1]) {
  const selection = selectWindow(entries, hints);
  return selection.ok ? undefined : selection.reason;
}

describe("selectWindow", () => {
  it("役割が stage の窓が1つならそれを選ぶ(ヒントは要らない)", () => {
    // 制限モードでは $SHOWME_SOCK が届かず、tmux でも伝播しない。
    // 「ヒント無しで stage が選べる」ことが主経路である(設計書 §2A.5)。
    expect(chosen([{ ...beta, role: "idle" }, alpha], {})).toBe("/rt/a.sock");
  });

  it("預けられた窓が無ければ no-stage(候補の数だけを持ち帰る)", () => {
    const selection = selectWindow([idle, { ...beta, role: "idle" }], {});
    expect(selection.ok).toBe(false);
    expect(!selection.ok && selection.reason).toBe("no-stage");
    expect(!selection.ok && selection.reason === "no-stage" && selection.idleCount).toBe(2);
  });

  it("役割の綴りが未知なら idle として扱う(フェイルクローズ)", () => {
    const future = { ...alpha, role: "admin" } as unknown as RegistryEntry;
    expect(failure([future], {})).toBe("no-stage");
  });

  it("stage が2つなら黙って選ばず、両方を持ち帰る", () => {
    const selection = selectWindow([alpha, beta], {});
    expect(!selection.ok && selection.reason).toBe("multiple-stages");
    const stages =
      !selection.ok && selection.reason === "multiple-stages" ? selection.stages : undefined;
    expect(stages?.map((s) => s.windowId)).toEqual(["win-alpha", "win-beta"]);
  });

  it("SHOWME_SOCK は stage の中の同点解決にだけ効く", () => {
    expect(chosen([alpha, beta], { sock: "/rt/b.sock" })).toBe("/rt/b.sock");
  });

  it("SHOWME_SOCK が idle の窓を指していても、その窓は選ばない", () => {
    // 預けていない窓を環境変数で拾い上げられるなら、既定が「不可」である意味が無い。
    expect(failure([idle], { sock: "/rt/a.sock" })).toBe("no-stage");
  });

  it("SHOWME_SOCK が stale でも、stage が1つならその1つに落ちる", () => {
    expect(chosen([alpha, { ...beta, role: "idle" }], { sock: "/rt/zzz.sock" })).toBe("/rt/a.sock");
  });

  it("workspacePath は stage が複数のときの同点解決にだけ効く", () => {
    expect(chosen([alpha, beta], { workspacePath: "/w/beta" })).toBe("/rt/b.sock");
  });

  it("workspacePath が idle の窓を指していても、その窓は選ばない", () => {
    expect(failure([idle], { workspacePath: "/w/alpha" })).toBe("no-stage");
  });

  it("同じフォルダの2窓が両方 stage なら、workspacePath では解けない", () => {
    // 実データで再現した事例。`.find` が黙って先頭を返してはならない(設計書 §2A.5)。
    const twin = { ...beta, workspacePath: "/w/alpha" };
    expect(failure([alpha, twin], { workspacePath: "/w/alpha" })).toBe("multiple-stages");
  });

  it("候補が無ければ no-entries", () => {
    expect(failure([], {})).toBe("no-entries");
  });

  it("版が違う登録しか無ければ version-mismatch(「拡張が居ない」と区別する)", () => {
    expect(failure([{ ...alpha, protocolVersion: 99 }], {})).toBe("version-mismatch");
  });

  it("版が違う登録は stage でも候補から外れる", () => {
    expect(chosen([{ ...alpha, protocolVersion: 99 }, beta], {})).toBe("/rt/b.sock");
  });

  it("除外したソケットは候補から外れる(再試行で同じ死体を掴まない)", () => {
    expect(chosen([alpha, beta], { exclude: ["/rt/a.sock"] })).toBe("/rt/b.sock");
  });

  it("除外して候補が尽きたら exhausted", () => {
    expect(failure([alpha], { exclude: ["/rt/a.sock"] })).toBe("exhausted");
  });

  it("stage を全部除外したら exhausted と言う(no-stage ではない)", () => {
    // 人間はちゃんと預けている。届かなかっただけなので、
    // 「ステータスバーを押してください」と言うのは嘘になる。
    expect(failure([alpha, { ...beta, role: "idle" }], { exclude: ["/rt/a.sock"] })).toBe(
      "exhausted",
    );
  });

  it("除外は SHOWME_SOCK の一致より強い(死んでいると分かった先を選び直さない)", () => {
    expect(chosen([alpha, beta], { sock: "/rt/a.sock", exclude: ["/rt/a.sock"] })).toBe(
      "/rt/b.sock",
    );
  });

  it("空文字の SHOWME_SOCK は「無い」として扱う", () => {
    expect(chosen([alpha, beta], { sock: "", workspacePath: "/w/beta" })).toBe("/rt/b.sock");
  });
});

describe("parseRegistryEntry", () => {
  const written = JSON.stringify({
    protocolVersion: WIRE_PROTOCOL_VERSION,
    workspacePath: "/w/alpha",
    pid: 4242,
    startedAt: "2026-09-09T00:00:00.000Z",
    socketPath: "/rt/a.sock",
    authToken: TOKEN,
  });

  it("拡張が書く形をそのまま読める", () => {
    expect(parseRegistryEntry(written)?.socketPath).toBe("/rt/a.sock");
  });

  it("知らないキーがあっても読める(拡張が先に新しくなっても止まらない)", () => {
    const forward = JSON.stringify({ ...JSON.parse(written), somethingNew: true });
    expect(parseRegistryEntry(forward)?.authToken).toBe(TOKEN);
  });

  it("版が違っても読む(読めないと「版が違う」と言えない)", () => {
    const other = JSON.stringify({ ...JSON.parse(written), protocolVersion: 99 });
    expect(parseRegistryEntry(other)?.protocolVersion).toBe(99);
  });

  it("JSON でなければ undefined", () => {
    expect(parseRegistryEntry("not json")).toBeUndefined();
  });

  it("トークンの長さが違えば undefined", () => {
    const short = JSON.stringify({ ...JSON.parse(written), authToken: "abc" });
    expect(parseRegistryEntry(short)).toBeUndefined();
  });

  it("トークンが hex でなければ undefined", () => {
    const notHex = JSON.stringify({ ...JSON.parse(written), authToken: "z".repeat(64) });
    expect(parseRegistryEntry(notHex)).toBeUndefined();
  });

  it("socketPath が空なら undefined", () => {
    const empty = JSON.stringify({ ...JSON.parse(written), socketPath: "" });
    expect(parseRegistryEntry(empty)).toBeUndefined();
  });

  it("配列や null は undefined", () => {
    expect(parseRegistryEntry("[]")).toBeUndefined();
    expect(parseRegistryEntry("null")).toBeUndefined();
  });

  it("windowId と role を読む", () => {
    const withRole = JSON.stringify({
      ...JSON.parse(written),
      windowId: "w-1",
      role: "stage",
    });
    expect(parseRegistryEntry(withRole)?.windowId).toBe("w-1");
    expect(parseRegistryEntry(withRole)?.role).toBe("stage");
  });

  it("role が無い古い登録は idle として読む(フェイルクローズ)", () => {
    // 役割を知らない拡張が書いた登録を stage と読むと、預けていない窓が選ばれる。
    expect(parseRegistryEntry(written)?.role).toBe("idle");
    expect(parseRegistryEntry(written)?.windowId).toBeUndefined();
  });

  it("role の綴りが未知でも登録ごと捨てず、idle として読む", () => {
    // 捨てると「拡張が居ない」と誤診する。読んだ上で預かっていないと解釈する。
    const future = JSON.stringify({ ...JSON.parse(written), role: "admin" });
    expect(parseRegistryEntry(future)?.role).toBe("idle");
  });

  it("role の大文字小文字は揺らさない(STAGE は stage ではない)", () => {
    const shouty = JSON.stringify({ ...JSON.parse(written), role: "STAGE" });
    expect(parseRegistryEntry(shouty)?.role).toBe("idle");
  });
});

/** 登録ファイルの名前とソケットの接尾辞（16 桁の hex。拡張の `crypto.randomBytes(8)` の形）。 */
const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";
/** POSIX の形の実行時ディレクトリ。これを使う検査は platform に "linux" を渡す（Windows の CI でも同じ答え）。 */
const RT = "/rt/vscode-showme";

describe("scanRegistry", () => {
  function fakeFs(
    files: Record<string, string | undefined>,
    dir?: DirState,
    others: Record<string, DirState> = {},
  ): RegistryFileSystem {
    return {
      openDir: (d) => others[d] ?? dir ?? { kind: "ok", names: Object.keys(files) },
      read: (_dir, name) => files[name],
    };
  }

  const regOf = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      workspacePath: "/w/alpha",
      pid: process.pid,
      startedAt: "2026-09-09T00:00:00Z",
      socketPath: `${RT}/${H1}.sock`,
      authToken: TOKEN,
      ...over,
    });
  const good = regOf();

  it(".json だけを読む", () => {
    const scan = scanRegistry(
      RT,
      fakeFs({ [`${H1}.json`]: good, [`${H1}.sock`]: good, "notes.txt": good }),
      "linux",
    );
    expect(scan.entries.map((e) => e.socketPath)).toEqual([`${RT}/${H1}.sock`]);
  });

  it("壊れた登録は飛ばし、残りは読む", () => {
    const scan = scanRegistry(RT, fakeFs({ [`${H2}.json`]: "{{{", [`${H1}.json`]: good }), "linux");
    expect(scan.entries).toHaveLength(1);
  });

  it("読めなかったファイル(衛生検査落ち)は飛ばす", () => {
    const scan = scanRegistry(
      RT,
      fakeFs({ [`${H2}.json`]: undefined, [`${H1}.json`]: good }),
      "linux",
    );
    expect(scan.entries).toHaveLength(1);
  });

  it("ディレクトリが無ければ present が false になる(拡張が居ないだけ・警報ではない)", () => {
    const scan = scanRegistry(RT, fakeFs({}, { kind: "absent" }));
    expect(scan.present).toBe(false);
    expect(scan.unsafe).toBeUndefined();
    expect(scan.entries).toEqual([]);
  });

  it("ディレクトリが衛生検査に落ちたら理由を持ち帰る(黙って迂回しない)", () => {
    const scan = scanRegistry(
      RT,
      fakeFs({ [`${H1}.json`]: good }, { kind: "unsafe", reason: "mode is 777, expected 700" }),
    );
    expect(scan.unsafe).toContain("mode is 777");
    // 衛生検査に落ちたディレクトリの中身は1件も読まない
    expect(scan.entries).toEqual([]);
  });

  it("ディレクトリが健全なら unsafe を持たない", () => {
    const scan = scanRegistry(RT, fakeFs({ [`${H1}.json`]: good }));
    expect(scan.unsafe).toBeUndefined();
    expect(scan.present).toBe(true);
  });

  describe("登録の pid が生きていること（D111）", () => {
    it("pid が死んでいる登録は使わず、ファイルと理由を持ち帰る", () => {
      const asked: number[] = [];
      const scan = scanRegistry(
        RT,
        fakeFs({
          [`${H1}.json`]: regOf({ pid: 4242 }),
          [`${H2}.json`]: regOf({ pid: 4343, socketPath: `${RT}/${H2}.sock` }),
        }),
        "linux",
        (pid) => {
          asked.push(pid);
          return pid === 4343;
        },
      );
      expect(asked.sort()).toEqual([4242, 4343]);
      expect(scan.entries.map((e) => e.pid)).toEqual([4343]);
      expect(scan.rejected).toEqual([
        { file: path.join(RT, `${H1}.json`), reason: expect.stringContaining("4242") },
      ]);
      expect(scan.rejected[0]?.reason).toContain("not running");
    });

    it("win32 でも同じ（パイプの名前は誰でも作れるので、死んだ窓の登録には繋がない）", () => {
      const dir = "C:\\Users\\u\\AppData\\Local\\Temp\\vscode-showme-0";
      const pipe = `\\\\.\\pipe\\vscode-showme-${H1}`;
      const scan = scanRegistry(
        dir,
        fakeFs({ [`${H1}.json`]: regOf({ socketPath: pipe, pid: 4242 }) }),
        "win32",
        () => false,
      );
      expect(scan.entries).toEqual([]);
      expect(scan.rejected).toHaveLength(1);
    });

    it("0 以下の pid は生死判定に渡さず捨てる（kill(0) はプロセスグループに飛ぶ）", () => {
      const asked: number[] = [];
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H1}.json`]: regOf({ pid: 0 }) }),
        "linux",
        (pid) => {
          asked.push(pid);
          return true;
        },
      );
      expect(asked).toEqual([]);
      expect(scan.entries).toEqual([]);
      expect(scan.rejected).toHaveLength(1);
    });

    it("使う登録は、読んだファイルのパスを持つ（ファイルに書かれた値ではない）", () => {
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H1}.json`]: regOf({ pid: process.pid, registryFile: "/etc/passwd" }) }),
        "linux",
      );
      expect(scan.entries.map((e) => e.registryFile)).toEqual([path.join(RT, `${H1}.json`)]);
    });

    it("既定の判定は本物の process.kill(pid, 0)（自分の pid は生きている）", () => {
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H1}.json`]: regOf({ pid: process.pid }) }),
        "linux",
      );
      expect(scan.entries).toHaveLength(1);
    });

    it("readRegistryEntries も同じ判定を渡す", () => {
      const read = readRegistryEntries(
        [RT],
        fakeFs({ [`${H1}.json`]: regOf({ pid: 4242 }) }),
        "linux",
        () => false,
      );
      expect(read.entries).toEqual([]);
      expect(read.rejected).toHaveLength(1);
    });
  });

  describe("socketPath の形（D105）", () => {
    it("別の候補（実行時ディレクトリの名前で、衛生を満たす）にあるソケットは通す", () => {
      // 拡張にだけ XDG がある: 登録は後退先で見つかり、ソケットは XDG 側にある（§2A.6）。
      const xdgSock = `/run/user/1000/vscode-showme/${H1}.sock`;
      const scan = scanRegistry(
        "/tmp/vscode-showme-1000",
        fakeFs({ [`${H1}.json`]: regOf({ socketPath: xdgSock }) }),
        "linux",
      );
      expect(scan.entries.map((e) => e.socketPath)).toEqual([xdgSock]);
    });

    it("実行時ディレクトリの名前でないところ・相対・.. ・接尾辞の食い違いのソケットは捨てる", () => {
      for (const socketPath of [
        `/home/me/.ssh/${H1}.sock`,
        `rt/vscode-showme/${H1}.sock`,
        `${RT}/../vscode-showme/${H1}.sock`,
        `${RT}/${H2}.sock`,
        `\\\\host\\pipe\\vscode-showme-${H1}`,
      ]) {
        const scan = scanRegistry(RT, fakeFs({ [`${H1}.json`]: regOf({ socketPath }) }), "linux");
        expect(scan.entries, socketPath).toEqual([]);
      }
    });

    it("登録ファイルの名前が <16桁の hex>.json でなければ捨てる", () => {
      const scan = scanRegistry(RT, fakeFs({ "a.json": good }), "linux");
      expect(scan.entries).toEqual([]);
    });

    it("ソケットの在るディレクトリが衛生検査に落ちたら捨てる（無い・危ない）", () => {
      const other = "/run/user/1000/vscode-showme";
      for (const state of [
        { kind: "absent" } as const,
        { kind: "unsafe", reason: "mode 777" } as const,
      ]) {
        const scan = scanRegistry(
          RT,
          fakeFs({ [`${H1}.json`]: regOf({ socketPath: `${other}/${H1}.sock` }) }, undefined, {
            [other]: state,
          }),
          "linux",
        );
        expect(scan.entries, state.kind).toEqual([]);
      }
    });

    it("形で捨てた登録は、ファイルと理由を持ち帰る（黙って消さない）", () => {
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H1}.json`]: regOf({ socketPath: `/home/me/.ssh/${H1}.sock` }) }),
        "linux",
      );
      expect(scan.entries).toEqual([]);
      expect(scan.rejected).toHaveLength(1);
      expect(scan.rejected[0]?.file).toBe(path.join(RT, `${H1}.json`));
      expect(scan.rejected[0]?.reason).toContain("socketPath");
      // 登録の中身（ソケットのパス）は言葉に載せない。
      expect(scan.rejected[0]?.reason).not.toContain(".ssh");
    });

    it("ソケットの在るディレクトリで捨てた登録は、そのディレクトリの理由を持ち帰る", () => {
      const other = "/run/user/1000/vscode-showme";
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H1}.json`]: regOf({ socketPath: `${other}/${H1}.sock` }) }, undefined, {
          [other]: { kind: "unsafe", reason: "mode 777" },
        }),
        "linux",
      );
      expect(scan.rejected.map((r) => r.file)).toEqual([path.join(RT, `${H1}.json`)]);
      expect(scan.rejected[0]?.reason).toContain("mode 777");
    });

    it("読めない・壊れた登録は rejected に数えない（今までどおり黙って飛ばす）", () => {
      const scan = scanRegistry(
        RT,
        fakeFs({ [`${H2}.json`]: "{{{", [`${H1}.json`]: undefined }),
        "linux",
      );
      expect(scan.rejected).toEqual([]);
    });

    it("win32: ローカルのパイプ `\\\\.\\pipe\\vscode-showme-<接尾辞>` だけを通す", () => {
      const dir = "C:\\Users\\u\\AppData\\Local\\Temp\\vscode-showme-0";
      const pipe = `\\\\.\\pipe\\vscode-showme-${H1}`;
      const ok = scanRegistry(
        dir,
        fakeFs({ [`${H1}.json`]: regOf({ socketPath: pipe }) }),
        "win32",
      );
      expect(ok.entries.map((e) => e.socketPath)).toEqual([pipe]);
      for (const socketPath of [
        `\\\\host\\pipe\\vscode-showme-${H1}`,
        `\\\\.\\pipe\\vscode-showme-${H2}`,
        `${dir}\\${H1}.sock`,
      ]) {
        const scan = scanRegistry(dir, fakeFs({ [`${H1}.json`]: regOf({ socketPath }) }), "win32");
        expect(scan.entries, socketPath).toEqual([]);
      }
    });
  });
});

describe("readRegistryEntries（両候補の走査）", () => {
  const TOKEN2 = "b".repeat(64);
  const XDG = "/xdg/vscode-showme";
  const TMP = "/tmp/vscode-showme-1000";

  /** 登録1件（ファイル名と中身）。ソケットは `socketDir` の下の `<suffix>.sock`。 */
  function reg(
    suffix: string,
    socketDir: string,
    over: Record<string, unknown> = {},
  ): Record<string, string> {
    return {
      [`${suffix}.json`]: JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        workspacePath: "/w/alpha",
        pid: process.pid,
        startedAt: "2026-09-09T00:00:00Z",
        socketPath: `${socketDir}/${suffix}.sock`,
        authToken: TOKEN2,
        windowId: "w-1",
        role: "stage",
        ...over,
      }),
    };
  }

  /** ディレクトリごとに中身と状態を持つ、偽のファイルシステム。 */
  function fsOf(
    tree: Record<string, Record<string, string | undefined> | DirState>,
  ): RegistryFileSystem & { listed: string[] } {
    const listed: string[] = [];
    return {
      listed,
      openDir(dir) {
        listed.push(dir);
        const node = tree[dir];
        if (node === undefined) return { kind: "absent" };
        if ("kind" in node) return node as DirState;
        return { kind: "ok", names: Object.keys(node) };
      },
      read(dir, name) {
        const node = tree[dir];
        if (node === undefined || "kind" in node) return undefined;
        return (node as Record<string, string | undefined>)[name];
      },
    };
  }

  it("片方の候補にしか登録が無くても読める", () => {
    const read = readRegistryEntries([XDG, TMP], fsOf({ [TMP]: reg(H1, TMP) }), "linux");
    expect(read.entries.map((e) => e.windowId)).toEqual(["w-1"]);
    expect(read.present).toBe(true);
  });

  it("両方の候補を走査して、両方の窓を集める", () => {
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, XDG, { windowId: "w-1" }),
        [TMP]: reg(H2, TMP, { windowId: "w-2" }),
      }),
      "linux",
    );
    expect(read.entries.map((e) => e.windowId)).toEqual(["w-1", "w-2"]);
  });

  it("同じ窓が両方の候補に書いていたら windowId で1つに畳む", () => {
    // 拡張は両候補に**同じ内容**を書く（ソケットは第一候補の1本だけ）。
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, XDG, { windowId: "same" }),
        [TMP]: reg(H1, XDG, { windowId: "same" }),
      }),
      "linux",
    );
    expect(read.entries).toHaveLength(1);
  });

  it("畳むときは候補の順序が先の登録を残す(自己申告の startedAt では決めない)", () => {
    // 同一 uid のプロセスは 0600 の登録を読める。本物の windowId と未来の
    // startedAt を後退先に置くだけで socketPath と authToken を差し替えられる
    // なら、両候補走査は攻撃者に経路を1本渡したことになる(レビュー N2)。
    // 順序で決めれば、攻撃者は拡張の第一候補より先の候補に置く必要がある。
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, XDG, {
          windowId: "same",
          authToken: "c".repeat(64),
          startedAt: "2026-09-09T00:00:00Z",
        }),
        [TMP]: reg(H2, TMP, {
          windowId: "same",
          authToken: "d".repeat(64),
          // 未来の時刻。自己申告なので、攻撃者は好きな値を書ける。
          startedAt: "2099-01-01T00:00:00Z",
        }),
      }),
      "linux",
    );
    expect(read.entries.map((e) => e.socketPath)).toEqual([`${XDG}/${H1}.sock`]);
    expect(read.entries.map((e) => e.authToken)).toEqual(["c".repeat(64)]);
  });

  it("windowId が違えば、同じフォルダの窓でも畳まない", () => {
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, XDG, { windowId: "w-1" }),
        [TMP]: reg(H2, TMP, { windowId: "w-2" }),
      }),
      "linux",
    );
    expect(read.entries).toHaveLength(2);
  });

  it("同じ候補を2度渡されても1度しか走査しない(同じ窓が2つに見える)", () => {
    const io = fsOf({ [TMP]: reg(H1, TMP) });
    const read = readRegistryEntries([TMP, TMP], io, "linux");
    expect(read.entries).toHaveLength(1);
    // ソケットの在り処の確かめも、同じ走査の中では同じ答えを使う（2度 lstat しない）。
    expect(io.listed).toEqual([TMP]);
  });

  it("片方が衛生検査に落ちても、もう片方は読む(先回りで塞がれない)", () => {
    // /tmp は 1777 なので、後退先の候補は攻撃者に先回りされうる。そこで
    // 全体を止めると、攻撃者は疎通そのものを止められる。読まずに迂回し、
    // 理由は持ち帰る(設計書 D22)。
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, XDG),
        [TMP]: { kind: "unsafe", reason: "mode 777" },
      }),
      "linux",
    );
    expect(read.entries).toHaveLength(1);
    expect(read.unsafe.map((u) => u.dir)).toEqual([TMP]);
  });

  it("後退先のソケットを指す登録は、後退先が衛生検査に落ちていれば捨てる（D105）", () => {
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, TMP),
        [TMP]: { kind: "unsafe", reason: "mode 777" },
      }),
      "linux",
    );
    expect(read.entries).toEqual([]);
  });

  it("走査先に無いディレクトリのソケットも、名前の形と衛生を満たせば通す（XDG を構成できないブリッジ）", () => {
    const io = fsOf({ [TMP]: reg(H1, XDG), [XDG]: {} });
    const read = readRegistryEntries([TMP], io, "linux");
    expect(read.entries.map((e) => e.socketPath)).toEqual([`${XDG}/${H1}.sock`]);
    expect(read.dirs).toEqual([TMP]);
    expect(read.unsafe).toEqual([]);
  });

  it("壊れた登録や読めない登録があっても、残りは読む", () => {
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: { [`${H2}.json`]: "{{{", "denied.json": undefined },
        [TMP]: reg(H1, TMP),
      }),
      "linux",
    );
    expect(read.entries).toHaveLength(1);
    expect(read.unsafe).toEqual([]);
  });

  it("捨てた登録を候補をまたいで集める（D105）", () => {
    const read = readRegistryEntries(
      [XDG, TMP],
      fsOf({
        [XDG]: reg(H1, "/home/me"),
        [TMP]: reg(H2, TMP, { socketPath: `${TMP}/${H1}.sock` }),
      }),
      "linux",
    );
    expect(read.entries).toEqual([]);
    expect(read.rejected.map((r) => r.file)).toEqual([
      path.join(XDG, `${H1}.json`),
      path.join(TMP, `${H2}.json`),
    ]);
  });

  it("どちらの候補も無ければ present が false(拡張が居ないだけ)", () => {
    const read = readRegistryEntries([XDG, TMP], fsOf({}), "linux");
    expect(read.present).toBe(false);
    expect(read.entries).toEqual([]);
    expect(read.dirs).toEqual([XDG, TMP]);
  });
});

describe("defaultRuntimeDirs", () => {
  it("protocol の候補計算をそのまま使う(両端が同じ規則で計算する)", () => {
    expect(defaultRuntimeDirs()).toEqual(
      runtimeDirCandidates(process.env, os.tmpdir(), processUid(process)),
    );
  });

  it("先頭は書き込み先の候補である", () => {
    const dirs = defaultRuntimeDirs();
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.every((d) => path.isAbsolute(d))).toBe(true);
  });
});

const onWindows = process.platform === "win32";

describe("ownedAndPrivate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-discover-own-"));
    fs.chmodSync(dir, 0o700);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("win32 では所有者とモードを見ない（DACL は verifyRuntimeDirWindows が見る。D104）", () => {
    const st = fs.lstatSync(dir);
    expect(ownedAndPrivate(st, "runtime dir", dir, "win32")).toBeUndefined();
  });

  it("win32 でも symlink は断る", () => {
    const link = path.join(dir, "link");
    fs.symlinkSync(dir, link, "junction");
    expect(ownedAndPrivate(fs.lstatSync(link), "runtime dir", link, "win32")).toContain("symlink");
  });
});

/** 実行時ディレクトリの名前の形をした、本物の一時ディレクトリの組（D105 の名前の形を満たす）。 */
function makeRuntimeRoot(prefix: string): { root: string; primary: string; fallback: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const primary = path.join(root, "xdg", "vscode-showme");
  const fallback = path.join(root, "tmp", "vscode-showme-1000");
  for (const dir of [primary, fallback]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!onWindows) for (const dir of [primary, fallback]) fs.chmodSync(dir, 0o700);
  return { root, primary, fallback };
}

describe.skipIf(onWindows)("posixRegistryFileSystem（本物のファイルシステムで検査する）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-discover-"));
    fs.chmodSync(dir, 0o700);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("無いディレクトリは absent", () => {
    expect(posixRegistryFileSystem.openDir(path.join(dir, "nope")).kind).toBe("absent");
  });

  it("0700 のディレクトリは中身を列挙できる", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "{}", { mode: 0o600 });
    const state = posixRegistryFileSystem.openDir(dir);
    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" ? [...state.names] : []).toEqual(["a.json"]);
  });

  it("他人が書けるディレクトリは unsafe（黙って使わない）", () => {
    // /tmp は 1777 なので、決定的なパスは先回りされうる（設計書 S7 / D22）。
    // 作る側だけでなく読む側にも同じ検査が要る。
    fs.chmodSync(dir, 0o777);
    const state = posixRegistryFileSystem.openDir(dir);
    expect(state.kind).toBe("unsafe");
    expect(state.kind === "unsafe" ? state.reason : "").toContain("mode 777");
  });

  it("ディレクトリでないものは unsafe", () => {
    const file = path.join(dir, "plain");
    fs.writeFileSync(file, "x", { mode: 0o600 });
    expect(posixRegistryFileSystem.openDir(file).kind).toBe("unsafe");
  });

  it("0600 の通常ファイルは読める", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "hello", { mode: 0o600 });
    expect(posixRegistryFileSystem.read(dir, "a.json")).toBe("hello");
  });

  it("他人が読める登録ファイルは読まない（トークンが漏れている登録は信じない）", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "hello", { mode: 0o644 });
    expect(posixRegistryFileSystem.read(dir, "a.json")).toBeUndefined();
  });

  it("シンボリックリンクの登録ファイルは辿らない", () => {
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "secret", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(dir, "link.json"));
    expect(posixRegistryFileSystem.read(dir, "link.json")).toBeUndefined();
  });

  it("無いファイルは undefined", () => {
    expect(posixRegistryFileSystem.read(dir, "missing.json")).toBeUndefined();
  });
});

describe.skipIf(onWindows)(
  "readRegistryEntries（本物のファイルシステムで両候補を走査する）",
  () => {
    let root: string;
    let primary: string;
    let fallback: string;

    const TOKEN3 = "c".repeat(64);
    const entry = (over: Record<string, unknown>) =>
      JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        workspacePath: "/w/alpha",
        pid: process.pid,
        startedAt: "2026-09-09T00:00:00Z",
        authToken: TOKEN3,
        role: "stage",
        ...over,
      });

    function place(dir: string, name: string, body: string, mode = 0o600): void {
      fs.writeFileSync(path.join(dir, name), body, { mode });
      fs.chmodSync(path.join(dir, name), mode);
    }

    beforeEach(() => {
      ({ root, primary, fallback } = makeRuntimeRoot("showme-candidates-"));
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("同じ窓が両方のディレクトリに書いていても1件になる", () => {
      const body = entry({ windowId: "same", socketPath: `${primary}/${H1}.sock` });
      place(primary, `${H1}.json`, body);
      place(fallback, `${H1}.json`, body);

      const read = readRegistryEntries([primary, fallback], posixRegistryFileSystem);
      expect(read.entries).toHaveLength(1);
      // 預けられた窓は1つ。畳めていなければ multiple-stages になる。
      const selection = selectWindow(read.entries, {});
      expect(selection.ok).toBe(true);
    });

    it("片方のディレクトリにしか無い窓も見つかる(XDG の食い違いで黙って見失わない)", () => {
      place(
        fallback,
        `${H1}.json`,
        entry({ windowId: "only", socketPath: `${fallback}/${H1}.sock` }),
      );
      const read = readRegistryEntries([primary, fallback], posixRegistryFileSystem);
      expect(read.entries.map((e) => e.windowId)).toEqual(["only"]);
    });

    it("読めない登録が混ざっても、読める登録は読む(全体が落ちない)", () => {
      place(primary, `${H2}.json`, "{{{ not json");
      place(
        primary,
        "1111111111111111.json",
        entry({ windowId: "leaky", socketPath: `${primary}/1111111111111111.sock` }),
        0o644,
      );
      fs.symlinkSync(path.join(primary, `${H2}.json`), path.join(primary, "2222222222222222.json"));
      fs.mkdirSync(path.join(primary, "3333333333333333.json"), { mode: 0o700 });
      place(
        fallback,
        `${H1}.json`,
        entry({ windowId: "good", socketPath: `${fallback}/${H1}.sock` }),
      );

      const read = readRegistryEntries([primary, fallback], posixRegistryFileSystem);
      expect(read.entries.map((e) => e.windowId)).toEqual(["good"]);
      expect(read.unsafe).toEqual([]);
    });

    it("後退先が他人にも書ける状態で先回りされていても、正規の候補は読める", () => {
      // /tmp は 1777。ここで全体を止めると、誰でも疎通を止められる。
      fs.chmodSync(fallback, 0o777);
      place(primary, `${H1}.json`, entry({ windowId: "ok", socketPath: `${primary}/${H1}.sock` }));

      const read = readRegistryEntries([primary, fallback], posixRegistryFileSystem);
      expect(read.entries.map((e) => e.windowId)).toEqual(["ok"]);
      expect(read.unsafe.map((u) => u.dir)).toEqual([fallback]);
    });

    it("危ないディレクトリの中身は1件も読まない", () => {
      place(
        fallback,
        `${H1}.json`,
        entry({ windowId: "planted", socketPath: `${fallback}/${H1}.sock` }),
      );
      fs.chmodSync(fallback, 0o777);

      const read = readRegistryEntries([primary, fallback], posixRegistryFileSystem);
      expect(read.entries).toEqual([]);
      expect(read.unsafe).toHaveLength(1);
    });

    it("ソケットの在るディレクトリが他人に開いていれば、その登録は捨てる（D105）", () => {
      // 登録は健全な候補にあるが、ソケットは他人も書ける実行時ディレクトリの形の場所を指す。
      const loose = path.join(root, "loose", "vscode-showme");
      fs.mkdirSync(loose, { recursive: true });
      fs.chmodSync(loose, 0o777);
      place(primary, `${H1}.json`, entry({ windowId: "loose", socketPath: `${loose}/${H1}.sock` }));
      const read = readRegistryEntries([primary], posixRegistryFileSystem);
      expect(read.entries).toEqual([]);
    });

    it("ソケットの在るディレクトリが symlink なら、その登録は捨てる（D105）", () => {
      const link = path.join(root, "link", "vscode-showme");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(primary, link);
      place(primary, `${H1}.json`, entry({ windowId: "link", socketPath: `${link}/${H1}.sock` }));
      expect(readRegistryEntries([primary], posixRegistryFileSystem).entries).toEqual([]);
    });

    it("走査先に無い、健全な実行時ディレクトリのソケットは通す（拡張にだけ XDG がある）", () => {
      place(
        fallback,
        `${H1}.json`,
        entry({ windowId: "xdg", socketPath: `${primary}/${H1}.sock` }),
      );
      const read = readRegistryEntries([fallback], posixRegistryFileSystem);
      expect(read.entries.map((e) => e.windowId)).toEqual(["xdg"]);
    });
  },
);

describe("discoverRegistry（win32 の手順。偽の DACL の判定で、どの OS でも回す）", () => {
  const PIPE = `\\\\.\\pipe\\vscode-showme-${H1}`;
  let root: string;
  let primary: string;
  let fallback: string;

  beforeEach(() => {
    ({ root, primary, fallback } = makeRuntimeRoot("showme-discover-w-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      workspacePath: "C:\\w",
      pid: process.pid,
      startedAt: "2026-09-09T00:00:00Z",
      socketPath: PIPE,
      authToken: TOKEN,
      windowId: "w-1",
      role: "stage",
      ...over,
    });

  it("通った候補だけを読み、通らなかった候補は理由つきの unsafe にする", async () => {
    fs.writeFileSync(path.join(primary, `${H1}.json`), body());
    fs.writeFileSync(
      path.join(fallback, `${H2}.json`),
      body({ windowId: "w-2", socketPath: PIPE.replace(H1, H2) }),
    );
    const verified: string[] = [];
    const read = await discoverRegistry([primary, fallback], {
      platform: "win32",
      verifyWindowsDir: async (dir) => {
        verified.push(dir);
        return dir === primary ? { ok: true } : { ok: false, reason: "Everyone can read it" };
      },
    });
    expect(verified.sort()).toEqual([primary, fallback].sort());
    expect(read.entries.map((e) => e.windowId)).toEqual(["w-1"]);
    expect(read.unsafe).toEqual([{ dir: fallback, reason: "Everyone can read it" }]);
  });

  it("無い候補は確かめず absent（拡張が居ないだけ。警報にしない）", async () => {
    const missing = path.join(root, "nope", "vscode-showme-0");
    const verified: string[] = [];
    const read = await discoverRegistry([missing], {
      platform: "win32",
      verifyWindowsDir: async (dir) => {
        verified.push(dir);
        return { ok: true };
      },
    });
    expect(verified).toEqual([]);
    expect(read.present).toBe(false);
    expect(read.unsafe).toEqual([]);
  });

  it("確かめる関数が投げたら、その候補は unsafe（確かめられないものは信じない）", async () => {
    fs.writeFileSync(path.join(primary, `${H1}.json`), body());
    const read = await discoverRegistry([primary], {
      platform: "win32",
      verifyWindowsDir: async () => {
        throw new Error("icacls timed out");
      },
    });
    expect(read.entries).toEqual([]);
    expect(read.unsafe[0]?.reason).toContain("icacls timed out");
  });

  it("SMB のパイプを指す登録は、通った候補にあっても捨てる（D105）", async () => {
    fs.writeFileSync(
      path.join(primary, `${H1}.json`),
      body({ socketPath: `\\\\attacker\\pipe\\vscode-showme-${H1}` }),
    );
    const read = await discoverRegistry([primary], {
      platform: "win32",
      verifyWindowsDir: async () => ({ ok: true }),
    });
    expect(read.entries).toEqual([]);
  });

  it("win32 の登録ファイルは通常のファイルだけ（symlink・ディレクトリは読まない）", async () => {
    const real = path.join(root, `${H2}.json`);
    fs.writeFileSync(real, body());
    fs.symlinkSync(real, path.join(primary, `${H1}.json`));
    fs.mkdirSync(path.join(fallback, `${H1}.json`));
    const read = await discoverRegistry([primary, fallback], {
      platform: "win32",
      verifyWindowsDir: async () => ({ ok: true }),
    });
    expect(read.entries).toEqual([]);
  });

  it("判定の無い候補を win32 で開くと unsafe（確かめていないものは読まない）", () => {
    const io = createNodeRegistryFileSystem({ platform: "win32" });
    const state = io.openDir(primary);
    expect(state.kind).toBe("unsafe");
    expect(state.kind === "unsafe" ? state.reason : "").toContain("not verified");
  });

  it.skipIf(onWindows)(
    "POSIX では DACL を確かめず、今までどおり所有者とモードで決める",
    async () => {
      fs.writeFileSync(
        path.join(primary, `${H1}.json`),
        body({ socketPath: `${primary}/${H1}.sock` }),
        { mode: 0o600 },
      );
      const read = await discoverRegistry([primary, fallback], {
        verifyWindowsDir: async () => {
          throw new Error("POSIX で呼ばれた");
        },
      });
      expect(read.entries.map((e) => e.windowId)).toEqual(["w-1"]);
    },
  );
});

describe("describeSelectionFailure", () => {
  const present = { dirs: ["/run/user/1000/vscode-showme"], present: true };
  const absent = {
    dirs: ["/run/user/1000/vscode-showme", "/tmp/vscode-showme-1000"],
    present: false,
  };

  it("登録を捨てただけで1件も無いときは、捨てたファイルと理由を言う（D105）", () => {
    const message = describeSelectionFailure(
      { ok: false, reason: "no-entries" },
      {
        ...present,
        rejected: [
          {
            file: `/run/user/1000/vscode-showme/${"0".repeat(16)}.json`,
            reason: "its socketPath is not a path the extension creates",
          },
        ],
      },
    );
    expect(message).toContain(`${"0".repeat(16)}.json`);
    expect(message).toContain("its socketPath is not a path the extension creates");
  });

  it("捨てた登録が無ければ、今までの言葉のまま", () => {
    const withEmpty = describeSelectionFailure(
      { ok: false, reason: "no-entries" },
      { ...present, rejected: [] },
    );
    expect(withEmpty).toBe(describeSelectionFailure({ ok: false, reason: "no-entries" }, present));
  });

  it("ディレクトリごと無いときは、走査した候補を全部名指しする", () => {
    const message = describeSelectionFailure({ ok: false, reason: "no-entries" }, absent);
    for (const dir of absent.dirs) expect(message).toContain(dir);
    expect(message).toContain("does not exist");
  });

  it("no-entries は「拡張が有効か」と「同じ環境か」の両方を尋ねる", () => {
    // どちらか片方しか言わないと、外した方の原因のとき直しようがない。
    for (const scan of [present, absent]) {
      const message = describeSelectionFailure({ ok: false, reason: "no-entries" }, scan);
      expect(message).toContain("ShowMe extension is enabled");
      expect(message).toContain("same environment");
      expect(message).toContain("TMPDIR");
      // $XDG_RUNTIME_DIR の食い違いは「同じマシンにいるのに見つからない」の
      // 主な原因である（拡張とブリッジの片方だけに設定されている構成が普通に
      // 起きる）。原因候補として名指ししないと、走査先を見せられた人間は
      // 「なぜそこを見ているのか」に辿り着けない。
      expect(message).toContain("XDG_RUNTIME_DIR");
    }
  });

  it("版違いは「版を揃えろ」と言う（「見つかりません」で終わらせない）", () => {
    expect(describeSelectionFailure({ ok: false, reason: "version-mismatch" }, present)).toContain(
      "Bring both to the same version",
    );
  });

  it("no-stage は、次にやること(ステータスバーを押す)を言う", () => {
    const message = describeSelectionFailure(
      { ok: false, reason: "no-stage", idleCount: 2 },
      present,
    );
    expect(message).toContain("ShowMe is off in every VS Code window");
    expect(message).toContain("status bar");
    expect(message).toContain("ShowMe");
    // 停止中（ShowMe: Stopped）の窓はブリッジに見えないので、ここに来る。クリックでは
    // オンにならないから、再開にも触れる。
    expect(message).toContain("Stopped");
  });

  it("no-stage は候補の数だけを言う(拡張が動いていないのと区別するため)", () => {
    const message = describeSelectionFailure(
      { ok: false, reason: "no-stage", idleCount: 3 },
      present,
    );
    expect(message).toContain("3");
  });

  it("no-stage は窓のパスも windowId も漏らさない", () => {
    // 預けていない窓の情報をエージェントに教える理由が無い。
    // 実際の選択結果から言葉を作って、経路ごと確かめる。
    const secret: RegistryEntry = {
      ...idle,
      windowId: "win-secret",
      workspacePath: "/w/private",
      socketPath: "/rt/secret.sock",
    };
    const selection = selectWindow([secret], {});
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    const message = describeSelectionFailure(selection, present);
    expect(message).not.toContain("/w/private");
    expect(message).not.toContain("win-secret");
    expect(message).not.toContain("secret.sock");
  });

  it("multiple-stages は、預けた窓を人間が選べるように名指しする", () => {
    // ここは漏らしてよい。人間がどちらかを外すために要る情報である。
    const message = describeSelectionFailure(
      {
        ok: false,
        reason: "multiple-stages",
        stages: [
          { windowId: "w-a", role: "stage", socketPath: "/rt/a.sock", workspacePath: "/w/alpha" },
          { windowId: "w-b", role: "stage", socketPath: "/rt/b.sock", workspacePath: "/w/beta" },
        ],
      },
      present,
    );
    expect(message).toContain("/w/alpha");
    expect(message).toContain("w-a");
    expect(message).toContain("/w/beta");
    expect(message).toContain("w-b");
    expect(message).toContain("exactly one window");
  });

  it("どの理由にも言葉がある（増やして黙る枝を作らない）", () => {
    const failures = [
      { ok: false, reason: "no-entries" },
      { ok: false, reason: "version-mismatch" },
      { ok: false, reason: "exhausted" },
      { ok: false, reason: "no-stage", idleCount: 1 },
      { ok: false, reason: "multiple-stages", stages: [] },
    ] as const;
    for (const failure of failures) {
      expect(describeSelectionFailure(failure, present).length).toBeGreaterThan(10);
    }
  });
});

describe("describeUnsafeRuntimeDir", () => {
  it("使わないこと・消さないことの両方を言う", () => {
    const message = describeUnsafeRuntimeDir("mode 777", "/tmp/vscode-showme-1000");
    expect(message).toContain("/tmp/vscode-showme-1000");
    expect(message).toContain("mode 777");
    expect(message).toContain("not deleted");
  });
});
