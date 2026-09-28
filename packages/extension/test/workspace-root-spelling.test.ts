import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * **「根からの相対パス」を決める関数は1つ**（不変条件14。増分11 の最終レビュー）。
 *
 * ワークスペースをリンク越しの綴り（POSIX の symlink、Windows の junction・8.3 の短い名前・
 * ドライブ文字の大小）で開くと、VS Code と言語サーバは中のファイルを**実体の綴り**で返すことがある。
 * 以前は4つの消費者が別々に相対パスを決めていた:
 *
 * - `language-surface.ts`（`find_*` の結果の名前）: 根の実体でも測り直す
 * - `stage-language.ts`（映しの定義・参照の写し方）: 同じく測り直すが、正規化の通し方が違う
 * - `editor-surface.ts` の `observedRelPath`（`get_editor_state` のタブの名前）: 綴りだけ
 * - `editor-observation.ts` の `relativizeToRoot`（上2つの土台）: 綴りだけ
 *
 * 結果、`find_references` が `src/a.ts` と名指したファイルを人間が開くと、同じファイルが
 * `get_editor_state` で `(outside workspace)` になった。ここでは**4つ全部**が、根の綴りと
 * 対象の綴りのどの組み合わせでも同じ名前を返すことを本物のファイルシステムで確かめる。
 *
 * 統合テストの固定具は、ワークスペースを実体の綴りで作る（TS がリンク越しの根で参照を崩すため）。
 * だからこの経路の回帰の検査はここだけにある。
 */
vi.mock("vscode", () => {
  class Uri {
    private constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
    ) {}
    get fsPath(): string {
      return this.path;
    }
    static file(p: string): Uri {
      return new Uri("file", "", p);
    }
    static from(parts: { scheme: string; authority?: string; path: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? "", parts.path);
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }
  class Location {
    constructor(
      readonly uri: Uri,
      readonly range: unknown,
    ) {}
  }
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class TabInputText {
    constructor(readonly uri: unknown) {}
  }
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }
  const answer: { value: unknown[] } = { value: [] };
  return {
    Uri,
    Location,
    Position,
    TabInputText,
    TabInputWebview,
    __answer: answer,
    commands: { executeCommand: async () => answer.value },
    workspace: { isTrusted: true },
  };
});

import * as vscode from "vscode";
import { relativizeToRoot } from "../src/editor-observation.js";
import { observedRelPath } from "../src/editor-surface.js";
import { createLanguageSurface } from "../src/language-surface.js";
import { placeOfResult } from "../src/stage-language.js";
import { diskChangeKey, humanDocumentKey } from "../src/stage-registration.js";
import {
  type RedactionPolicy,
  isRedactedEntity,
  relativeToWorkspaceRoot,
} from "../src/workspace-path-gate.js";

const onWindows = process.platform === "win32";
const policy: RedactionPolicy = { patterns: [], blockLinksToRedacted: true };
const answer = (vscode as unknown as { __answer: { value: unknown[] } }).__answer;
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

/**
 * 消費者が `target` をどう名指すか。`undefined` は「中ではない」。`stage-registration.ts` の2つ
 * （人間の文書の鍵・ディスクの変更の鍵）も `relativizeToRoot` の上にあるので、同じ表に並べる。
 */
async function namesFrom(rootPath: string, target: string, rootScheme = "file") {
  const root =
    rootScheme === "file"
      ? vscode.Uri.file(rootPath)
      : vscode.Uri.from({ scheme: rootScheme, path: rootPath });
  const uri = vscode.Uri.file(target);
  const place = placeOfResult(root, uri, policy);
  const surface = createLanguageSurface(root, () => policy);
  const anchor = await surface.resolveAnchor({ path: "src/b.ts", lines: { start: 1, end: 1 } });
  if (!anchor.ok) throw new Error(`錨が立たない: ${anchor.reason}`);
  // 錨のファイル（根の綴りの中）も1件混ぜる ―― 答えが空だと引き直しの輪が実時間で待つ。
  const sentinel = vscode.Uri.file(path.join(rootPath, "src", "b.ts"));
  answer.value = [new vscode.Location(uri, range), new vscode.Location(sentinel, range)];
  const found = (await surface.references(anchor.anchor))?.filter((f) => f.path !== "src/b.ts");
  return {
    relativizeToRoot: relativizeToRoot(root, uri),
    placeOfResult: place.kind === "inside" ? place.rel : place.kind,
    observedRelPath: observedRelPath(root, uri),
    languageSurface: found?.map((f) => f.path),
    humanDocumentKey: humanDocumentKey(root, uri, policy),
    diskChangeKey: diskChangeKey(root, uri),
  };
}

