import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REDACTED_PATTERNS } from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ShowMeConfig } from "../src/config.js";
import { type AnnotateDeps, handleAnnotate } from "../src/handlers/annotate.js";
import { type ShowCodeDeps, handleShowCode } from "../src/handlers/show-code.js";
import type { SymbolSurface } from "../src/handlers/symbol-prefetch.js";
import { NO_CANONICAL_PATH_KEY, RateLimiter, UNNORMALIZED_PATH_KEY } from "../src/rate-limit.js";
import { agentSpelling } from "./outside-spelling.js";

/**
 * `show_code` / `annotate` がワークスペースの外のファイルを扱う（D102）。
 *
 * - 設定がオフなら今と同じ（絶対パスは `invalid-path`）
 * - オンなら外のファイルを絶対パスで開き、`normalizedPath` は**正規化した綴り**（realpath ではない）
 * - 中のファイルを絶対パスで指したら相対パスとして扱う
 * - 資格情報の置き場所は、存在を問わず `excluded-path`
 */

const made: string[] = [];
function dirs(): { root: string; outside: string } {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-outside-h-")));
  made.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "one\nTARGET\nthree\n");
  fs.writeFileSync(path.join(outside, "b.ts"), "alpha\nNEEDLE\ngamma\n");
  return { root, outside };
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const config = (allowOutsideWorkspace: boolean): ShowMeConfig => ({
  enabled: true,
  features: { stage: true, html: true, layout: true },
  editorGroup: "dedicated",
  stageTabs: { agentTabs: true, editable: false },
  avoidToolColumns: false,
  definitionTarget: "file",
  html: { maxPanels: 2 },
  redaction: {
    patterns: [...DEFAULT_REDACTED_PATTERNS],
    blockLinksToRedacted: true,
    allowOutsideWorkspace,
  },
  maxSelectionChars: 4000,
  injectTerminalEnv: true,
  listAllWorkspaces: false,
  layout: { closeHumanTabs: false, closeDirtyTabs: false, protectViewingTab: false },
});

function showCodeSpy(root: string, allow: boolean, limiter = new RateLimiter()) {
  const revealed: string[] = [];
  const miss: string[] = [];
  const deps: ShowCodeDeps = {
    config: () => config(allow),
    workspaceRoot: root,
    limiter,
    editor: {
      reveal: async (relPath) => {
        revealed.push(relPath);
      },
    },
    log: { info: () => undefined },
    statusBar: {
      flashMiss: (p) => miss.push(p),
      flashManyMatches: () => undefined,
      flashRateLimited: () => undefined,
      flashMarked: () => undefined,
    },
  };
  return { deps, revealed, miss };
}

const CREDENTIAL = path.join(os.homedir(), ".ssh", "showme-test-nonexistent");

describe("show_code とワークスペースの外（D102）", () => {
  it("設定がオフなら外の絶対パスは今と同じ invalid-path で、開かない", async () => {
    const { root, outside } = dirs();
    const s = showCodeSpy(root, false);
    const out = await handleShowCode(
      { locations: [{ path: path.join(outside, "b.ts"), text: "NEEDLE" }] },
      s.deps,
    );
    expect(out.resolutions).toEqual([
      { resolvedBy: "none", match: "none", reason: "invalid-path" },
    ]);
    expect(s.revealed).toEqual([]);
  });

  it("オンなら外のファイルを開き、normalizedPath は正規化した絶対パス", async () => {
    const { root, outside } = dirs();
    const s = showCodeSpy(root, true);
    const abs = path.join(outside, "b.ts");
    const out = await handleShowCode(
      { locations: [{ path: `${outside}//b.ts`, text: "NEEDLE" }] },
      s.deps,
    );
    expect(out.resolutions).toEqual([
      {
        resolvedBy: "text",
        match: "one",
        // text の一致の列（D118）。
        range: { startLine: 2, endLine: 2, startColumn: 0, endColumn: 6 },
        normalizedPath: agentSpelling(abs),
      },
    ]);
    expect(s.revealed).toEqual([agentSpelling(abs)]);
  });

  it("シンボリックリンクの綴りで指したら、normalizedPath はリンクの綴りのまま（指す先を返さない）", async () => {
    const { root, outside } = dirs();
    const alias = path.join(outside, "alias.ts");
    fs.symlinkSync(path.join(outside, "b.ts"), alias);
    const s = showCodeSpy(root, true);
    const out = await handleShowCode({ locations: [{ path: alias, text: "NEEDLE" }] }, s.deps);
    expect((out.resolutions as { normalizedPath?: string }[])[0]?.normalizedPath).toBe(
      agentSpelling(alias),
    );
    expect(s.revealed).toEqual([agentSpelling(alias)]);
  });

  it("中のファイルを絶対パスで指したら、相対パスとして扱う", async () => {
    const { root } = dirs();
    const s = showCodeSpy(root, true);
    const out = await handleShowCode(
      { locations: [{ path: path.join(root, "src", "a.ts"), text: "TARGET" }] },
      s.deps,
    );
    expect((out.resolutions as { normalizedPath?: string }[])[0]?.normalizedPath).toBe("src/a.ts");
    expect(s.revealed).toEqual(["src/a.ts"]);
  });

  it("資格情報の置き場所は、無くても excluded-path（何も作らない）", async () => {
    const { root } = dirs();
    const s = showCodeSpy(root, true);
    const existedBefore = fs.existsSync(CREDENTIAL);
    const out = await handleShowCode({ locations: [{ path: CREDENTIAL, text: "x" }] }, s.deps);
    expect((out.resolutions as { reason?: string }[])[0]?.reason).toBe("excluded-path");
    expect(s.revealed).toEqual([]);
    expect(s.miss).toEqual([CREDENTIAL]);
    expect(fs.existsSync(CREDENTIAL)).toBe(existedBefore);
  });

  it("秘匿の名前の外のファイルは excluded-path", async () => {
    const { root, outside } = dirs();
    fs.writeFileSync(path.join(outside, ".env"), "S=1\n");
    const s = showCodeSpy(root, true);
    const out = await handleShowCode(
      { locations: [{ path: path.join(outside, ".env"), text: "S" }] },
      s.deps,
    );
    expect((out.resolutions as { reason?: string }[])[0]?.reason).toBe("excluded-path");
  });

  it("~ は展開しない（相対パスとして読み、無いので not-found）", async () => {
    const { root } = dirs();
    const s = showCodeSpy(root, true);
    const out = await handleShowCode({ locations: [{ path: "~/.bashrc", text: "x" }] }, s.deps);
    expect(s.revealed).toEqual([]);
    expect((out.resolutions as { match?: string }[])[0]?.match).toBe("none");
  });
});

