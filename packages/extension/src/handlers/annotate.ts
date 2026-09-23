import {
  type AnnotationColor,
  type Location,
  MAX_ANNOTATION_BODY_LINES,
  MAX_ANNOTATION_TEXT_CHARS,
  type MarkerLocation,
  type Resolution,
  type ResolutionReason,
  isRedactedPath,
  normalizeWorkspaceRelative,
  resolveLocation,
  sanitizeDisplayText,
} from "@zvx/vscode-showme-protocol";
import type { ShowMeConfig } from "../config.js";
import type { LineRange } from "../line-range.js";
import { type RateLimiter, fileRateLimitKey, sharedFileLimiter } from "../rate-limit.js";
import { readWorkspaceFile } from "../read-workspace-file.js";
import { fileRateLimitCanonicalizer } from "../workspace-path-gate.js";
import type { ShowCodeLog, ShowCodeStatus } from "./show-code.js";
import { type SymbolSurface, prefetchSymbol } from "./symbol-prefetch.js";

/**
 * 注釈を出す面。**`vscode` の値に触るのはこの実装だけ**（`editor-surface.ts`）。
 *
 * `EditorSurface` と同じ理由で切ってある ―― ハンドラが `vscode` を値 import
 * すると vitest から読み込めず、「置換が冪等か」「役割が idle なら拒否されるか」
 * を単体で確かめられない。
 *
 * **`body` は `string` である。** ここが markdown の文字列型を取れる形になった
 * 瞬間に、リモート画像の取得と `command:` リンクがこの経路に戻ってくる
 * （設計書 §3.2.1）。型でそれを閉じておく。
 */
export interface AnnotationSurface {
  /** すべての吹き出しを消す。 */
  clearAll(): void;
  /**
   * 1件出す。`body` は無害化済みのプレーンな文字列。
   *
   * `color` は**閉じた語彙**（設計 D57）。作成者名（`ShowMe 🔴 R`）の表の
   * 鍵の照合にしか使われない。自由文字列にすると、人間の名前や「VS Code」を
   * 名乗る吹き出しが描ける（設計書 §5.4）。省略すると無印（`ShowMe`）。
   *
   * 返すのは `id`（窓内で単調増加）**だけ**。`index` は `indices()` で、全部足した後に読む。
   */
  add(relPath: string, range: LineRange, body: string, color?: AnnotationColor): { id: number };
  /**
   * いま出ている注釈の `id → index`（1始まりの読む順）。**ストアの一覧1回から作る。**
   *
   * `add` が自分の位置を返す形にしない ―― 同じ呼び出しの後続の項目が上限の押し出しを
   * 起こすと、先に読んだ位置は1つずれ、吹き出し（`63/64`）と結果（`index: 64`）が
   * 別の数を言う。番号を決めるのはストアで、読むのは**呼び出しの最後に1回**
   * （順番を決める場所を2つにしない。増分6 §C3 / D71、不変条件14）。
   */
  indices(): ReadonlyMap<number, number>;
}

/** 注釈1件（線上のスキーマ `annotateArgsSchema` と同じ形）。 */
export interface AnnotateItem {
  /** 色を持たない位置（D65'）。色は下の `color` 1つで、作者名と行の塗りの両方に出る。 */
  location: MarkerLocation;
  text: string;
  /** 吹き出しの作成者名と行の塗りに出る色。省略すると無印で、塗らない（設計 D57 / D65）。 */
  color?: AnnotationColor;
}

export type AnnotateMode = "replace" | "add";

/**
 * 引数。`clear` は `items` を持たない（設計 D54）。線上のスキーマ
 * `annotateArgsSchema` の transform が同じ union を出すので、境界での移し替えは
 * 鍵の省略（`exactOptionalPropertyTypes`）だけである。
 */
export type AnnotateArgs = { mode: "clear" } | { items: AnnotateItem[]; mode?: AnnotateMode };

/**
 * `annotate` の項目1つの結果。`show_code` の `Resolution` に、吹き出しが出たときだけ
 * `id` と `index` が付く（増分6 D71。線上の形は `annotateResolutionSchema`）。
 */
export type AnnotateResolution = Resolution & { id?: number; index?: number };

