import type { Location, ResolutionReason } from "@zvx/vscode-showme-protocol";
import type { LineRange } from "../line-range.js";
import { acceptWorkspacePath } from "../workspace-path-gate.js";

/**
 * シンボル一覧を引いた結果。**「引けなかった」と「引けたが名前が無かった」を
 * 潰さない。** 潰すと設計書 §3.4 の表が書けなくなる。
 */
export type SymbolLookup =
  | { kind: "resolved"; ranges: LineRange[] }
  | { kind: "unavailable"; reason: Extract<ResolutionReason, "restricted-mode" | "no-provider"> };

/**
 * シンボルを引く面。**`vscode` の値に触るのはこの実装だけ**（`editor-surface.ts`）。
 *
 * `relPath` は**正準化済み**のワークスペース相対パスを渡す（下の
 * `prefetchSymbol` が正準化する）。生のパスを渡すと、シンボリックリンク経由で
 * ワークスペースの外のファイルを開いて、その中のシンボルの位置を返せてしまう。
 *
 * **引けなかった理由まで面が決める。** ウィンドウが信頼されているかも、その
 * ファイルが何語として開かれたかも、vscode に触らないと分からない環境の事実
 * である。判定そのものは純関数（`symbol-lookup.ts` の `symbolUnavailableReason`）
 * で、面はそれを呼ぶだけ ―― ハンドラ側に信頼の有無を持ち込まないので、
 * 「注釈の描き方が信頼で変わる」経路が型として生まれない。
 */
export interface SymbolSurface {
  lookup(relPath: string, name: string): Promise<SymbolLookup>;
}

/**
 * 解決の**前に**引いておいた結果。
 *
 * `resolveLocation` は純関数（同期）なので、非同期のシンボル検索をその中から
 * 呼べない。呼べるようにするために解決器を非同期にするのではなく、
 * 「引く必要があるときだけ先に引いて、同期の関数として渡す」形にしてある。
 */
export type SymbolPrefetch =
  | { kind: "skip" }
  | { kind: "ranges"; ranges: LineRange[] }
  | { kind: "unavailable"; reason: ResolutionReason };

export interface SymbolPrefetchDeps {
  /** 省略すると引かない（＝`resolveLocation` が `no-provider` を返す）。 */
  symbols?: SymbolSurface | undefined;
  workspaceRoot: string;
  redactedPathPatterns: readonly string[];
}

/**
 * `symbol` 指定のときだけ、解決の前にシンボル一覧を引いておく（設計書 §3.4）。
 *
 * 引かない場合（`skip`）は `resolveLocation` がいつも通りに判断する ――
 * 除外パスなら `excluded-path`、`text` 指定が優先されるならそちら、
 * 面が繋がっていなければ `no-provider`。
 *
 * **正準化に失敗したパスでは引かない。** 実在しない・ルートの外へ出る場合で、
 * `resolveLocation` はそこで `no-provider` を返す。ここで `not-found` に
 * 分けたくなるが、分けると「そのファイルが実在するか」がエージェントから
 * 読めるようになる ―― `text` 指定が「読めなかった」と「一致が無かった」を
 * どちらも `not-found` に畳んでいるのと同じ理由で、畳んだままにする。
 */
export async function prefetchSymbol(
  loc: Location,
  deps: SymbolPrefetchDeps,
): Promise<SymbolPrefetch> {
  // `text` は `symbol` より優先されるので、引くだけ無駄（かつ文書を開く分だけ遅い）。
  if (loc.text !== undefined || loc.symbol === undefined) return { kind: "skip" };
  const surface = deps.symbols;
  if (surface === undefined) return { kind: "skip" };

  // **共通の関門を通す**（`workspace-path-gate.ts`）。綴りの除外（秘匿パスの
  // 文書を開かせない ―― 開いた時点で、読まないという約束は既に破れている）、
  // realpath による脱出の検出、正準名への除外（`docs/notes.md -> ../.env` の
  // ようなリンク）は、すべて関門の中にある。以前はここに同じ3段を自前で
  // 並べていた（不変条件14。関門に畳んだ）。**ここで書き直さない。**
  const verdict = acceptWorkspacePath(deps.workspaceRoot, loc.path, deps.redactedPathPatterns);
  if (!verdict.ok) return { kind: "skip" };

  const lookup = await surface.lookup(verdict.canonical, loc.symbol);
  if (lookup.kind === "resolved") return { kind: "ranges", ranges: lookup.ranges };
  return { kind: "unavailable", reason: lookup.reason };
}
