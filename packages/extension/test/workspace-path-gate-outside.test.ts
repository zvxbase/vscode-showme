import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_CANONICAL_PATH_KEY,
  UNNORMALIZED_PATH_KEY,
  fileRateLimitKey,
} from "../src/rate-limit.js";
import {
  type RedactionPolicy,
  acceptObservablePath,
  acceptWorkspacePath,
  fileRateLimitCanonicalizer,
  insideOnly,
  isRedactedEntity,
} from "../src/workspace-path-gate.js";

/**
 * ワークスペースの外のパス（D101）。`showme.allowOutsideWorkspace` がオンのときだけ、絶対パスで
 * 外のファイルを受け入れる。関門は1つ（`acceptWorkspacePath`）のまま、答えに「中か外か」を持たせる。
 *
 * 実ファイルシステムの上で検査する（シンボリックリンク・ハードリンク・FIFO は実体が要る）。
 * ホームは偽物を注入する ―― 本物の `~/.ssh` に触らない。
 */

/**
 * ファイルシステムに触ったかを数える（`vi.spyOn(fs, …)` は組み込みモジュールでは使えない。
 * `server.test.ts` と同じく素通しで包む）。秘匿・資格情報の置き場所の綴りは、触る前に落とす。
 */
const fsTouches = vi.hoisted(() => ({ paths: [] as string[], calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // 第1引数（パス・fd）を記録してから本物へ渡す。`calls` は口の名前つき。
  const wrap =
    <F extends (...a: never[]) => unknown>(fn: F, name = fn.name) =>
    (...args: unknown[]) => {
      fsTouches.paths.push(String(args[0]));
      fsTouches.calls.push(`${name} ${String(args[0])}`);
      return (fn as unknown as (...a: unknown[]) => unknown)(...args);
    };
  const realpathSync = Object.assign(wrap(actual.realpathSync, "realpathSync"), {
    native: wrap(actual.realpathSync.native, "realpathSync.native"),
  });
  // fs.promises も数える（非同期の口から触っても空振りの緑にしない）。
  const promises = new Proxy(actual.promises, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? wrap(value.bind(target), `promises.${String(prop)}`)
        : value;
    },
  });
  const wrapped = {
    ...actual,
    realpathSync,
    statSync: wrap(actual.statSync, "statSync"),
    lstatSync: wrap(actual.lstatSync, "lstatSync"),
    existsSync: wrap(actual.existsSync, "existsSync"),
    accessSync: wrap(actual.accessSync, "accessSync"),
    openSync: wrap(actual.openSync, "openSync"),
    promises,
  };
  return { ...wrapped, default: wrapped };
});

function policy(
  allowOutsideWorkspace: boolean,
  patterns: readonly string[] = [],
  blockLinksToRedacted = true,
): RedactionPolicy {
  return { patterns, blockLinksToRedacted, allowOutsideWorkspace };
}

const made: string[] = [];
interface Fixture {
  root: string;
  outside: string;
  home: string;
}
function fixture(): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "showme-outside-")));
  made.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
  fs.mkdirSync(path.join(home, ".sshx"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "notes.md"), "ok\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(outside, "a.txt"), "outside\n");
  fs.writeFileSync(path.join(outside, ".env"), "SECRET=2\n");
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "key\n");
  fs.writeFileSync(path.join(home, ".ssh", "config"), "Host x\n");
  fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "token\n");
  fs.writeFileSync(path.join(home, ".sshx", "a"), "near miss\n");
  return { root, outside, home };
}
beforeEach(() => {
  fsTouches.paths.length = 0;
  fsTouches.calls.length = 0;
});
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const INVALID = { ok: false, reason: "invalid-path" } as const;
const EXCLUDED = { ok: false, reason: "excluded-path" } as const;

describe("設定がオフ: 今と同じ（絶対パスは invalid-path）", () => {
  it("外の絶対パスも、中の絶対パスも invalid-path", () => {
    const { root, outside, home } = fixture();
    for (const allow of [false, undefined]) {
      const p: RedactionPolicy = {
        patterns: [],
        blockLinksToRedacted: true,
        ...(allow === undefined ? {} : { allowOutsideWorkspace: allow }),
      };
      expect(acceptWorkspacePath(root, path.join(outside, "a.txt"), p, { home })).toEqual(INVALID);
      expect(acceptWorkspacePath(root, path.join(root, "docs", "notes.md"), p, { home })).toEqual(
        INVALID,
      );
    }
  });

  it("相対パスは中として受け入れ、kind は inside", () => {
    const { root, home } = fixture();
    const v = acceptWorkspacePath(root, "docs/notes.md", policy(false), { home });
    expect(v).toMatchObject({ ok: true, kind: "inside", canonical: "docs/notes.md" });
  });
});

