import { normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";

/** 映しのスキーム（設計 D81）。読み取り専用と、編集できるもの。 */
export const STAGE_SCHEME_READONLY = "showme-ro";
export const STAGE_SCHEME_EDITABLE = "showme-rw";

export type StageScheme = typeof STAGE_SCHEME_READONLY | typeof STAGE_SCHEME_EDITABLE;

export function isStageScheme(scheme: string): scheme is StageScheme {
  return scheme === STAGE_SCHEME_READONLY || scheme === STAGE_SCHEME_EDITABLE;
}

/**
 * この URI のタブの own を**記録で**決めるか（旧来の D53 の経路）。映しでなければ true。
 *
 * 映し（`showme-ro:` / `showme-rw:`）の own はスキームで決まる（D82）ので、記録しない・
 * 忘れない・記録し直さない。「映しは記録の対象でない」はこの1つで決める ―― `show_code` の
 * 記録（`stageOpenTarget` 経由）、タブが閉じたときの忘却、`arrange_editors` の移動と合流の
 * 記録し直しが、別々に `isStageScheme` を否定して書くと、1箇所だけ向きを誤っても他が緑のままに
 * なる（不変条件14）。
 *
 * これは**スキームの性質**（記録で own を決めうる URI か）であって、「この1回の open を記録するか」
 * ではない。後者は `stageOpenTarget` が、この関数に `realFile`（D87）を重ねて1回だけ決める。
 */
export function isLegacyOwnershipUri(uri: { readonly scheme: string }): boolean {
  return !isStageScheme(uri.scheme);
}

/**
 * 舞台で開くときのスキーム（D84 の分岐の唯一の場所）。
 *
 * `agentTabs` が false なら映しを使わない設定なので、editable の値に関わらず
 * 常に "file"（今までどおりの挙動）。true のときだけ、editable で読み取り専用
 * ／編集できる映しを選ぶ。
 */
export function stageSchemeFor(opts: { agentTabs: boolean; editable: boolean }):
  | "file"
  | StageScheme {
  if (!opts.agentTabs) return "file";
  return opts.editable ? STAGE_SCHEME_EDITABLE : STAGE_SCHEME_READONLY;
}

/**
 * 舞台のスキームを決める**唯一の関数**（D84 の分岐に、印だけ（D76）を合流させる）。
 *
 * `stageFeature` は `showme.stage.enabled` ―― これを切った窓は「印だけ」（舞台の機能自体を
 * 止めた状態）で、`agentTabs` / `editable` の値に関わらず常に `"file"` を返す。映しの
 * FileSystemProvider や own の判定は「舞台を切った窓には映しが無い」ことを前提にできる。
 * それ以外（`stageFeature` が true）は `stageSchemeFor` にそのまま委ねる ―― 分岐をここと
 * `stageSchemeFor` の2箇所に分けない（不変条件14）。
 */
export function effectiveStageScheme(opts: {
  stageFeature: boolean;
  agentTabs: boolean;
  editable: boolean;
}): "file" | StageScheme {
  if (!opts.stageFeature) return "file";
  return stageSchemeFor({ agentTabs: opts.agentTabs, editable: opts.editable });
}

/** `show_code` 1回の開き方: どのスキームで開き、開いた文書を記録するか（`stageOpenTarget`）。 */
export interface StageOpenTarget {
  readonly scheme: "file" | StageScheme;
  /** `Stage.open` が開いた文書を `OpenedByAgent` に記録するか（D53 の own の材料）。 */
  readonly record: boolean;
}

/**
 * `show_code` 1回の開き方を決める**唯一の関数**（D84 の分岐に D87 の `realFile` を合流させる）。
 *
 * - `realFile: true` は本物のファイル（`file:`）を開き、**記録しない**。そのタブは人間のもの
 *   （own にしない ―― エージェントは `close-own` で閉じられない）で、`agentTabs` の値に関わらない。
 *   印だけ（`stageFeature` が false）の窓でも `"file"` で、そもそも何も開かない（D76 のまま）。
 * - それ以外は今までどおり: スキームは `effectiveStageScheme`、記録は `isLegacyOwnershipUri` が
 *   そのスキームに言うとおり（映しは記録しない。`agentTabs: false` の `file:` は記録する ―― D53）。
 *
 * スキームと記録を**同じ1回の呼び出しで**決める。`realFile` の判断をスキームの側と記録の側に
 * 別々に書くと、片方だけ `realFile` を忘れたとき「`file:` で開いたのに own」が生まれる（不変条件14）。
 * `annotate` の `realFile` も同じ関数のスキームを使う（吹き出しは記録と無縁なので `record` は見ない）。
 *
 * **従来の窓（`agentTabs: false`）でタブが使い回される端の場合（両方向）。** 記録の鍵は URI で、
 * `showTextDocument` は同じ列に既にある同じ文書のタブを使い回す。だから:
 * - 記録済みの `file:` タブ（`realFile` なしの `show_code` が開いた）を `realFile` が使い回すと、
 *   記録は残るので own のままである（ここでは記録を消さない ―― 消す判断を足すと2箇所目になる）
 * - `realFile` で開いた `file:` タブを後から `realFile` なしの `show_code` が使い回すと、記録されて
 *   own になる
 * どちらも D53 の今までの振る舞い（URI で記録し、同じ文書のタブが1枚のときだけ own）と同じで、
 * 床（人間が見ているタブ・未保存のタブは閉じない。`arrange-policy.ts` の `mayTouch`）は変わらず守る。
 * 映しの窓（既定）では映しと `file:` は別の URI なので、この使い回しは起きない。
 */
export function stageOpenTarget(opts: {
  stageFeature: boolean;
  agentTabs: boolean;
  editable: boolean;
  realFile: boolean;
}): StageOpenTarget {
  if (opts.realFile) return { scheme: "file", record: false };
  const scheme = effectiveStageScheme(opts);
  return { scheme, record: isLegacyOwnershipUri({ scheme }) };
}

/**
 * ワークスペース相対パス（正規化済み — 呼び出し側が `normalizeWorkspaceRelative`
 * を通した後の値であること。ここではもう一度正規化しない）から、映しの URI の
 * path 部を作る。
 *
 * 映しの URI の path は常に絶対（先頭に "/"）―― `vscode.Uri` の path はそう
 * 扱うのが自然で、`relOfStagePath` 側もそれを前提に1つだけ剥がす。
 *
 * **この結果を vscode.Uri にする唯一の入口は `stage-uri-vscode.ts` の `stageMirrorUri`
 * （内部で `stageUriFor` の映し側からも呼ばれる）。** 呼び出し側がここで直接
 * `vscode.Uri.from` / `vscode.Uri.parse` を組まない。`stageMirrorUri` が `Uri.from` を
 * 使う理由（`parse` は `%` や `#` を誤読し、同じ実体が綴りの選び方で2つの URI になって
 * D82 を崩す）はそちらのコメントを参照。
 */
export function stageUriPath(rel: string): string {
  return `/${rel}`;
}

/**
 * 映しの URI（scheme・authority・path）→ ワークスペース相対パス。
 *
 * 映しでない（scheme が2つのどちらでもない）、authority を持つ、または
 * 正規化できない（脱出・NUL・コロン・末尾スラッシュなど）なら undefined を返す。
 *
 * **authority は常に空文字でなければならない（設計 D81）。** 窓のルートは1つ
 * なので映しの URI は authority を持たない ―― 持たせると
 * `showme-ro://x/.env` と `showme-ro:/.env` が同じファイルの2つの別名になり、
 * D82（所有は URI のスキーム／綴りで決まる）が壊れる（own の判定も
 * `close-own` も、綴りが違う URI を別の文書として扱う）。
 *
 * **先頭の "/" を1つだけ剥がす。** path が "/" で始まっていなければ
 * （映しの URI のはずなのに相対 path が来た＝呼び出し側の誤り）そのまま
 * undefined。2つ目以降の "/" は剥がさない ―― "//etc/passwd" は1つ剥がしても
 * まだ "/etc/passwd" で絶対のままなので、下の `normalizeWorkspaceRelative`
 * が拒む（脱出の一種として扱う）。
 *
 * **末尾が "/" なら undefined。** ファイルパスは "/" で終わらない ――
 * ディレクトリ相当の綴りを許すと、`readDirectory` を空で塞いでいる D81 の
 * 前提（列挙の口にしない）と矛盾する綴りが通ってしまう。生の path の末尾に
 * この検査をかけた後、正規化した rel の末尾にも同じ検査をかけている ―― 例えば
 * "/src/a.ts\\" は生の path では "/" 終わりに見えないが、正規化の結果は
 * "src/a.ts/" になる。**ただし、この後段の検査はもう唯一の防御ではない。**
 * 下の往復の等値検査（`stageUriPath(rel) === path`）も、rel が "/" で終われば
 * `stageUriPath` の結果が "/" 終わりになり、"\\" 終わりの生の path とは一致しない
 * ので、同じ入力を独立に undefined にする。ここに残す明示の検査は二重の防御で、
 * 害はないが、正しさはもう片方（別綴りの拒否、下の段落）にも支えられている。
 *
 * **秘匿（`.env` などを隠すか）の判定はここでしない。** それは関門
 * （`workspace-path-gate.ts` の `acceptWorkspacePath`）の仕事であり、ここは
 * 綴りの正規化だけを持つ。
 *
 * **正しい綴りだけを受ける（不変条件14）。** `/src//a.ts`・`/src/./a.ts`・
 * `/src\a.ts`・`/x/../a.ts` は正規化すると同じ rel になるが、URI としては別の綴りである。
 * 受け入れると同じ実体が2つの URI で開けてしまい、D82（所有は URI の綴りで決まる）が
 * 崩れる ―― own の判定も `close-own` も、綴りが違う URI を別の文書として扱う。
 * だから正規化した rel を `stageUriPath` でもう一度 URI の path に戻し、渡された path と
 * 一致するときだけ返す（一致しなければ別綴り＝undefined）。この検査は以前は
 * `stage-fs-provider.ts` の `relOf` が別に持っていたが、判断は1箇所（不変条件14）に
 * するため、ここへ寄せた（`relOf` はもう持たない）。
 */
export function relOfStagePath(
  scheme: string,
  authority: string,
  path: string,
): string | undefined {
  if (!isStageScheme(scheme)) return undefined;
  if (authority !== "") return undefined;
  if (!path.startsWith("/")) return undefined;
  if (path.endsWith("/")) return undefined;
  const rel = normalizeWorkspaceRelative(path.slice(1));
  if (rel === undefined) return undefined;
  if (rel.endsWith("/")) return undefined;
  return stageUriPath(rel) === path ? rel : undefined;
}