export interface AnnotateDeps {
  config: () => ShowMeConfig;
  annotations: AnnotationSurface;
  log: ShowCodeLog;
  /** 空振り・多重一致・回数制限の可視化。`show_code` と同じ口を使う。 */
  statusBar: ShowCodeStatus;
  workspaceRoot: string | undefined;
  /**
   * 回数制限器。**省略すると `show_code` と同じものを使う**（既定）。
   *
   * ツールごとに別の器を持たせない。持たせると、同じファイルに対する解決試行の
   * 予算が「ツールを変えるだけ」で倍になる ―― `annotate` も `show_code` と
   * まったく同じ解決器を通すので、絞り込みの帯域としては同じものである。
   */
  limiter?: RateLimiter;
  /** シンボルを引く面（`show_code` と同じもの）。省略すると `no-provider`。 */
  symbols?: SymbolSurface;
}

function unresolved(reason: ResolutionReason, normalizedPath?: string): Resolution {
  // exactOptionalPropertyTypes なので、undefined を渡さず鍵ごと省く。
  return normalizedPath === undefined
    ? { resolvedBy: "none", match: "none", reason }
    : { resolvedBy: "none", match: "none", reason, normalizedPath };
}

/** 空振りの表示に使う「何を探したか」。 */
function selectorLabel(loc: Location): string {
  return loc.text ?? loc.symbol ?? "the given lines";
}

/**
 * 行の下に説明の吹き出しを出す（設計書 §3.2）。
 *
 * 返り値にファイルの内容も本文も入れない。位置と解決手段だけを返す
 * 。
 *
 * **`mode: "replace"`（既定）は先に全部消す。** 同じ引数で2回呼んでも
 * 吹き出しが増えないのはこのためで、それが既定である理由でもある。
 * 「1件も解決できなかったときは消さない」にしてはいけない ―― 画面には
 * 古い説明が、新しい呼び出しの結果として残ることになる。
 *
 * **自ツール呼び出しの時計（`OwnToolCallClock`）は刻まない。** あれは
 * 「エージェントがエディタを動かした直後の選択を人間由来と誤認しない」ための
 * ものである。注釈は選択もカーソルも動かさないので、刻むと
 * 「選択 → get_editor_state → annotate → もう一度選択して質問」という
 * 2B の主たる流れが、自分の注釈のせいで毎回待たされることになる。
 */