describe("設定がオン", () => {
  it("外の普通のファイルは kind outside で、正規化した実体の絶対パスを返す", () => {
    const { root, outside, home } = fixture();
    const abs = path.join(outside, "a.txt");
    const verdict = acceptWorkspacePath(root, abs, policy(true), { home });
    const st = fs.statSync(abs, { bigint: true });
    // dev / ino は開く側（O_NOFOLLOW で開いて fstat と突き合わせる）のために持たせる。
    expect(verdict).toEqual({
      ok: true,
      kind: "outside",
      absPath: abs,
      realPath: abs,
      dev: String(st.dev),
      ino: String(st.ino),
    });
  });

  it("中のファイルを絶対パスで指したら、相対パスと同じ答え", () => {
    const { root, home } = fixture();
    expect(
      acceptWorkspacePath(root, path.join(root, "docs", "notes.md"), policy(true), { home }),
    ).toEqual(acceptWorkspacePath(root, "docs/notes.md", policy(true), { home }));
    expect(acceptWorkspacePath(root, path.join(root, ".env"), policy(true), { home })).toEqual(
      EXCLUDED,
    );
    // ルートそのものは相対でも通らない（空の相対パス）
    expect(acceptWorkspacePath(root, root, policy(true), { home })).toEqual(INVALID);
  });

  it("相対パスは今と同じ（外へ出る綴りは invalid-path）", () => {
    const { root, home } = fixture();
    expect(acceptWorkspacePath(root, "../outside/a.txt", policy(true), { home })).toEqual(INVALID);
  });

  it("秘匿の規則は外のパスにも当たる（ファイル名・途中の部分・足したパターン）", () => {
    const { root, outside, home } = fixture();
    expect(acceptWorkspacePath(root, path.join(outside, ".env"), policy(true), { home })).toEqual(
      EXCLUDED,
    );
    fs.mkdirSync(path.join(outside, "secrets"));
    fs.writeFileSync(path.join(outside, "secrets", "b.txt"), "x");
    expect(
      acceptWorkspacePath(
        root,
        path.join(outside, "secrets", "b.txt"),
        policy(true, ["secrets/**"]),
        {
          home,
        },
      ),
    ).toEqual(EXCLUDED);
  });

  it("資格情報の置き場所は断る。名前が似ているだけのものは通す", () => {
    const { root, home } = fixture();
    expect(
      acceptWorkspacePath(root, path.join(home, ".ssh", "config"), policy(true), { home }),
    ).toEqual(EXCLUDED);
    expect(
      acceptWorkspacePath(root, path.join(home, ".ssh", "id_rsa"), policy(true), { home }),
    ).toEqual(EXCLUDED);
    expect(
      acceptWorkspacePath(root, path.join(home, ".config", "gh", "hosts.yml"), policy(true), {
        home,
      }),
    ).toEqual(EXCLUDED);
    expect(
      acceptWorkspacePath(root, path.join(home, ".sshx", "a"), policy(true), { home }),
    ).toMatchObject({ ok: true, kind: "outside" });
  });

  it("資格情報の置き場所・秘匿の綴りにはファイルシステムを触らせない（無ければも同じ答え）", () => {
    const { root, outside, home } = fixture();
    const denied = [
      path.join(home, ".ssh", "no-such-key"),
      path.join(home, ".aws", "credentials"), // ディレクトリごと無い
      path.join(outside, ".env.missing"),
    ];
    for (const abs of denied) {
      fsTouches.paths.length = 0;
      expect(acceptWorkspacePath(root, abs, policy(true), { home }), abs).toEqual(EXCLUDED);
      // 触ってよいのはホームそのもの（実体を求める。綴りのホームがリンクでも照合するため）だけ。
      // 綴りにも、その親にも触らない。
      expect(
        fsTouches.paths.filter((p) => p !== home),
        abs,
      ).toEqual([]);
    }
    // 設定がオフの絶対パスは、ホームにも触らない。
    fsTouches.paths.length = 0;
    expect(acceptWorkspacePath(root, path.join(outside, "a.txt"), policy(false), { home })).toEqual(
      INVALID,
    );
    expect(fsTouches.paths).toEqual([]);
    // 対照: 通る外のパスでは実際に数えている（包みが関門に効いていない空振りの緑を見分ける）。
    fsTouches.paths.length = 0;
    const allowed = path.join(outside, "a.txt");
    expect(acceptWorkspacePath(root, allowed, policy(true), { home }).ok).toBe(true);
    expect(fsTouches.paths).toContain(allowed);
  });

  it("許された外のパスから資格情報の置き場所へのシンボリックリンクは断る", () => {
    const { root, outside, home } = fixture();
    fs.symlinkSync(path.join(home, ".ssh", "config"), path.join(outside, "innocent.txt"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(outside, "dir-link"));
    expect(
      acceptWorkspacePath(root, path.join(outside, "innocent.txt"), policy(true), { home }),
    ).toEqual(EXCLUDED);
    expect(
      acceptWorkspacePath(root, path.join(outside, "dir-link", "config"), policy(true), { home }),
    ).toEqual(EXCLUDED);
  });

  it("許された外のパスから秘匿の名前へのシンボリックリンクは断る", () => {
    const { root, outside, home } = fixture();
    fs.symlinkSync(path.join(outside, ".env"), path.join(outside, "harmless.txt"));
    expect(
      acceptWorkspacePath(root, path.join(outside, "harmless.txt"), policy(true), { home }),
    ).toEqual(EXCLUDED);
  });

  it("外からワークスペースの中へのシンボリックリンクは、中の規則で決まる", () => {
    const { root, outside, home } = fixture();
    fs.symlinkSync(path.join(root, "docs", "notes.md"), path.join(outside, "to-notes.md"));
    fs.symlinkSync(path.join(root, ".env"), path.join(outside, "to-env.txt"));
    expect(
      acceptWorkspacePath(root, path.join(outside, "to-notes.md"), policy(true), { home }),
    ).toMatchObject({ ok: true, kind: "inside", canonical: "docs/notes.md" });
    expect(
      acceptWorkspacePath(root, path.join(outside, "to-env.txt"), policy(true), { home }),
    ).toEqual(EXCLUDED);
  });

  it("外のハードリンク（リンク数2以上）は、blockLinksToRedacted がオンなら一律に断る", () => {
    const { root, outside, home } = fixture();
    fs.linkSync(path.join(outside, "a.txt"), path.join(outside, "b.txt"));
    const abs = path.join(outside, "b.txt");
    expect(acceptWorkspacePath(root, abs, policy(true), { home })).toEqual(EXCLUDED);
    expect(acceptWorkspacePath(root, path.join(outside, "a.txt"), policy(true), { home })).toEqual(
      EXCLUDED,
    );
    expect(acceptWorkspacePath(root, abs, policy(true, [], false), { home })).toMatchObject({
      ok: true,
      kind: "outside",
    });
  });

  it("ディレクトリと FIFO は断る（通常のファイルだけ）", () => {
    const { root, outside, home } = fixture();
    expect(acceptWorkspacePath(root, outside, policy(true), { home })).toEqual(INVALID);
    const fifo = path.join(outside, "pipe");
    if (process.platform !== "win32") {
      // mkfifo の代わり（node に mkfifo は無い）
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync("mkfifo", [fifo]);
      expect(acceptWorkspacePath(root, fifo, policy(true), { home })).toEqual(INVALID);
    }
  });

  it("無い外のファイルは invalid-path", () => {
    const { root, outside, home } = fixture();
    expect(
      acceptWorkspacePath(root, path.join(outside, "no-such.txt"), policy(true), { home }),
    ).toEqual(INVALID);
  });

  it.each([["~/x"], ["~"], ["/a/../b"], ["/tmp/./a.txt"], ["relative/../../x"]])(
    "%s は invalid-path（~ は展開しない・.. を含む絶対パスは通さない）",
    (raw) => {
      const { root, home } = fixture();
      expect(acceptWorkspacePath(root, raw, policy(true), { home })).toEqual(INVALID);
    },
  );

  it("/proc・/sys・/dev は断る", () => {
    const { root, home } = fixture();
    for (const abs of ["/proc/self/environ", "/dev/null", "/sys/kernel/notes"]) {
      expect(acceptWorkspacePath(root, abs, policy(true), { home }), abs).toEqual(EXCLUDED);
    }
  });

  it("ホームがシンボリックリンクでも、実体の側の綴りを FS に触る前に断る（存在のオラクルを作らない）", () => {
    const { root } = fixture();
    const base = path.dirname(root);
    const realHomeDir = path.join(base, "real-home");
    fs.mkdirSync(path.join(realHomeDir, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(realHomeDir, ".config", "gh", "hosts.yml"), "token\n");
    const homeLink = path.join(base, "home-link");
    fs.symlinkSync(realHomeDir, homeLink);
    for (const name of ["hosts.yml", "no-such.yml"]) {
      const abs = path.join(realHomeDir, ".config", "gh", name);
      fsTouches.paths.length = 0;
      expect(acceptWorkspacePath(root, abs, policy(true), { home: homeLink }), abs).toEqual(
        EXCLUDED,
      );
      expect(
        fsTouches.paths.filter((p) => p !== homeLink),
        abs,
      ).toEqual([]);
    }
  });

  it("ホームの名前の Unicode 正規化（NFD / NFC）が違っても断る", () => {
    const { root } = fixture();
    const base = path.dirname(root);
    const nfdHome = path.join(base, "cafe\u0301");
    fs.mkdirSync(nfdHome, { recursive: true });
    const typed = path.join(base, "caf\u00e9", ".config", "gh", "hosts.yml");
    fsTouches.paths.length = 0;
    expect(acceptWorkspacePath(root, typed, policy(true), { home: nfdHome })).toEqual(EXCLUDED);
    expect(fsTouches.paths.filter((p) => p !== nfdHome)).toEqual([]);
  });

  it("大文字の綴り（.SSH・.Config/GH）も断る", () => {
    const { root, home } = fixture();
    for (const abs of [
      path.join(home, ".SSH", "config"),
      path.join(home, ".Config", "GH", "hosts.yml"),
    ]) {
      fsTouches.paths.length = 0;
      expect(acceptWorkspacePath(root, abs, policy(true), { home }), abs).toEqual(EXCLUDED);
      expect(fsTouches.paths.filter((p) => p !== home)).toEqual([]);
    }
  });

  it("どの深さの .ssh / .gnupg / .aws / .password-store も断る", () => {
    const { root, outside, home } = fixture();
    fs.mkdirSync(path.join(outside, "backup", ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(outside, "backup", ".ssh", "config"), "x");
    expect(
      acceptWorkspacePath(root, path.join(outside, "backup", ".ssh", "config"), policy(true), {
        home,
      }),
    ).toEqual(EXCLUDED);
  });

  it("最後の部分は lstat で見る（実体が通常のファイルであることを、リンクを辿らずに確かめる）", () => {
    const { root, outside, home } = fixture();
    const abs = path.join(outside, "a.txt");
    fsTouches.calls.length = 0;
    expect(acceptWorkspacePath(root, abs, policy(true), { home }).ok).toBe(true);
    // 実体は realpath.native で求め、その後は lstat だけ（stat はリンクを辿る）。
    const onTarget = fsTouches.calls.filter((c) => c.endsWith(` ${abs}`));
    expect(onTarget).toEqual([`realpathSync.native ${abs}`, `lstatSync ${abs}`]);
  });

  it("ワークスペースが無いときは今と同じく invalid-path", () => {
    const { outside, home } = fixture();
    expect(
      acceptWorkspacePath(undefined, path.join(outside, "a.txt"), policy(true), { home }),
    ).toEqual(INVALID);
  });
});

describe("insideOnly（外を扱わない呼び出し口の、閉じる側の畳み）", () => {
  it("outside は invalid-path に畳み、inside と失敗はそのまま", () => {
    const { root, outside, home } = fixture();
    const out = acceptWorkspacePath(root, path.join(outside, "a.txt"), policy(true), { home });
    expect(out.ok).toBe(true);
    expect(insideOnly(out)).toEqual(INVALID);
    const inside = acceptWorkspacePath(root, "docs/notes.md", policy(true), { home });
    expect(insideOnly(inside)).toBe(inside);
    expect(insideOnly(EXCLUDED)).toBe(EXCLUDED);
  });
});

describe("レート制限の鍵（外は正準の絶対パス、落ちたものは共有の鍵）", () => {
  it("外で受け入れたファイルは正準の絶対パスが鍵。綴り替え・リンクでも同じ鍵", () => {
    const { root, outside, home } = fixture();
    fs.symlinkSync(path.join(outside, "a.txt"), path.join(outside, "alias.txt"));
    const key = fileRateLimitCanonicalizer(root, policy(true), { home });
    const abs = path.join(outside, "a.txt");
    expect(fileRateLimitKey(abs, key)).toBe(abs);
    expect(fileRateLimitKey(path.join(outside, "alias.txt"), key)).toBe(abs);
    expect(fileRateLimitKey(`${outside}//a.txt`, key)).toBe(abs);
  });

  it("中を絶対パスで指したら、相対パスと同じ鍵", () => {
    const { root, home } = fixture();
    const key = fileRateLimitCanonicalizer(root, policy(true), { home });
    expect(fileRateLimitKey(path.join(root, "docs", "notes.md"), key)).toBe("docs/notes.md");
  });

  it("落ちた外のパスは、存在を問わず同じ共有の鍵", () => {
    const { root, outside, home } = fixture();
    const key = fileRateLimitCanonicalizer(root, policy(true), { home });
    const keys = [
      path.join(home, ".ssh", "id_rsa"),
      path.join(home, ".ssh", "no-such"),
      path.join(outside, "no-such.txt"),
      path.join(outside, ".env"),
    ].map((p) => fileRateLimitKey(p, key));
    expect(new Set(keys).size).toBe(1);
    expect([UNNORMALIZED_PATH_KEY, NO_CANONICAL_PATH_KEY]).toContain(keys[0]);
  });

  it("設定がオフなら絶対パスは今と同じ鍵（UNNORMALIZED）", () => {
    const { root, outside, home } = fixture();
    const key = fileRateLimitCanonicalizer(root, policy(false), { home });
    expect(fileRateLimitKey(path.join(outside, "a.txt"), key)).toBe(UNNORMALIZED_PATH_KEY);
  });
});

/**
 * 外のパスの部品（`outside-path.ts`）を使ってよいのは関門だけ（不変条件14）。
 * 別の口が直に呼ぶと、順序（FS に触る前に綴りで落とす）を持たない判断が関門の外に増える。
 */
describe("関門の外で outside-path を import していない（D101）", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");
  const IMPORTS_OUTSIDE =
    /(?:from\s*|import\s*\(\s*|export\s+\*\s+from\s*)["'][^"']*outside-path(?:\.js)?["']/;
  const walk = (dir: string, into: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, into);
      else if (full.endsWith(".ts")) into.push(full);
    }
  };
  it("src/ で import しているのは workspace-path-gate.ts だけ", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    expect(files.length).toBeGreaterThan(10);
    const importers = files
      .filter((f) => IMPORTS_OUTSIDE.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f));
    expect(importers).toEqual(["workspace-path-gate.ts"]);
  });
});

