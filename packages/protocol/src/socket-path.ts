import * as path from "node:path";
import { isRuntimeDirName } from "./runtime-dir.js";

/**
 * ソケットのパスを**作る関数と確かめる関数を1つずつ**置く（D105。不変条件14）。
 *
 * 拡張が作り、ブリッジが登録ファイルの `socketPath` を確かめる。形を確かめないと、
 * 登録ファイルに `\\host\pipe\x` を置かれたとき Windows のブリッジは SMB で外へ繋ぎ、
 * NTLM の資格情報を送る。確かめる側は「作る関数が作りうる形か」だけを見るので、
 * 作り方を変えれば確かめ方も同時に変わる。
 */

/** 接尾辞の hex の桁数（8 バイトの乱数）。 */
export const SOCKET_SUFFIX_HEX_LENGTH = 16;

/** 接尾辞の形。小文字の hex ちょうど 16 桁（`crypto.randomBytes(8).toString("hex")` の形）。 */
export const SOCKET_SUFFIX_PATTERN = /^[0-9a-f]{16}$/;

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\vscode-showme-";
const POSIX_SOCKET_EXTENSION = ".sock";

/**
 * ソケットのパスを作る。Windows は名前付きパイプ（ディレクトリに依らない）、
 * それ以外は `<dir>/<suffix>.sock`。接尾辞の形が違えば投げる（呼び出し側の誤り）。
 */
export function socketPathFor(dir: string, suffix: string, platform: NodeJS.Platform): string {
  if (!SOCKET_SUFFIX_PATTERN.test(suffix)) {
    throw new Error("Socket path suffix must be 16 lowercase hex digits");
  }
  if (platform === "win32") return `${WINDOWS_PIPE_PREFIX}${suffix}`;
  return path.posix.join(dir, `${suffix}${POSIX_SOCKET_EXTENSION}`);
}

const REGISTRY_FILE_EXTENSION = ".json";

/**
 * 登録ファイルの名前を作る（`<接尾辞>.json`）。ソケットと同じ接尾辞を使う。拡張はこの名前で
 * 書き、ブリッジは読んだ名前から接尾辞を取り出してソケットのパスと突き合わせる。
 */
export function registryFileNameFor(suffix: string): string {
  if (!SOCKET_SUFFIX_PATTERN.test(suffix)) {
    throw new Error("Registry file name suffix must be 16 lowercase hex digits");
  }
  return `${suffix}${REGISTRY_FILE_EXTENSION}`;
}

/**
 * 登録ファイルの名前から接尾辞を取り出す（`registryFileNameFor` の逆）。作る関数が作りえない名前
 * （桁数・大文字・拡張子が違う、書きかけの `.tmp`）は `undefined`。ブリッジの確かめ（下の
 * `checkRegisteredSocketPath`）と拡張の掃除（`cleanStaleRegistrations`）が同じこの1つを通す
 * （不変条件14: 「どれが登録ファイルか」を2つの正規表現で決めない）。
 */
export function registrySuffixOf(registryFileName: string): string | undefined {
  if (!registryFileName.endsWith(REGISTRY_FILE_EXTENSION)) return undefined;
  const suffix = registryFileName.slice(0, -REGISTRY_FILE_EXTENSION.length);
  return SOCKET_SUFFIX_PATTERN.test(suffix) ? suffix : undefined;
}

/** 登録の `socketPath` を確かめた結果。 */
export type RegisteredSocketPath =
  | { ok: false }
  /**
   * 形は合っている。POSIX ではソケットの在るディレクトリを返す ―― **呼び出し側が、そこが
   * 実行時ディレクトリと同じ衛生（自分のもので、他人に開いていない）を満たすかを確かめる**。
   * win32 は名前付きパイプでディレクトリを持たないので `undefined`。
   */
  | { ok: true; socketDir: string | undefined };

