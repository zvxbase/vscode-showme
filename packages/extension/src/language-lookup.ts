import {
  type FoundLocation,
  type LocationSearchResult,
  MAX_FOUND_LOCATIONS,
  type ResolutionReason,
} from "@zvx/vscode-showme-protocol";

/**
 * 言語サーバの答えを、線に載せる結果に畳む。**`vscode` 非依存の純関数。**
 *
 * `symbol-lookup.ts` と同じ作法 ―― I/O は呼び出し側が持ち、ここには判断だけを置く。
 * こうしないと「プロバイダ不在と制限モードを取り違えていないか」を単体で確かめられない。
 */

/** 畳むときに要る、その窓とファイルの状況。 */
export interface LookupContext {
  /** ワークスペースが信頼されているか。制限モードでは言語プロバイダが動かないことがある */
  isTrusted: boolean;
}

/**
 * プロバイダの答えを結果に畳む。
 *
 * **`undefined` と空配列を区別する。** VS Code は「プロバイダが無い」も
 * 「1件も無い」も曖昧に返しうるので、呼び出し側が
 * 「引けなかった」= `undefined` / 「引けたが0件」= `[]` に正規化してから渡すこと。
 *
 * - `undefined`（引けなかった）→ 制限モードなら `restricted-mode`、そうでなければ `no-provider`
 * - `[]`（引けたが0件）→ `not-found`。**一覧が取れたときにしか名乗れない**（設計書 §3.4）
 */
export function foldProviderResult(
  found: readonly FoundLocation[] | undefined,
  context: LookupContext,
): LocationSearchResult {
  if (found === undefined) {
    // **どちらの理由かでエージェントの次の手が変わる。** 制限モードなら
    // 人間に信頼を求めればよいが、プロバイダ不在なら待っても無駄である。
    const reason: ResolutionReason = context.isTrusted ? "no-provider" : "restricted-mode";
    return { match: "none", locations: [], reason };
  }
  if (found.length === 0) {
    return { match: "none", locations: [], reason: "not-found" };
  }
  // **正確な件数は返さない。** 上限で切るが、切ったことも切った数も言わない
  // （言えば件数を復元できる。設計書 S1「正確な件数は無音のオラクル」）。
  return {
    match: found.length === 1 ? "one" : "many",
    locations: found.slice(0, MAX_FOUND_LOCATIONS).map((f) => ({ ...f })),
  };
}

/**
 * 外の結果（D102）の名前。結果が**錨（エージェントが指したファイル）の実体**と同じなら、エージェントが
 * 渡した綴りで返す ―― 錨を `/x/alias.ts -> /x/real/b.ts` のリンクの綴りで指したとき、同じファイルの
 * 定義・参照を実体の綴り（`/x/real/b.ts`）で返すと、リンクの指す先が結果から読める
 * （`show_code` の `normalizedPath` が realpath を返さないのと同じ理由）。
 *
 * - `realPath`: 関門が受け入れた結果の実体
 * - `spelled`: 結果の URI の綴り（言語サーバが返したもの）を正規化した名前
 * - `anchors`: 錨の実体 → エージェントの綴り
 */
export function outsideResultName(
  realPath: string,
  spelled: string,
  anchors: ReadonlyMap<string, string>,
): string {
  return anchors.get(realPath) ?? spelled;
}
