import {
  DEFAULT_PANEL_LIMIT,
  DEFAULT_REDACTED_PATTERNS,
  type Feature,
  type PanelLimit,
  panelLimitSchema,
} from "@zvx/vscode-showme-protocol";
import type * as vscodeTypes from "vscode";
import type { ArrangePermissions } from "./arrange-policy.js";
import type { RedactionPolicy } from "./workspace-path-gate.js";

export interface InspectResult<T> {
  defaultValue?: T | undefined;
  globalValue?: T | undefined;
  workspaceValue?: T | undefined;
  workspaceFolderValue?: T | undefined;
}

/**
 * 安全に関わる設定の値を選ぶ。
 *
 * ワークスペース値を読まない（設計書 §4.6 / D11'）。この道具の主敵は
 * 読ませている OSS そのもので、そこには .vscode/settings.json が入っている。
 * scope: "machine" と restrictedConfigurations の宣言もしてあるが、
 * それらが honor されるかに依存せず、読む場所をコードで固定する。
 */
export function pickTrustedValue<T>(inspected: InspectResult<T> | undefined): T | undefined {
  if (inspected === undefined) return undefined;
  return inspected.globalValue ?? inspected.defaultValue;
}

/**
 * "vscode" モジュールを遅延取得する。
 *
 * "vscode" は拡張ホストの中でしか解決できない特別なモジュールで、vitest
 * のようなプレーンな Node 実行では実体がない。トップレベルで value import
 * すると、pickTrustedValue だけを使うテスト（config.test.ts）の読み込み
 * 自体が「Failed to load url vscode」で失敗する（実測して確認済み）。
 * 呼ばれるまで require しないことで、純粋な pickTrustedValue は vscode
 * に触れずに単体テストできる。esbuild は "vscode" を external にして
 * CJS へビルドするので、この require はそのまま拡張ホストの実行時解決に渡る。
 */
function getVSCode(): typeof vscodeTypes {
  return require("vscode") as typeof vscodeTypes;
}

function trusted<T>(key: string): T | undefined {
  return pickTrustedValue(getVSCode().workspace.getConfiguration().inspect<T>(key));
}

/**
 * 秘匿パスパターンを加算専用でまとめる。
 *
 * 既定リストは常に含み、利用者の追加はそこに「足す」だけ。利用者が
 * 空配列を設定しても（あるいは既定と矛盾する値を入れても）既定リストは
 * 取り除けない。純粋関数として切り出してあるのは、readConfig() 経由だと
 * vscode モジュールが要るため単体テストできないため。
 */
export function mergeRedactedPatterns(extra: readonly string[]): string[] {
  return [...DEFAULT_REDACTED_PATTERNS, ...extra];
}

