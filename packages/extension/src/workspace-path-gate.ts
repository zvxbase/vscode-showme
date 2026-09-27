import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRedactedPath, normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";
import { type CanonicalTarget, canonicalizeWorkspacePath } from "./canonical-path.js";
import {
  isDeniedOutsidePath,
  isRedactedOutsidePath,
  normalizeOutsideAbsolute,
} from "./outside-path.js";
import {
  RedactedLinkIndex,
  type RedactedLinkIndexOptions,
  isLinkToRedacted,
} from "./redacted-links.js";

/**
 * 秘匿の方針。`readConfig().redaction` が1回の要求につき1回作り、関門と観測の側に同じ値を渡す。
 *
 * - `patterns`: 秘匿の名前（既定のパターンに設定の `showme.redactedPathPatterns` を足したもの）
 * - `blockLinksToRedacted`: `showme.blockLinksToRedactedFiles`（D91。既定 `true`）。秘匿ファイルと
 *   同じ実体（ハードリンク）を、名前が秘匿でなくても秘匿として扱う
 * - `allowOutsideWorkspace`: `showme.allowOutsideWorkspace`（D101。既定 `false`）。真のときだけ、
 *   関門は絶対パスでワークスペースの外のファイルを受け入れる。**秘匿の方針と同じ1つの値に載せる**
 *   ―― 関門の呼び出し口はどれもこの方針を1つ渡すだけなので、「外を許すか」を口ごとに別に
 *   読む経路ができない（不変条件14）。省略は `false`（検査が作る方針・古い呼び出し口は閉じる側）
 */
export interface RedactionPolicy {
  readonly patterns: readonly string[];
  readonly blockLinksToRedacted: boolean;
  readonly allowOutsideWorkspace?: boolean;
}

/**
 * 関門が外のパスの判断で使うホーム。**検査のための口**（偽のホームを注入する。本物の `~/.ssh` に
 * 触らない）。本体は渡さず、`os.homedir()` を使う。
 */
export interface GateHost {
  readonly home?: string;
}

/** 秘匿ファイルの実体を集める走査が不完全に終わったときの知らせ先（操作ログ）。 */
let incompleteWalkListener: ((rootPath: string) => void) | undefined;

/**
 * 関門の索引を作る。**不完全な走査の知らせを必ず知らせ先へつなぐ**（本体の索引と、検査で
 * 差し替える索引が同じ配線を持つように、作る場所をここ1つにする）。
 */
export function createGateRedactedLinkIndex(
  options: Omit<RedactedLinkIndexOptions, "onIncomplete"> = {},
): RedactedLinkIndex {
  return new RedactedLinkIndex({
    ...options,
    onIncomplete: (rootPath) => incompleteWalkListener?.(rootPath),
  });
}

/**
 * 秘匿ファイルの実体の索引。**プロセスに1つ**（モジュールで持つ）。
 *
 * 引数で渡す形にしないのは、関門の呼び出し口が十数箇所あり、どれか1つが新しい索引を
 * 作って渡すと、その口だけ要求のたびに歩き直す（キャッシュが効かない）からである。
 * 索引は（ルート, パターン）の組ごとに集合を分けて持つので、窓やパターンが違っても混ざらない。
 */
let redactedLinkIndex = createGateRedactedLinkIndex();

/**
 * 走査が不完全に終わったとき（上限・ルートが読めない。そのルートでリンク数2以上のファイルが
 * すべて拒まれる間）の知らせ先を置く。`extension.ts` が操作ログにつなぐ。`undefined` で外す。
 */
export function onRedactedLinkWalkIncomplete(
  listener: ((rootPath: string) => void) | undefined,
): void {
  incompleteWalkListener = listener;
}

/**
 * 索引を差し替え、前の索引を返す。**検査のための口**（歩いた回数を数える・前の検査の集合を
 * 持ち越さない）。本体からは呼ばない。
 */
export function replaceRedactedLinkIndex(next: RedactedLinkIndex): RedactedLinkIndex {
  const previous = redactedLinkIndex;
  redactedLinkIndex = next;
  return previous;
}

