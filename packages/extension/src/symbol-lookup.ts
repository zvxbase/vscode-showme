import type { ResolutionReason } from "@zvx/vscode-showme-protocol";
import type { LineRange } from "./line-range.js";

/**
 * 文書シンボルの解決に要る判断ロジック（設計書 §3.4）。**vscode 非依存**。
 *
 * ここに置いてあるのは3つで、どれも実機の測定から形が決まっている:
 *
 *   1. 引き直し（`probeDocumentSymbols`）― 1回引いて諦めてはいけない
 *   2. 木を畳んで名前で引く（`collectSymbolRanges`）
 *   3. 引けなかった理由を名指しする（`symbolUnavailableReason`）
 *
 * `editor-surface.ts` がこれらを vscode の API に繋ぐ。ここに vscode を値
 * import すると vitest から読み込めず、**「1回で諦めていないか」を単体で
 * 確かめられなくなる** ―― それは実機でしか判別しない振る舞いになる、という
 * ことである。
 */

/**
 * 引き直しの間隔（ミリ秒）。最初の1回はこの表の**前**に引くので、試行は4回。
 *
 * **1回引いて `undefined` なら「プロバイダが無い」、という実装は嘘をつく。**
 * 実測（Task 0 / 制限モード）で、`.json` のシンボルは1回目の呼び出しでは
 * 返らず2回目で返った。言語拡張がその時点でまだ起動していないためである。
 * VS Code は「プロバイダが無い」と「プロバイダがまだ起きていない」を同じ
 * `undefined` で返すので、区別する手段は**時間を与えること**しかない。
 *
 * 合計の待ちは 1 秒。人間が見ている画面を動かす道具なので、上限は要る。
 */
export const SYMBOL_PROBE_DELAYS_MS: readonly number[] = [200, 300, 500];

/**
 * シンボル一覧を、上限つきで引き直す。
 *
 * **空配列は「まだ起きていない」として扱い、最後まで空なら `undefined` を返す。**
 * `executeDocumentSymbolProvider` は空配列を `undefined` に潰すので実際には
 * 空配列は返らないが、返ったときに「一覧が取れた」と読むと、そこから
 * `not-found`（＝その名前は無い）を名乗ることになる。`not-found` は
 * **一覧が取れたときにしか名乗れない**（設計書 §3.4）ので、空を一覧とは呼ばない。
 */
export async function probeDocumentSymbols<T>(
  probe: () => Promise<readonly T[] | undefined>,
  sleep: (ms: number) => Promise<void>,
  delaysMs: readonly number[] = SYMBOL_PROBE_DELAYS_MS,
): Promise<readonly T[] | undefined> {
  const last = await probeUntilNonEmpty(probe, sleep, delaysMs);
  return last !== undefined && last.length > 0 ? last : undefined;
}

/**
 * 空でない答えが返るまで、上限つきで引き直す。**最後の答えをそのまま返す。**
 *
 * `probeDocumentSymbols` と `language-surface.ts`（定義・参照）が**同じ輪**を使う。
 * 畳み方は違う ―― シンボル一覧は「最後まで空なら起きていない」と読むが、
 * 定義・参照は**本当に無い**ときに `[]` が正当な答えなので、時間を与えた後の
 * `[]` は `not-found` である。畳み方を分けて、**待ち方は1つ**にする（不変条件14）。
 *
 * 実地で、VS Code を再読み込みした直後の1回目の `find_definition` が `not-found` を
 * 返し、数秒後の2回目が当たった。
 * tsserver がプロジェクトを読み込む前は、登録済みのプロバイダが空で応答する。
 * シンボル一覧で既に測っていた挙動と同じ形である。
 */
export async function probeUntilNonEmpty<T>(
  probe: () => Promise<readonly T[] | undefined>,
  sleep: (ms: number) => Promise<void>,
  delaysMs: readonly number[] = SYMBOL_PROBE_DELAYS_MS,
): Promise<readonly T[] | undefined> {
  let last = await probe();
  for (const delay of delaysMs) {
    if (last !== undefined && last.length > 0) return last;
    await sleep(delay);
    last = await probe();
  }
  return last;
}

/** `DocumentSymbol` と `SymbolInformation` の**両方**を受けられる構造的な形。 */
interface RangeLike {
  start?: { line?: unknown };
  end?: { line?: unknown };
}
interface SymbolNodeLike {
  name?: unknown;
  /** `DocumentSymbol` 側。 */
  range?: RangeLike;
  /** `SymbolInformation` 側。 */
  location?: { range?: RangeLike };
  children?: unknown;
}

