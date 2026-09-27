import * as fs from "node:fs";
import * as path from "node:path";
import { isRedactedPath } from "@zvx/vscode-showme-protocol";

/**
 * 秘匿ファイルへのハードリンクを見分ける（D91）。
 *
 * 秘匿の判定は名前（綴りと realpath 後の名前）で行っている。シンボリックリンクは
 * realpath で解けるが、ハードリンクは解けない ―― `docs/notes.txt` が `.env` と
 * 同じ実体でも、名前はどちらも「本物」で、realpath は何も変えない。だから名前では
 * なく実体（dev:ino）で見る。秘匿の名前を持つファイルの実体を集めておき、
 * 読もうとするファイルの実体がその中にあれば秘匿として扱う。
 *
 * vscode に依存させない（実ファイルシステムで検査するため）。
 */

/** 歩く項目数の既定の上限。大きなワークスペースで要求を止めないための打ち切り。 */
export const DEFAULT_MAX_WALK_ENTRIES = 50_000;

/** 集めた実体の有効期間の既定値（ミリ秒）。 */
export const DEFAULT_REDACTED_INDEX_TTL_MS = 10_000;

/** 覚えておく（ルート, パターン）の組の数。ワークスペースは通常少ないので小さくてよい。 */
const MAX_CACHED_KEYS = 8;

/**
 * 入らないディレクトリ（名前で決める。どの深さでも）。
 *
 * どれも道具が作る木で、利用者の秘匿ファイルの置き場所ではない。そして依存の木は
 * ハードリンクで埋まっていることが多い（pnpm の `node_modules`、uv / pip の `.venv`、
 * cargo の `target`）。歩くと上限（`DEFAULT_MAX_WALK_ENTRIES`）を食い、上限に達すると
 * リンク数が2以上のファイルはすべて閉じる側に倒れる ―― 依存のコードが見せられなくなる。
 *
 * - `.git`: git の内部（オブジェクトは秘匿の名前を持たない）
 * - `node_modules`: npm / pnpm / yarn の依存
 * - `.venv` / `venv`: Python の仮想環境
 * - `target`: cargo（Rust）・Maven のビルド出力
 * - `.tox`: tox の環境
 * - `__pycache__`: Python のバイトコード
 * - `.cache`: 各種道具のキャッシュ
 *
 * 見逃しの形: この名前のディレクトリに置いた秘匿ファイル（`target/.env` など）への
 * ハードリンクは見分けない（名前での判定は今までどおり効く）。
 */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "target",
  ".tox",
  "__pycache__",
  ".cache",
]);

export interface RedactedWalkLimits {
  maxEntries: number;
}

export interface RedactedInodeSet {
  /** `"dev:ino"`（bigint を文字列にしたもの）の集合。 */
  inodes: ReadonlySet<string>;
  /**
   * 最後まで歩けたか。歩く項目数の上限で打ち切ったとき（とルートそのものが読めないとき）
   * だけ false。false の集合に「無い」ことは「秘匿でない」を意味しない。
   * 読めないディレクトリ・調べられない項目は飛ばし、false にはしない（下の説明）。
   */
  complete: boolean;
}

/** 判定に要る実体の情報。`fs.Stats`（bigint でも number でも）がそのまま渡せる。 */
export interface LinkIdentity {
  nlink: number | bigint;
  dev: number | bigint;
  ino: number | bigint;
}

function inodeKey(dev: number | bigint, ino: number | bigint): string {
  // number の ino は 2^53 を超えると丸まり、別の実体と同じ鍵になりうる。
  // 集める側は bigint で取る。number で渡された側は丸まった値しか持たないので、
  // そのまま文字列にする（丸まりは「一致しない」側にしか働かない）。
  return `${BigInt(dev)}:${BigInt(ino)}`;
}

/**
 * ルートから歩いて、秘匿の名前を持つ通常ファイルの実体を集める。
 *
 * シンボリックリンクはたどらない。たどった先はワークスペースの外かもしれず、
 * 外の実体は関門がそもそも読ませない。再帰ではなく明示的なスタックで歩く
 * （深いディレクトリで呼び出しスタックを使い切らないため）。
 */