/**
 * 実体まで辿った名前と実体が秘匿か。**関門（`acceptWorkspacePath`）と観測の側
 * （`isRedactedEntity`）の両方がここを通る**（不変条件14: 「秘匿か」を2通りに決めない）。
 *
 * 1. 正準化した名前に秘匿のパターンを当てる（シンボリックリンク経由の秘匿）
 * 2. 方針が許せば、実体が秘匿ファイルへのハードリンクかを見る（D91）。ハードリンクは
 *    realpath で解けず、名前はどちらも「本物」なので、名前ではなく実体（dev:ino）で見る。
 *    ハードリンクはファイルにしか張れないので、ファイル以外は歩かない
 */
function redactsTarget(target: CanonicalTarget, policy: RedactionPolicy): boolean {
  if (isRedactedPath(target.canonical, policy.patterns)) return true;
  if (!policy.blockLinksToRedacted) return false;
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(target.realPath, { bigint: true });
  } catch {
    // realpath の直後に消えた。実体を確かめられないので閉じる側に倒す。
    return true;
  }
  if (!stat.isFile()) return false;
  // 歩くのは実体のルートから（綴りのルートはリンクでありうる。歩く木と実体の木を揃える）。
  return isLinkToRedacted(redactedLinkIndex, target.rootRealPath, stat, policy.patterns);
}

/**
 * エージェントが渡したパスを受け入れるかどうかの**唯一の判断**。
 *
 * ## なぜ関数にまとめたか
 *
 * この repo は同じ境界を**4回**別々に書いた:
 *
 * | 場所 | 何を通していたか | 結果 |
 * |---|---|---|
 * | `resolve-location.ts`（`show_code` ほか） | 正規化＋除外＋realpath | 正しい |
 * | `read-workspace-file.ts` | realpath＋正準名への除外 | 正しい |
 * | `language-surface.ts`（初版） | **何も** | ホストのファイルの存在オラクル |
 * | `language-surface.ts`（2版） | 正規化＋除外（綴りのみ） | シンボリックリンクで脱出、内容のオラクル |
 * | `view-surface.ts` | **正規化のみ** | 除外パスをツリーに出せた |
 *
 * 毎回「同じ量を別の方法で決めている」（不変条件14）。**書くたびに1段ずつ抜ける。**
 * だから判断を1つにして、面はこれを通すだけにする。
 *
 * > **残りも通した。** `read-workspace-file.ts` / `symbol-prefetch.ts` と、
 * > `show-code.ts` / `annotate.ts` のレート制限の鍵（`fileRateLimitCanonicalizer`）は、
 * > 以前は自前で「正規化→正準化→正準名への除外」を書いていた。どれも正しかったが、
 * > 関門だけに「綴りへの除外」が無く、秘匿ファイルの存在のオラクルになっていた
 * > （Task 0 で実測）。「1つにした」を**言葉で信じない**ために、
 * > `test/workspace-path-gate.test.ts` が `src/` を走査して、この2ファイル以外が
 * > `canonicalizeWorkspacePath` を import していないことを検査している。
 *
 * ## 5つを順に当てる。順序に意味がある
 *
 * 1. `normalizeWorkspaceRelative` ―― 綴りの拒否（`..` / 絶対 / コロン / NUL / 末尾の空白）
 * 2. `isRedactedPath` ―― **綴り**に当てる。秘匿の綴りにはファイルシステムを触らせない
 * 3. `canonicalizeWorkspacePath` ―― **realpath まで辿って**ルート配下を確認
 * 4. `isRedactedPath` ―― **正準化した名前**に当てる
 * 5. （D91）方針が許せば、実体が秘匿ファイルへの**ハードリンク**でないか ―― 4 と合わせて
 *    `redactsTarget` 1つが決め、観測の側（`isRedactedEntity`）も同じものを通す
 *
 * 4 だけにして綴りに当てないと `.env` の**存在**が答えの割れ方から読める
 * （2 が無かった間、実際に割れていた）。
 * 2 だけにして正準名に当てないと `docs/harmless.txt -> .env` が通る。**両方要る。**
 *
 * > **1 は単独では効いていない**（変異検査で外しても緑）。`canonicalizeWorkspacePath` が
 * > 正準化した後にもう一度 `normalizeWorkspaceRelative` を当てるからである。
 * > 残してあるのは、**ファイルシステムに触る前に落とす**ためで
 * > （`realpathSync` は存在しないパスでも例外を作る＝相手に仕事をさせる）、
 * > 層として数えるものではない。次に読む人が実際には無い層を数えないよう、書いておく。
 *
 * ## 失敗は2つの理由に畳む
 *
 * 「存在しない」と「外にある」を分けない ―― 分けると、そこから存在を読める
 * （S1 と同じ形の無音のオラクル）。どちらも `invalid-path` である。
 */