const INSIDE_A = {
  relativizeToRoot: "src/a.ts",
  placeOfResult: "src/a.ts",
  observedRelPath: "src/a.ts",
  languageSurface: ["src/a.ts"],
  humanDocumentKey: "src/a.ts",
  diskChangeKey: "src/a.ts",
};

const NOT_INSIDE = {
  relativizeToRoot: undefined,
  placeOfResult: "outside",
  observedRelPath: undefined,
  languageSurface: [],
  humanDocumentKey: undefined,
  diskChangeKey: undefined,
};

/**
 * 根の2つの綴り（`spelledRoot` はリンク越し、`realRoot` は実体）で開いたとき、対象を綴りの根の下の
 * 綴りで渡しても実体の綴りで渡しても同じ名前になる。実体の根に対して**リンク越しの綴りの対象**を渡す
 * 組は含めない（対象の綴りのリンクは辿らない。既知の限界 ―― 増分11 設計書）。`symmetric` は、綴りの
 * 違いがリンクでなく比較の規則で吸収されるもの（Windows のドライブ文字の大小）で、4組とも確かめる。
 */
async function expectSameNameFromEverySpelling(
  spelledRoot: string,
  realRoot: string,
  symmetric = false,
) {
  const pairs: [string, string][] = [
    [spelledRoot, spelledRoot],
    [spelledRoot, realRoot],
    [realRoot, realRoot],
  ];
  if (symmetric) pairs.push([realRoot, spelledRoot]);
  for (const [root, base] of pairs) {
    expect({ root, base, ...(await namesFrom(root, path.join(base, "src", "a.ts"))) }).toEqual({
      root,
      base,
      ...INSIDE_A,
    });
  }
}

/** 根そのものと、本当の外は、どの綴りでも中にならない。秘匿は実体の綴りでも関門に落ちる。 */
async function expectRootAndOutsideStayOut(spelledRoot: string, realRoot: string, outside: string) {
  for (const root of [spelledRoot, realRoot]) {
    for (const target of [spelledRoot, realRoot]) {
      expect(await namesFrom(root, target)).toEqual(NOT_INSIDE);
    }
    expect(await namesFrom(root, outside)).toEqual(NOT_INSIDE);
    const env = await namesFrom(root, path.join(realRoot, ".env"));
    expect(env.placeOfResult).toBe("rejected");
    expect(env.languageSurface).toEqual([]);
    // 観測の側は名前を出す（除外は下流が決める。設計書 §3.1）―― 同じ名前であること。
    expect(env.observedRelPath).toBe(".env");
    expect(env.relativizeToRoot).toBe(".env");
    expect(env.humanDocumentKey).toBe(".env");
    expect(env.diskChangeKey).toBe(".env");
  }
}

function makeWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(ws, "src", "b.ts"), "import { a } from './a';\n");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1\n");
}

