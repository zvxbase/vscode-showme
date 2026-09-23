import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 2窓の受け入れテストで、測る側と測られる側が話すための約束（増分2A Task 8）。
 *
 * **なぜ話す必要があるのか。** 窓の役割は窓ごとのメモリにあり（設計書 §2A.2）、
 * 切り替える手段は `showme.toggle` コマンドだけである。コマンドは自分の窓の
 * 拡張ホストでしか動かないので、片方の窓から他方の役割を変えることはできない。
 * だから2つ目の窓にも同じテストコードを載せ、ファイル越しに指図する。
 *
 * ソケットで話さない。この検査が確かめたいのは「登録ファイルとソケットの層が
 * 役割で正しく窓を選ぶか」であって、その層をテストの連絡路にも使うと、
 * 検査対象が壊れたときに検査そのものが動かなくなる（何が壊れたのか分からない
 * 落ち方をする）。連絡は素のファイルで行い、被検査系と交わらせない。
 *
 * 書き込みは全部 rename で原子的にする。相手は 200ms ごとに読みに来るので、
 * 書きかけを読ませると「JSON が壊れている」という嘘の失敗が混じる。
 */

/** 連絡用ディレクトリの場所を渡す環境変数。ハーネスが子プロセスに渡す。 */
export const COORD_ENV_VAR = "SHOWME_TWO_WINDOW_DIR";

/**
 * 先着1つが測る側になるための錠。`wx` で作れた窓だけが alpha。
 *
 * `--extensionTestsPath` は新しく開いた窓にも受け継がれるので（スパイクで実測）、
 * 2つ目の窓でも同じ `run()` が走る。役を決める手段がないと、両方が測る側に
 * なって互いの役割を奪い合う。
 */
export const ALPHA_LOCK = "alpha.lock";

/** 測る側が最後に書く結果。ハーネスはこれが無ければ落ちたものとして扱う。 */
export const RESULTS_FILE = "results.json";

/** 測る側から測られる側への指図。`seq` が増えたときだけ新しい指図とみなす。 */
export const COMMAND_FILE = "command.json";

/** 測られる側にできること。 */
export type BetaOp =
  | { readonly op: "identity" }
  | { readonly op: "set-role"; readonly role: "stage" | "idle" }
  | { readonly op: "snapshot" };

export interface BetaCommand {
  readonly seq: number;
  readonly command: BetaOp;
}

export interface BetaReply {
  readonly seq: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly data?: unknown;
}

/**
 * 測られる側が定期的に書く近況。
 *
 * `failure` を持つ。2つ目の窓に拡張が入らなかった場合、測る側からは
 * 「beta が現れない」としか見えず、原因（拡張が無い / activate が投げた）が
 * 消える。**測られる側は失敗しても黙って止まらず、失敗の中身を書いて立ち続ける。**
 */
export interface BetaStatus {
  readonly pid: number;
  readonly updatedAt: string;
  readonly ready: boolean;
  readonly failure?: string;
  readonly windowId?: string;
  readonly workspacePath?: string;
  readonly role?: string;
  readonly visibleEditors?: readonly string[];
}

/** 測る側が最後に残す結果。ハーネスが読む。 */
export interface TwoWindowResults {
  readonly ok: boolean;
  readonly failures: number;
  readonly notes: readonly string[];
  readonly finishedAt: string;
}

export function coordDirFrom(env: NodeJS.ProcessEnv): string {
  const dir = env[COORD_ENV_VAR];
  if (dir === undefined || dir === "") {
    throw new Error(`${COORD_ENV_VAR} が渡っていない。2窓のテストはハーネス越しに走らせること`);
  }
  return dir;
}

export function replyPath(dir: string, seq: number): string {
  return path.join(dir, `reply-${seq}.json`);
}

export function betaStatusPath(dir: string, pid: number): string {
  return path.join(dir, `beta-${pid}.json`);
}

/** `beta-*.json` を全部読む。読めないものは飛ばす。 */
export function readBetaStatuses(dir: string): BetaStatus[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BetaStatus[] = [];
  for (const name of names) {
    if (!name.startsWith("beta-") || !name.endsWith(".json")) continue;
    const value = readJson<BetaStatus>(path.join(dir, name));
    if (value !== undefined) out.push(value);
  }
  return out;
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** 書きかけを読ませない。同じディレクトリに書いてから rename する。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
