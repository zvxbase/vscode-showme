import * as fs from "node:fs";
import { MAX_RESOLVE_BYTES } from "@zvx/vscode-showme-protocol";
import { STAGE_SCHEME_READONLY, type StageScheme } from "./stage-uri.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

export type MirrorRead = { ok: true; bytes: Uint8Array } | { ok: false };
export type MirrorStat =
  | { ok: true; size: number; mtime: number; ctime: number; readonly: boolean }
  | { ok: false };
export type MirrorWrite =
  | { ok: true }
  | { ok: false; reason: "readonly" | "too-large" | "not-found" | "not-writable" | "io-error" };

/**
 * 関門と実体の検査を通ったファイル。stat は bigint で取る ―― dev/ino を number に
 * すると 2^53 を超える値で丸まり、別の inode が同じ値に見えうる（同一性の比較が緩む）。
 */
type Resolved = { realPath: string; stat: fs.BigIntStats };

export type JudgedOpen =
  | { ok: true; fd: number; stat: fs.BigIntStats }
  | { ok: false; reason: "not-found" | "io-error" };

// Windows には O_NOFOLLOW / O_NONBLOCK / O_NOCTTY が無い（undefined）。無ければ 0 で、
// その場合も下の dev/ino の比較が差し替えを落とす。
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const O_NOCTTY = fs.constants.O_NOCTTY ?? 0;
const CAP = BigInt(MAX_RESOLVE_BYTES);

/**
 * 開く所で「判定した実体がもう無い／別物になった」ことを示す errno。
 * どれも差し替えや消失の結果なので `not-found` に畳む（`io-error` にすると、
 * 関門を通った後の差し替えの種類が答えから読める）。
 * - ENOENT / ENOTDIR: 消えた・親が別物になった
 * - ELOOP / EMLINK: 最後の要素がリンクになった（O_NOFOLLOW。EMLINK は FreeBSD 系）
 * - EISDIR: ディレクトリになった（書き込みで開いたとき）
 * - ENXIO: 相手のいない FIFO・ソケット・デバイスになった
 * - ETXTBSY: 実行中のバイナリになった（書き込みで開いたとき）
 */
const GONE_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EMLINK", "EISDIR", "ENXIO", "ETXTBSY"]);

/** 読み込みの1回分。上限まで一度に確保しない（小さいファイルに 5MB を取らない）。 */
const READ_CHUNK = 64 * 1024;

/**
 * 判定した実体（`expected` を stat した inode）だけを開く。開いた後に確かめるので、
 * 判定と開く間に差し替えられても（TOCTOU）別の実体を掴まない。
 *
 * - `O_NOFOLLOW`: 最後の要素がリンクに差し替わっていれば開かない（ELOOP）
 * - `O_NONBLOCK`: FIFO に差し替わっていても開く所で止まらない（通常ファイルには無害）
 * - `O_NOCTTY`: 端末に差し替わっていても制御端末にしない
 * - `fstat` で通常ファイル・同じ dev/ino・上限以内を確かめる。親ディレクトリが
 *   リンクに差し替わった場合は O_NOFOLLOW では防げないので、inode の比較で落とす
 *
 * 開けない（消えた・リンク・別物）のは `not-found`。関門を通った実体についての
 * それ以外の失敗（権限など）だけが `io-error`。
 *
 * **`acceptWorkspacePath` / `resolve` が返した realPath と、それを stat した値でだけ呼ぶこと。**
 * ここは関門を当てない（任意のパスで呼べば関門を通らない読み書きの口になる）。
 * `test/workspace-path-gate.test.ts` が `src/` を走査して、このファイルの外で
 * 使われていないことを検査している。
 *
 * テストのために export している（正規の経路では realPath 自体がリンクになる
 * 状態を作れないので、差し替えの後の状態を直接渡して検査する）。
 */