/**
 * 登録ファイル `registryFileName` から読んだ `socketPath` が、拡張が作りうる形か（D105）。
 *
 * - win32: `\\.\pipe\vscode-showme-<接尾辞>` ちょうど。SMB（`\\host\pipe\…`）へ外に繋いで
 *   NTLM の資格情報を送ることを塞ぐ
 * - POSIX: 絶対パスで正規形（`..`・`.`・`//` を含まない）、`<実行時ディレクトリの名前>/<接尾辞>.sock`。
 *   ディレクトリの場所は問わない ―― 登録は全候補に複製され（§2A.6）、ソケットは1つの候補にしか
 *   ないうえ、ブリッジは拡張にだけ `$XDG_RUNTIME_DIR` がある候補を構成できない。代わりに返した
 *   ディレクトリの衛生を呼び出し側が確かめる。POSIX のソケットは外の機械に届かないので、これは多層の守り
 * - どちらも、接尾辞は登録ファイルの名前（`<接尾辞>.json`）と同じであること
 *
 * 形の定義を2つ持たないよう、取り出した接尾辞から `socketPathFor` でもう一度作って完全一致で比べる。
 */
export function checkRegisteredSocketPath(
  socketPath: string,
  registryFileName: string,
  platform: NodeJS.Platform,
): RegisteredSocketPath {
  const no = { ok: false } as const;
  const suffix = registrySuffixOf(registryFileName);
  if (suffix === undefined) return no;

  if (platform === "win32") {
    return socketPath === socketPathFor("", suffix, platform)
      ? { ok: true, socketDir: undefined }
      : no;
  }

  if (!path.posix.isAbsolute(socketPath)) return no;
  if (path.posix.normalize(socketPath) !== socketPath) return no;
  const socketDir = path.posix.dirname(socketPath);
  if (!isRuntimeDirName(path.posix.basename(socketDir))) return no;
  if (socketPathFor(socketDir, suffix, platform) !== socketPath) return no;
  return { ok: true, socketDir };
}

/** `sockaddr_un.sun_path` の大きさ（終端の NUL を含むバイト数）。 */
const SUN_PATH_BYTES_DARWIN = 104;
const SUN_PATH_BYTES_DEFAULT = 108;

/**
 * ソケットのパスに使える最大のバイト数（終端の NUL を含む）。上限の無い win32（名前付きパイプ）は
 * `undefined`。長すぎるときの理由の文言も、判定と同じこの値から作る（不変条件14）。
 */
export function socketPathByteLimit(platform: NodeJS.Platform): number | undefined {
  if (platform === "win32") return undefined;
  return platform === "darwin" ? SUN_PATH_BYTES_DARWIN : SUN_PATH_BYTES_DEFAULT;
}

/**
 * ソケットのパスが `sun_path` に収まらないか（D108）。**終端を含むバイト数**で数える
 * （文字数で数えると、日本語の名前を含むパスで単位が割れる ―― 不変条件14 の 3A'）。
 * 収まらないと listen は黙って切り詰めた名前で立ち、続く chmod が ENOENT になる。
 * 名前付きパイプ（win32）には、この上限は無い。
 */
export function socketPathTooLong(p: string, platform: NodeJS.Platform): boolean {
  return socketPathLength(p, platform).tooLong;
}

/**
 * ソケットのパスの長さを測る。`bytes` は終端の NUL を含むバイト数、`limit` は `socketPathByteLimit`
 * （win32 は `undefined`）。長すぎるかの判定と、理由の文言（何バイトで、上限はいくつか）を
 * **この1つの戻り値から**作る ―― 呼ぶ側で数え直すと、判定と文言が別の数を言いうる（不変条件14）。
 */
export function socketPathLength(
  p: string,
  platform: NodeJS.Platform,
): { bytes: number; limit: number | undefined; tooLong: boolean } {
  const bytes = Buffer.byteLength(p, "utf8") + 1;
  const limit = socketPathByteLimit(platform);
  return { bytes, limit, tooLong: limit !== undefined && bytes > limit };
}
