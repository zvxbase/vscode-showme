import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_LOCATIONS,
  isDeniedOutsidePath,
  isRedactedOutsidePath,
  normalizeOutsideAbsolute,
} from "../src/outside-path.js";

/**
 * ワークスペースの外のパスの、ファイルシステムに触らない部分（D101）。
 * 綴りの正規化・資格情報の置き場所・秘匿の規則。どれも純関数で、パスの流儀（posix / win32）を
 * 引数で受けるので、Linux の上でも Windows の綴りを確かめられる。
 */

describe("normalizeOutsideAbsolute（posix）", () => {
  const p = path.posix;
  it("正規化済みの絶対パスはそのまま通る", () => {
    expect(normalizeOutsideAbsolute("/tmp/x/a.txt", p)).toBe("/tmp/x/a.txt");
    expect(normalizeOutsideAbsolute("/tmp//x/a.txt", p)).toBe("/tmp/x/a.txt");
    // 末尾の区切りは落とす（同じ鍵にする）
    expect(normalizeOutsideAbsolute("/tmp/x/", p)).toBe("/tmp/x");
  });

  it.each([
    ["空", ""],
    ["相対", "tmp/a.txt"],
    ["チルダ", "~/x"],
    ["チルダ（名前付き）", "~root/x"],
    ["..", "/a/../b"],
    ["末尾の ..", "/a/b/.."],
    [".", "/a/./b"],
    ["NUL", "/a/b\u0000c"],
    ["バックスラッシュ", "/a\\b"],
    ["ルートそのもの", "/"],
  ])("%s は通らない", (_label, raw) => {
    expect(normalizeOutsideAbsolute(raw, p)).toBeUndefined();
  });
});

describe("normalizeOutsideAbsolute（win32）", () => {
  const w = path.win32;
  it("ドライブからの絶対パスは通り、区切りは \\ に、ドライブ文字は小文字に揃う（D102）", () => {
    expect(normalizeOutsideAbsolute("C:\\Users\\me\\a.txt", w)).toBe("c:\\Users\\me\\a.txt");
    expect(normalizeOutsideAbsolute("c:/Users/me/a.txt", w)).toBe("c:\\Users\\me\\a.txt");
    expect(normalizeOutsideAbsolute("C:\\Users\\me\\", w)).toBe("c:\\Users\\me");
  });

  it.each([
    ["UNC（外へ SMB で問い合わせる）", "\\\\server\\share\\a.txt"],
    ["UNC（/ 区切り）", "//server/share/a.txt"],
    ["デバイスの名前空間", "\\\\?\\C:\\a.txt"],
    ["ドライブ相対", "C:a.txt"],
    ["ドライブの無い根", "\\Users\\a.txt"],
    ["代替データストリーム", "C:\\a\\.env::$DATA"],
    ["末尾のドット", "C:\\a\\b.\\c"],
    ["末尾の空白", "C:\\a\\b \\c"],
    ["..", "C:\\a\\..\\b"],
    ["チルダ", "~\\x"],
    ["8.3 の短い名前", "C:\\Users\\ME~1\\a.txt"],
    ["8.3 の短い名前（途中）", "C:\\PROGRA~1\\x\\a.txt"],
  ])("%s は通らない", (_label, raw) => {
    expect(normalizeOutsideAbsolute(raw, w)).toBeUndefined();
  });
});

