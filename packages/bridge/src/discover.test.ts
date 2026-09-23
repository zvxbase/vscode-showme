import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processUid, runtimeDirCandidates } from "@zvx/vscode-showme-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DirState,
  type RegistryEntry,
  type RegistryFileSystem,
  defaultRuntimeDirs,
  describeSelectionFailure,
  describeUnsafeRuntimeDir,
  nodeRegistryFileSystem,
  parseRegistryEntry,
  readRegistryEntries,
  scanRegistry,
  selectWindow,
} from "./discover.js";

const TOKEN = "a".repeat(64);

const alpha: RegistryEntry = {
  protocolVersion: 1,
  workspacePath: "/w/alpha",
  pid: 1,
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
    protocolVersion: 1,
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

describe("scanRegistry", () => {
  function fakeFs(files: Record<string, string | undefined>, dir?: DirState): RegistryFileSystem {
    return {
      openDir: () => dir ?? { kind: "ok", names: Object.keys(files) },
      read: (_dir, name) => files[name],
    };
  }

  const good = JSON.stringify({
    protocolVersion: 1,
    workspacePath: "/w/alpha",
    pid: 1,
    startedAt: "2026-09-09T00:00:00Z",
    socketPath: "/rt/a.sock",
    authToken: TOKEN,
  });

  it(".json だけを読む", () => {
    const scan = scanRegistry("/rt", fakeFs({ "a.json": good, "a.sock": good, "notes.txt": good }));
    expect(scan.entries.map((e) => e.socketPath)).toEqual(["/rt/a.sock"]);
  });

  it("壊れた登録は飛ばし、残りは読む", () => {
    const scan = scanRegistry("/rt", fakeFs({ "bad.json": "{{{", "a.json": good }));
    expect(scan.entries).toHaveLength(1);
  });

  it("読めなかったファイル(衛生検査落ち)は飛ばす", () => {
    const scan = scanRegistry("/rt", fakeFs({ "hostile.json": undefined, "a.json": good }));
    expect(scan.entries).toHaveLength(1);
  });

  it("ディレクトリが無ければ present が false になる(拡張が居ないだけ・警報ではない)", () => {
    const scan = scanRegistry("/rt", fakeFs({}, { kind: "absent" }));
    expect(scan.present).toBe(false);
    expect(scan.unsafe).toBeUndefined();
    expect(scan.entries).toEqual([]);
  });

  it("ディレクトリが衛生検査に落ちたら理由を持ち帰る(黙って迂回しない)", () => {
    const scan = scanRegistry(
      "/rt",
      fakeFs({ "a.json": good }, { kind: "unsafe", reason: "mode is 777, expected 700" }),
    );
    expect(scan.unsafe).toContain("mode is 777");
    // 衛生検査に落ちたディレクトリの中身は1件も読まない
    expect(scan.entries).toEqual([]);
  });

  it("ディレクトリが健全なら unsafe を持たない", () => {
    const scan = scanRegistry("/rt", fakeFs({ "a.json": good }));
    expect(scan.unsafe).toBeUndefined();
    expect(scan.present).toBe(true);
  });
});

describe("readRegistryEntries（両候補の走査）", () => {
  const TOKEN2 = "b".repeat(64);

  function entryJson(over: Record<string, unknown>): string {
    return JSON.stringify({
      protocolVersion: 1,
      workspacePath: "/w/alpha",
      pid: 1,
      startedAt: "2026-09-09T00:00:00Z",
      socketPath: "/rt/a.sock",
      authToken: TOKEN2,
      windowId: "w-1",
      role: "stage",
      ...over,
    });
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
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({ "/tmp/rt": { "a.json": entryJson({}) } }),
    );
    expect(read.entries.map((e) => e.windowId)).toEqual(["w-1"]);
    expect(read.present).toBe(true);
  });

  it("両方の候補を走査して、両方の窓を集める", () => {
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": { "a.json": entryJson({ windowId: "w-1", socketPath: "/xdg/a.sock" }) },
        "/tmp/rt": { "b.json": entryJson({ windowId: "w-2", socketPath: "/tmp/rt/b.sock" }) },
      }),
    );
    expect(read.entries.map((e) => e.windowId)).toEqual(["w-1", "w-2"]);
  });

  it("同じ窓が両方の候補に書いていたら windowId で1つに畳む", () => {
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": { "a.json": entryJson({ windowId: "same", socketPath: "/xdg/a.sock" }) },
        "/tmp/rt": { "a.json": entryJson({ windowId: "same", socketPath: "/tmp/rt/a.sock" }) },
      }),
    );
    expect(read.entries).toHaveLength(1);
  });

  it("畳むときは候補の順序が先の登録を残す(自己申告の startedAt では決めない)", () => {
    // 同一 uid のプロセスは 0600 の登録を読める。本物の windowId と未来の
    // startedAt を後退先に置くだけで socketPath と authToken を差し替えられる
    // なら、両候補走査は攻撃者に経路を1本渡したことになる(レビュー N2)。
    // 順序で決めれば、攻撃者は拡張の第一候補より先の候補に置く必要がある。
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": {
          "a.json": entryJson({
            windowId: "same",
            socketPath: "/xdg/real.sock",
            authToken: "c".repeat(64),
            startedAt: "2026-09-09T00:00:00Z",
          }),
        },
        "/tmp/rt": {
          "a.json": entryJson({
            windowId: "same",
            socketPath: "/tmp/rt/planted.sock",
            authToken: "d".repeat(64),
            // 未来の時刻。自己申告なので、攻撃者は好きな値を書ける。
            startedAt: "2099-01-01T00:00:00Z",
          }),
        },
      }),
    );
    expect(read.entries.map((e) => e.socketPath)).toEqual(["/xdg/real.sock"]);
    expect(read.entries.map((e) => e.authToken)).toEqual(["c".repeat(64)]);
  });

  it("windowId が違えば、同じフォルダの窓でも畳まない", () => {
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": { "a.json": entryJson({ windowId: "w-1", socketPath: "/xdg/a.sock" }) },
        "/tmp/rt": { "b.json": entryJson({ windowId: "w-2", socketPath: "/tmp/rt/b.sock" }) },
      }),
    );
    expect(read.entries).toHaveLength(2);
  });

  it("同じ候補を2度渡されても1度しか走査しない(同じ窓が2つに見える)", () => {
    const io = fsOf({ "/tmp/rt": { "a.json": entryJson({}) } });
    const read = readRegistryEntries(["/tmp/rt", "/tmp/rt"], io);
    expect(read.entries).toHaveLength(1);
    expect(io.listed).toEqual(["/tmp/rt"]);
  });

  it("片方が衛生検査に落ちても、もう片方は読む(先回りで塞がれない)", () => {
    // /tmp は 1777 なので、後退先の候補は攻撃者に先回りされうる。そこで
    // 全体を止めると、攻撃者は疎通そのものを止められる。読まずに迂回し、
    // 理由は持ち帰る(設計書 D22)。
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": { "a.json": entryJson({}) },
        "/tmp/rt": { kind: "unsafe", reason: "mode 777" },
      }),
    );
    expect(read.entries).toHaveLength(1);
    expect(read.unsafe.map((u) => u.dir)).toEqual(["/tmp/rt"]);
  });

  it("壊れた登録や読めない登録があっても、残りは読む", () => {
    const read = readRegistryEntries(
      ["/xdg", "/tmp/rt"],
      fsOf({
        "/xdg": { "broken.json": "{{{", "denied.json": undefined },
        "/tmp/rt": { "a.json": entryJson({}) },
      }),
    );
    expect(read.entries).toHaveLength(1);
    expect(read.unsafe).toEqual([]);
  });

  it("どちらの候補も無ければ present が false(拡張が居ないだけ)", () => {
    const read = readRegistryEntries(["/xdg", "/tmp/rt"], fsOf({}));
    expect(read.present).toBe(false);
    expect(read.entries).toEqual([]);
    expect(read.dirs).toEqual(["/xdg", "/tmp/rt"]);
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

describe("nodeRegistryFileSystem（本物のファイルシステムで検査する）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "showme-discover-"));
    fs.chmodSync(dir, 0o700);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("無いディレクトリは absent", () => {
    expect(nodeRegistryFileSystem.openDir(path.join(dir, "nope")).kind).toBe("absent");
  });

  it("0700 のディレクトリは中身を列挙できる", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "{}", { mode: 0o600 });
    const state = nodeRegistryFileSystem.openDir(dir);
    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" ? [...state.names] : []).toEqual(["a.json"]);
  });

  it("他人が書けるディレクトリは unsafe（黙って使わない）", () => {
    // /tmp は 1777 なので、決定的なパスは先回りされうる（設計書 S7 / D22）。
    // 作る側だけでなく読む側にも同じ検査が要る。
    fs.chmodSync(dir, 0o777);
    const state = nodeRegistryFileSystem.openDir(dir);
    expect(state.kind).toBe("unsafe");
    expect(state.kind === "unsafe" ? state.reason : "").toContain("mode 777");
  });

  it("ディレクトリでないものは unsafe", () => {
    const file = path.join(dir, "plain");
    fs.writeFileSync(file, "x", { mode: 0o600 });
    expect(nodeRegistryFileSystem.openDir(file).kind).toBe("unsafe");
  });

  it("0600 の通常ファイルは読める", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "hello", { mode: 0o600 });
    expect(nodeRegistryFileSystem.read(dir, "a.json")).toBe("hello");
  });

  it("他人が読める登録ファイルは読まない（トークンが漏れている登録は信じない）", () => {
    fs.writeFileSync(path.join(dir, "a.json"), "hello", { mode: 0o644 });
    expect(nodeRegistryFileSystem.read(dir, "a.json")).toBeUndefined();
  });

  it("シンボリックリンクの登録ファイルは辿らない", () => {
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "secret", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(dir, "link.json"));
    expect(nodeRegistryFileSystem.read(dir, "link.json")).toBeUndefined();
  });

  it("無いファイルは undefined", () => {
    expect(nodeRegistryFileSystem.read(dir, "missing.json")).toBeUndefined();
  });
});

