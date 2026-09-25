import * as vscode from "vscode";
import { type StageScheme, isStageScheme, relOfStagePath, stageUriPath } from "./stage-uri.js";

/** `relOfStageUri` / `isAgentStageUri` が読む URI の部品（`vscode.Uri` はこれを満たす）。 */
export type StageUriParts = Pick<vscode.Uri, "scheme" | "authority" | "path">;

/**
 * 映しの URI を組む唯一の場所（`stageUriFor` の映し側と `notifyChanged` が共有する）。
 * authority は持たない（設計 D81）。
 *
 * **`Uri.from` を使う。`Uri.parse` は使わない。** `parse` は文字列を RFC 3986 の URI として
 * 解釈するので、ファイル名に含まれる `%`（パーセントエンコードの開始と誤読される）や
 * `#`（フラグメントの区切りと誤読される）が壊れる ―― 同じ実体が綴りの選び方で2つの URI
 * になり、D82（所有は URI で決まる）が崩れる（`stage-uri.ts` の `stageUriPath` のコメントと
 * 同じ理由）。
 *
 * **`rel` はすでに正規化済みであること（`stageUriPath` と同じ前提）。** ここではもう一度
 * 正規化しない ―― 呼び出し側が `normalizeWorkspaceRelative` を通した後の値を渡す。
 */
export function stageMirrorUri(rel: string, scheme: StageScheme): vscode.Uri {
  return vscode.Uri.from({ scheme, path: stageUriPath(rel) });
}

/**
 * 舞台で開く URI を組む唯一の場所（D84）。
 *
 * `scheme` が `"file"` なら `Uri.joinPath(root, rel)`（今までどおり、人間の実ファイル）。
 * 映しの2つのスキームなら `stageMirrorUri(rel, scheme)`（root は使わない ―― 映しの URI は
 * authority を持たず、window に1つのルートを前提にするので path だけで決まる）。
 *
 * 呼び出し側（`reveal` / `setSpotlight` / `annotations.add` など）は ここだけを通し、
 * `Uri.from` / `Uri.joinPath` を直接組まない（不変条件14: 舞台の URI を決める場所を
 * 2つにしない）。`notifyChanged`（`stage-fs-provider.ts`）は root を持たないので
 * ここを通さず、映しの URI だけを組む `stageMirrorUri` を直接呼ぶ ―― それでも
 * URI を組む場所自体は `stageMirrorUri` 1つのまま増えない。
 *
 * **大文字小文字（設計 D81 の `isCaseSensitive: true`、`stage-registration.ts`）。**
 * ここが作る映しの URI の綴りは、常に `show_code` が受け取った rel（エージェントの綴り）
 * そのものである。人間がエクスプローラ等から大文字小文字を変えて映しの URI を開いても
 * （例えば `showme-ro:/SRC/a.ts`）、それはここが作る URI（`showme-ro:/src/a.ts`）とは
 * 別の綴りなので、`isCaseSensitive: true` の下では別の文書として扱われる。これは意図した
 * 挙動である ―― 大文字小文字だけを変えたタブをエージェントの映しと同一視すると、
 * D82（所有は URI の綴りで決まる）が「どちらの綴りが本物か」を推測する側に戻ってしまう。
 */
export function stageUriFor(
  root: vscode.Uri,
  rel: string,
  scheme: "file" | StageScheme,
): vscode.Uri {
  if (scheme === "file") return vscode.Uri.joinPath(root, rel);
  return stageMirrorUri(rel, scheme);
}

/**
 * 映しの URI → ワークスペース相対パス（D83 の逆関数）。映しでない（スキームが2つの
 * どちらでもない、または別綴り）なら undefined。
 *
 * 判断そのものは `relOfStagePath`（`stage-uri.ts`）1つに集約されている ―― ここは
 * `vscode.Uri` の3つの部分をそこへ渡すだけの薄い層で、綴りの正しさの検査を
 * 二重に持たない（不変条件14）。
 */
export function relOfStageUri(uri: StageUriParts): string | undefined {
  return relOfStagePath(uri.scheme, uri.authority, uri.path);
}

/**
 * その URI がエージェントのタブ（正しい綴りの映し）か（D82 / D89）。
 *
 * **「エージェントのタブか」の判断はここ1つ**（不変条件14）。`isOwnTab` のテキストの枝
 * （所有）と、タブの印（`stage-decoration.ts`）の両方がこれを読む ―― 片方だけ綴りの
 * 検査が緩むと、印の付いたタブが片づけられない・印の無いタブが片づけられる、が起きる。
 * 判定は綴りだけで、実体の有無は見ない（`isOwnTab` のコメントと同じ）。
 */
export function isAgentStageUri(uri: StageUriParts): boolean {
  return isStageScheme(uri.scheme) && relOfStageUri(uri) !== undefined;
}