describe("回数制限の鍵（外。D102）", () => {
  it("受け入れた外のファイルは実体の絶対パスが鍵、落ちたものは存在を問わず同じ共有の鍵", async () => {
    const { root, outside } = dirs();
    const keys: string[] = [];
    const limiter = new RateLimiter();
    const allow = limiter.allow.bind(limiter);
    limiter.allow = (key: string) => {
      keys.push(key);
      return allow(key);
    };
    const s = showCodeSpy(root, true, limiter);
    await handleShowCode(
      {
        locations: [
          { path: path.join(outside, "b.ts"), text: "NEEDLE" },
          { path: CREDENTIAL, text: "x" },
          { path: path.join(os.homedir(), ".ssh", "config"), text: "x" },
          { path: path.join(outside, "missing.ts"), text: "x" },
        ],
      },
      s.deps,
    );
    expect(keys[0]).toBe(path.join(outside, "b.ts"));
    expect(new Set(keys.slice(1)).size).toBe(1);
    expect([UNNORMALIZED_PATH_KEY, NO_CANONICAL_PATH_KEY]).toContain(keys[1]);
  });
});

describe("annotate とワークスペースの外（D102）", () => {
  function annotateSpy(root: string, allow: boolean) {
    const added: string[] = [];
    const deps: AnnotateDeps = {
      config: () => config(allow),
      workspaceRoot: root,
      limiter: new RateLimiter(),
      annotations: {
        clearAll: () => undefined,
        add: (relPath) => {
          added.push(relPath);
          return { id: added.length };
        },
        indices: () => new Map(added.map((_, i) => [i + 1, i + 1])),
      },
      log: { info: () => undefined },
      statusBar: {
        flashMiss: () => undefined,
        flashManyMatches: () => undefined,
        flashRateLimited: () => undefined,
        flashMarked: () => undefined,
      },
    };
    return { deps, added };
  }

  it("オンなら外のファイルに吹き出しを付け、オフなら invalid-path", async () => {
    const { root, outside } = dirs();
    const abs = path.join(outside, "b.ts");
    const on = annotateSpy(root, true);
    const outOn = await handleAnnotate(
      { items: [{ location: { path: abs, text: "NEEDLE" }, text: "here" }] },
      on.deps,
    );
    expect(on.added).toEqual([agentSpelling(abs)]);
    expect((outOn.resolutions as { normalizedPath?: string }[])[0]?.normalizedPath).toBe(
      agentSpelling(abs),
    );

    const off = annotateSpy(root, false);
    const outOff = await handleAnnotate(
      { items: [{ location: { path: abs, text: "NEEDLE" }, text: "here" }] },
      off.deps,
    );
    expect(off.added).toEqual([]);
    expect((outOff.resolutions as { reason?: string }[])[0]?.reason).toBe("invalid-path");
  });
});

describe("symbol で外のファイルを引く（D102）", () => {
  it("引く面には実体の絶対パスが渡る。資格情報の置き場所では引かない", async () => {
    const { root, outside } = dirs();
    const asked: string[] = [];
    const symbols: SymbolSurface = {
      lookup: async (p) => {
        asked.push(p);
        return { kind: "resolved", ranges: [{ startLine: 2, endLine: 2 }] };
      },
    };
    const s = showCodeSpy(root, true);
    await handleShowCode(
      {
        locations: [
          { path: path.join(outside, "b.ts"), symbol: "NEEDLE" },
          { path: CREDENTIAL, symbol: "x" },
        ],
      },
      { ...s.deps, symbols },
    );
    expect(asked).toEqual([path.join(outside, "b.ts")]);
    expect(s.revealed).toEqual([agentSpelling(path.join(outside, "b.ts"))]);
  });
});