describe("isDeniedOutsidePath（資格情報の置き場所。設定で外せない）", () => {
  const homes = ["/home/me"];
  const p = path.posix;
  it.each([
    "/home/me/.ssh/id_rsa",
    "/home/me/.ssh",
    "/home/me/.config/gh/hosts.yml",
    "/home/me/.aws/credentials",
    "/home/me/.claude.json",
    "/home/me/.claude/settings.json",
    "/home/me/.vscode-server/data/User/globalStorage/x",
    "/home/me/.config/Code/User/settings.json",
    "/home/me/Library/Application Support/Google/Chrome/Default/Cookies",
    "/home/me/.SSH/id_rsa", // 大小を区別しない FS で迂回させない
    "/home/me/.bash_history",
    "/home/me/.local/share/fish/fish_history",
    "/home/me/.m2/settings-security.xml",
    "/home/me/.config/Code - Insiders/User/x",
    "/home/me/.cursor-server/data/x",
    "/home/me/Library/Cookies/Cookies.binarycookies",
    // 別のユーザーのホームも、ホームとして扱う
    "/home/you/.config/gh/hosts.yml",
    "/home/you/.netrc",
    "/Users/alice/.pgpass",
    "/root/.git-credentials",
    "/var/root/.vault-token",
    "/private/var/root/.vault-token",
    // どの深さでも
    "/tmp/backup/.ssh/config",
    "/srv/x/.gnupg/pubring.kbx",
    "/mnt/old/.aws/config",
    "/opt/.password-store/a.gpg",
    // システム
    "/proc/self/environ",
    "/sys/kernel/x",
    "/dev/null",
    "/run/secrets/token",
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
  ])("%s は断る", (abs) => {
    expect(isDeniedOutsidePath(abs, homes, p)).toBe(true);
  });

  it.each([
    "/home/me/.sshx/a", // 名前が似ているだけ
    "/home/me/.ssh-notes.txt",
    "/home/me/projects/a.txt",
    "/home/me/.config/ghx/a",
    "/home/you/projects/a.txt",
    "/tmp/x/a.txt",
    "/procfs/a",
    "/device/a",
    "/run/user/1000/a.txt",
    "/home/.netrc", // /home 自体はホームでない
  ])("%s は断らない", (abs) => {
    expect(isDeniedOutsidePath(abs, homes, p)).toBe(false);
  });

  it("Unicode の正規化（NFD / NFC）が違っても同じ名前として照合する", () => {
    expect(isDeniedOutsidePath("/data/caf\u00e9/.netrc", ["/data/cafe\u0301"], p)).toBe(true);
    expect(isDeniedOutsidePath("/data/cafe\u0301/.netrc", ["/data/caf\u00e9"], p)).toBe(true);
  });

  it("ホームを複数渡したら、どれの下でも断る（綴りのホームと実体のホーム）", () => {
    expect(isDeniedOutsidePath("/data/real/.netrc", ["/data/link", "/data/real"], p)).toBe(true);
  });

  it("ホームが絶対パスでないなら、確かめられないので全部断る", () => {
    expect(isDeniedOutsidePath("/tmp/a.txt", [""], p)).toBe(true);
    expect(isDeniedOutsidePath("/tmp/a.txt", [], p)).toBe(true);
  });

  it("一覧は1箇所にあり、依頼の置き場所を含む", () => {
    for (const entry of [
      ".ssh",
      ".config/gh",
      ".npmrc",
      "Library/Keychains",
      ".config/Code",
      ".bash_history",
      "AppData/Roaming/Microsoft/Protect",
    ]) {
      expect(CREDENTIAL_LOCATIONS).toContain(entry);
    }
  });

  it("Windows ではユーザーのプロファイルの下で、Windows の流儀で照合する", () => {
    const w = path.win32;
    const profiles = ["C:\\Users\\me"];
    expect(isDeniedOutsidePath("C:\\Users\\me\\.ssh\\id_rsa", profiles, w)).toBe(true);
    expect(isDeniedOutsidePath("c:\\users\\ME\\.SSH\\id_rsa", profiles, w)).toBe(true);
    expect(isDeniedOutsidePath("C:\\Users\\me\\.config\\gh\\hosts.yml", profiles, w)).toBe(true);
    expect(isDeniedOutsidePath("C:\\Users\\me\\AppData\\Roaming\\Code\\User\\x", profiles, w)).toBe(
      true,
    );
    expect(
      isDeniedOutsidePath(
        "C:\\Users\\other\\AppData\\Local\\Google\\Chrome\\User Data\\x",
        profiles,
        w,
      ),
    ).toBe(true);
    expect(isDeniedOutsidePath("D:\\Users\\x\\.netrc", profiles, w)).toBe(true);
    expect(isDeniedOutsidePath("D:\\backup\\.ssh\\id", profiles, w)).toBe(true);
    expect(isDeniedOutsidePath("C:\\Users\\me\\.sshx\\a", profiles, w)).toBe(false);
    expect(isDeniedOutsidePath("D:\\work\\a.txt", profiles, w)).toBe(false);
    // /proc 等は posix だけの話
    expect(isDeniedOutsidePath("C:\\proc\\a", profiles, w)).toBe(false);
  });
});

describe("isRedactedOutsidePath（秘匿の規則をパスの各部分とファイル名に）", () => {
  const p = path.posix;
  it("ファイル名が秘匿なら断る", () => {
    expect(isRedactedOutsidePath("/tmp/x/.env", [], p)).toBe(true);
    expect(isRedactedOutsidePath("/tmp/x/server.pem", [], p)).toBe(true);
  });
  it("途中の部分が秘匿なら断る", () => {
    expect(isRedactedOutsidePath("/tmp/.env/a.txt", [], p)).toBe(true);
  });
  it("設定で足したパターンは末尾の部分列に当たる", () => {
    expect(isRedactedOutsidePath("/tmp/proj/secrets/a.txt", ["secrets/**"], p)).toBe(true);
    expect(isRedactedOutsidePath("/tmp/proj/public/a.txt", ["secrets/**"], p)).toBe(false);
  });
  it("普通のパスは通る", () => {
    expect(isRedactedOutsidePath("/tmp/x/a.txt", [], p)).toBe(false);
  });
  it("Windows の区切りでも当たる", () => {
    expect(isRedactedOutsidePath("C:\\tmp\\x\\.env", [], path.win32)).toBe(true);
    expect(isRedactedOutsidePath("C:\\tmp\\x\\a.txt", [], path.win32)).toBe(false);
  });
});
