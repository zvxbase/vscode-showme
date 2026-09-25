import {
  type Location,
  type Resolution,
  type ResolutionReason,
  isRedactedPath,
  normalizeWorkspaceRelative,
  resolveLocation,
} from "@zvx/vscode-showme-protocol";
import type { ShowMeConfig } from "../config.js";
import { type OwnToolCallClock, sharedOwnToolClock } from "../human-selection.js";
import type { LineRange } from "../line-range.js";
import { type RateLimiter, fileRateLimitKey, sharedFileLimiter } from "../rate-limit.js";
import { readWorkspaceFile } from "../read-workspace-file.js";
import type { StageLayout } from "../stage-column.js";
import { ToolError } from "../tool-error.js";
import { fileRateLimitCanonicalizer } from "../workspace-path-gate.js";
import { type SymbolSurface, prefetchSymbol } from "./symbol-prefetch.js";

export type { LineRange } from "../line-range.js";

/**
 * 舞台のどこに置くか。
 *
 * **列番号ではなく「枠」を渡す。** 実際の列は可視列から毎回導出しなければ
 * ならず（ViewColumn は位置番号なので人間が手前のグループを閉じるとずれる。
 * 設計書 Y7）、そのためには vscode に触る必要がある。ハンドラは vscode を
 * 知らないので、意図（何番目の枠か・分割するか）だけを渡す。
 *
 * `slot` は**開けた位置の数**で進む。0 が舞台の1列目、1 が2列目。
 */
export interface StagePlacement {
  slot: number;
  layout: StageLayout;
}

/**
 * 人間に見せる面。**`vscode` の値に触るのはこの実装だけ**（`editor-surface.ts`）。
 *
 * ハンドラから vscode の値 import を追い出すために切ってある。以前は
 * `show-code.ts` が `vscode.Uri` / `vscode.Range` を直接使っていたので、
 * このファイルは vitest から読み込めず、**ハンドラの単体テストが1件も
 * 書けなかった**。その結果、空振りの可視化（設計書 §5.4 の実装要件）と
 * レート制限を両方壊しても単体・統合とも緑のままだった（実測）。
 */
export interface EditorSurface {
  /** ワークスペース相対パスを人間の画面に開き、行範囲を可視にする。 */
  reveal(relPath: string, range: LineRange, placement: StagePlacement): Promise<void>;
  /**
   * 1回の `show_code` のスポットライトを**窓ごと**に置き換える（増分6 D67）。
   * 前回の呼び出しの分は全部消える。空の Map でも呼ぶ（消すのも置き換えである）。
   */
  setSpotlight(byPath: ReadonlyMap<string, readonly LineRange[]>): void;
}

/**
 * 空振り・多重一致・回数制限を人間に見せる口。
 *
 * `ShowMeStatusBar` が構造的に満たす。ハンドラ側は必要な3つだけを要求する
 * ので、偽物1つで「本当に呼んでいるか」を判別できる。
 */
export interface ShowCodeStatus {
  flashMiss(path: string, needle: string): void;
  flashManyMatches(path: string, needle: string): void;
  flashRateLimited(path: string): void;
  /**
   * `stage` を切っているので開かずに印だけ付けた（増分6 D76）。`line` は1始まり。
   * 人間が自分でその場所を探しに行くための手がかりで、開かない結果を黙らせない
   * ための可視化でもある。
   */
  flashMarked(path: string, line: number): void;
}

/** `ShowMeLog` が構造的に満たす、ハンドラが要る分だけの口。 */
export interface ShowCodeLog {
  info(message: string, fields?: Record<string, string>): void;
}

