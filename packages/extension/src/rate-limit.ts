import { TOOL_NAMES, normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";

/**
 * 同一ファイルへの解決試行のレート制限（設計書 §4.1 ⑦）。
 *
 * 判断ロジックだけを切り出してある（vscode 非依存・時計は注入）。
 * ハンドラ側は vscode を値 import するので vitest から読み込めず、
 * ここに置かないと制限の挙動を単体で確かめられない。
 */

/** 1つの鍵が窓の中で許される試行回数。 */
export const RATE_LIMIT_MAX_HITS = 30;
/** 窓の幅。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** 同時に追跡する鍵の上限。エージェントは鍵を無限に作れるので必要。 */
export const RATE_LIMIT_MAX_KEYS = 512;

/**
 * 正規化できなかったパスをまとめる鍵。
 *
 * 正準キーが無いパス（絶対パス・ルート外・コロンを含む綴りなど）は、
 * 生文字列ごとに別バケットにすると実質無制限になる。1つのバケットに
 * まとめて、そこも同じ予算で縛る。これらの要求は何も読んでいないので
 * オラクルにはならないが、空振りの表示を無限に叩けると人間の画面を
 * 潰せる（可視性そのものが防御なので、そこを守る）。
 *
 * 正規化はコロンを含むパスを必ず拒否するため、この鍵に実在のファイルが
 * 化けることはない — 合法な要求が巻き添えにならない。
 */
export const UNNORMALIZED_PATH_KEY = "unnormalized:path";

/**
 * 正準パスを得られなかったものをまとめる鍵。
 *
 * 実在しない・ルートの外へ出る・秘匿として弾かれた、のいずれか。共通して
 * 「このあと1バイトも読まない」ものなので、1つのバケットで足りる。
 *
 * **綴りごとに分けてはいけない。** 分けると、存在しないパスの綴りを撒くだけで
 * 追跡中の鍵の上限（`RATE_LIMIT_MAX_KEYS`）を埋められ、正当な呼び出しまで
 * `rate-limited` になる（利用者側の DoS）。
 *
 * UNNORMALIZED_PATH_KEY と同じ理由で、実在のファイルがこの鍵に化けることは
 * ない（正準パスはコロンを含めないので綴りが衝突しない）。
 */
export const NO_CANONICAL_PATH_KEY = "no-canonical:path";

/**
 * レート制限の鍵を作る。**予算は「綴り」ごとではなく「ファイル」ごとにする。**
 *
 * 生の `Location.path` を鍵にしてはいけない。`.env` / `./.env` / `.//.env` /
 * `a/../.env` はすべて同じファイルなのに別々のバケットになる。だが
 * `normalizeWorkspaceRelative` で潰せるのは**綴りの違いまで**で、そこまでで
 * 止めると穴が残る:
 *
 *   リポジトリに `s -> .` という自己参照シンボリックリンクを **1本** 置くと、
 *   `s/t.txt` / `s/s/t.txt` / `s/s/s/t.txt` … がすべて別バケットになる。
 *   `path` の上限は 1024 字なので 511 段まで作れ、独立した予算が 511 本取れる
 *   （30回/分 → 15,360回/分）。しかも `RATE_LIMIT_MAX_KEYS` を埋め切ると、
 *   正当な呼び出しまで `rate-limited` になる。
 *
 * 別名を潰せるのは realpath だけなので、**正準パスで鍵を作る**。正準化には
 * I/O が要るので関数として注入する（この関数自体は純関数のまま保つ）。
 * 注入するのは `workspace-path-gate.ts` の `fileRateLimitCanonicalizer` で、
 * 読み出し側（`read-workspace-file.ts`）と同じ関門を通す — 「同じファイルとは
 * 何か」の定義が2つあると、片方だけが別名に騙される。秘匿の綴りに realpath を
 * 当てない理由もそちらにある。
 *
 * 綴りの鍵を安いガードとして併用しない。併用すると、綴りを撒くだけで
 * `RATE_LIMIT_MAX_KEYS` を埋められる経路（上記の DoS）が残ったままになる。
 * 正準化1回分の realpath は、この後に控えている最大 5MB のファイル読み出しと
 * 走査に比べれば無視できる。
 */
export function fileRateLimitKey(
  rawPath: string,
  canonicalize: (rel: string) => string | undefined,
): string {
  const spelled = normalizeWorkspaceRelative(rawPath);
  if (spelled === undefined) return UNNORMALIZED_PATH_KEY;
  return canonicalize(spelled) ?? NO_CANONICAL_PATH_KEY;
}

export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions = {}) {
    this.limit = options.limit ?? RATE_LIMIT_MAX_HITS;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxKeys = options.maxKeys ?? RATE_LIMIT_MAX_KEYS;
    this.now = options.now ?? Date.now;
  }

  allow(key: string): boolean {
    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);

    if (live.length >= this.limit) {
      // 落とした試行は記録しない。拒否のたびに時刻を積むと窓の端が押し出され続け、
      // 一度詰まった鍵が永久に開かなくなる。
      this.hits.set(key, live);
      return false;
    }

    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      this.sweepExpired(now);
      if (this.hits.size >= this.maxKeys) {
        // 生きたバケットを追い出さない。追い出すと、鍵を撒くだけで自分の
        // 予算を初期化できてしまう。代わりに落とす（fail closed）。
        // 落とされた側は "rate-limited" として画面に出るので無音ではない。
        return false;
      }
    }

    live.push(now);
    this.hits.set(key, live);
    return true;
  }

  /**
   * 予算を空にする。**統合テスト専用の口である。**
   *
   * 本番の経路からは呼ばない（呼べる場所も作らない）。統合テストは1つのプロセスで
   * 何十回もツールを呼ぶので、予算が尽きると**攻撃入力がサニタイザに届く前に
   * 制限で弾かれる** ―― そのとき例外は「制限」なのに、検査は「落ちた」と読む。
   * 実際に egress の検査で 41 件中 11 件が届いていなかった。
   */
  clear(): void {
    this.hits.clear();
  }

  /** 追跡中の鍵の数。上限が効いていることをテストから見るために公開する。 */
  trackedKeys(): number {
    return this.hits.size;
  }

  private sweepExpired(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/**
 * ファイル単位の解決試行の予算を、**プロセスで1つ**持つ器。
 *
 * ツールごと・接続ごとに作らない。接続ごとに作ると切って繋ぎ直すだけで予算が
 * 戻り、ツールごとに作るとツールを変えるだけで予算が倍になる。`show_code` も
 * `annotate` も同じ解決器を通す ―― 絞り込みの帯域としては同じものである。
 *
 * 差し替えられるのは検査のためだけで、`extension.ts` は渡さない。
 */
export const sharedFileLimiter = new RateLimiter();

/**
 * `get_editor_state` の**呼び出し単位**の予算（設計書 §3.1.3）。
 *
 * ファイル単位の予算（`sharedFileLimiter`）はこのツールを一度も通らない ――
 * 引数が無く、ファイルを解決しないからである。全体の上限も無かったので、
 * **100ms 間隔で叩けば人間の作業の連続的な軌跡が取れた**（カーソル位置と
 * 可視行は毎回返る）。`already-returned` は直前の1つしか覚えないので歯止めに
 * ならず、一瞬のドラッグ選択も取り逃さない。
 *
 * 鍵はツール名1つ。ファイルではなく**呼び出し**を数える。
 */
export const EDITOR_STATE_MAX_CALLS = 30;
export const EDITOR_STATE_WINDOW_MS = 60_000;

/** 呼び出し単位の予算の鍵。ファイル単位の鍵と混ざらないよう、器そのものを分ける。 */
export const EDITOR_STATE_LIMIT_KEY = "get_editor_state";

/**
 * `get_editor_state` の予算を、**プロセスで1つ**持つ器。
 *
 * `sharedFileLimiter` と器を分ける。同じ器に入れると、ファイルを見せる予算と
 * 人間の画面を読む予算が互いを食い合い、どちらの上限も意味を持たなくなる。
 *
 * 接続ごとに作らない（`sharedFileLimiter` と同じ理由）。切って繋ぎ直すだけで
 * 予算が戻るなら、予算は無いのと同じである。
 */
export const sharedEditorStateLimiter = new RateLimiter({
  limit: EDITOR_STATE_MAX_CALLS,
  windowMs: EDITOR_STATE_WINDOW_MS,
  // 鍵は1つしか使わない。器を分けてあるので、上限も1で足りる。
  maxKeys: 1,
});

/**
 * 図とメモ（2C）の**呼び出し回数**の制限。
 *
 * パネルは枠ごとに1枚を使い回す（上限2）ので窓は増えないが、中身の差し替えは何度でもできる。
 * 上限が無いと、人間の画面をちらつかせ続ける面がそのまま残る。鍵はツール名
 * （`fileRateLimitKey` のようなパスではない） ―― 対象はファイルではなく
 * 「人間の画面を書き換える行為」そのものだからである。
 */
export const PANEL_MAX_CALLS = 30;
export const PANEL_WINDOW_MS = 60_000;

export const panelCallLimiter = new RateLimiter({
  limit: PANEL_MAX_CALLS,
  windowMs: PANEL_WINDOW_MS,
  // **鍵の数はツールの数から導出する。**
  //
  // 以前は `3` と直に書いてあり、コメントも「ツール名3つだけ」と言っていた。
  // ところが増分3で `find_locations` と `show_view` が同じ器に足され、鍵は5つになった。
  // `allow()` は `maxKeys` を超えた**新しい鍵を fail-closed で落とす**ので、
  // 先に3つが使われた窓では、4つ目のツールが自分の予算を1度も使わないまま
  // 拒否される ―― 互いに飢えさせ合う形になっていた。
  //
  // 数を書くと、ツールを足した人がここを直し忘れる。導出すれば直し忘れが起きない。
  maxKeys: TOOL_NAMES.length,
});
