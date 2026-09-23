import { isRedactedPath, normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";
import { canonicalizeWorkspacePath } from "./canonical-path.js";

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
 * ## 4つを順に当てる。順序に意味がある
 *
 * 1. `normalizeWorkspaceRelative` ―― 綴りの拒否（`..` / 絶対 / コロン / NUL / 末尾の空白）
 * 2. `isRedactedPath` ―― **綴り**に当てる。秘匿の綴りにはファイルシステムを触らせない
 * 3. `canonicalizeWorkspacePath` ―― **realpath まで辿って**ルート配下を確認
 * 4. `isRedactedPath` ―― **正準化した名前**に当てる
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
  | { ok: true; canonical: string; realPath: string }
  | { ok: false; reason: "invalid-path" | "excluded-path" };

export function acceptWorkspacePath(
  rootPath: string | undefined,
  rawPath: string,
  extraRedactedPatterns: readonly string[],
): WorkspacePathVerdict {
  if (rootPath === undefined) return { ok: false, reason: "invalid-path" };

  const normalized = normalizeWorkspaceRelative(rawPath);
  if (normalized === undefined) return { ok: false, reason: "invalid-path" };

  // **秘匿の綴りには realpath を当てない。** 当てると、存在すれば excluded-path、
  // 無ければ invalid-path と答えが割れ、秘匿ファイルの存在を1本ずつ確かめられる
  // （S1 と同じ形の無音のオラクル）。綴りで落とせば、存在を問わず同じ答えになる。
  // `symbol-prefetch.ts` / `annotate.ts` が既にこの順序で、関門だけが違っていた
  // ―― 同じ境界を別々に書いた4箇所目の、さらに残りである（不変条件14）。
  // 実測: 直す前は `.env`（実在）と `.env.missing`（不在）の
  // reason が実際に割れていた。
  if (isRedactedPath(normalized, extraRedactedPatterns)) {
    return { ok: false, reason: "excluded-path" };
  }

  const canonical = canonicalizeWorkspacePath(rootPath, normalized);
  // 存在しないものも外にあるものも同じ答え。分けると存在が読める。
  if (canonical === undefined) return { ok: false, reason: "invalid-path" };

  // **正準化した名前に当てる。** 綴りに当てると、除外パスを指すリンクが通る。
  if (isRedactedPath(canonical.canonical, extraRedactedPatterns)) {
    return { ok: false, reason: "excluded-path" };
  }

  return { ok: true, canonical: canonical.canonical, realPath: canonical.realPath };
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
  extraRedactedPatterns: readonly string[],
): (rel: string) => string | undefined {
  return (rel) => {
    const verdict = acceptWorkspacePath(rootPath, rel, extraRedactedPatterns);
    return verdict.ok ? verdict.canonical : undefined;
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