export type WorkspacePathVerdict =
  | InsideWorkspacePathVerdict
  | OutsideWorkspacePathVerdict
  | RefusedWorkspacePathVerdict;

/** ワークスペースの中。`canonical` はルートからの正準相対パス。 */
export interface InsideWorkspacePathVerdict {
  ok: true;
  kind: "inside";
  canonical: string;
  realPath: string;
}

/**
 * ワークスペースの外（D101。`allowOutsideWorkspace` がオンのときだけ）。`absPath` は実体まで
 * 辿った正規化済みの絶対パス（`realPath` と同じ値。名前として使う側と、読む側の両方に同じ
 * 綴りを渡すために2つ置く ―― 中の `canonical` / `realPath` と形を揃える）。
 */
export interface OutsideWorkspacePathVerdict {
  ok: true;
  kind: "outside";
  absPath: string;
  realPath: string;
  /**
   * 関門が lstat で見た実体（10進の文字列。bigint をそのまま運べない線もあるので文字列にする）。
   * 開く側はリンクを辿らずに開き（O_NOFOLLOW）、開いたものの fstat とこの2つを突き合わせる ――
   * 判定と開くの間に最後の部分をリンクに差し替えられても、別の実体を開かない。
   */
  dev: string;
  ino: string;
}

export interface RefusedWorkspacePathVerdict {
  ok: false;
  reason: "invalid-path" | "excluded-path";
}

const INVALID: RefusedWorkspacePathVerdict = Object.freeze({
  ok: false,
  reason: "invalid-path",
}) as RefusedWorkspacePathVerdict;
const EXCLUDED: RefusedWorkspacePathVerdict = Object.freeze({
  ok: false,
  reason: "excluded-path",
}) as RefusedWorkspacePathVerdict;

/**
 * パスの関門の**唯一の入口**。中か外かもここで決める（D102）。
 *
 * - 設定（`policy.allowOutsideWorkspace`）がオフ、または絶対パスでない: 今までどおり
 *   ワークスペース相対パスとして判断する（下の5段。絶対パスは `invalid-path`）
 * - 設定がオンで絶対パス: `acceptOutsidePath`（外の判断。中を指していれば中の判断に戻す）
 *
 * `~` は展開しない。`~/x` は絶対パスではないので、今までどおり「ワークスペースの中の `~` という
 * 名前のフォルダ」として判断される（普通は無いので `invalid-path`）。
 *
 * `host` は検査のための口（偽のホーム）。本体は渡さない。
 */
export function acceptWorkspacePath(
  rootPath: string | undefined,
  rawPath: string,
  policy: RedactionPolicy,
  host: GateHost = {},
): WorkspacePathVerdict {
  if (rootPath === undefined) return INVALID;
  const spelled = spellAgentPath(rootPath, rawPath, policy);
  if (spelled === undefined) return INVALID;
  if (spelled.kind === "inside") return acceptInsidePath(rootPath, spelled.rel, policy);
  return acceptOutsidePath(rootPath, spelled.abs, policy, homesOf(host));
}

/**
 * エージェントの綴りを正規化した結果（D102）。`inside` の `rel` はワークスペース相対の正準の綴り、
 * `outside` の `abs` は正規化した絶対パス（**綴り**。realpath ではない）。
 */
export type SpelledAgentPath =
  | { readonly kind: "inside"; readonly rel: string }
  | { readonly kind: "outside"; readonly abs: string };

/**
 * エージェントの綴りを、中か外かを含めて正規化する。**ファイルシステムに触らない。**
 * 関門（`acceptWorkspacePath`）が最初に通すのがこれで、解決器の `normalizedPath`
 * （`agentPathKey`）も同じものから作る ―― 「どの綴りをどう読むか」を2箇所で決めない（不変条件14）。
 *
 * - 設定がオフ、または絶対パスでない: `normalizeWorkspaceRelative`（今までどおり）
 * - 設定がオンで絶対パス: `normalizeOutsideAbsolute`。綴りがワークスペースの中なら相対パスに直す
 *   （中のファイルを絶対パスで指したら、相対パスとして扱う）
 *
 * `~` は展開しない。`~/x` は絶対パスではないので、今までどおり「ワークスペースの中の `~` という
 * 名前のフォルダ」として読む。
 */
