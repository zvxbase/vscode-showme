import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  MAX_WIRE_LINE_BYTES,
  TOKEN_HEX_LENGTH,
  WIRE_PROTOCOL_VERSION,
  type WindowRole,
  type WireRequest,
  helloSchema,
  requestSchema,
} from "@zvx/vscode-showme-protocol";
import { ToolError } from "./tool-error.js";

// 既存の呼び出し口（`extension.ts` / 統合テスト）はここから読んでいる。
// 定義元は `tool-error.ts` 1つで、ここは名前を通すだけ ―― ハンドラが
// `server.ts` を読み込まずに投げられるようにするために分けてある。
export { ToolError };

/** ハンドシェイク前に受け取ってよい最大バイト数。 */
const MAX_HANDSHAKE_BYTES = 4096;
/**
 * 1行(1メッセージ)の最大バイト数。**protocol が決める**（不変条件14）。
 *
 * ここで独立に決めていた 256 KiB は `MAX_HTML_CHARS`（256 K **文字**）と単位が違い、
 * 日本語なら**スキーマを通る入力が線で落ちて**いた（実測 786,480 B）。
 * スキーマと線は同じ量を測っているので、決めるのは1箇所にする。
 */
const MAX_LINE_BYTES = MAX_WIRE_LINE_BYTES;
/** ハンドシェイクの猶予。 */
const HANDSHAKE_TIMEOUT_MS = 3000;

/**
 * 同時に受け付ける**認証済み**接続の数（設計書 §3.5 / D21）。
 *
 * 生の接続数ではなく認証済みの数で数える。ハンドシェイク前の3秒間ただ座って
 * いるだけのプロセスがあると、生の数では正規のブリッジの接続が毎回「2本目」に
 * なってしまう（可視化が事実と違うことを言う）。
 */
const MAX_AUTHED_CONNECTIONS = 1;

/**
 * 2本目を拒否したときに観測者へ渡す理由。
 *
 * 可視化の分岐（ステータスバーに出すかどうか）が文字列リテラルの綴りに
 * 依存しないよう、定義元を1つにする。
 */
export const SECOND_CONNECTION_REASON = "second concurrent connection";

export type PrepareResult = { ok: true } | { ok: false; reason: string };

/**
 * 実行時ディレクトリを用意し、安全性を検証する。
 *
 * /tmp は 1777 なので、攻撃者が先回りしてディレクトリやシンボリックリンクを
 * 置ける(設計書 S7 / D22)。作成後に開いた fd を fstat し、所有者・
 * シンボリックリンクでないこと・モードを検証する。1つでも外れたら
 * **拒否する。既存を消さない**(共有ディレクトリでの無検査 unlink は
 * 任意ファイル削除になる)。
 */
