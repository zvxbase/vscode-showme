import * as path from "node:path";
import {
  MAX_HTML_CHARS,
  type PanelLimit,
  type PanelSlot,
  type ShowHtmlArgs,
  normalizeWorkspaceRelative,
  panelSlotAllowed,
  sanitizeHtmlWithReport,
  sanitizeStatusText,
} from "@zvx/vscode-showme-protocol";
import { ToolError } from "../tool-error.js";

/**
 * `show_html`（設計書 §4、D52 / C4）。
 *
 * やることは2つだけ。**無害化して、表示フレームに入れる。**
 *
 * 無害化は `protocol` の `sanitizeHtml` が1つだけ持つ（不変条件7）。ここでは
 * 通し直さないし、ここで別の判定を足さない ―― 足した瞬間に「どこで無害化されたか」
 * が2箇所になり、片方を外したときに気づけなくなる。
 *
 * `path` のときも同じ。**パスの関門は `deps.readFile`（= `readWorkspaceFile`）が持つ。**
 * ここは `string | undefined` だけを見て、綴り・正準化・秘匿・脱出の判断を一切足さない
 * （不変条件14 ―― 新しい入口で書き直すと1段抜ける）。
 */

/** パネルの既定のタイトル。エージェントが渡さなかったときに使う。 */
export const DEFAULT_PANEL_TITLE = "ShowMe";

/** 表示面。`vscode` に触る実装は `webview/panel.ts` にある。 */
export interface PanelSurface {
  showHtml(sanitizedHtml: string, title: string): Promise<void>;
  /**
   * いまあるパネルの中身だけを差し替える。**`reveal` しない**（再描画は保存のたびに
   * 起きるので、そのたびに前面に出すと人間の見ているタブを奪う）。パネルが無ければ何もしない。
   */
  refreshHtml(sanitizedHtml: string): Promise<void>;
  /**
   * `relPath` を見張り、変わるたびに `rerender` を呼ぶ。**判断はしない。**
   * 前の見張りがあれば止める（パネルにつき1つ）。`rerender` が何を描くかは
   * ハンドラの閉包が決める（関門とサニタイザを毎回通る）。
   *
   * 同じ `rerender` が、`move-panel` で作り直したパネルを描き直す正にもなる（* `path` 由来は覚えている HTML ではなく閉包で読み直す）。だから `path` はこれを
   * **必ず** `showHtml` の後に呼ぶ ―― 呼ばないと、作り直しが `showHtml` の写しから描く。
   */
  watch(relPath: string, rerender: () => Promise<void>): void;
  /** 見張りを止める（`html` で出し直したとき、パネルが閉じたとき）。 */
  unwatch(): void;
}

export type { ShowHtmlArgs };

export interface ShowPanelDeps {
  /**
   * 枠（`slot`）ごとの表示面（D61）。**面は自分がどの枠かを知らない** ―― どの枠に出すかは
   * ハンドラが `args.slot` で引く。**要るときに作られる**（`extension.ts` の `Map`）ので、
   * 上限を越えた枠では**呼ばない**（呼ぶと実体が生まれる）。
   */
  panels: (slot: PanelSlot) => PanelSurface;
  /**
   * パネルの上限（増分6.2 D80）。`showme.html.maxPanels` を**呼び出しのたびに**読む
   * （人間が途中で変えたら次の呼び出しから効く。写して持たない）。`slot` との比較は
   * protocol の `panelSlotAllowed` 1つで、**判定する場所は `handleShowHtml` のここ1箇所**。
   * スキーマは上限を知らない（知ると同じ量を2箇所で決める。不変条件14）。
   */
  maxPanels: () => PanelLimit;
  /**
   * ワークスペース相対パスを読む。**関門込み**（`readWorkspaceFile`）。
   * 読めない理由はここから出てこない ―― `undefined` は「無い／秘匿／外／大きすぎる」
   * のどれでもありうるし、ハンドラはそれを区別しない。
   */
  readFile: (rel: string) => string | undefined;
  /** 回数制限。`undefined` なら制限しない（テスト用）。 */
  allowCall?: () => boolean;
  log: { info: (message: string, fields?: Record<string, string>) => void };
}

/**
 * パネルのタイトルを表示に載る形にする。
 *
 * **エージェントが決めた文字列がタブに出る。** 制御文字も双方向オーバーライドも
 * codicon 記法も、ここで潰す（`sanitizeStatusText` が1行の行き先の規則を持つ）。
 */
export function panelTitle(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_PANEL_TITLE;
  const safe = sanitizeStatusText(raw).trim();
  return safe === "" ? DEFAULT_PANEL_TITLE : `${DEFAULT_PANEL_TITLE}: ${safe}`;
}

type Sanitized = { html: string; droppedDeclarations: number };

/**
 * 読んだ中身を描ける形にする。初回も再描画も**この1つ**を通る。
 *
 * 戻りが `undefined` になる理由は2つ（読めない／大きすぎる）だが、再描画の側は
 * どちらでも「描き直さない」で同じなので区別しない。初回だけが理由を分けて投げる
 * ため、`tooLarge` を別に返す。**`readFile` はここで1回しか呼ばない。**
 */