export function spellAgentPath(
  rootPath: string | undefined,
  rawPath: string,
  policy: RedactionPolicy,
): SpelledAgentPath | undefined {
  if (policy.allowOutsideWorkspace === true && path.isAbsolute(rawPath)) {
    const abs = normalizeOutsideAbsolute(rawPath);
    if (abs === undefined) return undefined;
    const inside = rootPath === undefined ? undefined : relativeInside(rootPath, abs);
    if (inside !== undefined) {
      const rel = normalizeWorkspaceRelative(inside);
      return rel === undefined ? undefined : { kind: "inside", rel };
    }
    return { kind: "outside", abs };
  }
  const rel = normalizeWorkspaceRelative(rawPath);
  return rel === undefined ? undefined : { kind: "inside", rel };
}

/**
 * エージェントに返す `normalizedPath`（と、舞台の URI・塗り・吹き出しの鍵）。中は相対パス、外は
 * 正規化した絶対パス（**綴り**。realpath を返すと、シンボリックリンクの指す先が返り値から読める）。
 * 相対パスは根で始まらないので、2つの形は交わらない。鍵をもう一度関門に渡しても同じ答えになる。
 */
export function agentPathKey(
  rootPath: string | undefined,
  rawPath: string,
  policy: RedactionPolicy,
): string | undefined {
  const spelled = spellAgentPath(rootPath, rawPath, policy);
  if (spelled === undefined) return undefined;
  return spelled.kind === "inside" ? spelled.rel : spelled.abs;
}

/**
 * 綴りだけで秘匿・資格情報の置き場所に当たるか（**ファイルシステムに触らない**。ホームの実体を
 * 求めるためにホームにだけ触る）。解決器の `isRedacted` に渡す口で、関門が realpath の前に当てる
 * 判断と同じ関数を通す（`excludesOutsideSpelling`）。受け入れない綴りは偽（`invalid-path` の側）。
 */
export function isExcludedSpelling(
  rootPath: string | undefined,
  rawPath: string,
  policy: RedactionPolicy,
  host: GateHost = {},
): boolean {
  const spelled = spellAgentPath(rootPath, rawPath, policy);
  if (spelled === undefined) return false;
  if (spelled.kind === "inside") return isRedactedPath(spelled.rel, policy.patterns);
  return excludesOutsidePath(spelled.abs, policy, homesOf(host));
}

/** 関門が受け入れたものの名前（中は正準相対パス、外は実体の絶対パス）。 */
export function verdictPath(
  verdict: InsideWorkspacePathVerdict | OutsideWorkspacePathVerdict,
): string {
  return verdict.kind === "inside" ? verdict.canonical : verdict.absPath;
}

/** 照合するホーム（綴りと実体）。実体を求めるためにホームにだけ触る。 */
function homesOf(host: GateHost): string[] {
  const home = host.home ?? os.homedir();
  return [home, realHome(home)];
}

/** 外のパス（綴りでも実体でも）が秘匿の規則か資格情報の置き場所に当たるか。 */
function excludesOutsidePath(
  abs: string,
  policy: RedactionPolicy,
  homes: readonly string[],
): boolean {
  return isRedactedOutsidePath(abs, policy.patterns) || isDeniedOutsidePath(abs, homes);
}

/**
 * 外を扱わない呼び出し口のための畳み: `outside` を `invalid-path` にする（閉じる側）。
 *
 * 外を扱わない口がこれを通す。設定の既定はオフなので、オフのままなら何も変わらない（`outside` は
 * 設定がオンのときしか作られない）。いま通しているのは、エクスプローラーで示す口と `show_html` の `path` を読む口
 * （`readWorkspaceFile`）。どちらも設計でワークスペースの中だけ。
 * **外を扱えるようになった口から外す。**
 */
export function insideOnly(
  verdict: WorkspacePathVerdict,
): InsideWorkspacePathVerdict | RefusedWorkspacePathVerdict {
  return verdict.ok && verdict.kind === "outside" ? INVALID : verdict;
}