export function prepareRuntimeDir(dir: string): PrepareResult {
  const parent = path.dirname(dir);
  if (!fs.existsSync(parent)) {
    return { ok: false, reason: `parent directory does not exist: ${parent}` };
  }

  // lstat でシンボリックリンクを先に弾く(follow しない)
  let lst: fs.Stats | undefined;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    lst = undefined;
  }

  let justCreated = false;
  if (lst === undefined) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      justCreated = true;
    } catch (e) {
      return { ok: false, reason: `cannot create runtime dir: ${String(e)}` };
    }
  } else if (lst.isSymbolicLink()) {
    return {
      ok: false,
      reason: `runtime dir is a symlink, refusing to use or remove it: ${dir}`,
    };
  } else if (!lst.isDirectory()) {
    return { ok: false, reason: `runtime dir exists but is not a directory: ${dir}` };
  }

  // mkdir(mode) は umask で減算されるので、作った直後だけ明示的に締め直す。
  // 既存のディレクトリは黙って chmod せず、下の fd 検証でモードを判定させる
  // (そうしないと権限が緩いディレクトリも常に 0700 に「修復」されてしまい、
  // 「権限が緩いディレクトリを拒否する」という検査そのものが無効になる)。
  if (justCreated) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (e) {
      return { ok: false, reason: `cannot chmod runtime dir: ${String(e)}` };
    }
  }

  // 開いた fd に対して検証する(TOCTOU を縮める)
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    const st = fs.fstatSync(fd);
    if (!st.isDirectory()) return { ok: false, reason: `not a directory after open: ${dir}` };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      return { ok: false, reason: `runtime dir owned by another user (uid ${st.uid}): ${dir}` };
    }
    const mode = st.mode & 0o777;
    if (mode !== 0o700) {
      return { ok: false, reason: `runtime dir mode is ${mode.toString(8)}, expected 700: ${dir}` };
    }
  } catch (e) {
    return { ok: false, reason: `cannot verify runtime dir: ${String(e)}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  return { ok: true };
}

/** 登録ファイルの名前。suffix は 16 桁の 16 進数。 */
const REGISTRATION_NAME = /^[0-9a-f]+\.json$/;
/**
 * 原子的な書き込みの途中（rename 前）に落ちたときに残る名前。pid を含む。
 *
 * `.json` で終わらないので、ブリッジは登録ファイルとして読まない
 * （`scanRegistry` は `.json` だけを見る）。それでも**残しっぱなしにしない** ――
 * 設定以外の状態をディスクに残さないのが不変条件13 で、消す条件は登録ファイル
 * と同じ「pid が死んでいる」である。
 */
const REGISTRATION_TMP_NAME = /^[0-9a-f]+\.json\.tmp-(\d+)-[0-9a-f]+$/;
/** 登録ファイルとして読む上限。共有ディレクトリなので、中身は他人が置きうる。 */
const MAX_REGISTRATION_BYTES = 64 * 1024;

/**
 * プロセスが生きているか。
 *
 * `EPERM` は「いるが自分のものではない」なので**生きている**側に倒す。
 * `ESRCH` のときだけ死んでいると判定する。**この判定は消しすぎない向きにだけ
 * 外れる**: pid が再利用されていれば「生きている」と答え、掃除を見送る
 * （設計書 S7 が「pid だけで生死を決めるな」と言う理由）。到達可否による
 * 一次判定は、発見の側（ブリッジ）が接続して行う。
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 登録ファイルから pid を読む。読めない・信用できないなら undefined。
 *
 * lstat で通常ファイル・自分所有であることを確かめてから開く。symlink を
 * 辿らないのは D23 のため、FIFO を弾くのは `readFileSync` が**永久に
 * 止まりうる**ため（攻撃者は同じディレクトリに名前付きパイプを置ける）。
 */
function readRegistrationPid(file: string): number | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return undefined;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return undefined;
    if (st.size > MAX_REGISTRATION_BYTES) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    const pid = parsed.pid;
    // pid <= 0 を渡さない。kill(0, 0) はプロセスグループ全体に飛ぶ。
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * 死んだウィンドウが残した登録ファイルを掃除する（設計書 §6.2 / D23）。
 *
 * VS Code が SIGKILL で落ちると `deactivate()` は走らず、登録ファイルが残る。
 * するとブリッジの選択は「候補が2つ以上でヒントが無ければ選ばない」ので、
 * **生きたウィンドウが1つしかないのに「ウィンドウが見つかりません」**になる。
 *
 * 消すのは「自分のディレクトリの、登録ファイルの名前をした、通常ファイルで、
 * 自分所有で、pid が死んでいるもの」だけ。**ディレクトリ横断はしない**
 * （readdir 1段のみ・部分ディレクトリの中は見ない）。削除は必ず `safeUnlink`
 * を通す — 共有ディレクトリでの無検査 `unlink` は任意ファイル削除になる。
 * 判断がつかないものは残す。
 *
 * **候補ごとに呼ぶこと。** 読む候補が2つなら掃除する候補も2つ、が対称である
 * （設計書 §2A.6）。呼び出し側は `start()`。
 */
export function cleanStaleRegistrations(
  dir: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    const tmp = REGISTRATION_TMP_NAME.exec(name);
    if (tmp !== null) {
      // 名前に埋めた pid が死んでいるものだけ。生きているプロセスが
      // いままさに書いている途中のものを消さない。
      const owner = Number(tmp[1]);
      if (Number.isInteger(owner) && owner > 0 && !isAlive(owner)) {
        safeUnlink(path.join(dir, name));
      }
      continue;
    }
    if (!REGISTRATION_NAME.test(name)) continue;
    const registryPath = path.join(dir, name);
    const pid = readRegistrationPid(registryPath);
    if (pid === undefined || isAlive(pid)) continue;

    safeUnlink(registryPath);
    // 対応するソケットは**名前から導く**。登録ファイルの中の socketPath は
    // 他人が書ける値で、そこを消しに行くと任意パスへの unlink になる。
    safeUnlink(path.join(dir, `${name.slice(0, -".json".length)}.sock`));
    removed.push(registryPath);
  }
  return removed;
}

/**
 * 登録ファイルに載せる、この窓が誰であるか（設計書 §2A.4）。
 *
 * `role` は**関数**である。値で受け取ると、預けた瞬間に握った古い値を書き
 * 続けることになる ―― ブリッジは登録ファイルしか見ないので、それは
 * 「人間が預けたのに永久に見つからない窓」になる。
 *
 * 既定は「窓ごとに一意な id」と「預けていない」。配線を忘れた窓が
 * ブリッジから選ばれないよう、既定はフェイルクローズにしてある。
 */
export interface WindowIdentity {
  windowId: string;
  role: () => WindowRole;
}

export interface ServerInfo {
  /** ソケットは1本。用意できた**先頭の候補**の中にある。 */
  socketPath: string;
  /**
   * 登録ファイル。**候補ごとに1つ**（設計書 §2A.6）。
   *
   * 複数形である。読むのが両候補なら書くのも両候補、が対称であり、
   * 単数の名前を残すと「1箇所しか書いていない」という古い前提が名前として
   * 生き残る。先頭は書き込みの第一候補（＝ソケットのあるディレクトリ）。
   */
  registryPaths: readonly string[];
  /** 認証トークン。ソケットのパス名とは別の値である(設計書 D5')。 */
  token: string;
}

export type RequestHandler = (req: WireRequest) => Promise<Record<string, unknown>>;

/**
 * 書き直し（役割の変更）から見て動いてはいけない、start() のときに決まった値。
 *
 * `registryPaths` は**複数**。候補ごとに1つ書く（設計書 §2A.6）。
 */
interface Registration {
  registryPaths: readonly string[];
  socketPath: string;
  token: string;
  startedAt: string;
}

/**
 * 登録ファイルを**原子的に**置き換える（同じディレクトリに書いて rename する）。
 *
 * `writeFileSync` は truncate → write なので、書いている最中は**中身が空か
 * 途中まで**になる。2A でこの書き込みは「窓ごとに1回」から「役割を切り替える
 * たび」に変わり、露出窓が増えた。読み手（ブリッジ）が書きかけを掴むと登録は
 * 黙って消え、**人間がまさに今ステータスバーを押した直後に「ステータスバーを
 * クリックしてください」**と表示される ―― 原因を消す言葉になる。
 *
 * 同じ問題をテストハーネス側は既に塞いでいる
 * （`test/integration/two-window-coord.ts` の `writeJsonAtomic`）。製品側だけが
 * 残っていた。tmp は同じディレクトリに置く ―― `rename(2)` が原子的なのは
 * 同一ファイルシステム内だけで、`/tmp` を経由すると保証が消える。
 *
 * 名前は `.json` で終わらないので、ブリッジは途中の tmp を登録ファイルとして
 * 読まない。落ちて残った tmp は `cleanStaleRegistrations` が pid で掃除する。
 */
function writeRegistrationFile(target: string, payload: string): void {
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    // `wx` で作る。既存を開かないので、モード 0600 は必ず作成時に効く
    // （`writeFileSync` の mode は既存ファイルには適用されない）。
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, target);
  } catch (e) {
    safeUnlink(tmp);
    throw e;
  }
}

export interface ConnectionObserver {
  /**
   * ハンドシェイクを通った接続。
   *
   * `pid` は **取れないのが普通**。Node は `net.Socket` に SO_PEERCRED を
   * 公開しないので、実機ではまず `undefined` が来る。受け手は「pid が無い＝
   * 接続が無い」と扱ってはならない（設計書 §3.5 / §5.3 / D21 は可視化を
   * 防御の層に数えている）。
   */
  onAccepted(pid: number | undefined): void;
  onRejected(reason: string): void;
  /**
   * ハンドシェイクを通った接続が切れた。`remaining` は残っている接続数。
   *
   * 接続だけを通知して切断を通知しないと、一度繋がったあと画面は永久に
   * 「接続中」のままになる — 可視化が実態を映さなくなる。
   */
  onDisconnected(remaining: number): void;
}

export class ShowMeSocketServer {
  private server: net.Server | undefined;
  private info: ServerInfo | undefined;
  /** ハンドシェイクを通った接続の数。可視化も同時接続の制限もこちらを見る。 */
  private authedConnections = 0;
  /** 開いている接続。stop() で切るために握る（close() だけでは終わらない）。 */
  private readonly sockets = new Set<net.Socket>();

  /** 登録ファイルを書き直すのに要る、start() のときに決まった値。 */
  private registration: Registration | undefined;

  constructor(
    private readonly runtimeDirs: readonly string[],
    private readonly handle: RequestHandler,
    private readonly workspacePath: string = "",
    private readonly observer: ConnectionObserver = {
      onAccepted: () => {},
      onRejected: () => {},
      onDisconnected: () => {},
    },
    private readonly identity: WindowIdentity = {
      windowId: crypto.randomUUID(),
      role: () => "idle",
    },
  ) {}

  async start(): Promise<ServerInfo> {
    // **候補は全部用意する**（設計書 §2A.6）。読むのが両候補なら書くのも
    // 両候補、が対称である。用意できなかった候補は黙って飛ばす ―― ここで
    // 全体を止めると、`/tmp`（1777）に後退先の名前で先回りするだけで
    // 拡張を起動不能にできる（読み取り側と同じ DoS 経路）。
    const prepared: string[] = [];
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const dir of this.runtimeDirs) {
      // 同じディレクトリに2度書かない（候補が畳まれていないときの保険）。
      if (seen.has(dir)) continue;
      seen.add(dir);
      const result = prepareRuntimeDir(dir);
      if (result.ok) prepared.push(dir);
      else failures.push(result.reason);
    }
    const socketDir = prepared[0];
    // **両方失敗したときだけ**投げる。理由は全部載せる ―― どちらが
    // どう落ちたかが分からないと、人間には直しようがない。
    if (socketDir === undefined) {
      throw new Error(
        failures.length === 0 ? "No runtime directory candidate was given" : failures.join(" / "),
      );
    }

    // 自分の分を作る前に、死んだウィンドウが残した分を掃除する（設計書 §6.2）。
    // **掃除も両候補**。読む候補が2つなら掃除する候補も2つ、が対称である。
    for (const dir of prepared) cleanStaleRegistrations(dir);

    // パス接尾辞は衝突回避のためだけ。秘密ではない(/proc/net/unix は world-readable)。
    const suffix = crypto.randomBytes(8).toString("hex");
    // 認証トークンは別の値で、登録ファイルの中にだけ置く。
    const token = crypto.randomBytes(32).toString("hex");

    // **ソケットは1本のまま。** 登録ファイルは `socketPath` を絶対パスで持つので、
    // どちらの候補で見つけても同じソケットに繋がる。複製するのは登録ファイルだけ。
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\vscode-showme-${suffix}`
        : path.join(socketDir, `${suffix}.sock`);
    const registryPaths = prepared.map((dir) => path.join(dir, `${suffix}.json`));

    // maxConnections は設定しない。トークンを持たない接続まで「2本目」に
    // 数えてしまうし、蹴ったことを人間に見せる手段も無くなる。制限は
    // ハンドシェイクを通った数で自分で掛け、そのとき観測者に伝える
    // (設計書 §3.5 / D21)。
    const server = net.createServer((socket) => this.onConnection(socket, token));

    // listen したあとは、この先のどこで失敗しても**自分で片付けてから**投げる。
    // 途中で投げると this.server / this.info が未設定のまま listen 中のサーバと
    // ソケットファイルが残り、stop() では回収できない（呼び出し側は握っていない）。
    try {
      const previousUmask = typeof process.umask === "function" ? process.umask(0o077) : undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600);
      } finally {
        if (previousUmask !== undefined) process.umask(previousUmask);
      }

      // 書き直し（役割の変更）から見て動いてはいけない値をここで確定させる。
      // 起動時刻は「この窓がいつ立ったか」なので、預け直すたびに若返らせない。
      const registration: Registration = {
        registryPaths,
        socketPath,
        token,
        startedAt: new Date().toISOString(),
      };
      this.writeRegistration(registration);
      this.registration = registration;
    } catch (e) {
      await this.abandon(server, socketPath, registryPaths);
      throw e;
    }

    this.server = server;
    this.info = { socketPath, registryPaths, token };
    return this.info;
  }

  /**
   * 登録ファイルを**全候補に**書く。**内容は毎回いまの役割から作る。**
   *
   * 丸ごと置き換える（モード 0600）。書き足しではないので、古い役割が残る
   * ことはない。トークンが入るファイルなので、モードは書き直しのたびに指定する。
   *
   * 書けなかった候補は飛ばし、**1つも書けなかったときだけ投げる**（設計書 §2A.6）。
   * 片方が落ちても、もう片方が生きていればブリッジは疎通する。
   */
  private writeRegistration(registration: Registration): void {
    const payload = JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      workspacePath: this.workspacePath,
      pid: process.pid,
      startedAt: registration.startedAt,
      socketPath: registration.socketPath,
      authToken: registration.token,
      windowId: this.identity.windowId,
      role: this.currentRole(),
    });

    let wrote = 0;
    const failures: string[] = [];
    for (const target of registration.registryPaths) {
      try {
        writeRegistrationFile(target, payload);
        wrote += 1;
      } catch (e) {
        failures.push(`${target}: ${String(e)}`);
      }
    }
    if (wrote === 0) {
      throw new Error(
        `Could not write the registration file to any candidate: ${failures.join(" / ")}`,
      );
    }
  }

  /**
   * いまの役割。読み出しに失敗したら**預けていない側に倒す**。
   *
   * 迷ったときに stage と書くと、預けていない窓がブリッジに選ばれる。
   * 逆に倒しておけば、失敗の結果は「見つからない」で済む。
   */
  private currentRole(): WindowRole {
    try {
      return this.identity.role();
    } catch {
      return "idle";
    }
  }

  /**
   * 役割が変わったので登録ファイルを書き直す（設計書 §2A.4）。
   *
   * **メモリの役割だけを変えても意味が無い。** ブリッジは登録ファイルしか
   * 見ないので、書き直さない限り、人間が預けた窓は永久に見つからないままか、
   * 預けるのをやめた窓が選ばれ続ける。
   *
   * まだ start() していない、あるいは stop() した後は何もしない。前者は
   * start() がそのときの役割を書くので取りこぼしが無く、後者で書くと死んだ
   * 窓の登録を復活させてしまう。
   *
   * 書き込みに失敗したら**投げる**。呼び出し側（拡張）が人間に見せる。黙って
   * 飲み込むと、人間には預けたように見えてエージェントからは見えない窓ができる。
   */
  refreshRegistration(): void {
    const registration = this.registration;
    if (registration === undefined) return;
    this.writeRegistration(registration);
  }

  /**
   * 中途半端に開いたものを捨てる。
   *
   * 片付けの失敗で、起動できなかったという本来の理由を上書きしない。
   * 削除は stop() と同じ safeUnlink を通す。
   */
  private async abandon(
    server: net.Server,
    socketPath: string,
    registryPaths: readonly string[],
  ): Promise<void> {
    try {
      // listen していないサーバでも close のコールバックは（エラー付きで）呼ばれる。
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // 閉じられなくても、ファイルの片付けは続ける
    }
    for (const registryPath of registryPaths) safeUnlink(registryPath);
    if (process.platform !== "win32") safeUnlink(socketPath);
  }

  /**
   * 認証と**無関係な**理由で切る。理由を1行書いてから閉じる（設計 D28）。
   *
   * **`bad token` にこれを使ってはならない。** トークンの当否を教えることになる。
   * 「大きすぎる」「長すぎる」は繋いだ相手が誰であれ同じ答えなので、隠す意味が無い。
   * 一方で無言で切ると、**正当なエージェントが原因に到達する手段を失う** ――
   * 実地では「応答が返る前に接続が閉じられました」しか届かず、
   * 手掛かりがゼロだった。
   */
  private rejectWithReason(socket: net.Socket, reason: string, message: string): void {
    this.observer.onRejected(reason);
    try {
      socket.write(
        `${JSON.stringify({ id: "", ok: false, error: { code: "invalid-request", message } })}\n`,
      );
    } catch {
      // 書けなくても切ることが本体。
    }
    socket.destroy();
  }

  private onConnection(socket: net.Socket, token: string): void {
    this.sockets.add(socket);
    let authed = false;
    /**
     * **Buffer のまま繋ぐ。** チャンクごとに `toString("utf8")` すると、
     * マルチバイト文字が境界で割れたときに置換文字へ化けて黙って壊れる
     * （`text: "日本語の検索文字列"` が「日」の途中で割れると、ハンドラは
     * 永久に当たらない検索文字列を受け取る）。ブリッジ側（client.ts）は
     * 同じ理由で既に Buffer 連結にしてあり、拡張側だけが残っていた。
     */
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      if (!authed) {
        this.observer.onRejected("handshake timeout");
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (authed) {
        authed = false;
        this.authedConnections -= 1;
        this.observer.onDisconnected(this.authedConnections);
      }
    });
    socket.on("error", () => clearTimeout(timer));

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // **ハンドシェイクの終わりは「まだ消費していないバッファの中の行」で決める。**
      //
      // 以前は「未認証中に届いた累計バイト数」で数えていた。ところがブリッジは
      // hello と要求を**1回の `write`** で送る（`client.ts`: 「分けても意味は同じ」）。
      // 受け側にとっては同じではない ―― `authed` が立つのはこのハンドラの下流なので、
      // `hello + request` がまるごと未認証扱いで計上され、要求本文が 4096 B の予算を
      // 食い潰した時点で **hello を読む前に**切られていた。
      //
      // 実効上限は約 3.9 KiB。宣言（`MAX_HTML_CHARS` = 256 KiB）の **1/67** である。
      // 日本語のメモなら約 1,300 文字で、宣言の 40,000 文字とは 30 倍ちがった。
      //
      // これは**同じ量を2箇所が別の方法で決めていた欠陥の4件目**である。
      // 前3件と違って**安全側に閉じすぎる**方向に壊れたので、安全性の検査は全部緑のまま
      // 機能だけが黙って死んでいた。実地で踏むまで誰も気づかなかった。
      //
      // 改行が来ていれば、その手前までが hello 行で、後ろは要求本文である。
      // こうすると1回の `write` でも2回でも**同じ答え**になる ―― それが要求である。
      if (!authed) {
        const helloEnd = buffer.indexOf(0x0a);
        const helloLineBytes = helloEnd < 0 ? buffer.length : helloEnd;
        if (helloLineBytes > MAX_HANDSHAKE_BYTES) {
          this.rejectWithReason(socket, "handshake too large", "Handshake is too large");
          return;
        }
      }

      // 上限は**バイト数**で測る。`String.length` は UTF-16 コード単位なので、
      // CJK（1文字 3 バイト）なら約3倍まで通ってしまう。
      if (buffer.length > MAX_LINE_BYTES) {
        this.rejectWithReason(socket, "line too long", "A single message is too large");
        return;
      }

      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) break;
        // 1行が揃ってから初めて文字列にする。ここが「割れない」ことの根拠。
        const line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        if (line.trim().length === 0) continue;

        if (!authed) {
          if (!this.checkHello(line, token)) {
            this.observer.onRejected("bad token");
            socket.destroy();
            return;
          }
          if (this.authedConnections >= MAX_AUTHED_CONNECTIONS) {
            // **本当に切る。** 以前は受理したまま onRejected を呼んでいたので、
            // 接続は生きてツール呼び出しを普通に通すのに、人間には
            // 「connection rejected」と表示されていた。可視化がこの道具の防御で
            // ある以上（設計書 §3.5 / §5.4 / D21）、可視化が事実と逆を言うのは
            // 最も高くつく。拒否した接続は authed に数えないので、切断通知も
            // 出ない（出すと今度は「切れた」が二重に見える）。
            this.observer.onRejected(SECOND_CONNECTION_REASON);
            socket.destroy();
            return;
          }
          authed = true;
          this.authedConnections += 1;
          clearTimeout(timer);
          this.observer.onAccepted(peerPid(socket));
          continue;
        }

        void this.dispatch(socket, line);
      }
    });
  }

  private checkHello(line: string, token: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    const hello = helloSchema.safeParse(parsed);
    if (!hello.success) return false;

    const given = Buffer.from(hello.data.token, "utf8");
    const expected = Buffer.from(token, "utf8");
    if (given.length !== expected.length || given.length !== TOKEN_HEX_LENGTH) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  private async dispatch(socket: net.Socket, line: string): Promise<void> {
    let id = "unknown";
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;

      // 信頼境界はブリッジではなくソケット。ここで必ず再検証する。
      const req = requestSchema.safeParse(parsed);
      if (!req.success) {
        this.send(socket, {
          id,
          ok: false,
          error: { code: "invalid-request", message: req.error.message },
        });
        return;
      }
      const result = await this.handle(req.data);
      this.send(socket, { id, ok: true, result });
    } catch (e) {
      // 判っている失敗は判っている名前で返す。それ以外だけが internal。
      const error =
        e instanceof ToolError
          ? { code: e.code, message: e.message }
          : { code: "internal" as const, message: String(e) };
      this.send(socket, { id, ok: false, error });
    }
  }

  private send(socket: net.Socket, payload: unknown): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const info = this.info;
    this.server = undefined;
    this.info = undefined;
    // 以後の書き直しで登録ファイルを復活させない。
    this.registration = undefined;
    if (server !== undefined) {
      // close() は「新規受付を止める」だけで、**最後の接続が閉じるまで完了しない**。
      // 待つ前に開いている接続を切る。切らないと、エージェントが繋いだままの
      // ときに deactivate() が終わらず、VS Code のシャットダウンが止まる。
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closed;
    }
    if (info !== undefined) {
      // **両方消す。** 書いたのが両候補なら消すのも両候補、が対称である。
      // 片方だけ消すと、死んだ窓の登録が後退先に残り続ける。
      for (const registryPath of info.registryPaths) safeUnlink(registryPath);
      if (process.platform !== "win32") safeUnlink(info.socketPath);
    }
  }
}

/** 自分が作った通常ファイルだけを消す。シンボリックリンクは辿らない。 */
function safeUnlink(target: string): void {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return;
    fs.unlinkSync(target);
  } catch {
    // 既に無いなら何もしない
  }
}

function peerPid(socket: net.Socket): number | undefined {
  // Node は SO_PEERCRED を公開していない。したがって **ここは実機では常に
  // undefined を返す**。将来の Node や別ランタイムが公開したときのために
  // 読む試みだけ残すが、可視化はこの値に依存してはならない(設計書 S11)。
  const withPid = socket as unknown as { pid?: number };
  return typeof withPid.pid === "number" ? withPid.pid : undefined;
}