export function collectRedactedInodes(
  rootPath: string,
  patterns: readonly string[],
  limits: RedactedWalkLimits = { maxEntries: DEFAULT_MAX_WALK_ENTRIES },
): RedactedInodeSet {
  const inodes = new Set<string>();
  let walked = 0;
  // 各要素はルートからの相対パス（"/" 区切り、ルート自体は ""）。
  const stack: string[] = [""];

  try {
    if (!fs.lstatSync(rootPath).isDirectory()) return { inodes, complete: false };
  } catch {
    return { inodes, complete: false };
  }

  while (stack.length > 0) {
    const dirRel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(rootPath, dirRel), { withFileTypes: true });
    } catch {
      // 一覧できないディレクトリは飛ばす（不完全にしない）。閉じる側に倒すと、権限の無い
      // ディレクトリが1つあるだけで、ワークスペースのリンク数2以上のファイルがすべて
      // 拒まれる（pnpm / venv / cargo の依存が見せられなくなる）。見逃すのは「一覧できない
      // ディレクトリの中の秘匿ファイルへの、外に置かれたハードリンク」である。それを張るには
      // その中を辿る権限とファイル名が要り、それはローカルのシェルを既に持っていることを
      // 意味する（repo は git でハードリンクもディレクトリの権限も運べない）。設計はその
      // 脅威を扱わない（シェルを持つ相手は秘匿ファイルを直接読める）。受け入れる見逃し。
      continue;
    }
    for (const entry of entries) {
      walked++;
      if (walked > limits.maxEntries) return { inodes, complete: false };

      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDir && !isFile && !entry.isSymbolicLink() && !isKnownSpecial(entry)) {
        // 種類を返さないファイルシステムがある。そのときだけ lstat で確かめる。
        try {
          const st = fs.lstatSync(path.join(rootPath, rel));
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          // 歩いている間に消えた・調べられない項目は飛ばす（読めないディレクトリと同じ理由）。
          continue;
        }
      }

      if (isDir) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(rel);
        continue;
      }
      if (!isFile || !isRedactedPath(rel, patterns)) continue;
      try {
        const st = fs.lstatSync(path.join(rootPath, rel), { bigint: true });
        inodes.add(inodeKey(st.dev, st.ino));
      } catch {
        // 同上。
      }
    }
  }
  return { inodes, complete: true };
}

function isKnownSpecial(entry: fs.Dirent): boolean {
  return entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice();
}

export interface RedactedLinkIndexOptions {
  ttlMs?: number;
  /** 時計。テストで差し替える。 */
  now?: () => number;
  maxEntries?: number;
  /**
   * 歩いた結果が不完全（上限で打ち切った・ルートが読めない）だったときに呼ぶ。その間、そのルートでは
   * リンク数2以上のファイルがすべて拒まれるので、人間に見える場所（操作ログ）に出すため。
   */
  onIncomplete?: (rootPath: string) => void;
}

/**
 * (ルート, パターン) の組ごとに集めた実体を覚えておく。
 *
 * 要求のたびに歩くと大きなワークスペースで遅い。一方で覚えっぱなしにすると、
 * 後から作られた秘匿ファイルへのリンクを見逃し続ける。有効期間で両者を折り合わせる
 * （期間内に作られたリンクは、期間が過ぎるまで見逃しうる）。
 */
export class RedactedLinkIndex {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly onIncomplete: ((rootPath: string) => void) | undefined;
  private readonly cache = new Map<string, { at: number; set: RedactedInodeSet }>();
  /** 歩いた回数。リンク数1のファイルで歩かないことを検査で確かめるため。 */
  walkCount = 0;

  constructor(options: RedactedLinkIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_REDACTED_INDEX_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_WALK_ENTRIES;
    this.onIncomplete = options.onIncomplete;
  }

  lookup(rootPath: string, patterns: readonly string[]): RedactedInodeSet {
    const key = JSON.stringify([rootPath, ...patterns]);
    const at = this.now();
    const hit = this.cache.get(key);
    if (hit && at - hit.at <= this.ttlMs) {
      // 最近使った順に並べ直す（古い組から捨てるため）。
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.set;
    }
    this.walkCount++;
    const set = collectRedactedInodes(rootPath, patterns, { maxEntries: this.maxEntries });
    if (!set.complete) this.onIncomplete?.(rootPath);
    this.cache.delete(key);
    this.cache.set(key, { at, set });
    while (this.cache.size > MAX_CACHED_KEYS) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return set;
  }
}

/**
 * この実体は秘匿ファイルへのハードリンクか。
 *
 * リンク数が1なら、ほかの名前は無い ―― 名前の判定だけで足りるので歩かない
 * （ほとんどのファイルはここで終わる）。集合が不完全なら「無い」と言い切れないので
 * true（閉じる側）に倒す。
 *
 * 実体の番号（ino）が 0 のときも true に倒す。番号を返さないファイルシステムでは、
 * 別々の実体が同じ `dev:0` になり、見分けられない。Windows（NTFS の番号が stat に
 * どう出るか）では、この判定は確かめていない。
 */
export function isLinkToRedacted(
  index: RedactedLinkIndex,
  rootPath: string,
  stat: LinkIdentity,
  patterns: readonly string[],
): boolean {
  if (BigInt(stat.nlink) <= 1n) return false;
  if (BigInt(stat.ino) === 0n) return true;
  const set = index.lookup(rootPath, patterns);
  if (!set.complete) return true;
  return set.inodes.has(inodeKey(stat.dev, stat.ino));
}