describe("観測の側の名前と秘匿（D102）", () => {
  it("isRedactedEntity: 外の鍵は関門を通るときだけ秘匿でない。オフなら外の鍵は秘匿として扱う", () => {
    const { root, outside, home } = fixture();
    const abs = path.join(outside, "a.txt");
    expect(isRedactedEntity(root, abs, policy(true))).toBe(false);
    expect(isRedactedEntity(root, path.join(outside, ".env"), policy(true))).toBe(true);
    expect(isRedactedEntity(root, abs, policy(false))).toBe(true);
    expect(isRedactedEntity(root, path.join(home, ".ssh", "config"), policy(true))).toBe(true);
  });

  it("acceptObservablePath: 外は正規化した綴り（realpath でない）を名前にし、中は正準名", () => {
    const { root, outside, home } = fixture();
    fs.symlinkSync(path.join(outside, "a.txt"), path.join(outside, "alias.txt"));
    expect(
      acceptObservablePath(root, `${outside}//alias.txt`, policy(true), { home }),
    ).toMatchObject({ ok: true, canonical: path.join(outside, "alias.txt") });
    expect(
      acceptObservablePath(root, path.join(root, "docs", "notes.md"), policy(true), { home }),
    ).toMatchObject({ ok: true, canonical: "docs/notes.md" });
    expect(
      acceptObservablePath(root, path.join(outside, "a.txt"), policy(false), { home }),
    ).toEqual(INVALID);
  });
});