export function openJudgedFile(
  realPath: string,
  expected: { dev: bigint; ino: bigint },
  flags: number,
): JudgedOpen {
  let fd: number;
  try {
    fd = fs.openSync(realPath, flags | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code !== undefined && GONE_CODES.has(code) ? "not-found" : "io-error",
    };
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      stat.isFile() &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino &&
      stat.size <= CAP
    ) {
      return { ok: true, fd, stat };
    }
  } catch {
    // fstat の失敗も「判定した実体を確かめられなかった」として下で落とす。
  }
  fs.closeSync(fd);
  return { ok: false, reason: "not-found" };
}

/**
 * 映し（`showme-ro:` / `showme-rw:`）の中身と関門（設計 D81）。vscode に依存しない。
 *
 * ## なぜ映し自身が関門を持つか
 *
 * 映しの URI は**誰でも**開ける（人間・別の拡張・リンク）。エージェントの道具の
 * 入口で関門を通していても、映しの口を直接叩かれれば素通りになる。だから
 * FileSystemProvider（`stage-fs-provider.ts`）が呼ぶここの全入口で `acceptWorkspacePath` を通す。
 * 受け入れの判断（綴り・秘匿・脱出・正準化）はそちらが唯一持ち、ここでは書き直さない
 * （不変条件14）。`read-workspace-file.ts` と同じく、判定が返した `realPath` だけを
 * 触り、正準名をルートに繋ぎ直さない（繋ぎ直すとリンクをもう一度辿り、判定と
 * 触る実体がずれる）。さらに開くときは `openJudgedFile` で、開いた fd が判定した
 * inode そのものであることを確かめる。
 *
 * ## 失敗は理由を問わず同じ形
 *
 * 秘匿・不正な綴り・脱出・不在・ディレクトリ・上限超えを答えの形で割らない。
 * 割れば `.env` の存在が答えから読める。`read` / `stat` は
 * `{ ok: false }`、`write` は `not-found` 1つに畳む。`write` のそれ以外の理由は
 * パスについて何も語らないか、既に `read` が明かしていることしか語らない
 * （各理由の所で書く）。
 *
 * 既知の制限: 人間の未保存の中身は UTF-8 で符号化し直す（しかも `getText()` は BOM を
 * 落とす）。UTF-8 でないファイルでは、未保存のときの showme-ro の見え方が、保存済みの
 * ときと別の復号になりうる。映しのタブを実際に開く増分で見直す。
 */
export class StageMirror {
  /**
   * 映しの版。**showme-ro の** mtime にだけ足して、VS Code に「中身が変わった」と気づかせる
   * （人間の未保存の中身はディスクの mtime を動かさないので、版が無いと読み直されない）。
   *
   * **showme-rw には足さない。** rw はディスクの素通しで、未保存の中身を映さない ――
   * 版を足す理由が無いうえ、足すと人間が無関係なファイルを打鍵するたびに rw の mtime が
   * 動く（VS Code は保存の前に mtime を比べる。偽の「ファイルの方が新しい」の種になる）。
   *
   * 版はファイルごとではなく全体で1つ。どのファイルの ro の stat も一緒に上がるが無害である
   * （VS Code が読み直すのは、その URI の onDidChangeFile を受けたときだけ）。
   * ディスクの mtime が版の差と同じだけ戻ると以前の値と重なりうるが、理論上のもので
   * 受け入れている。
   */
  private version = 0;

  constructor(
    // どちらも関数で受けて**毎回読む**。窓のルートも秘匿の設定も後から変わりうるので、
    // 構築時の値を握ると古い判断で通してしまう。
    private readonly rootPath: () => string | undefined,
    private readonly redactedPatterns: () => readonly string[],
  ) {}

  /** 映しの版。人間の未保存の編集・ディスクの変更のたびに1つ上げる（mtime に足す。D81）。 */
  bump(): void {
    this.version++;
  }