export interface ShowMeConfig {
  enabled: boolean;
  /**
   * 人間が切れる3機能（増分6 §C4 / D74）。`showme.stage.enabled` /
   * `showme.html.enabled` / `showme.layout.enabled`。どのツールがどの機能に
   * 属するかは protocol の `FEATURE_OF_TOOL` 1つが決め、関門（`tool-gate.ts`）と
   * `list_workspaces.disabledTools` はそこから読む（D75）。
   *
   * **3つとも安全に関わる**（layout は人間のタブに触る、html は webview を出す、
   * stage はタブを開く）ので `trusted()` 以外で読まない（不変条件9）。既定が
   * true なので、ワークスペース値が効くとしたら「人間が global で切ったものを
   * 読ませている OSS が戻す」向きである ―― 読まないので戻せない。
   */
  features: Record<Feature, boolean>;
  /**
   * `show_code` / `show_note` / `show_html` が開く列。鍵は `showme.stage.editorGroup`（D74 で
   * `showme.editorGroup` から移った。`shared` は D93）。**どの列に開くか**を決める量なので
   * `trusted()` 以外で読まない（不変条件9）。人間の列を使うかの判断は `human-column.ts` の
   * `useHumanColumnFor` 1つ ―― ここは値を運ぶだけ。
   */
  editorGroup: EditorGroup;
  /**
   * 舞台を映しの URI（`showme-ro:` / `showme-rw:`）で開くかどうか（D84・D86）。
   *
   * `agentTabs` は `showme.stage.agentTabs`（既定 `true`。`false` で従来の D53 の `file:` タブに
   * 戻る）、`editable` は `showme.stage.editable`（既定 `false`）。**どちらもタブを開く／
   * 保存を本物のファイルに書く**という安全に関わる量なので `trusted()` 以外で読まない
   * （不変条件9）。スキームを実際に決める分岐は `stage-uri.ts` の `effectiveStageScheme` 1箇所
   * ―― ここでは値を運ぶだけで判断しない。
   */
  stageTabs: { agentTabs: boolean; editable: boolean };
  /**
   * `showme.stage.avoidToolColumns`（D90。既定 `false`）。`true` なら、表示中のタブがターミナル・
   * 他の拡張のパネル・型の分からない入力である列に舞台を置かず、置ける列が無ければ
   * `no-stage-column` で断る。**どの列に開くか**を決める量なので `trusted()` 以外で読まない
   * （不変条件9）。判断は `stage-column.ts` の `placeStageColumn` 1つ ―― ここは値を運ぶだけ。
   * `editorGroup: "active"` のときは効かない（その設定は人間の列を使う）。
   */
  avoidToolColumns: boolean;
  /**
   * 人間がエージェントのタブで Ctrl+クリック / F12 したとき、**別のファイル**の名前の行き先（D88）。
   * `showme.stage.definitionTarget`（既定 `"file"`）。同じファイルの中は設定に依らず映しのまま
   * （TS が映しの上で答える。`stage-language.ts`）。人間の画面のどのタブが開くかを決める量なので
   * `trusted()` 以外で読まない（不変条件9）。
   */
  definitionTarget: DefinitionTarget;
  /**
   * `show_html` のパネル（増分6.2 D80）。`maxPanels` は `showme.html.maxPanels`
   * （設定は整数 0〜999、`0` が無制限。既定 2。線上の `number | "unlimited"` に畳むのは
   * `panelLimitOr` 1箇所）。**上限は人間の作業面を守る量**なので
   * `trusted()` 以外で読まない（不変条件9）―― 読ませている OSS の `.vscode/settings.json` が
   * `0` を置いても効かない。`slot` との比較は protocol の `panelSlotAllowed` 1つ
   * （`handlers/show-html.ts` が呼ぶ）で、`list_workspaces.panels.max` は同じ値を写す。
   */
  html: { maxPanels: PanelLimit };
  /**
   * 秘匿の方針（`workspace-path-gate.ts` の `RedactionPolicy`）。`patterns` は既定のパターンに
   * `showme.redactedPathPatterns` を足したもの（加算専用）、`blockLinksToRedacted` は
   * `showme.blockLinksToRedactedFiles`（D91。既定 `true`）。**どちらも秘匿を緩める向きに
   * 動かせる量**なので `trusted()` 以外で読まない（不変条件9）。関門と観測の側に同じ写しを渡す。
   * `allowOutsideWorkspace` は `showme.allowOutsideWorkspace`（D101。既定 `false`）。ワークスペースの
   * 外のファイルを開けるようにする ―― 読ませている OSS の `.vscode/settings.json` がオンにできたら、
   * 仕込んだ指示でホームの秘密を画面に出せる。だから同じく `trusted()` だけで読む。
   */
  redaction: RedactionPolicy;
  maxSelectionChars: number;
  injectTerminalEnv: boolean;
  listAllWorkspaces: boolean;
  /**
   * `arrange_editors` の許可（設計 §7 / D40）。
   *
   * **3つとも既定は false で、`trusted()` 経由で読む**（不変条件9）。
   * `protectViewingTab`（D92）は立てると守りが増える向きだが、読み口は同じにする ――
   * ワークスペースが false に落とせるなら、人間が global で立てた保護を外せてしまう。
   * 新しい読み口を作らない ―― 作った瞬間、ワークスペース値を読む経路が
   * 1つ増える。主敵は読ませている OSS そのもので、そこには
   * `.vscode/settings.json` があり、`closeDirtyTabs: true` を置けたら
   * 人間の未保存が消える。
   */
  layout: ArrangePermissions;
}

/**
 * 設定の値を**型で守る**。
 *
 * `inspect<T>()` は宣言した型を信じて返すだけで、実際の JSON が配列か文字列かは
 * 確かめない。配列の設定に文字列が書かれると、`Array.prototype` を期待する側と
 * `String.prototype`（`includes` など）で動いてしまう側とで**同じ量を2箇所が
 * 別の答えで読む**（不変条件14。かつての `showme.tools.disabled` で実際に起きた形）。
 * 読む場所で型を揃えれば、全員が同じ値を見る。
 * ワークスペースからは来ない（scope: machine）ので安全性の話ではないが、形は同じである。
 */
export function stringArrayOr(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? [...value]
    : [...fallback];
}

