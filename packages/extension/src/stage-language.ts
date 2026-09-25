import * as fs from "node:fs";
import * as vscode from "vscode";
import type { DefinitionTarget } from "./config.js";
import { relativizeToRoot } from "./editor-observation.js";
import { relOfStageUri, stageUriFor } from "./stage-uri-vscode.js";
import {
  STAGE_SCHEME_EDITABLE,
  STAGE_SCHEME_READONLY,
  type StageScheme,
  isStageScheme,
} from "./stage-uri.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/** `vscode.executeDefinitionProvider` / `executeReferenceProvider` が返す1件。 */
export type LocationResult = vscode.Location | vscode.LocationLink;

/**
 * 結果の URI がワークスペースのどこにあるか。
 *
 * - `outside`: ワークスペースの外（型定義の `lib.d.ts` など）か、`file:` でない。写さない
 * - `rejected`: ワークスペースの中だが関門（`acceptWorkspacePath`）に落ちる。返さない
 * - `inside`: 関門を通る。`rel` は結果の綴り（映しの URI を組む）、`canonical` は正準名（同じファイルかの比較）
 */
export type ResultPlace =
  | { readonly kind: "outside" }
  | { readonly kind: "rejected" }
  | { readonly kind: "inside"; readonly rel: string; readonly canonical: string };

/**
 * 結果の `file:` URI → ワークスペースの置き場所を答える関数を作る。関門は `acceptWorkspacePath` 1つ
 * （不変条件14: パスを受け入れるかをここで別に決めない）。
 *
 * **1回の問い合わせにつき1つ作る。** ルートの実体（realpath）は最初に要ったときに1回だけ取り、
 * 答えは結果の URI ごとに覚える（参照は同じファイルの結果が何十件も来る）。問い合わせをまたいで
 * 持ち越さない ―― ルートも秘匿の設定もファイルシステムも、次の問い合わせまでに変わりうる。
 */
export function resultPlacer(
  root: vscode.Uri,
  redactedPatterns: readonly string[],
): (uri: vscode.Uri) => ResultPlace {
  let realRoot: vscode.Uri | null | undefined; // undefined = まだ取っていない、null = 使わない
  const realRootUri = (): vscode.Uri | null => {
    if (realRoot !== undefined) return realRoot;
    realRoot = null;
    if (root.scheme !== "file") return realRoot;
    try {
      const real = fs.realpathSync(root.fsPath);
      if (real !== root.fsPath) realRoot = vscode.Uri.file(real);
    } catch {
      // ルートが読めなければ綴りだけで決める（関門も同じルートで落とす）。
    }
    return realRoot;
  };
  const cache = new Map<string, ResultPlace>();
  return (uri) => {
    const key = uri.toString();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // 綴りのルートで相対にできなければ、ルートの実体でも試す。ルートがリンクのとき、TS は実体の
    // パスで答えうる ―― 綴りだけで比べるとワークスペースの中の結果が `outside` になり、関門を
    // 通らずに返る（秘匿のファイルでも）。実体のルートからの rel は綴りのルートに繋いでも同じ実体を
    // 指すので、関門にはそのまま渡せる。
    let rel = relativizeToRoot(root, uri);
    if (rel === undefined) {
      const real = realRootUri();
      if (real !== null) rel = relativizeToRoot(real, uri);
    }
    let place: ResultPlace;
    if (rel === undefined) place = { kind: "outside" };
    else {
      const verdict = acceptWorkspacePath(root.fsPath, rel, redactedPatterns);
      place = verdict.ok
        ? { kind: "inside", rel, canonical: verdict.canonical }
        : { kind: "rejected" };
    }
    cache.set(key, place);
    return place;
  };
}

/** 1件だけの置き場所（`resultPlacer` を1回使う）。 */
export function placeOfResult(
  root: vscode.Uri,
  uri: vscode.Uri,
  redactedPatterns: readonly string[],
): ResultPlace {
  return resultPlacer(root, redactedPatterns)(uri);
}

