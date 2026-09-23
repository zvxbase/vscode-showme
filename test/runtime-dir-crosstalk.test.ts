import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeRegistryFileSystem,
  readRegistryEntries,
  selectWindow,
} from "../packages/bridge/src/discover.js";
import { ShowMeSocketServer } from "../packages/extension/src/server.js";
import { processUid, runtimeDirCandidates } from "../packages/protocol/src/runtime-dir.js";

/**
 * 拡張とブリッジで `$XDG_RUNTIME_DIR` が食い違っても疎通する（設計書 §2A.6 / 2A.8）。
 *
 * **これは合成テストではない。** 既存の単体テストは `dirs` を直接渡していたので、
 * 「その `dirs` をどう作るか」という食い違いそのものを一度も通っていなかった。
 * ここでは両端が `runtimeDirCandidates` に**別々の env** を渡すところから始め、
 * 本物のファイルシステムに本物の `ShowMeSocketServer` を立て、本物の
 * `nodeRegistryFileSystem` で走査する。
 *
 * この束は増分2A のレビューで実測された欠陥を捕まえるためにある:
 *
 * ```
 * 拡張 XDG あり / ブリッジ XDG なし:
 *   拡張の書き込み先 : /run/user/1000/vscode-showme
 *   ブリッジの走査先 : [ /tmp/vscode-showme-1000 ]        ← 見つからない
 * ```
 *
 * ブリッジは**自分に `$XDG_RUNTIME_DIR` が無ければ XDG 候補を構成できない**ので、
 * 読み取りだけを両候補にしても片方向しか塞がらない。そして塞がっていない方こそが
 * 現実的な構成である（デスクトップ／コンテナで起動した VS Code には XDG があり、
 * `docker exec` / `ssh` / `su` で入ったシェルには無い）。
 *
 * 拡張の書き込みを両候補にする対称化を外すと、この節の最初の検査が落ちる。
 *
 * パッケージ境界をまたぐので、置き場所は個々のパッケージではなくルートの
 * `test/` にする。確かめているのは拡張とブリッジの**間の契約**である。
 */

const made: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "showme-xdg-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 同じマシンの上の、env だけが違う2つの立場を作る。
 *
 * `tmpdir` は両者で同じ（同じマシン・同じファイルシステム名前空間にいることが
 * 疎通の唯一の成立条件。設計書 §3.4）。違うのは `$XDG_RUNTIME_DIR` だけである。
 */
function twoSides(): {
  xdgRoot: string;
  tmpdir: string;
  withXdg: string[];
  withoutXdg: string[];
} {
  const root = tmpRoot();
  const xdgRoot = path.join(root, "run-user-1000");
  const tmpdir = path.join(root, "tmp");
  fs.mkdirSync(xdgRoot, { mode: 0o700 });
  fs.mkdirSync(tmpdir, { mode: 0o700 });
  const uid = processUid(process);
  return {
    xdgRoot,
    tmpdir,
    withXdg: runtimeDirCandidates({ XDG_RUNTIME_DIR: xdgRoot }, tmpdir, uid),
    withoutXdg: runtimeDirCandidates({}, tmpdir, uid),
  };
}

const stageIdentity = { windowId: "window-under-test", role: () => "stage" as const };

