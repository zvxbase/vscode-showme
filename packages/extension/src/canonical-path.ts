import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";

export interface CanonicalTarget {
  /**
   * ワークスペースルートからの**正準相対パス**。
   *
   * 綴りが違っても同じ実体なら同じ値になる。`normalizeWorkspaceRelative` が
   * 潰せるのは綴りの違い（`./a` / `a/../a`）までで、シンボリックリンク経由の
   * 別名（`s -> .` に対する `s/a` / `s/s/a` …）は潰せない。それを潰せるのは
   * realpath だけである。
   */
  canonical: string;
  /** realpath を取った実体の絶対パス。読み出しはこちらに対して行う。 */
  realPath: string;
  /**
   * realpath を取ったルートの絶対パス。`canonical` はここからの相対である。
   * 秘匿ファイルの実体を集める走査（`redacted-links.ts`）はこちらから歩く ――
   * 綴りのルートがリンクでも、歩く木と判定した実体が同じ木になる。
   */
  rootRealPath: string;
}

/**
 * ワークスペース相対パスを、実体まで辿った正準相対パスに直す（設計書 §4.1 ⑤）。
 *
 * ルートの外へ出るもの・存在しないもの・正規化を通らないものは undefined。
 * **剥がして通すのではなく fail-closed**。
 *
 * ここが「判定した文字列」と「実際に触る実体」を一致させる唯一の場所なので、
 * 読み出し（`read-workspace-file.ts`）とレート制限の鍵（`rate-limit.ts` の
 * `fileRateLimitKey`）の**両方**がこの関数を通る。別々に持つと、片方だけが
 * 別名に騙される（実際にレート制限だけが騙されていた）。
 *
 * **呼ぶのは `workspace-path-gate.ts` だけ。** 他の面は関門（`acceptWorkspacePath`
 * ほか）を通す。ここを直に呼ぶと除外の判断が関門の外に増える（不変条件14）。
 * `test/workspace-path-gate.test.ts` が `src/` を走査してそれを検査している。
 */
export function canonicalizeWorkspacePath(
  rootPath: string,
  rel: string,
): CanonicalTarget | undefined {
  try {
    // `.native`（D106）。JS の realpathSync は Windows で 8.3 の短い名前（`ENV~1`）を展開せず、
    // 大小もディスクに揃えない ―― 同じ実体が綴りごとに別の正準名になり、秘匿の判定が綴りに
    // 騙される。関門の外の判断・ホームの実体と同じ関数で求める（同じ量を2つの方法で決めない）。
    const rootReal = fs.realpathSync.native(rootPath);
    const targetReal = fs.realpathSync.native(path.join(rootReal, rel));

    const relFromRoot = path.relative(rootReal, targetReal);
    // 空文字列はルート自身。".." そのものと ".." で始まる**セグメント**だけを弾く
    // （"..hidden.txt" のような普通の名前を脱出と誤判定しない）。
    if (relFromRoot.length === 0) return undefined;
    if (path.isAbsolute(relFromRoot)) return undefined;
    if (relFromRoot === ".." || relFromRoot.startsWith(`..${path.sep}`)) return undefined;

    // posix ではバックスラッシュは名前の1文字であって区切りではない。下の正規化はエージェントの
    // 綴り（Windows の流儀）のためにそれを `/` に読み替えるので、実体の名前に当てると正準名が
    // 別の実体を名指す（`credentials\old` が `credentials/old` になって秘匿の規則を外れる・
    // `a\b.txt` が別のファイル `a/b.txt` の名前になる）。**実体の名前は読み替えない。断る。**
    if (path.sep === "/" && relFromRoot.includes("\\")) return undefined;
    // 正準化した相対パスで正規化し直す。正規化そのものが通らない綴りも拒否する。
    // 8.3 の短い名前の形（`~` の後に数字）が実体の名前に残っていれば、ここで落ちる（D106。
    // `.native` は展開するので、残るのは展開できなかったか、本当にそういう名前のもの。閉じる側）。
    const canonical = normalizeWorkspaceRelative(relFromRoot);
    if (canonical === undefined) return undefined;
    return { canonical, realPath: targetReal, rootRealPath: rootReal };
  } catch {
    // 辿れない理由をここから外へ出さない。呼び出し側は「正準化できなかった」だけを見る。
    return undefined;
  }
}