/** `abs` が `root` の中（ルート自身を含む）なら `/` 区切りの相対パス、外なら `undefined`。 */
function relativeInside(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs);
  if (path.isAbsolute(rel)) return undefined;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * ワークスペースの外の絶対パスを受け入れるか（D101）。**順序に意味がある** ――
 * 中の5段（下の `acceptInsidePath`）と同じ考え方で、ファイルシステムに触る前に綴りで落とす。
 *
 * 1. 綴りの正規化（`normalizeOutsideAbsolute`。`~`・`.` / `..`・NUL・UNC などを落とす）
 * 2. 綴りがワークスペースの中なら、相対パスに直して**中の判断**に渡す
 * 3. 秘匿の規則（パスの各部分と末尾の部分列）と資格情報の置き場所を**綴り**に当てる ――
 *    ここで落とせば、`~/.ssh/無いファイル` も `~/.ssh/id_rsa` も同じ答え（存在のオラクルを作らない）。
 *    ホームは**綴りと実体の両方**で照合する。ホーム自体がリンクのとき、実体の側の綴り
 *    （`/real/home/.ssh/…`）を綴りのホームだけで見ると、ここを素通りして realpath が割れ方を作る。
 *    ホームの実体を求めるためにホームには触るが、エージェントが渡した綴りには触らない
 * 4. realpath（`realpathSync.native`。Windows の 8.3 の短い名前・subst、macOS の大小を実体の綴りに
 *    直す）。辿れないもの（無い）は `invalid-path`
 * 5. 実体がワークスペースの中なら、**中の判断**に渡す（外から中へのシンボリックリンク）
 * 6. 3 を**実体**にもう一度当てる（許された綴りから `~/.ssh` へのシンボリックリンクを落とす）
 * 7. 実体を **lstat** で見て通常のファイルだけ（ディレクトリ・FIFO・デバイスは `invalid-path`。
 *    realpath の後に最後の部分をリンクに差し替えられたら、それも通常のファイルでないので落ちる）
 * 8. リンク数が2以上なら、`blockLinksToRedacted` がオンのとき一律に断る。中では秘匿ファイルの
 *    実体の索引（ワークスペースを歩いて作る）と照合できるが、外で同じ照合をするにはホーム全体を
 *    歩くことになる。照合できないので閉じる側に倒す。理由は中のハードリンクと同じ `excluded-path`
 *
 * 失敗の理由は中と同じ2つだけ（秘匿・資格情報の置き場所・ハードリンクは `excluded-path`、
 * それ以外は `invalid-path`）。割ると、どの綴りが何で落ちたかから存在が読める。
 */