describe("実行時ディレクトリ: $XDG_RUNTIME_DIR が食い違っても見つかる（実ファイルシステム）", () => {
  it("拡張に XDG があり、ブリッジには無い（docker exec / ssh / su で入ったシェル）", async () => {
    const { withXdg, withoutXdg, xdgRoot, tmpdir } = twoSides();
    // 前提そのものを検査する。ブリッジ側は XDG 候補を**構成できない**ので、
    // 拡張が第一候補にしか書かなければ、ここは原理的に見つからない。
    expect(withoutXdg).toHaveLength(1);
    expect(withXdg[0]).toBe(path.join(xdgRoot, "vscode-showme"));
    expect(withoutXdg[0]).toBe(withXdg[1]);

    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    const info = await server.start();
    try {
      const read = readRegistryEntries(withoutXdg, nodeRegistryFileSystem);
      expect(read.entries.map((e) => e.windowId)).toEqual(["window-under-test"]);

      // 見つけた登録から、**実在するソケット**へ辿れること。ソケットは1本で、
      // 第一候補（XDG 側）にある。登録は絶対パスを持っているので、後退先で
      // 見つけても同じソケットに繋がる。
      const entry = read.entries[0];
      expect(entry?.socketPath).toBe(info.socketPath);
      expect(fs.existsSync(String(entry?.socketPath))).toBe(true);
      expect(path.dirname(info.socketPath)).toBe(path.join(xdgRoot, "vscode-showme"));

      // 選択まで通す。「登録が読めた」で止めると、役割の軸を壊しても緑になる。
      const selection = selectWindow(read.entries, {});
      expect(selection.ok).toBe(true);
      expect(selection.ok && selection.entry.socketPath).toBe(info.socketPath);

      // 後退先には登録ファイルだけがある（ソケットは複製しない）。
      const fallback = path.join(tmpdir, `vscode-showme-${processUid(process)}`);
      expect(fs.readdirSync(fallback).filter((n) => n.endsWith(".sock"))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("拡張に XDG が無く、ブリッジにはある（逆向き）", async () => {
    const { withXdg, withoutXdg } = twoSides();
    const server = new ShowMeSocketServer(withoutXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    const info = await server.start();
    try {
      const read = readRegistryEntries(withXdg, nodeRegistryFileSystem);
      expect(read.entries.map((e) => e.socketPath)).toEqual([info.socketPath]);
    } finally {
      await server.stop();
    }
  });

  it("両端の env が揃っていれば、同じ窓が2つに見えない", async () => {
    const { withXdg } = twoSides();
    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    await server.start();
    try {
      const read = readRegistryEntries(withXdg, nodeRegistryFileSystem);
      // 両候補に同じ内容が置いてあるので、畳めないと候補が2つに見え、
      // 「預けられた窓が複数あります」になる（実際には1窓しかないのに）。
      expect(read.entries).toHaveLength(1);
      expect(selectWindow(read.entries, {}).ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("登録ファイルは両候補に同じ内容で置かれる", async () => {
    const { withXdg } = twoSides();
    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    const info = await server.start();
    try {
      expect(info.registryPaths).toHaveLength(2);
      const contents = info.registryPaths.map((p) => fs.readFileSync(p, "utf8"));
      expect(contents[0]).toBe(contents[1]);
      for (const p of info.registryPaths) {
        expect(fs.statSync(p).mode & 0o777, `${p} のモード`).toBe(0o600);
      }
    } finally {
      await server.stop();
    }
  });

  it("役割の書き直しは両候補に届く（片方だけ古い役割が残らない）", async () => {
    const { withXdg, withoutXdg } = twoSides();
    let role: "stage" | "idle" = "idle";
    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      windowId: "w1",
      role: () => role,
    });
    await server.start();
    try {
      role = "stage";
      server.refreshRegistration();
      // 後退先しか見られないブリッジから、預けたことが見えること。
      const read = readRegistryEntries(withoutXdg, nodeRegistryFileSystem);
      expect(read.entries.map((e) => e.role)).toEqual(["stage"]);
    } finally {
      await server.stop();
    }
  });

  it("stop() は両候補の登録を消す（死んだ窓が後退先に残らない）", async () => {
    const { withXdg, withoutXdg } = twoSides();
    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    const info = await server.start();
    await server.stop();

    for (const p of info.registryPaths) expect(fs.existsSync(p), p).toBe(false);
    expect(fs.existsSync(info.socketPath)).toBe(false);
    expect(readRegistryEntries(withoutXdg, nodeRegistryFileSystem).entries).toEqual([]);
  });

  it("start は両候補の、死んだ窓の登録を掃除する", async () => {
    const { withXdg } = twoSides();
    const stale: string[] = [];
    for (const dir of withXdg) {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, `${"9".repeat(16)}.json`);
      // 存在しない pid。掃除の対象になる。
      fs.writeFileSync(file, JSON.stringify({ pid: 0x7fffffff, socketPath: "/tmp/dead.sock" }), {
        mode: 0o600,
      });
      stale.push(file);
    }

    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    await server.start();
    try {
      // 片方しか掃除しないと、生きた窓が1つでもブリッジには2候補に見える。
      for (const file of stale) expect(fs.existsSync(file), file).toBe(false);
      expect(readRegistryEntries(withXdg, nodeRegistryFileSystem).entries).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("片方の候補が衛生検査に落ちても、もう片方で疎通する（先回りで起動不能にできない）", async () => {
    const { withXdg, withoutXdg } = twoSides();
    // 後退先に、他人も書けるディレクトリを先回りで置く。/tmp は 1777 なので
    // 誰にでもできる。ここで起動ごと失敗させると、それが DoS になる。
    const fallback = String(withoutXdg[0]);
    fs.mkdirSync(fallback, { mode: 0o777 });
    fs.chmodSync(fallback, 0o777);

    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    const info = await server.start();
    try {
      expect(info.registryPaths).toHaveLength(1);
      expect(readRegistryEntries(withXdg, nodeRegistryFileSystem).entries).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("両方の候補が用意できないときだけ起動に失敗し、両方の理由を言う", async () => {
    const { withXdg } = twoSides();
    for (const dir of withXdg) {
      fs.mkdirSync(dir, { mode: 0o777 });
      fs.chmodSync(dir, 0o777);
    }
    const server = new ShowMeSocketServer(withXdg, async () => ({}), "/ws", undefined, {
      ...stageIdentity,
    });
    await expect(server.start()).rejects.toThrow(
      // 片方の理由しか言わないと、人間はもう片方を直しようがない。
      new RegExp(`${withXdg[0]}[\\s\\S]*${withXdg[1]}`),
    );
  });
});
