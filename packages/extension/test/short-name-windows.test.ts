import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { currentUserSid, lockPrivateDir } from "@zvx/vscode-showme-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedactedLinkIndex } from "../src/redacted-links.js";
import {
  type RedactionPolicy,
  acceptWorkspacePath,
  replaceRedactedLinkIndex,
} from "../src/workspace-path-gate.js";

/**
 * 8.3 の短い名前（D106）を**本物の NTFS の上で**確かめる。Windows だけ。
 *
 * `ENV~1` は Windows では `.env` と同じ実体を指す。綴りに当てる秘匿の判定（`.env`）をすり抜けるので、
 * 関門は `~` の後に数字が続く部分を持つ綴りを断る（`normalizeWorkspaceRelative`）。さらに、
 * 許された綴りから短い名前へのリンク（`link.txt -> <ws>\ENV~1`）は、実体を
 * `realpathSync.native` で求めるので長い名前（`.env`）に展開され、秘匿として落ちる ――
 * JS の `realpathSync` は短い名前を展開しないので、同じリンクが `invalid-path` になる
 * （落ちはするが、秘匿の判定を通らずに落ちている）。ここが `excluded-path` であることが
 * `.native` を使っている証拠になる。
 *
 * 短い名前は `cmd.exe /d /c dir /x /a` の出力から取る（作られた名前はボリュームの設定と
 * 衝突の順で決まるので、決め打ちしない）。ボリュームで 8.3 の生成が切られていれば短い名前は
 * 無い。そのときは理由を出して飛ばす（緑を装わない）。
 *
 * 置き場所は `os.tmpdir()`（CI では C:。8.3 の生成が有効なのを測ってある。checkout の D: は
 * 無効でありうる）の下に作って締めたフォルダ（`server.test.ts` と同じく、ランナーの TEMP の
 * ACL に結果を預けない）。
 */
const onWindows = process.platform === "win32";

const policy: RedactionPolicy = {
  // 既定のパターンは `.env` と `credentials*`。残り2つは設定で足したものとして扱う。
  patterns: ["secrets.yaml", ".ssh/**"],
  blockLinksToRedacted: true,
};
const INVALID = { ok: false, reason: "invalid-path" };
const EXCLUDED = { ok: false, reason: "excluded-path" };

/** `dir /x` の1行から、長い名前 → 短い名前。短い名前の欄が空の行は載せない。 */
function shortNamesIn(dir: string, longNames: readonly string[]): Map<string, string> {
  const out = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a", dir], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    for (const long of longNames) {
      if (!line.endsWith(` ${long}`)) continue;
      const before = line.slice(0, line.length - long.length).trimEnd();
      const token = before.slice(before.lastIndexOf(" ") + 1);
      if (/~\d/.test(token)) found.set(long, token);
    }
  }
  return found;
}

describe.runIf(onWindows)("8.3 の短い名前（Windows の本物の NTFS。D106）", () => {
  let base: string;
  let root: string;
  let short: Map<string, string>;
  let previous: RedactedLinkIndex;
  const secrets = [".env", "credentials.json", "secrets.yaml", ".ssh"] as const;

  beforeAll(async () => {
    previous = replaceRedactedLinkIndex(new RedactedLinkIndex());
    base = fs.mkdtempSync(path.join(os.tmpdir(), "sn-"));
    await lockPrivateDir(base, await currentUserSid());
    root = path.join(base, "workspace");
    fs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(root, "credentials.json"), "{}\n");
    fs.writeFileSync(path.join(root, "secrets.yaml"), "k: v\n");
    fs.writeFileSync(path.join(root, ".ssh", "config"), "Host x\n");
    fs.writeFileSync(path.join(root, "notes.txt"), "ok\n");
    short = shortNamesIn(root, secrets);
    // CI の記録に残す（短い名前が本当に取れて、検査が空振りしていないことの証拠）。
    console.log(
      `[short-name] tmpdir=${os.tmpdir()} root=${root} names=${JSON.stringify([...short])}`,
    );
  });
  afterAll(() => {
    replaceRedactedLinkIndex(previous);
    if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  });

  /** 短い名前が1つも無ければ、理由を出して飛ばす。あれば全部そろっていること。 */
  const requireShortNames = (ctx: { skip: () => void }): void => {
    if (short.size === 0) {
      const note = `8.3 short names are not generated on the volume of ${root}; skipping`;
      console.warn(`[short-name] ${note}`);
      ctx.skip();
    }
    expect([...short.keys()].sort()).toEqual([...secrets].sort());
  };

  it("短い名前の綴りは、どれも関門を通らない（invalid-path）", (ctx) => {
    requireShortNames(ctx);
    for (const long of secrets) {
      const s = short.get(long) as string;
      const spellings = long === ".ssh" ? [`${s}/config`, `${s}\\config`] : [s, s.toLowerCase()];
      for (const p of spellings) expect(acceptWorkspacePath(root, p, policy), p).toEqual(INVALID);
    }
  });

  it("長い名前は今までどおり秘匿（excluded-path）、ふつうのファイルは通る", () => {
    for (const p of [".env", "credentials.json", "secrets.yaml", ".ssh/config"]) {
      expect(acceptWorkspacePath(root, p, policy), p).toEqual(EXCLUDED);
    }
    const ok = acceptWorkspacePath(root, "notes.txt", policy);
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.kind === "inside") expect(ok.canonical).toBe("notes.txt");
  });

  it("短い名前の綴りを指すシンボリックリンクは、実体（長い名前）で秘匿として落ちる", (ctx) => {
    requireShortNames(ctx);
    const made: string[] = [];
    for (const long of [".env", "credentials.json", "secrets.yaml"]) {
      const link = path.join(root, `link-${made.length}.txt`);
      try {
        fs.symlinkSync(path.join(root, short.get(long) as string), link, "file");
      } catch (e) {
        const note = `file symlinks need a privilege here (${(e as NodeJS.ErrnoException).code}); skipping`;
        console.warn(`[short-name] ${note}`);
        ctx.skip();
      }
      made.push(path.basename(link));
      expect(acceptWorkspacePath(root, path.basename(link), policy), long).toEqual(EXCLUDED);
    }
    expect(made).toHaveLength(3);
  });

  it("短い名前のフォルダを指すジャンクションの下も、実体（長い名前）で秘匿として落ちる", (ctx) => {
    requireShortNames(ctx);
    // ジャンクションは管理者の権限なしで作れる。先は絶対パス（短い名前の綴りのまま）。
    fs.symlinkSync(
      path.join(root, short.get(".ssh") as string),
      path.join(root, "jdir"),
      "junction",
    );
    expect(acceptWorkspacePath(root, "jdir/config", policy)).toEqual(EXCLUDED);
  });
});