function acceptOutsidePath(
  rootPath: string,
  abs: string,
  policy: RedactionPolicy,
  homes: readonly string[],
): WorkspacePathVerdict {
  // 綴りの正規化と「綴りが中か」は `spellAgentPath` が済ませている。ホームは綴りと実体の両方
  // （触るのはホームだけ。綴りにはまだ触らない）。
  if (excludesOutsidePath(abs, policy, homes)) return EXCLUDED;

  let realPath: string;
  let rootReal: string;
  try {
    realPath = fs.realpathSync.native(abs);
    rootReal = fs.realpathSync.native(rootPath);
  } catch {
    return INVALID;
  }

  const realInside = relativeInside(rootReal, realPath);
  if (realInside !== undefined) return acceptInsidePath(rootPath, realInside, policy);

  if (excludesOutsidePath(realPath, policy, homes)) return EXCLUDED;

  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(realPath, { bigint: true });
  } catch {
    return INVALID;
  }
  if (!stat.isFile()) return INVALID;
  if (policy.blockLinksToRedacted && stat.nlink > 1n) return EXCLUDED;

  return {
    ok: true,
    kind: "outside",
    absPath: realPath,
    realPath,
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

/** ホームの実体。辿れなければ綴りのまま（綴りでの照合は既に済んでいる）。 */
function realHome(home: string): string {
  if (!path.isAbsolute(home)) return home;
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

/**
 * ワークスペース相対パスの判断（D101 より前の関門そのもの）。設定がオフのときの答えはここだけが
 * 決める ―― オフのままなら今までと1文字も変わらない。
 */
function acceptInsidePath(
  rootPath: string,
  rawPath: string,
  policy: RedactionPolicy,
): WorkspacePathVerdict {
  const normalized = normalizeWorkspaceRelative(rawPath);
  if (normalized === undefined) return INVALID;

  // **秘匿の綴りには realpath を当てない。** 当てると、存在すれば excluded-path、
  // 無ければ invalid-path と答えが割れ、秘匿ファイルの存在を1本ずつ確かめられる
  // （S1 と同じ形の無音のオラクル）。綴りで落とせば、存在を問わず同じ答えになる。
  // `symbol-prefetch.ts` / `annotate.ts` が既にこの順序で、関門だけが違っていた
  // ―― 同じ境界を別々に書いた4箇所目の、さらに残りである（不変条件14）。
  // 実測: 直す前は `.env`（実在）と `.env.missing`（不在）の
  // reason が実際に割れていた。
  if (isRedactedPath(normalized, policy.patterns)) return EXCLUDED;

  const canonical = canonicalizeWorkspacePath(rootPath, normalized);
  // 存在しないものも外にあるものも同じ答え。分けると存在が読める。
  if (canonical === undefined) return INVALID;

  // **正準化した名前と実体に当てる。** 綴りに当てると、除外パスを指すリンクが通る。
  // ハードリンク（D91）も同じ答え（`excluded-path`）にする ―― 理由を割ると、どの名前が
  // 秘匿ファイルと同じ実体かが読める。
  if (redactsTarget(canonical, policy)) return EXCLUDED;

  return {
    ok: true,
    kind: "inside",
    canonical: canonical.canonical,
    realPath: canonical.realPath,
  };
}

/**
 * レート制限の鍵（`rate-limit.ts` の `fileRateLimitKey`）に注入する正準化。
 *
 * **関門が受け入れた実体の正準名だけ**を返す。落としたもの（綴りが悪い・
 * 外にある・存在しない・秘匿）は `undefined` で、`fileRateLimitKey` が共有の
 * `NO_CANONICAL_PATH_KEY` に畳む。
 *
 * ## なぜ `canonicalWorkspaceName` ではないか
 *
 * 鍵は正準名で作られる。秘匿の綴りに realpath を当てて正準名を鍵にすると、
 * `.env` が実在すれば専用の鍵、無ければ共有の鍵、と**制限に当たるかどうか**から
 * 存在が読める（Task 0 で関門に見つかったのと同じ形が、鍵の分かれ方に移るだけ）。
 * 秘匿へのリンク（`docs/harmless.txt -> .env`）も、正準名を鍵にすれば専用の
 * 鍵が生える。だから鍵には**関門の判定そのもの**を使う ―― 受け入れなかった
 * ものは名前を持たない。
 *
 * 以前は `show-code.ts` / `annotate.ts` がそれぞれ同じ3段の閉包を持っていた
 * （不変条件14。ここに畳んだ）。**呼び出し口で書き直さない。**
 */
export function fileRateLimitCanonicalizer(
  rootPath: string | undefined,
  policy: RedactionPolicy,
  host: GateHost = {},
): (rawPath: string) => string | undefined {
  return (rawPath) => {
    const verdict = acceptWorkspacePath(rootPath, rawPath, policy, host);
    // 外（D101）は実体の絶対パスが鍵。中の鍵（相対パス）とは綴りが交わらない ―― 相対パスは
    // 根で始まらず、コロンも含まない（Windows の外の鍵は `c:\…`）。
    return verdict.ok ? verdictPath(verdict) : undefined;
  };
}

/**
 * **判断せず、実体の名前だけを返す。**
 *
 * `acceptWorkspacePath` は除外を理由に落とすが、観測の経路（`get_editor_state`）は
 * 「除外されたファイルを人間が開いている」ことまでは伝える（`activePath` は返す。
 * 設計書 §3.1）。だから**除外の判断は下流に任せて、名前だけを実体に直す**。
 *
 * 除外の判断を2箇所に置かないための口である ―― ここで除外を決めてしまうと、
 * 下流の `isRedactedPath` と合わせて2箇所になる（不変条件14）。
 *
 * ルートの外・存在しないものは `undefined`（fail-closed）。
 */
export function canonicalWorkspaceName(
  rootPath: string | undefined,
  rawPath: string,
): string | undefined {
  if (rootPath === undefined) return undefined;
  const normalized = normalizeWorkspaceRelative(rawPath);
  if (normalized === undefined) return undefined;
  return canonicalizeWorkspacePath(rootPath, normalized)?.canonical;
}

/**
 * 観測した名前（`get_editor_state` のタブ・選択、`find_*` の結果）が秘匿か。
 *
 * 観測の側は関門のように「落とす」のではなく、名前は出して中身に当たるものを伏せる
 * （設計書 §3.1）。だから判定だけを返す口が要る。**判定そのものは関門と同じ**
 * （`redactsTarget`）―― 観測の側が名前だけで決めると、関門が落とすハードリンクの
 * 選択が `get_editor_state` から返る（不変条件14: 観測した値も同じ関門を通す）。
 *
 * - 綴りが秘匿なら、存在を問わず秘匿（ファイルシステムに触らない）
 * - 実体まで辿れれば、関門と同じく実体の名前とハードリンクを見る
 * - 辿れない（無い・外・ルートが無い）ものは名前だけで判定する（D91 より前と同じ）。
 *   **受け入れる限界**: 開いている文書は、そのパスが消えた・別の実体に張り替えられた後も
 *   中身を持ちうる。そのときは名前だけで判定し、実体（リンク）は見ない
 */
export function isRedactedEntity(
  rootPath: string | undefined,
  rel: string,
  policy: RedactionPolicy,
): boolean {
  if (isRedactedPath(rel, policy.patterns)) return true;
  // 外の鍵（D102。正規化した絶対パス）は、**関門をいま通るときだけ**秘匿でない。設定がオフ・
  // 秘匿の名前・資格情報の置き場所・無い・ハードリンクは秘匿として扱う（閉じる側。可視行・
  // カーソル・選択を返さない）。観測の側（`observedPathName`）は関門に落ちる外を名指さないので、
  // 普通はここへ来る前に `(outside workspace)` に畳まれている。
  if (path.isAbsolute(rel)) return !acceptWorkspacePath(rootPath, rel, policy).ok;
  if (rootPath === undefined) return false;
  const normalized = normalizeWorkspaceRelative(rel);
  if (normalized === undefined) return false;
  const target = canonicalizeWorkspacePath(rootPath, normalized);
  if (target === undefined) return false;
  return redactsTarget(target, policy);
}

/** 観測の側と `arrange_editors` のパスの答え（`acceptObservablePath`）。 */
export type ObservablePathVerdict =
  | { ok: true; canonical: string; realPath: string }
  | RefusedWorkspacePathVerdict;

/**
 * エージェントが**タブを名指す**パス（`arrange_editors` の `move-tab` / `close-tabs`）を受け入れ、
 * 観測の側（`observedPathName`）と**同じ名前**に直す（不変条件14: エージェントが
 * `get_editor_state` で読んだ名前で指せるように、名前を作る関数を1つにする）。
 *
 * - 中: 関門の正準名（今までどおり）
 * - 外（D102。設定がオンで関門を通るとき）: 正規化した**綴り**の絶対パス（`agentPathKey`）。
 *   realpath にしない ―― `show_code` の `normalizedPath` と映しの鍵がその綴りなので、同じ綴りで
 *   開いたタブと突き合う
 */
export function acceptObservablePath(
  rootPath: string | undefined,
  rawPath: string,
  policy: RedactionPolicy,
  host: GateHost = {},
): ObservablePathVerdict {
  const verdict = acceptWorkspacePath(rootPath, rawPath, policy, host);
  if (!verdict.ok) return verdict;
  if (verdict.kind === "inside") {
    return { ok: true, canonical: verdict.canonical, realPath: verdict.realPath };
  }
  const key = agentPathKey(rootPath, rawPath, policy);
  return key === undefined ? INVALID : { ok: true, canonical: key, realPath: verdict.realPath };
}

/**
 * 観測した綴り（映しの鍵、または `file:` のタブのパスを `agentPathKey` で読んだもの）を、
 * `get_editor_state` と `arrange_editors` が名指す名前にする。**除外の判断はしない**のが中の
 * 規則（`canonicalWorkspaceName`。秘匿のタブも名前は出し、中身を伏せるのは下流）。
 *
 * 外（D102）は**関門を通るときだけ**名指す（`acceptObservablePath` と同じ名前）。関門に落ちる外
 * （設定がオフ・秘匿の名前・資格情報の置き場所・無い・ハードリンク）は `undefined`
 * ＝ `(outside workspace)`。中の秘匿のタブと扱いが違うのは、外の名前を出すことがホームの
 * ファイル名を列挙する口になるから（D37'。設定がオフのときと同じ見え方に倒す）。
 */
export function observedPathName(
  rootPath: string | undefined,
  spelled: string,
  policy: RedactionPolicy,
): string | undefined {
  if (!path.isAbsolute(spelled)) return canonicalWorkspaceName(rootPath, spelled);
  if (policy.allowOutsideWorkspace !== true) return undefined;
  const verdict = acceptObservablePath(rootPath, spelled, policy);
  return verdict.ok ? verdict.canonical : undefined;
}
