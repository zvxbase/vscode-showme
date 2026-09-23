import * as path from "node:path";

/** 実行時ディレクトリの名前。ブリッジと拡張の両方がこの規則で計算する。 */
export const RUNTIME_DIR_BASENAME = "vscode-showme";

/**
 * 拡張が統合ターミナルに注入し、ブリッジが読む環境変数の名前。
 *
 * 注入する側(拡張)と読む側(ブリッジ)は別プロセスなので、名前が両方に
 * 書かれていると片方だけ直したときに黙って疎通しなくなる。実行時ディレクトリの
 * 計算と同じ理由で、唯一の定義元は protocol に置く。
 *
 * `VSCODE_` 接頭辞は使わない。`sanitizeProcessEnvironment` の削除対象で、
 * いま生き残っているのは適用順序の偶然にすぎない(設計書 Y2)。
 */
export const SOCKET_ENV_VAR = "SHOWME_SOCK";

export interface UidSource {
  getuid?: (() => number) | undefined;
}

/**
 * 実行時ディレクトリの名前に使う uid。
 *
 * `runtimeDirPath` と同じく、**両端が同じ答えを出さないと互いを見つけられない**。
 * Windows には `process.getuid` が無い。`os.userInfo().uid` は -1 を返すが、
 * それを使うと「片方が -1、もう片方が 0」で黙ってすれ違いうるので、
 * 無いときの値もここで1つに決める。
 */
export function processUid(source: UidSource): number {
  return typeof source.getuid === "function" ? source.getuid() : 0;
}

export interface RuntimeDirEnv {
  XDG_RUNTIME_DIR?: string | undefined;
}

/**
 * ソケットと登録ファイルを置くディレクトリを決める。
 *
 * ブリッジと拡張は別プロセスなので、この関数が両者で同じ答えを出すことが
 * 疎通の前提になる（設計書 §3.3 / Y4）。os.tmpdir() は $TMPDIR に従うため、
 * 呼び出し側が tmpdir を渡す形にして、テストで固定できるようにしてある。
 *
 * mkdtemp() は使わない。名前がランダムだとブリッジが登録ファイルを見つけられない。
 * パスは決定的にし、安全性は「開いた fd を fstat して検証する」ことで担保する（設計書 D22）。
 */
export function runtimeDirPath(env: RuntimeDirEnv, tmpdir: string, uid: number): string {
  const xdg = env.XDG_RUNTIME_DIR;
  // path.join / path.isAbsolute は process.platform に束縛されるので POSIX と Windows で
  // 答えが変わるが、これは欠陥ではない。ブリッジと拡張は必ず同じ OS / 同じファイルシステム
  // 名前空間にいる（設計書 §3.4 が唯一の成立条件としてそう定めており、ホスト↔コンテナ／WSL
  // の組み合わせは明示的に非対応）。したがって両者は揃って POSIX 風、または揃って Windows 風
  // の答えを得るので、path のプラットフォーム依存はこの契約に影響しない。
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, RUNTIME_DIR_BASENAME);
  }
  return path.join(tmpdir, `${RUNTIME_DIR_BASENAME}-${uid}`);
}

/**
 * 実行時ディレクトリの候補。**読む側も書く側もこれを使う**（設計書 §2A.6）。
 *
 * 拡張とブリッジで `$XDG_RUNTIME_DIR` が食い違うと、同じマシンにいても別の場所を
 * 探して黙って見つからなくなる（長生きした tmux サーバが古い値を握る、
 * ログアウト後に /run/user/<uid> が消える、など）。
 *
 * **読むだけを両候補にしても片方向しか塞がらない。** ブリッジは自分に
 * `$XDG_RUNTIME_DIR` が無ければ XDG 候補を**構成できない**ので、「拡張に XDG が
 * あり、ブリッジには無い」向きは残る ―― そしてそれが現実的な構成である
 * （デスクトップ／コンテナで起動した VS Code には XDG があり、`docker exec` /
 * `ssh` / `su` で入ったシェルには無い）。だから拡張は**両方の候補に登録ファイルを
 * 書く**。ソケットは1本のままで、複製するのは登録ファイルだけである。
 *
 * 先頭は必ず第一候補（＝ソケットを置く場所）。`$XDG_RUNTIME_DIR` が無い /
 * 相対で信用できないときは第一候補と後退先が同じ場所になるので、1つに畳む
 * （同じディレクトリを2度走査すると、同じ窓の登録が2つに見える）。
 */
export function runtimeDirCandidates(env: RuntimeDirEnv, tmpdir: string, uid: number): string[] {
  const primary = runtimeDirPath(env, tmpdir, uid);
  const fallback = path.join(tmpdir, `${RUNTIME_DIR_BASENAME}-${uid}`);
  return primary === fallback ? [primary] : [primary, fallback];
}