export interface MirrorMapping {
  /** 聞いた映しの正準名（関門の `canonical`）。これと同じ実体の結果は返さない。 */
  readonly sourceCanonical: string;
  readonly target: DefinitionTarget;
  /**
   * `agentTab` の写す先のスキーム。**いまの設定で `show_code` が開くのと同じスキーム**
   * （呼び出し側が `stageOpenTarget` で決める。聞いた映しのスキームではない ―― 舞台のスキームを
   * 決める場所を2つにしない。不変条件14）。`"file"`（映しを使わない設定）なら `file:` のまま。
   */
  readonly agentTabScheme: "file" | StageScheme;
  readonly root: vscode.Uri;
  readonly place: (uri: vscode.Uri) => ResultPlace;
}

/**
 * `file:` に聞いた結果を、映しのタブに返す形に写す（設計 D88 / B3）。
 *
 * - **同じファイルの結果は返さない。** TS は映しを単独のファイルとして扱い、同じファイルの中の
 *   定義・参照を映しの URI で既に返している。VS Code は同じ参照は畳むが、同じ定義は畳まない
 *   （2件になり、F12 が飛ばずに覗き見になる。B3 の実測）。同じかどうかは正準名で比べる
 *   （綴りやリンクの違いで2件にしない）
 * - 別のファイルは設定に従う: `file` → `file:` のまま、`agentTab` → いまの設定の舞台のスキームの
 *   URI（`stageUriFor`。映しを使わない設定なら `file:` のまま）
 * - 関門に落ちるパスは返さない（設定に依らず。同じ量を設定で割らない）
 * - ワークスペースの外は `file:` のまま（映しは外を映せない）
 *
 * 範囲は変えない（映しと本物は同じ中身を映す前提）。`showme-ro` では前提が成り立つ（映しは人間の
 * `file:` の未保存の中身を映す）。`showme-rw` では成り立たないことがある: 映しの中身は「ディスク＋
 * エージェントのタブでの未保存の編集」、聞く先の `file:` の文書は人間の未保存の中身でありうる。
 * そのとき**聞く位置（映しの位置をそのまま `file:` に渡す）も返す範囲も**ずれうる。
 */
export function mapMirrorLocations(
  results: readonly LocationResult[],
  m: MirrorMapping,
): LocationResult[] {
  const out: LocationResult[] = [];
  for (const r of results) {
    const isLink = "targetUri" in r;
    const uri = isLink ? r.targetUri : r.uri;
    const p = m.place(uri);
    if (p.kind === "rejected") continue;
    if (p.kind === "outside") {
      out.push(r);
      continue;
    }
    if (p.canonical === m.sourceCanonical) continue;
    if (m.target === "file" || m.agentTabScheme === "file") {
      out.push(r);
      continue;
    }
    const mirror = stageUriFor(m.root, p.rel, m.agentTabScheme);
    out.push(isLink ? { ...r, targetUri: mirror } : new vscode.Location(mirror, r.range));
  }
  return out;
}

/** 1回の問い合わせで使う設定。**1つの設定の写しから作る**（途中で変わっても割れない）。 */
export interface StageLanguageSettings {
  readonly redactedPatterns: readonly string[];
  readonly target: DefinitionTarget;
  /** `MirrorMapping.agentTabScheme` と同じ。 */
  readonly agentTabScheme: "file" | StageScheme;
}

export interface StageLanguageDeps {
  readonly root: () => vscode.Uri | undefined;
  /** 呼ばれるたびに読む（人間が途中で変えたら次の問い合わせから効く）。 */
  readonly settings: () => StageLanguageSettings;
}