describe("relativeToWorkspaceRoot（根からの相対パスの唯一の決め手）", () => {
  let dir: string;
  let ws: string;
  let link: string;
  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-rootsp-")));
    ws = path.join(dir, "ws");
    makeWorkspace(ws);
    link = path.join(dir, "ws-link");
    fs.symlinkSync(ws, link, onWindows ? "junction" : "dir");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("綴りの根の中はそのまま（/ 区切り）", () => {
    expect(relativeToWorkspaceRoot(link, path.join(link, "src", "a.ts"), true)).toBe("src/a.ts");
    expect(relativeToWorkspaceRoot(ws, path.join(ws, "src", "a.ts"), true)).toBe("src/a.ts");
  });

  it("綴りの根から外に見える実体の綴りは、根の実体から測る", () => {
    expect(relativeToWorkspaceRoot(link, path.join(ws, "src", "a.ts"), true)).toBe("src/a.ts");
  });

  it("根の実体を辿らない指定（file: でない根）では、実体の綴りは中にならない", () => {
    expect(relativeToWorkspaceRoot(link, path.join(ws, "src", "a.ts"), false)).toBeUndefined();
  });

  it("根そのものは undefined（どちらの綴りでも）", () => {
    expect(relativeToWorkspaceRoot(link, link, true)).toBeUndefined();
    expect(relativeToWorkspaceRoot(link, ws, true)).toBeUndefined();
    expect(relativeToWorkspaceRoot(ws, ws, true)).toBeUndefined();
  });

  it("本当の外は undefined", () => {
    expect(relativeToWorkspaceRoot(link, path.join(dir, "outside.ts"), true)).toBeUndefined();
    expect(
      relativeToWorkspaceRoot(link, path.join(dir, "ws-sibling", "a.ts"), true),
    ).toBeUndefined();
  });

  it("根が無い（辿れない）ときは綴りだけで決める", () => {
    const gone = path.join(dir, "gone");
    expect(relativeToWorkspaceRoot(gone, path.join(gone, "a.ts"), true)).toBe("a.ts");
    expect(relativeToWorkspaceRoot(gone, path.join(ws, "a.ts"), true)).toBeUndefined();
  });

  it("正規化を通る（NTFS の代替データストリーム・8.3 の短い名前の形は中にならない）", () => {
    expect(relativeToWorkspaceRoot(ws, path.join(ws, ".env::$DATA"), true)).toBeUndefined();
    expect(relativeToWorkspaceRoot(ws, path.join(ws, "ENV~1"), true)).toBeUndefined();
  });

  it.skipIf(onWindows)(
    "posix でバックスラッシュを名前に持つものは中にならない（別の実体を名指さない）",
    () => {
      expect(relativeToWorkspaceRoot(ws, path.join(ws, "src\\a.ts"), true)).toBeUndefined();
      expect(relativeToWorkspaceRoot(link, path.join(ws, "src\\a.ts"), true)).toBeUndefined();
    },
  );
});

describe("4つの消費者が同じ名前を返す（根がリンク越しの綴り: POSIX は symlink、Windows は junction）", () => {
  let dir: string;
  let ws: string;
  let link: string;
  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-rootsp4-")));
    ws = path.join(dir, "ws");
    makeWorkspace(ws);
    link = path.join(dir, "ws-link");
    fs.symlinkSync(ws, link, onWindows ? "junction" : "dir");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("中のファイルは、根と対象のどの綴りの組でも src/a.ts", async () => {
    await expectSameNameFromEverySpelling(link, ws);
  });

  it("根そのもの・本当の外は中にならず、秘匿は実体の綴りでも関門に落ちる", async () => {
    fs.writeFileSync(path.join(dir, "outside.ts"), "x\n");
    await expectRootAndOutsideStayOut(link, ws, path.join(dir, "outside.ts"));
  });
});

describe("file: でない根（仮想のワークスペース）は、どの消費者も根の実体を辿らない", () => {
  let dir: string;
  let ws: string;
  let link: string;
  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-rootvfs-")));
    ws = path.join(dir, "ws");
    makeWorkspace(ws);
    link = path.join(dir, "ws-link");
    fs.symlinkSync(ws, link, onWindows ? "junction" : "dir");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("根が vscode-vfs: なら、file: の結果は言語の面でも get_editor_state でも中にならない", async () => {
    // 以前は言語の面だけが根のスキームを見ずに根の実体を辿り、`src/a.ts` と名指していた。
    expect(await namesFrom(link, path.join(ws, "src", "a.ts"), "vscode-vfs")).toEqual(NOT_INSIDE);
  });
});