function lineRangeOf(node: SymbolNodeLike): LineRange | undefined {
  const range = node.range ?? node.location?.range;
  const start = range?.start?.line;
  const end = range?.end?.line;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  // vscode は0始まり、我々は1始まり。
  return { startLine: start + 1, endLine: Math.max(start, end) + 1 };
}

/**
 * シンボルの木を畳んで、名前が一致するものの行範囲を**文書順に**返す。
 *
 * `DocumentSymbol`（入れ子）と `SymbolInformation`（平ら）の両方を受ける。
 * プロバイダによってどちらが返るかが違い、片方しか読まない実装は
 * 「プロバイダはあるのに毎回 not-found」という形で静かに壊れる。
 *
 * 名前は**完全一致**で引く。部分一致にすると `parse` が `parseHeader` に
 * 当たり、エージェントが指していない場所を人間の画面に開くことになる。
 */
export function collectSymbolRanges(nodes: readonly unknown[], name: string): LineRange[] {
  const found: LineRange[] = [];
  const walk = (list: readonly unknown[], depth: number): void => {
    // 深さに上限を置く。プロバイダは他人（言語拡張）の実装で、循環した木を
    // 返さない保証は我々の側には無い。
    if (depth > 32) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const node = item as SymbolNodeLike;
      if (node.name === name) {
        const range = lineRangeOf(node);
        if (range !== undefined) found.push(range);
      }
      if (Array.isArray(node.children)) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return found;
}

/**
 * 制限モードで**シンボルのプロバイダごと落ちる**言語（`languageId`）。
 *
 * 実測 1.137.0: 同梱97拡張のうち `untrustedWorkspaces.supported: false` は
 * `typescript-language-features` / `git` / `terminal-suggest` の3つだけで、
 * そのうち文書シンボルを持つのは TypeScript だけである。JSON / CSS / HTML /
 * Markdown のプロバイダは制限モードでも動く（統合テストで確認済み）。
 */
export const TRUST_DEPENDENT_LANGUAGE_IDS: readonly string[] = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
];

/**
 * 同じことを**拡張子**でも見る。
 *
 * **実測 1.137.0 では、制限モードでも `.ts` の `languageId` は `typescript` の
 * ままだった**（統合テストの `[測定] 制限モードで .ts はどの言語として開かれるか`）。
 * つまり今この綴り側の判定は効いていない ―― 言語 id だけで足りている。
 *
 * それでも残してあるのは、判定材料が**消える向き**だけを塞ぐためである。
 * 無効化された拡張の言語寄与が登録されない構成なら `.ts` は `plaintext` として
 * 開かれ、言語 id だけの判定は**まさに制限モードのときだけ**外れる。外れた側は
 * `no-provider` と名乗る ―― 「制限モードだから引けない」を「プロバイダが無い」と
 * 言い換える誤りで、人間が信頼を与えれば直る問題を、直しようのない問題に見せる。
 */
export const TRUST_DEPENDENT_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export interface SymbolUnavailableContext {
  /** ワークスペース相対パス。 */
  relPath: string;
  /** 開けたときの言語 id。開けなかったときは undefined。 */
  languageId?: string | undefined;
  isTrusted: boolean;
}

/**
 * シンボル一覧が引けなかったとき、その理由を名指しする（設計書 §3.4 の表）。
 *
 * 3分岐は実装できない。`executeDocumentSymbolProvider` は「プロバイダ不在」と
 * 「引けたが空」を同じ `undefined` に潰し、TextMate ベースの代替も無い。
 * 実装できるのはこの2つだけである:
 *
 * | 状況 | reason |
 * |---|---|
 * | 制限モード **かつ** 信頼に依存する言語（実質 TS/JS） | `restricted-mode` |
 * | それ以外 | `no-provider` |
 *
 * `not-found` はここからは返らない。あれは**一覧が取れた**ときにしか名乗れない。
 */
export function symbolUnavailableReason(
  context: SymbolUnavailableContext,
): Extract<ResolutionReason, "restricted-mode" | "no-provider"> {
  if (context.isTrusted) return "no-provider";
  const byLanguage =
    context.languageId !== undefined && TRUST_DEPENDENT_LANGUAGE_IDS.includes(context.languageId);
  const lower = context.relPath.toLowerCase();
  const byExtension = TRUST_DEPENDENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  return byLanguage || byExtension ? "restricted-mode" : "no-provider";
}