/**
 * 映しのスキームの定義・参照プロバイダ（D88）。映しと同じ位置を `file:` に聞いて写す。
 *
 * **再帰しない。** 聞く先は `stageUriFor(root, rel, "file")`（`file:`）で、このプロバイダの
 * セレクタは映しの2つのスキームだけなので、聞いた先でこのプロバイダは呼ばれない。映しの URI
 * には決して聞かない（聞けば自分が呼ばれる）。
 *
 * **細工した映しの URI もここに届く**（どのプロバイダも URI を選べない）ので、聞く前に
 * `relOfStageUri`（正しい綴りか）と `acceptWorkspacePath`（関門）を通す。落ちれば何も返さない。
 *
 * 参照: `executeReferenceProvider` は宣言を常に含める（`context.includeDeclaration` を渡す口が
 * 無い）。人間の画面に出す一覧なので、宣言が混ざっても害は無い。
 */
export class StageLanguageProvider implements vscode.DefinitionProvider, vscode.ReferenceProvider {
  constructor(private readonly deps: StageLanguageDeps) {}

  async provideDefinition(
    document: Pick<vscode.TextDocument, "uri">,
    position: vscode.Position,
  ): Promise<vscode.LocationLink[]> {
    // 定義の戻り値の型は Location の配列か Link の配列のどちらかで、混ぜられない。聞いた先は
    // 混ぜて返しうるので Link に揃える（Location は範囲をそのまま `targetRange` にした Link と同じ）。
    const results = await this.delegate("vscode.executeDefinitionProvider", document.uri, position);
    return results.map((r) => ("targetUri" in r ? r : { targetUri: r.uri, targetRange: r.range }));
  }

  provideReferences(
    document: Pick<vscode.TextDocument, "uri">,
    position: vscode.Position,
  ): Promise<vscode.Location[]> {
    // 参照の結果は Location だけ（Link は来ない）。
    return this.delegate("vscode.executeReferenceProvider", document.uri, position) as Promise<
      vscode.Location[]
    >;
  }

  private async delegate(
    command: "vscode.executeDefinitionProvider" | "vscode.executeReferenceProvider",
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<LocationResult[]> {
    const root = this.deps.root();
    if (root === undefined || !isStageScheme(uri.scheme)) return [];
    const rel = relOfStageUri(uri);
    if (rel === undefined) return [];
    const settings = this.deps.settings();
    const source = acceptWorkspacePath(root.fsPath, rel, settings.redactedPatterns);
    if (!source.ok) return [];
    const fileUri = stageUriFor(root, rel, "file");
    let results: LocationResult[] | undefined;
    try {
      results = await vscode.commands.executeCommand<LocationResult[]>(command, fileUri, position);
    } catch {
      // 聞いた先の失敗（文書が開けない等）は人間の画面の補助が出ないだけ。映しの TS の答えは残る。
      return [];
    }
    return mapMirrorLocations(results ?? [], {
      sourceCanonical: source.canonical,
      target: settings.target,
      agentTabScheme: settings.agentTabScheme,
      root,
      place: resultPlacer(root, settings.redactedPatterns),
    });
  }
}

/**
 * 映しの2つのスキームに定義・参照プロバイダを登録する。activate で1回呼ぶ。
 *
 * **窓を預けていなくても登録する**（映しの FS・印と同じ: 復元された映しのタブでも効く）。
 * 返す `provider` は統合テストの口が同じインスタンスを呼ぶためのもの。
 */
export function registerStageLanguage(deps: StageLanguageDeps): {
  provider: StageLanguageProvider;
  register: () => vscode.Disposable;
} {
  const provider = new StageLanguageProvider(deps);
  const selector: vscode.DocumentSelector = [
    { scheme: STAGE_SCHEME_READONLY },
    { scheme: STAGE_SCHEME_EDITABLE },
  ];
  const register = (): vscode.Disposable =>
    vscode.Disposable.from(
      vscode.languages.registerDefinitionProvider(selector, provider),
      vscode.languages.registerReferenceProvider(selector, provider),
    );
  return { provider, register };
}