describe.skipIf(onWindows)(
  "リンク越しの根で、実体の綴りで開いたタブの名前と秘匿（POSIX の本物のファイルシステム）",
  () => {
    let dir: string;
    let ws: string;
    let link: string;
    beforeAll(() => {
      dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-rootred-")));
      ws = path.join(dir, "ws");
      makeWorkspace(ws);
      link = path.join(dir, "ws-link");
      fs.symlinkSync(ws, link, "dir");
      fs.symlinkSync(path.join(ws, ".env"), path.join(ws, "notes.md"));
      fs.linkSync(path.join(ws, ".env"), path.join(ws, "hard.txt"));
      fs.writeFileSync(path.join(dir, "outside.txt"), "o\n");
      fs.symlinkSync(path.join(dir, "outside.txt"), path.join(ws, "leak.txt"));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const tab = (name: string) =>
      observedRelPath(vscode.Uri.file(link), vscode.Uri.file(path.join(ws, name)));

    it(".env へのリンクは .env と名指し、秘匿", () => {
      expect(tab("notes.md")).toBe(".env");
      expect(isRedactedEntity(link, ".env", policy)).toBe(true);
    });

    it(".env へのハードリンクは秘匿", () => {
      const name = tab("hard.txt");
      expect(name).toBe("hard.txt");
      expect(isRedactedEntity(link, String(name), policy)).toBe(true);
    });

    it("外へのリンクは (outside workspace)（名前を持たない）", () => {
      expect(tab("leak.txt")).toBeUndefined();
    });

    it("対照: ふつうのファイルは名前があり秘匿でない", () => {
      expect(tab("src/a.ts")).toBe("src/a.ts");
      expect(isRedactedEntity(link, "src/a.ts", policy)).toBe(false);
    });
  },
);

/** `dir /x` の1行から、長い名前 → 短い名前（`short-name-windows.test.ts` と同じ読み方）。 */
function shortNameIn(dir: string, long: string): string | undefined {
  const out = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a", dir], {
    encoding: "utf8",
    windowsHide: true,
  });
  for (const line of out.split(/\r?\n/)) {
    if (!line.endsWith(` ${long}`)) continue;
    const before = line.slice(0, line.length - long.length).trimEnd();
    const token = before.slice(before.lastIndexOf(" ") + 1);
    if (/~\d/.test(token)) return token;
  }
  return undefined;
}

describe.runIf(onWindows)(
  "4つの消費者が同じ名前を返す（Windows: 8.3 の短い名前・ドライブ文字の大小）",
  () => {
    let dir: string;
    let ws: string;
    beforeAll(() => {
      dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-root83-")));
      ws = path.join(dir, "workspace-with-a-long-name");
      makeWorkspace(ws);
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("根を 8.3 の短い名前で綴っても、実体の綴りの対象は src/a.ts", async (ctx) => {
      const short = shortNameIn(dir, "workspace-with-a-long-name");
      // CI の記録に残す（短い名前が取れて、検査が空振りしていないことの証拠）。
      console.log(`8.3 root: ${short ?? "(none)"}`);
      if (short === undefined) {
        ctx.skip("このボリュームでは 8.3 の短い名前が作られていない");
        return;
      }
      const spelled = path.join(dir, short);
      expect(fs.realpathSync.native(spelled)).toBe(ws);
      await expectSameNameFromEverySpelling(spelled, ws);
    });

    it("os.tmpdir() が短い名前の綴り（CI の RUNNER~1）なら、その綴りの根でも同じ名前", async (ctx) => {
      const tmp = os.tmpdir();
      const tmpReal = fs.realpathSync.native(tmp);
      console.log(`os.tmpdir(): ${tmp} -> ${tmpReal}`);
      if (tmp === tmpReal) {
        ctx.skip("os.tmpdir() は実体の綴り（短い名前を含まない）");
        return;
      }
      const spelled = path.join(tmp, path.relative(tmpReal, ws));
      expect(spelled).not.toBe(ws);
      await expectSameNameFromEverySpelling(spelled, ws);
    });

    it("ドライブ文字の大小が違っても（Uri.fsPath は c:、os.homedir() は C:）同じ名前", async () => {
      const lower = ws[0].toLowerCase() + ws.slice(1);
      const upper = ws[0].toUpperCase() + ws.slice(1);
      await expectSameNameFromEverySpelling(lower, upper, true);
    });
  },
);

describe("「根からの相対パス」を src/ の中で別に決めない", () => {
  it("realpath（どの形でも）を呼ぶのは関門と canonical-path.ts だけ", () => {
    const srcDir = path.join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          // 同期・非同期・promises・`.native` のどの形でも（`fs.realpath(`・`promises.realpath`・
          // `realpathSync`・`realpath.native`）。
          if (
            /realpathSync|\.realpath\b|\brealpath\s*\(|\brealpath\.native/.test(
              fs.readFileSync(p, "utf8"),
            )
          )
            offenders.push(path.relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    expect(offenders.map((p) => p.split(path.sep).join("/")).sort()).toEqual([
      "canonical-path.ts",
      "workspace-path-gate.ts",
    ]);
  });
});