function renderFromFile(
  readFile: ShowPanelDeps["readFile"],
  rel: string,
): { kind: "ok"; sanitized: Sanitized } | { kind: "unreadable" } | { kind: "too-large" } {
  const read = readFile(rel);
  if (read === undefined) return { kind: "unreadable" };
  // 関門の 5 MiB（バイト）の後に、inline と**同じ量を同じ単位で**もう一度切る（3A' の教訓）。
  if (read.length > MAX_HTML_CHARS) return { kind: "too-large" };
  return { kind: "ok", sanitized: sanitizeHtmlWithReport(read) };
}

export async function handleShowHtml(
  args: ShowHtmlArgs,
  deps: ShowPanelDeps,
): Promise<{ shown: true; droppedDeclarations: number }> {
  if (deps.allowCall !== undefined && !deps.allowCall()) {
    throw new ToolError("rate-limited", "Too many show_html calls");
  }

  // **上限の判定はここ1箇所**（D80）。線上のスキーマは整数 1〜999 しか見ていない。
  // 面を引く前・ファイルを読む前に断る ―― 面を引くと上限を越えた枠の実体が生まれ、
  // 読んでから断ると断りの割れ方が存在の口になる。文言は上限を言う（エージェントは
  // `list_workspaces.panels.max` で先に知れるが、人間が途中で変えたときはここで知る）。
  const limit = deps.maxPanels();
  if (!panelSlotAllowed(args.slot, limit)) {
    throw new ToolError(
      "invalid-request",
      `slot ${args.slot} exceeds showme.html.maxPanels (${String(limit)})`,
    );
  }

  // **枠は引数が決めている**（既定 1 はスキーマの transform が畳んだ）。以下、この面だけを触る ――
  // 見張り（C4）も差し替えも枠ごとに独立で、他の枠には何も起きない。
  const panel = deps.panels(args.slot);

  if (args.kind === "html") {
    // ファイルの見張りを、インラインの中身で上書きしたら止める（C4: 差し替えたら前の見張りは止める）。
    panel.unwatch();
    let sanitized: Sanitized;
    try {
      sanitized = sanitizeHtmlWithReport(args.html);
    } catch {
      // `sanitizeHtml` が投げるのは上限超過だけ。**理由の文字列を作り直さない**
      // （入力の断片が戻る経路にしない）。
      throw new ToolError("invalid-request", "HTML is too long");
    }
    await panel.showHtml(sanitized.html, panelTitle(args.title));
    deps.log.info("show_html", {
      source: "html",
      slot: String(args.slot),
      chars: String(sanitized.html.length),
      dropped: String(sanitized.droppedDeclarations),
    });
    // **落とした件数を返す。** これが無いと、エージェントは自分の CSS が
    // 落ちたことに気づけない（実地で `background` が落ちて黒地に黒になった）。
    return { shown: true, droppedDeclarations: sanitized.droppedDeclarations };
  }

  // path。**関門は readFile（readWorkspaceFile）が持つ。ここで判定を足さない。**
  // 読めなかった理由は1つに畳む ―― 「無い」と「秘匿」を分けると存在を問う口になる
  // 。
  const first = renderFromFile(deps.readFile, args.path);
  if (first.kind === "unreadable") throw new ToolError("excluded-path", "That path cannot be read");
  if (first.kind === "too-large") throw new ToolError("invalid-request", "HTML is too long");
  // 既定のタイトルはファイル名。`args.path` はエージェントの生の綴り（`docs\a.html` や
  // `./docs/a.html` でも関門は通る）なので、**表示のためだけに**関門と同じ関数で `/` 区切りに
  // 揃えてから切る。判定ではない（関門はもう通っている。通ったなら正規化も通る）。
  const title = panelTitle(
    args.title ?? path.posix.basename(normalizeWorkspaceRelative(args.path) ?? args.path),
  );
  await panel.showHtml(first.sanitized.html, title);
  // **再描画は関門とサニタイザを通り直す。** 読めなくなったら描き直さず、そのまま
  // （「読めなくなった」を画面にも結果にも出さない）。回数制限には数えない ――
  // これはエージェントの呼び出しではなく、書き手（人間・エージェント・他のプロセス、
  // 誰でも）の保存の速さで有界で、下限は面のデバウンス（150 ms）である。
  // `refreshHtml` であって `showHtml` ではない: 保存のたびにパネルを前面に出さない。
  // 失敗は記録だけして投げない（線に載せる先が無い。中身も理由も外に出さない）。
  panel.watch(args.path, async () => {
    try {
      const next = renderFromFile(deps.readFile, args.path);
      if (next.kind !== "ok") return;
      await panel.refreshHtml(next.sanitized.html);
    } catch {
      deps.log.info("show_html", { source: "path", rerender: "failed" });
    }
  });
  deps.log.info("show_html", {
    source: "path",
    slot: String(args.slot),
    chars: String(first.sanitized.html.length),
    dropped: String(first.sanitized.droppedDeclarations),
  });
  return { shown: true, droppedDeclarations: first.sanitized.droppedDeclarations };
}