/**
 * `showme.stage.editorGroup` の値（D74 / D93）。`shared`（既定）= 右の既存の列を先に、足りなければ
 * 人間の列、それでも足りなければ右端の外。`dedicated` = 人間の列は使わない（D94: 人間のタブが無い
 * 列は除く）。`active` = 常に人間の列（`layout` と枠を見ない）。
 */
export type EditorGroup = "shared" | "dedicated" | "active";

/**
 * 設定が読めない（`undefined`。宣言も無い）ときは宣言の既定と同じ `shared`。**知らない値は
 * `dedicated` に倒す** ―― 既定の `shared` ではなく守る側（人間の列を避ける側）。綴りを間違えた
 * 設定で人間の列が使われる向きにしない。
 */
export function editorGroupOr(value: unknown): EditorGroup {
  if (value === undefined) return "shared";
  return value === "shared" || value === "active" ? value : "dedicated";
}

/** `showme.stage.definitionTarget` の値（D88）。`file` = 本物のファイル、`agentTab` = エージェントのタブ。 */
export type DefinitionTarget = "file" | "agentTab";

/** 知らない値は既定の `"file"` に倒す。 */
export function definitionTargetOr(value: unknown): DefinitionTarget {
  return value === "agentTab" ? "agentTab" : "file";
}

/**
 * `showme.html.maxPanels` の値を型で守る（D80）。
 *
 * 設定は整数1つ（0〜999。設定画面に入力欄を出すため ―― `anyOf` は VS Code の設定 UI が
 * 描けず「settings.json で編集」のリンクになる）。線上の語彙 `number | "unlimited"`
 * （protocol の `panelLimitSchema`。`list_workspaces.panels.max` / `panelSlotAllowed`）に畳むのは
 * **ここ1箇所**: `0` → `"unlimited"`、1〜999 → その数。文字列の `"unlimited"` は宣言が受けない
 * ので壊れた値として扱う。外れた値は `fallback`（既定 2）に倒す ―― `"unlimited"` には倒さない
 * （壊れた設定で上限が消える向きにしない）。
 */
export function panelLimitOr(value: unknown, fallback: PanelLimit): PanelLimit {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value === 0) return "unlimited";
  const parsed = panelLimitSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function readConfig(): ShowMeConfig {
  const extra = stringArrayOr(trusted<unknown>("showme.redactedPathPatterns"), []);
  return {
    enabled: trusted<boolean>("showme.enabled") ?? true,
    features: {
      stage: trusted<boolean>("showme.stage.enabled") ?? true,
      html: trusted<boolean>("showme.html.enabled") ?? true,
      layout: trusted<boolean>("showme.layout.enabled") ?? true,
    },
    editorGroup: editorGroupOr(trusted<unknown>("showme.stage.editorGroup")),
    stageTabs: {
      agentTabs: trusted<boolean>("showme.stage.agentTabs") ?? true,
      editable: trusted<boolean>("showme.stage.editable") ?? false,
    },
    definitionTarget: definitionTargetOr(trusted<unknown>("showme.stage.definitionTarget")),
    avoidToolColumns: trusted<boolean>("showme.stage.avoidToolColumns") ?? false,
    html: {
      maxPanels: panelLimitOr(trusted<unknown>("showme.html.maxPanels"), DEFAULT_PANEL_LIMIT),
    },
    redaction: {
      // 加算専用: 既定リストは設定から取り除けない
      patterns: mergeRedactedPatterns(extra),
      blockLinksToRedacted: trusted<boolean>("showme.blockLinksToRedactedFiles") ?? true,
      // D101: 関門が外の絶対パスを受け入れるか。秘匿の方針と同じ値に載せ、関門の全ての口に
      // 同じ1つを渡す。**真のときだけ**開く（壊れた値・ワークスペースの値では開かない）。
      allowOutsideWorkspace: trusted<unknown>("showme.allowOutsideWorkspace") === true,
    },
    maxSelectionChars: trusted<number>("showme.maxSelectionChars") ?? 4000,
    injectTerminalEnv: trusted<boolean>("showme.injectTerminalEnv") ?? true,
    listAllWorkspaces: trusted<boolean>("showme.listAllWorkspaces") ?? false,
    layout: {
      closeHumanTabs: trusted<boolean>("showme.layout.closeHumanTabs") ?? false,
      closeDirtyTabs: trusted<boolean>("showme.layout.closeDirtyTabs") ?? false,
      protectViewingTab: trusted<boolean>("showme.layout.protectViewingTab") ?? false,
    },
  };
}