export async function handleAnnotate(
  args: AnnotateArgs,
  deps: AnnotateDeps,
): Promise<Record<string, unknown>> {
  if (args.mode === "clear") {
    // **消すだけ。** 読むものが無いので回数制限にも数えない。ワークスペースが
    // 無くても消す（下の「置換の約束は果たす」と同じ理由: 古い注釈を固定しない）。
    // 「解決しない位置を渡して replace の副作用で消す」に頼らせないための枝で、
    // `clearAll()` が replace の先頭にあることとは独立に成り立つ。
    deps.annotations.clearAll();
    deps.log.info("annotate clear");
    return { resolutions: [] };
  }

  const root = deps.workspaceRoot;
  const mode: AnnotateMode = args.mode ?? "replace";

  if (root === undefined) {
    deps.log.info("annotate without a workspace folder", { items: String(args.items.length) });
    // ワークスペースが無ければ何も出せないが、**置換の約束は果たす**。
    // 果たさないと、フォルダを閉じた瞬間に古い注釈が固定される。
    if (mode === "replace") deps.annotations.clearAll();
    return { resolutions: args.items.map(() => unresolved("not-found")) };
  }

  const config = deps.config();
  const limiter = deps.limiter ?? sharedFileLimiter;
  const resolutions: AnnotateResolution[] = [];
  /** 出せた項目の `id`（結果の位置 → id）。`index` は最後にまとめて引く。 */
  const addedIds = new Map<number, number>();

  if (mode === "replace") deps.annotations.clearAll();

  // 予算の鍵は関門の口をそのまま注入する（`show_code` と同じもの。
  // 秘匿の綴りに realpath を当てない理由もそちらに書いてある）。
  const canonicalize = fileRateLimitCanonicalizer(root, config.redactedPathPatterns);

  for (const item of args.items) {
    const loc = item.location;
    const normalizedPath = normalizeWorkspaceRelative(loc.path);

    if (!limiter.allow(fileRateLimitKey(loc.path, canonicalize))) {
      deps.log.info("annotate rate limited", { path: loc.path });
      deps.statusBar.flashRateLimited(loc.path);
      resolutions.push(unresolved("rate-limited", normalizedPath));
      continue;
    }

    // シンボルは解決の前に引く（`show_code` と同じ組み立て・同じ面）。
    const prefetched = await prefetchSymbol(loc, {
      symbols: deps.symbols,
      workspaceRoot: root,
      redactedPathPatterns: config.redactedPathPatterns,
    });
    if (prefetched.kind === "unavailable") {
      deps.log.info("annotate", {
        path: loc.path,
        selector: selectorLabel(loc),
        match: "none",
        reason: prefetched.reason,
      });
      deps.statusBar.flashMiss(loc.path, selectorLabel(loc));
      resolutions.push({
        resolvedBy: "symbol",
        match: "none",
        reason: prefetched.reason,
        ...(normalizedPath === undefined ? {} : { normalizedPath }),
      });
      continue;
    }

    const resolution = resolveLocation(loc, {
      isRedacted: (rel) => isRedactedPath(rel, config.redactedPathPatterns),
      readText: (rel) => readWorkspaceFile(root, rel, config.redactedPathPatterns),
      findSymbol: () => (prefetched.kind === "ranges" ? prefetched.ranges : undefined),
    });

    deps.log.info("annotate", {
      path: loc.path,
      selector: selectorLabel(loc),
      match: resolution.match,
      reason: resolution.reason ?? "-",
    });

    // 吹き出しが出ない結果はすべて画面に出す（`show_code` と同じ理由。
    // 無音のオラクルを作らない。設計書 §4.1 ⑥ / §5.4）。
    if (resolution.match === "none") {
      deps.statusBar.flashMiss(loc.path, selectorLabel(loc));
    } else if (resolution.match === "many") {
      deps.statusBar.flashManyMatches(loc.path, selectorLabel(loc));
    }

    if (
      resolution.match === "one" &&
      resolution.range !== undefined &&
      resolution.normalizedPath !== undefined
    ) {
      // **本文はここで無害化する。** `string` を選んでも、双方向オーバーライドと
      // 制御文字は `innerText` にそのまま描かれる（設計書 §3.2.1 / §4.4）。
      // 無害化の実装は protocol に1つしかない（不変条件7）。
      //
      // **行き先を渡す。** 吹き出しは複数行を描ける面なので、改行はそのまま
      // 通す（潰すと説明が実質1行になる）。改行を潰すのは行を偽装させない
      // ための規則で、ログではない吹き出しに偽の行を混ぜても意味を持たない
      // ―― 危ないのは双方向オーバーライドと制御文字のほうで、そちらは
      // 行き先によらず可視化される。関数を分けずに引数で言うので、これは
      // 2つ目のサニタイザにならない。
      const body = sanitizeDisplayText(item.text, {
        maxChars: MAX_ANNOTATION_TEXT_CHARS,
        maxLines: MAX_ANNOTATION_BODY_LINES,
      });
      // 色は**そのまま渡す**。ここで既定に倒さない ―― 無印は
      // 「色を持たない固定名」という別の状態であって、既定色ではない。
      const { id } = deps.annotations.add(
        resolution.normalizedPath,
        resolution.range,
        body,
        item.color,
      );
      // 番号が載るのは**出た項目だけ**。出せなかった項目に番号を付けると
      // 「出た」と読める（D71）。`index` はここでは読まない（下）。
      addedIds.set(resolutions.length, id);
      resolutions.push({ ...resolution, id });
      continue;
    }

    resolutions.push(resolution);
  }

  // **`index` は全部足した後に1回で決める。** ループの中で読むと、後続の項目が上限の
  // 押し出しを起こしたときに先に読んだ位置がずれ、吹き出しと結果が別の数を言う
  // （不変条件14: 同じ量を2箇所で決めない）。同じ呼び出しの中で押し出された id
  // （1回の上限 20 では起きないが、起きたら）は一覧に無いので `index` が付かない。
  const indices = deps.annotations.indices();
  for (const [position, id] of addedIds) {
    const index = indices.get(id);
    const resolution = resolutions[position];
    if (index !== undefined && resolution !== undefined) resolution.index = index;
  }

  return { resolutions };
}
