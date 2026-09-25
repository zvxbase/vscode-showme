import {
  type FoundLocation,
  type Location,
  type LocationSearchResult,
  isRedactedPath,
} from "@zvx/vscode-showme-protocol";
import { foldProviderResult } from "../language-lookup.js";

/**
 * `find_definition` / `find_references`（設計 D33）。
 *
 * VS Code が組み込みで持つ言語プロバイダに聞く。**返すのは位置だけ**で、
 * ファイルの中身は返さない（不変条件2）。
 *
 * ## なぜ要るか
 *
 * 未知の OSS を読むときの最頻の問いは「これはどこで定義され、どこから呼ばれるか」である。
 * いまエージェントはこれを grep で答えていて、`handle` や `run` のような名前では
 * **確実に間違える**。説明が嘘になると、体験そのものが壊れる。
 */

/** 位置を引く面。`vscode` に触る実装は `language-surface.ts` にある。 */
export interface LanguageSurface {
  /**
   * エージェントが指定した位置を、ファイル内の1点に解決する。
   *
   * **パスの検証はこの面の中で行う。** 呼び出し側の作法に頼らない ――
   * 頼ると、次に足された呼び出し口が検証を忘れた時点で穴が開く（実際に開いた）。
   * ファイルシステムに触るのはこの面なので、**触る側が決める**（不変条件14）。
   */
  resolveAnchor(location: Location): Promise<AnchorResolution>;
  /** 定義を引く。**引けなかったら `undefined`、引けて0件なら `[]`** */
  definitions(anchor: { path: string; line: number; column: number }): Promise<
    readonly FoundLocation[] | undefined
  >;
  /**
   * 参照を引く。同上。**宣言を含めて返す。**
   *
   * `vscode.executeReferenceProvider` は宣言をいつも含める（3つ目の引数で
   * `includeDeclaration` を渡しても受け取らずに捨てる）。面が守れない引数を面に
   * 持たせない ―― 持たせると、渡すだけで守られたつもりになる（実際にそうなっていた）。
   * 宣言を除くのは `handleFindReferences` の仕事。
   */
  references(anchor: {
    path: string;
    line: number;
    column: number;
  }): Promise<readonly FoundLocation[] | undefined>;
  /** ワークスペースが信頼されているか */
  isTrusted(): boolean;
}

/**
 * アンカーの解決結果。**失敗の理由を持つ。**
 *
 * `undefined` を返す形だと、呼び出し側が「なぜ駄目だったか」を自分で決めることになり、
 * 判断が2箇所に割れる（不変条件14）。理由まで含めて面が返す。
 */
export type AnchorResolution =
  | { ok: true; anchor: { path: string; line: number; column: number } }
  | { ok: false; reason: "invalid-path" | "excluded-path" | "not-found" };

export interface FindLocationsDeps {
  language: LanguageSurface;
  /** 設定で足された除外パターン。`show_code` と同じ表を使う（不変条件14） */
  extraRedactedPatterns: () => readonly string[];
  allowCall?: () => boolean;
  log: { info: (message: string, fields?: Record<string, string>) => void };
}

export interface FindDefinitionArgs {
  location: Location;
}

export interface FindReferencesArgs {
  location: Location;
  includeDeclaration?: boolean;
}

/**
 * 秘匿パスの中の位置を落とす。
 *
 * **落とした本数は返さない。** `get_editor_state` がかつて返していた
 * `openPathsHidden`（増分4 で削除）は「タブが何枚あるか」＝人間の画面の量
 * だったが、ここは「その名前がどこで使われているか」なので、**本数そのものが
 * 情報になる**（`.env` の中でその識別子が何回使われているか、が漏れる）。
 */
function withoutRedacted(
  found: readonly FoundLocation[],
  extraPatterns: readonly string[],
): FoundLocation[] {
  return found.filter((f) => !isRedactedPath(f.path, extraPatterns));
}

async function search(
  location: Location,
  deps: FindLocationsDeps,
  lookup: (anchor: {
    path: string;
    line: number;
    column: number;
  }) => Promise<readonly FoundLocation[] | undefined>,
): Promise<LocationSearchResult> {
  if (deps.allowCall !== undefined && !deps.allowCall()) {
    return { match: "none", locations: [], reason: "rate-limited" };
  }

  // **パスの検証は面の中で行う**（`language-surface.ts`）。ここでは理由を写すだけ。
  //
  // 一度は「呼び出し側が先に検証する」形にしたが、それは**作法**であって
  // 構造ではない ―― 面は依然として生のパスから `Uri` を組めるので、
  // 次に足された呼び出し口が検証を忘れた時点で穴が開く。
  // ファイルシステムに触るのは面なので、**触る側が決める**（不変条件14）。
  const resolved = await deps.language.resolveAnchor(location);
  if (!resolved.ok) {
    return { match: "none", locations: [], reason: resolved.reason };
  }
  const found = await lookup(resolved.anchor);
  return foldProviderResult(
    found === undefined ? undefined : withoutRedacted(found, deps.extraRedactedPatterns()),
    { isTrusted: deps.language.isTrusted() },
  );
}

export async function handleFindDefinition(
  args: FindDefinitionArgs,
  deps: FindLocationsDeps,
): Promise<LocationSearchResult> {
  const result = await search(args.location, deps, (anchor) => deps.language.definitions(anchor));
  deps.log.info("find_definition", { match: result.match });
  return result;
}

/**
 * 参照から宣言を除く。宣言は「その位置の定義」と同じ位置として見分ける。
 *
 * **定義を引けなければ落とさない。** どれが宣言か分からないまま推測で落とすと、
 * 本物の使用箇所を消しうる。宣言が混ざる方が害が小さい（位置は正しい）。
 */
export function withoutDeclarations(
  references: readonly FoundLocation[],
  declarations: readonly FoundLocation[] | undefined,
): readonly FoundLocation[] {
  if (declarations === undefined) return references;
  const key = (f: FoundLocation) => `${f.path}\u0000${f.line}\u0000${f.column}`;
  const declared = new Set(declarations.map(key));
  return references.filter((r) => !declared.has(key(r)));
}

export async function handleFindReferences(
  args: FindReferencesArgs,
  deps: FindLocationsDeps,
): Promise<LocationSearchResult> {
  const includeDeclaration = args.includeDeclaration ?? false;
  const result = await search(args.location, deps, async (anchor) => {
    const found = await deps.language.references(anchor);
    if (found === undefined || includeDeclaration) return found;
    return withoutDeclarations(found, await deps.language.definitions(anchor));
  });
  deps.log.info("find_references", { match: result.match });
  return result;
}