  /**
   * showme-ro で unsaved（人間の file: 文書が未保存ならその中身）が渡れば、それを返す。
   *
   * **unsaved もディスクの読みと同じ検査をすべて通してから差し替える。** 関門だけでなく
   * 「実体が通常ファイルで上限以内」までを条件にする ―― unsaved の有無で答えが
   * 変わる経路を作らないためである。unsaved 自身の上限も同じ値で見る。
   * showme-rw は編集の実体がディスクなので unsaved を無視する。
   */
  read(scheme: StageScheme, rel: string, unsaved?: string): MirrorRead {
    const resolved = this.resolve(rel);
    if (resolved === undefined) return { ok: false };
    const substitute = this.unsavedFor(scheme, unsaved);
    if (substitute === "too-large") return { ok: false };
    if (substitute !== undefined) return { ok: true, bytes: substitute };

    const opened = openJudgedFile(resolved.realPath, resolved.stat, fs.constants.O_RDONLY);
    if (!opened.ok) return { ok: false };
    try {
      const bytes = readUpToCap(opened.fd);
      return bytes === undefined ? { ok: false } : { ok: true, bytes };
    } catch {
      // 読めない理由を外へ出さない。
      return { ok: false };
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  /**
   * showme-ro で unsaved が渡れば、size はその UTF-8 のバイト数（read が返すものと同じ）。
   * mtime に版を足すのは showme-ro だけ（showme-rw はディスクの mtime そのまま。`version` の説明）。
   */
  stat(scheme: StageScheme, rel: string, unsaved?: string): MirrorStat {
    const resolved = this.resolve(rel);
    if (resolved === undefined) return { ok: false };
    const substitute = this.unsavedFor(scheme, unsaved);
    if (substitute === "too-large") return { ok: false };
    const { stat } = resolved;
    return {
      ok: true,
      // bigint の stat から number へは明示的に直す（ns → ms。ms の小数まで保つ）。
      size: substitute?.length ?? Number(stat.size),
      mtime: nsToMs(stat.mtimeNs) + (scheme === STAGE_SCHEME_READONLY ? this.version : 0),
      ctime: nsToMs(stat.ctimeNs),
      // showme-rw でも、write が断るファイルは読み取り専用と答える（判断は `writable` 1つ）。
      // 答えないと、書けないファイルのタブが編集できる顔をして、保存の時に初めて落ちる。
      readonly: scheme === STAGE_SCHEME_READONLY || !writable(resolved.realPath, stat),
    };
  }

  /**
   * showme-rw だけ。既存の通常ファイルの realPath にだけ書く。作らない。
   *
   * 理由ごとにオラクルにならないことの根拠:
   * - `readonly`: スキームだけで決まり、関門より先に返す（パスを見ない）
   * - `too-large`: 呼び出し側が渡した bytes の長さだけで決まり、関門より先に返す
   * - `not-found`: 関門・実体の検査の失敗すべて（秘匿・脱出・不在・ディレクトリ・
   *   上限超え）を1つに畳む
   * - `not-writable`: 関門と実体の検査を**通った後**、`writable` が偽のとき（ハードリンク・
   *   ディスクの権限）。そのパスが存在して通ることは `read` が既に明かしており、書けない
   *   ことは `stat` の readonly が同じく答えている。関門で落ちたものはここに来ない
   *   （not-found のまま）ので、秘匿や不在と形で割れない
   * - `io-error`: 同じく関門を通った後の、それ以外の書き込みの失敗
   */
  write(scheme: StageScheme, rel: string, bytes: Uint8Array): MirrorWrite {
    if (scheme === STAGE_SCHEME_READONLY) return { ok: false, reason: "readonly" };
    if (bytes.length > MAX_RESOLVE_BYTES) return { ok: false, reason: "too-large" };
    const resolved = this.resolve(rel);
    if (resolved === undefined) return { ok: false, reason: "not-found" };
    // 開く前に見る: 権限で書けないファイルは O_RDWR で開けず、開く所の失敗（io-error）に
    // なってしまう。stat の readonly と同じ述語で、同じ理由として断る。
    if (!writable(resolved.realPath, resolved.stat)) return { ok: false, reason: "not-writable" };

    const opened = openJudgedFile(resolved.realPath, resolved.stat, fs.constants.O_RDWR);
    if (!opened.ok) return { ok: false, reason: opened.reason };
    try {
      // 開いた後にもう一度（判定から開くまでの間にハードリンクが足されうる）。
      if (!writable(resolved.realPath, opened.stat)) return { ok: false, reason: "not-writable" };
      // 先に先頭から書き、その後で長さに切り詰める。先に空にすると、書き終わるまで
      // （あるいは書き込みが途中で失敗すると）ファイルが空の瞬間が残る。
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      }
      fs.ftruncateSync(opened.fd, bytes.length);
      return { ok: true };
    } catch {
      return { ok: false, reason: "io-error" };
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  /**
   * showme-ro の unsaved を bytes にする。read と stat がこの1つを通るので、
   * 返す中身と size の長さ・上限の判断が食い違わない。
   * 差し替えない（showme-rw か unsaved 無し）なら undefined。
   */
  private unsavedFor(
    scheme: StageScheme,
    unsaved: string | undefined,
  ): Uint8Array | "too-large" | undefined {
    if (scheme !== STAGE_SCHEME_READONLY || unsaved === undefined) return undefined;
    const bytes = new TextEncoder().encode(unsaved);
    return bytes.length > MAX_RESOLVE_BYTES ? "too-large" : bytes;
  }

  /**
   * 全入口の共通の検査: 関門 → 実体が通常ファイル → 上限以内。
   * どこで落ちても `undefined` 1つ（理由を呼び出し側へ渡さない）。
   */
  private resolve(rel: string): Resolved | undefined {
    const verdict = acceptWorkspacePath(this.rootPath(), rel, this.redactedPatterns());
    if (!verdict.ok) return undefined;
    try {
      const stat = fs.statSync(verdict.realPath, { bigint: true });
      if (!stat.isFile()) return undefined;
      // 上限は protocol が宣言する（`read-workspace-file.ts` と同じ定義元）。
      if (stat.size > CAP) return undefined;
      return { realPath: verdict.realPath, stat };
    } catch {
      return undefined;
    }
  }
}

/**
 * 関門を通った実体に、showme-rw から書いてよいか。`stat` の readonly と `write` の拒否が
 * この1つを見る（不変条件14。2つに書くと「読み取り専用と見えるのに書ける」がずれうる）。
 *
 * - ハードリンク（nlink > 1）には書かない。同じ inode の別名がワークスペースの外に
 *   ありうるが、それをここから確かめる手段が無い（pnpm の store など）。読むのは別名が
 *   何であれ中身が同じ（外の名前を知らせない）ので許す
 * - ディスクの権限は `access(W_OK)` で見る。mode のビットを自分で読まない ―― 実効 uid・
 *   グループ・ACL・root・読み取り専用のマウントを OS が判断するので、`open(O_RDWR)` が
 *   通るかどうかと同じ答えになる（ビットで見ると、root が 444 に書ける場合や ACL で
 *   許された場合を「書けない」と誤る）
 */
function writable(realPath: string, stat: fs.BigIntStats): boolean {
  if (stat.nlink > 1n) return false;
  try {
    fs.accessSync(realPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

/**
 * fd を上限+1 バイトまでだけ読む。上限を超えた時点で読むのをやめて undefined。
 * EOF まで読み切ると、開いた後に育ったファイル（あるいは差し替えられた巨大な実体）を
 * 全部メモリに載せてから捨てることになる。
 */
function readUpToCap(fd: number): Uint8Array | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    const n = fs.readSync(fd, chunk, 0, READ_CHUNK, null);
    if (n === 0) return Buffer.concat(chunks, total);
    total += n;
    if (total > MAX_RESOLVE_BYTES) return undefined;
    chunks.push(n === READ_CHUNK ? chunk : chunk.subarray(0, n));
  }
}
