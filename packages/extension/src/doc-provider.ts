/**
 * D98: 設定の案内・撤去手順を、読み取り専用の仮想文書として開くための固定表。
 *
 * 今までは `openTextDocument({ content })` で untitled のバッファを作っていた
 * （題名が "Untitled-1" になり、閉じるときに保存を聞かれる）。かわりに
 * `TextDocumentContentProvider` をスキーム `showme-doc` に登録し、この固定の
 * 2つの URI だけに中身を返す。
 *
 * **このファイルは vscode に依存しない。** URI がどの文書を指すかという
 * 判断だけを持つ純関数なので、単体で確かめられる。
 *
 * URI の path を組む場所（`showMeDocUriPath`）と、URI からどの文書かを読む場所
 * （`showMeDocIdForUri`）は別々の綴りを書かない ―― 開く側（コマンド）とプロバイダが
 * それぞれ "/agent-configuration.md" のような文字列リテラルを持つと、片方だけ
 * 直したときに黙ってずれる（不変条件14）。
 */

/** 仮想文書のスキーム。 */
export const SHOWME_DOC_SCHEME = "showme-doc";

/** この拡張が返す、固定の2つの文書。 */
export type ShowMeDocId = "agent-configuration" | "teardown";

const SHOWME_DOC_IDS: readonly ShowMeDocId[] = ["agent-configuration", "teardown"];

/**
 * id → URI の path 部（先頭 "/" 付き）。
 *
 * 開く側（`vscode.Uri.from({ scheme: SHOWME_DOC_SCHEME, path: showMeDocUriPath(id) })`）と
 * `showMeDocIdForUri` の両方がこの1つを通る。
 */
export function showMeDocUriPath(id: ShowMeDocId): string {
  return `/${id}.md`;
}

/**
 * URI の各部品。`vscode.Uri` はこれを満たす（`editor-observation.ts` の `UriParts` /
 * `stage-uri-vscode.ts` の `StageUriParts` と同じ形の絞り込み）。query と fragment も
 * 見るのは、この仮想文書に「同じ文書に見えて実は別のもの」を作らせないため
 * （D98: プロバイダが返すのはこの2つの固定の文書だけ）。
 */
export interface ShowMeDocUriParts {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

/**
 * この URI がどの固定文書を指すか。**この2つ以外は全部 undefined**。
 *
 * scheme が `showme-doc` で、authority・query・fragment がすべて空で、path が
 * 2つの綴りのどちらかと**完全一致**するときだけ id を返す。他の path
 * （余分な区切り・二重スラッシュを含む）・query・fragment・authority・別の
 * scheme はどれも undefined ―― 呼び出し側（`provideTextDocumentContent`）は
 * undefined を「空文字を返す」に落とすので、ワークスペースのファイルを読む口には
 * ならない。
 */
export function showMeDocIdForUri(uri: ShowMeDocUriParts): ShowMeDocId | undefined {
  if (uri.scheme !== SHOWME_DOC_SCHEME) return undefined;
  if (uri.authority !== "") return undefined;
  if (uri.query !== "") return undefined;
  if (uri.fragment !== "") return undefined;
  return SHOWME_DOC_IDS.find((id) => showMeDocUriPath(id) === uri.path);
}