export interface ShowCodeDeps {
  config: () => ShowMeConfig;
  editor: EditorSurface;
  log: ShowCodeLog;
  statusBar: ShowCodeStatus;
  /**
   * ワークスペースルートのファイルシステムパス。無ければ undefined。
   *
   * `vscode.Uri` ではなく素のパスを受ける。realpath（正準化）も読み出しも
   * ファイルシステムパスに対して行うので、ここで vscode 型を持ち回る理由が無い。
   */
  workspaceRoot: string | undefined;
  /**
   * 回数制限器。**省略すると `annotate` と共有するものを使う**（既定）。
   *
   * 接続もツールもまたいで1つを共有する。接続ごとに作り直すと切って繋ぎ直す
   * だけで予算が戻り、ツールごとに持つとツールを変えるだけで倍になる。鍵は
   * **正準パス**（realpath 後）で作る ―― 理由は `rate-limit.ts` の
   * `fileRateLimitKey` に書いてある。差し替えられるのは検査のためだけで、
   * `extension.ts` は渡さない。
   */
  limiter?: RateLimiter;
  /**
   * シンボルを引く面。**省略すると symbol 指定は `no-provider` になる**。
   *
   * 引く前に正準化と除外判定を通す（`prefetchSymbol`）。
   */
  symbols?: SymbolSurface;
  /**
   * 自ツールがエディタに触った時刻を刻む時計。**省略するとモジュールで1つ
   * 共有するものを使う**（既定）。`get_editor_state` が読む。
   */
  clock?: OwnToolCallClock;
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
 * 人間の画面にファイルを開き、該当箇所を見せる。
 *
 * 返り値にファイルの内容を入れない。位置と解決手段だけを返す
 * 。
 *
 * `args.layout` は**舞台の枠の数**を決める（設計書 §2A.7）。`"split"` なら
 * 2箇所を左右に並べ、`"single"`（既定）なら1列にタブとして重ねる。舞台は
 * 有界であり人間の列を含まない（不変条件10）という枠の中の話で、列の選び方
 * そのものは `chooseStageColumns` が持つ。
 *
 * **枠は昇順に、開けた分だけ進める。** 大きい枠を先に開くと、VS Code は
 * 存在しない列を「必要な分だけ」作るので手前の列に落ち、2列にならない
 * （`clampStageColumn` に逐語）。開けなかった位置で枠を進めないのは、
 * 空振り1件が舞台の1列目を空のまま消費しないようにするため。
 *
 * `config.features.stage` が false なら**開かない**（印だけ。増分6 D76。
 * 本文の `stage` のコメント）。
 */
export async function handleShowCode(
  args: { locations: Location[]; layout?: StageLayout },
  deps: ShowCodeDeps,
): Promise<Record<string, unknown>> {
  // **入口で刻む。** このツールは人間のエディタを動かす道具なので、開けたか
  // どうかに関わらず「触りに来た」ことを記録する。開けたときだけ刻むと、
  // 空振りの直後の窓が無防備になる。
  //
  // 刻むのはエディタを動かすツールだけである。`list_workspaces` のような
  // 読むだけのツールでも刻むと、エージェントの自然な開始手順（まず窓を
  // 確かめてから状態を読む）が毎回この待ちに当たり、「効かないから緩めよう」
  // という圧力になる。緩めた先に穴が開くのは、出所の申告で見たとおりである。
  (deps.clock ?? sharedOwnToolClock).mark();

  const root = deps.workspaceRoot;
  if (root === undefined) {
    deps.log.info("show_code without a workspace folder", {
      locations: String(args.locations.length),
    });
    return { resolutions: args.locations.map(() => unresolved("not-found")) };
  }

  const config = deps.config();
  const layout = args.layout ?? "single";
  /**
   * **`stage` を切ると印だけ**（増分6 §C4 / D76）。設定が縛るのはエージェントで
   * あって人間ではない（§C5）: 位置は解決して返し、塗りはスポットライトに登録する
   * （見えていれば今貼る。見えていなければ人間が開いたときに画家が貼る）が、
   * **開かない・スクロールしない・列を作らない**。`layout` は無視する
   * （列を作るのは開く側の量）。`annotate` と同じ流儀 ―― 印は残るが画面は動かない。
   *
   * 結果の形は設定で変えない（`opened` のような欄を足さない。`list_workspaces` の
   * `features.stage` で分かる）。
   */
  const stage = config.features.stage;
  const limiter = deps.limiter ?? sharedFileLimiter;
  const resolutions: Resolution[] = [];
  /** 次に使う舞台の枠。**実際に開けたときだけ進む。** */
  let slot = 0;
  // 1回の呼び出しの全位置を溜めて、最後に**1つの窓**として渡す（D67）。画家は窓ごとに
  // 置き換えるので、ファイルごとに渡すと後のファイルの分が前のファイルの分を消す。
  const highlightsByPath = new Map<string, LineRange[]>();

  /**
   * 予算を数える単位を決める。**関門の口をそのまま注入する**
   * （`workspace-path-gate.ts` の `fileRateLimitCanonicalizer`。秘匿の綴りに
   * realpath を当てない・秘匿へのリンクに専用の鍵を与えない、はそちらにある）。
   * 以前はここと `annotate.ts` が同じ3段の閉包を別々に持っていた（不変条件14）。
   */
  const canonicalize = fileRateLimitCanonicalizer(root, config.redactedPathPatterns);

  for (const loc of args.locations) {
    // エージェントに返す normalizedPath は**綴りの正規化まで**。正準パスを
    // 返すと、シンボリックリンクの指す先が返り値から読めてしまう。
    const normalizedPath = normalizeWorkspaceRelative(loc.path);

    if (!limiter.allow(fileRateLimitKey(loc.path, canonicalize))) {
      // 落とされた試行も画面に出す。攻撃が進行しているときこそ人間に見えている
      // 必要がある（設計書 §4.1 ⑦・§5.4）。
      deps.log.info("show_code rate limited", { path: loc.path });
      deps.statusBar.flashRateLimited(loc.path);
      resolutions.push(unresolved("rate-limited", normalizedPath));
      continue;
    }

    // シンボルは解決の**前に**引く（`resolveLocation` は同期の純関数なので、
    // 非同期の検索をその中から呼べない）。回数制限の後に置いてあるのは、
    // 制限に当たった要求で文書を開かないようにするためである。
    const prefetched = await prefetchSymbol(loc, {
      symbols: deps.symbols,
      workspaceRoot: root,
      redactedPathPatterns: config.redactedPathPatterns,
    });
    if (prefetched.kind === "unavailable") {
      // **`not-found` はここからは返らない**（設計書 §3.4）。一覧が取れなかった
      // のだから、「その名前が無かった」は名乗れない。
      deps.log.info("show_code", {
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
      // 読み出しは realpath 後のパスにもう一度除外判定を当てる（設計書 §4.1 ⑤）。
      readText: (rel) => readWorkspaceFile(root, rel, config.redactedPathPatterns),
      findSymbol: () => (prefetched.kind === "ranges" ? prefetched.ranges : undefined),
    });

    deps.log.info("show_code", {
      path: loc.path,
      selector: selectorLabel(loc),
      match: resolution.match,
      reason: resolution.reason ?? "-",
    });

    // エディタが開かない結果はすべて画面に出す。無音のオラクルを作らない
    // （設計書 §4.1 ⑥ / §5.4）。判定基準は「0件かどうか」ではなく
    // 「エディタが開くかどうか」である:
    //   one  -> 開いてハイライトされるので、その表示自体が可視化になる
    //   none -> 何も起きない。黙らせると、`.env` に対して探す文字列を変えながら
    //           何百回も問い合わせて内容を絞り込む攻撃が人間に一切見えない
    //   many -> 候補を返すだけで何も起きない。エージェントには情報量のある結果
    //           （「当たったが複数」）なので、none と同じ理由で出す
    if (resolution.match === "none") {
      deps.statusBar.flashMiss(loc.path, selectorLabel(loc));
    } else if (resolution.match === "many") {
      // 候補の行番号は渡さない。ステータスバーの露出面を増やさない。
      deps.statusBar.flashManyMatches(loc.path, selectorLabel(loc));
    }

    if (
      resolution.match === "one" &&
      resolution.range !== undefined &&
      resolution.normalizedPath !== undefined
    ) {
      const rel = resolution.normalizedPath;
      // **列も写す。** 欄を数え上げて写すと、`Resolution` に欄が増えたときに
      // ここで黙って落ちる（実際に落ちていて、文字単位の指定が効かなかった）。
      // **色は解決結果ではなく指定である。** `Resolution` には載せない ――
      // 載せると「解決器が色を決めている」ように読める。指定した本人から写す。
      const color = loc.color;
      const range: LineRange = {
        startLine: resolution.range.startLine,
        endLine: resolution.range.endLine,
        ...(color === undefined ? {} : { color }),
        ...(resolution.range.startColumn !== undefined && resolution.range.endColumn !== undefined
          ? {
              startColumn: resolution.range.startColumn,
              endColumn: resolution.range.endColumn,
            }
          : {}),
      };
      if (stage) {
        try {
          // selection は絶対に触らない（設計書 D8' / S2）。
          // 触ると show_code -> get_editor_state の合成で任意ファイルの生テキストが
          // 取れてしまい、「どのツールもファイルの中身を返さない」が無効になる。
          // それを守るのは EditorSurface の実装側の責務である。
          await deps.editor.reveal(rel, range, { slot, layout });
        } catch (e) {
          // 見せられなかったのに位置を返すと、人間に何の痕跡も残らないまま
          // エージェントだけが位置を得る（＝無音のオラクル）。返さない。
          //
          // 舞台の列が無い（D90。面が `no-stage-column` で断った）ときだけ理由を分ける ――
          // それ以外の失敗は今までどおり `not-found` に畳む（例外の中身を線に載せない）。
          const reason: ResolutionReason =
            e instanceof ToolError && e.code === "no-stage-column"
              ? "no-stage-column"
              : "not-found";
          deps.log.info("show_code failed to open", { path: loc.path, error: String(e) });
          deps.statusBar.flashMiss(loc.path, selectorLabel(loc));
          resolutions.push(unresolved(reason, rel));
          continue;
        }
        // 枠は**実際に開けたときだけ**進む。印だけのときは1つも進まない。
        slot += 1;
      } else {
        // 開かないので、開いたこと自体が可視化になる道は無い。空振り（`flashMiss`）と
        // 同じく、ステータスバーの一瞬の表示が**人間に残る唯一の痕跡**である
        // （無音のオラクルを作らない。設計書 §5.4）。塗りは登録するが、見えていない
        // ファイルの塗りは人間が開くまで画面に出ない。
        deps.statusBar.flashMarked(rel, range.startLine);
      }
      const ranges = highlightsByPath.get(rel) ?? [];
      ranges.push(range);
      highlightsByPath.set(rel, ranges);
    }

    resolutions.push(resolution);
  }

  // **空でも渡す。** スポットライトの寿命は「1回の show_code の分だけ」（§C1）で、
  // 何も解決できなかった呼び出しも前回の指差しを消す ―― 残すと、開けなかった位置の
  // 代わりに前の呼び出しの塗りが「今ここ」に見える。
  deps.editor.setSpotlight(highlightsByPath);

  return { resolutions };
}