describe("readRegistryEntries（本物のファイルシステムで両候補を走査する）", () => {
  let root: string;
  let primary: string;
  let fallback: string;

  const TOKEN3 = "c".repeat(64);
  const entry = (over: Record<string, unknown>) =>
    JSON.stringify({
      protocolVersion: 1,
      workspacePath: "/w/alpha",
      pid: 1,
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "showme-candidates-"));
    primary = path.join(root, "xdg");
    fallback = path.join(root, "tmp");
    for (const dir of [primary, fallback]) fs.mkdirSync(dir, { mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同じ窓が両方のディレクトリに書いていても1件になる", () => {
    place(primary, "w.json", entry({ windowId: "same", socketPath: `${primary}/w.sock` }));
    place(fallback, "w.json", entry({ windowId: "same", socketPath: `${fallback}/w.sock` }));

    const read = readRegistryEntries([primary, fallback], nodeRegistryFileSystem);
    expect(read.entries).toHaveLength(1);
    // 預けられた窓は1つ。畳めていなければ multiple-stages になる。
    const selection = selectWindow(read.entries, {});
    expect(selection.ok).toBe(true);
  });

  it("片方のディレクトリにしか無い窓も見つかる(XDG の食い違いで黙って見失わない)", () => {
    place(fallback, "w.json", entry({ windowId: "only", socketPath: `${fallback}/w.sock` }));
    const read = readRegistryEntries([primary, fallback], nodeRegistryFileSystem);
    expect(read.entries.map((e) => e.windowId)).toEqual(["only"]);
  });

  it("読めない登録が混ざっても、読める登録は読む(全体が落ちない)", () => {
    place(primary, "broken.json", "{{{ not json");
    place(primary, "leaky.json", entry({ windowId: "leaky", socketPath: "/x.sock" }), 0o644);
    fs.symlinkSync(path.join(primary, "broken.json"), path.join(primary, "link.json"));
    fs.mkdirSync(path.join(primary, "dir.json"), { mode: 0o700 });
    place(fallback, "good.json", entry({ windowId: "good", socketPath: `${fallback}/g.sock` }));

    const read = readRegistryEntries([primary, fallback], nodeRegistryFileSystem);
    expect(read.entries.map((e) => e.windowId)).toEqual(["good"]);
    expect(read.unsafe).toEqual([]);
  });

  it("後退先が他人にも書ける状態で先回りされていても、正規の候補は読める", () => {
    // /tmp は 1777。ここで全体を止めると、誰でも疎通を止められる。
    fs.chmodSync(fallback, 0o777);
    place(primary, "w.json", entry({ windowId: "ok", socketPath: `${primary}/w.sock` }));

    const read = readRegistryEntries([primary, fallback], nodeRegistryFileSystem);
    expect(read.entries.map((e) => e.windowId)).toEqual(["ok"]);
    expect(read.unsafe.map((u) => u.dir)).toEqual([fallback]);
  });

  it("危ないディレクトリの中身は1件も読まない", () => {
    place(fallback, "w.json", entry({ windowId: "planted", socketPath: `${fallback}/w.sock` }));
    fs.chmodSync(fallback, 0o777);

    const read = readRegistryEntries([primary, fallback], nodeRegistryFileSystem);
    expect(read.entries).toEqual([]);
    expect(read.unsafe).toHaveLength(1);
  });
});

describe("describeSelectionFailure", () => {
  const present = { dirs: ["/run/user/1000/vscode-showme"], present: true };
  const absent = {
    dirs: ["/run/user/1000/vscode-showme", "/tmp/vscode-showme-1000"],
    present: false,
  };

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
