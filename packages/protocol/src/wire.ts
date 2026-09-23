import { z } from "zod";
import { ANNOTATION_COLORS } from "./annotation-color.js";
import { ARRANGE_ACTIONS } from "./arrange-action.js";
import {
  MAX_FOUND_LOCATIONS,
  RESOLUTION_REASONS,
  locationSchema,
  markerLocationSchema,
} from "./location.js";
import { MAX_PANEL_SLOT, panelLimitSchema } from "./panel-limit.js";
import { MAX_HTML_CHARS } from "./sanitize-html.js";
import {
  MAX_OPEN_PATHS,
  MAX_SELECTED_TEXT_CHARS,
  SELECTION_WITHHELD_REASONS,
} from "./selection.js";
import { TOOL_NAMES } from "./tools.js";
import { VIEW_ACTIONS } from "./view-action.js";

/** 線上プロトコルの版。互換性が壊れる変更で上げる。 */
export const WIRE_PROTOCOL_VERSION = 1;

/** トークンは randomBytes(32) の hex なので 64 文字。 */
export const TOKEN_HEX_LENGTH = 64;

export const helloSchema = z
  .object({
    protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
    token: z
      .string()
      .length(TOKEN_HEX_LENGTH)
      .regex(/^[0-9a-f]+$/),
  })
  .strict();
export type Hello = z.infer<typeof helloSchema>;

export const showCodeArgsSchema = z
  .object({
    locations: z
      .array(locationSchema)
      .min(1)
      .max(3)
      .describe("Locations to show. 1 to 3 items; 4 or more are rejected (the stage is bounded)"),
    layout: z
      .enum(["single", "split"])
      .optional()
      .describe(
        "How to lay out the stage. split places the locations side by side in at most 2 columns " +
          '("defined here, used here"); single stacks them as tabs in one column. Default is single. ' +
          "Either way the column the human is using is never used, and the stage never exceeds 2 columns",
      ),
  })
  .strict();

/**
 * 注釈1件の本文の上限。
 *
 * 表示に載せる前の無害化（`sanitizeDisplayText`）にもこの値を渡す。上限が
 * 2箇所にあると、「スキーマは通るが表示では切れる」長さが生まれる。
 */
export const MAX_ANNOTATION_TEXT_CHARS = 2000;

/** 1回で出せる注釈の件数。舞台と同じく、注釈も有界である。 */
export const MAX_ANNOTATION_ITEMS = 20;

/**
 * 同時に出しておける吹き出しの数（窓ごと）。
 *
 * `mode: "add"` は呼ぶたびに足せるので、1回の上限（`MAX_ANNOTATION_ITEMS`）だけでは
 * 注釈は人間の画面を埋めるための無限の面になる。溢れたら拡張が古いものから捨てる。
 *
 * **ここに1つだけ置く。** 拡張のストア（`Annotations.MAX_THREADS`）と、線上の
 * `index` の上限・`get_editor_state.annotations` の件数の上限が同じ量である
 * （不変条件14）。拡張が別の数を持つと、スキーマが通る `index` と実際に出ている
 * 吹き出しの番号が食い違う。
 */
export const MAX_ANNOTATION_THREADS = 64;

/** 注釈1件（線上の形）。拡張のハンドラも同じ形を要求する。 */
export const annotateItemSchema = z
  .object({
    // 色は項目の `color` にだけある。`location.color` は塗らないので落とす（D65'）。
    location: markerLocationSchema,
    text: z
      .string()
      .min(1)
      .max(MAX_ANNOTATION_TEXT_CHARS)
      .describe(
        "The explanation shown in the bubble. **A plain string, not markdown**: " +
          "links, images and bold are not interpreted (design §3.2.1)",
      ),
    color: z
      .enum(ANNOTATION_COLORS)
      .optional()
      .describe(
        "Color of the annotation. Shown in the bubble's author name (e.g. `ShowMe 🔴 R`) " +
          "**and painted on the line** in the same color. Omit for the unmarked `ShowMe` (no paint). " +
          "A subset of the highlight color vocabulary (minus gray)",
      ),
  })
  .strict();

export type AnnotateItem = z.infer<typeof annotateItemSchema>;

export const ANNOTATE_MODES = ["replace", "add", "clear"] as const;

/**
 * `annotate` の引数の**広告面**（tools/list に載る形）。
 *
 * **なぜ union ではなく、この object と下の transform に分かれているか。**
 * 設計 D54 の初稿は `z.union([{ mode: "clear" }, { items, mode? }])` だったが、
 * MCP SDK（1.30）は **`.shape` を持つ ZodObject しか広告できない** ―― union にも
 * `.superRefine()` にも `.shape` が無いので、`tools/list` の `inputSchema` が
 * `{ type: "object", properties: {} }` になる（実測）。呼び出しの検証は通るのに、
 * エージェントからは引数の形も説明も見えなくなる。安全側の検査は全部緑のまま
 * 機能だけが黙って死ぬ、3A / 3A' と同じ向きの壊れ方である。
 *
 * だから形（この object）と規則（`annotateArgsSchema` の transform）を分ける。
 * ブリッジは広告にこの object を使い、検証は `requestSchema` 経由で transform を通す。
 * **規則は transform に1つしか無い**（object 側に `items` の必須性を書かない）。
 */
export const annotateArgsObjectSchema = z
  .object({
    items: z
      .array(annotateItemSchema)
      .min(1)
      .max(MAX_ANNOTATION_ITEMS)
      .optional()
      .describe(
        'Annotations to show. 1 to 20 items. Required for mode: "replace" / "add". **Do not pass** for mode: "clear"' +
          " (passing it is rejected: it would be ambiguous whether to clear or to show)",
      ),
    mode: z
      .enum(ANNOTATE_MODES)
      .optional()
      .describe(
        "replace (default) replaces all annotations in this window (calling again with the same arguments does not add more). " +
          "add appends to the existing annotations. " +
          "clear removes all annotations in this window (do not pass items; the result is { resolutions: [] })",
      ),
  })
  .strict();

/** `annotate` の引数（検証後の形）。`clear` は `items` を持たない。 */
export type AnnotateArgs = { mode: "clear" } | { items: AnnotateItem[]; mode?: "replace" | "add" };

/**
 * `annotate` の引数。**規則はここに1つ**（設計 D54）:
 *
 * - `mode: "clear"` は `items` を取らない（付いていたら意図が曖昧なので落とす）
 * - それ以外は `items` が要る
 *
 * 出力は `AnnotateArgs` の判別可能な union。ハンドラはこの形で `clear` を先頭で分ける。
 */
export const annotateArgsSchema = annotateArgsObjectSchema.transform((args, ctx): AnnotateArgs => {
  if (args.mode === "clear") {
    if (args.items !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message:
          'mode: "clear" does not take items (it would be ambiguous whether to clear or to show)',
      });
      return z.NEVER;
    }
    return { mode: "clear" };
  }
  if (args.items === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: 'items is required (for every mode other than "clear")',
    });
    return z.NEVER;
  }
  // `exactOptionalPropertyTypes` なので、未指定の鍵は省く（undefined を入れない）。
  return args.mode === undefined ? { items: args.items } : { items: args.items, mode: args.mode };
});

/**
 * パネルのタイトル。
 *
 * **表示に載る文字列である。** 無害化（`sanitizeStatusText`）を通してから使うこと ――
 * ここはスキーマの上限だけを持つ。
 */
export const MAX_PANEL_TITLE_CHARS = 60;

/** メモの本文の上限。 */
export const MAX_NOTE_CHARS = 40_000;

/** ワークスペース相対パスの上限。`locationSchema.path` と揃える。 */
const MAX_REL_PATH_CHARS = 1024;

/**
 * `arrange_editors { action: "close-tabs" }` で1回に指せるパスの本数。
 *
 * **ここに1つだけ置く。** 引数の `paths` の上限と、結果の `notOpen` の上限が同じ量である
 * （指した本数より多くは「開いていなかった」と言えない）。`MAX_OPEN_PATHS`（200。
 * `get_editor_state.openPaths` の上限）とは別の量 ―― あちらは「開いているタブ」の観測の
 * 上限で、こちらは「1回の指示」の上限。人間が「これとこれを閉じて」と指す数は多くても
 * 十数本で、50 本を超える指示は `close-own` か `close-other-tabs` の仕事である。
 */
export const MAX_CLOSE_TABS_PATHS = 50;

/**
 * パネルの枠（設計 D61 / §B2 → 増分6.2 D80）。
 *
 * 線上の形は**整数 1〜`MAX_PANEL_SLOT`**（線の健全性）。**何枚まで出せるかはここに無い** ――
 * 上限は人間の設定 `showme.html.maxPanels`（既定 2）が決め、拡張の `handlers/show-html.ts` が
 * `panelSlotAllowed`（`panel-limit.ts`。上限の判定はそこ1つ）で1回判定する。スキーマが上限を
 * 知ると、同じ量を2箇所で決めることになる（不変条件14）。
 * `show_html`（どこに出すか）・`arrange_editors`（`move-panel` でどれを動かすか）・
 * `get_editor_state`（own の webview がどの枠か）の3つが**同じこの1つ**を使う。
 */
export type PanelSlot = number;
/** 既定の枠。`slot` 省略はこれ。**既定に畳むのは `showHtmlArgsSchema` の transform 1箇所**。 */
export const DEFAULT_PANEL_SLOT: PanelSlot = 1;
export const panelSlotSchema = z.number().int().min(1).max(MAX_PANEL_SLOT);

/**
 * `show_html` の引数の**広告面**（tools/list に載る形）。
 *
 * `html | path` の排他は、`annotateArgsObjectSchema` と同じ理由で object＋transform に
 * 分ける（`.refine` / union は `.shape` を持たず、MCP SDK が広告できない ―― 実測）。
 * **規則は transform（`showHtmlArgsSchema`）に1つしか無い。**
 */
export const showHtmlArgsObjectSchema = z
  .object({
    html: z
      .string()
      .min(1)
      .max(MAX_HTML_CHARS)
      .optional()
      .describe(
        "The HTML to display. Mutually exclusive with path. " +
          '**Scripts do not run** (the display surface is an iframe with sandbox=""). ' +
          "script / link / meta / iframe / form / on* attributes, and src/href with any scheme other than data:, " +
          "are dropped. Tables, headings, pre, code, basic SVG shapes, data: images and " +
          "style such as colors pass through",
      ),
    path: z
      .string()
      .min(1)
      .max(MAX_REL_PATH_CHARS)
      .optional()
      .describe(
        "A workspace-relative HTML file. The extension reads and renders it, and " +
          "**re-renders it every time the file is saved** (until the panel closes or is replaced with other content). " +
          "Contents are not returned. To change it, just edit the file (no need to call again). " +
          "Redacted files and files outside the workspace cannot be read. Mutually exclusive with html",
      ),
    title: z
      .string()
      .min(1)
      .max(MAX_PANEL_TITLE_CHARS)
      .optional()
      .describe(
        "Panel title. The panel of a given slot is reused, so this only renames it. " +
          "With path, the default is the file name",
      ),
    slot: panelSlotSchema
      .optional()
      .describe(
        "Which panel to show in (1-based; default 1). " +
          "The human's setting showme.html.maxPanels decides how many exist (default 2; list_workspaces.panels.max tells you). " +
          "A slot above the limit is refused with invalid-request naming the limit. " +
          "Showing again in the same slot replaces its content. " +
          "In get_editor_state, own webviews carry their slot",
      ),
  })
  .strict();

/**
 * `show_html` の引数（検証後の形）。`kind` で判別する。
 * `slot` は**必ず入る**（省略は transform が 1 に畳む。ハンドラで `?? 1` を書き直さない）。
 */
export type ShowHtmlArgs =
  | { kind: "html"; html: string; slot: PanelSlot; title?: string }
  | { kind: "path"; path: string; slot: PanelSlot; title?: string };

/**
 * `show_html` の引数。**規則はここに1つ**（設計 D52）: `html` か `path` のどちらか一方。
 *
 * 両方でも、どちらも無くても落とす。issue は `path` に付ける（意図した理由で落ちたことを
 * テストが指せるように）。
 */
export const showHtmlArgsSchema = showHtmlArgsObjectSchema.transform((args, ctx): ShowHtmlArgs => {
  const hasHtml = args.html !== undefined;
  const hasPath = args.path !== undefined;
  if (hasHtml === hasPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["path"],
      message: "Exactly one of html or path",
    });
    return z.NEVER;
  }
  // `exactOptionalPropertyTypes` なので、未指定の title は鍵ごと省く。
  const title = args.title === undefined ? {} : { title: args.title };
  // `slot` の既定は**ここで1回**畳む（D61）。
  const slot = args.slot ?? DEFAULT_PANEL_SLOT;
  if (args.path !== undefined) return { kind: "path", path: args.path, slot, ...title };
  return { kind: "html", html: args.html as string, slot, ...title };
});

export const showNoteArgsSchema = z
  .object({
    text: z.string().min(1).max(MAX_NOTE_CHARS).describe("Body of the note. A plain string"),
    language: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe("Language ID (markdown / typescript etc.). Default is markdown"),
  })
  .strict();

// `find_*` は色を読まない。色を持つのは `show_code` だけ（D65'）。
export const findDefinitionArgsSchema = z.object({ location: markerLocationSchema }).strict();

export const findReferencesArgsSchema = z
  .object({
    location: markerLocationSchema,
    includeDeclaration: z
      .boolean()
      .optional()
      .describe("Whether to include the declaration itself. Default is false (usages only)"),
  })
  .strict();

export const showViewArgsSchema = z
  .object({
    action: z
      .enum(VIEW_ACTIONS)
      .describe(
        "The screen operation. A **closed vocabulary**; arbitrary VS Code commands cannot be passed",
      ),
    path: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Workspace-relative path, required only for reveal-in-explorer"),
  })
  .strict();

/**
 * `arrange_editors` の引数。**閉じた語彙1語だけ**を受け取る（設計 D42）。
 *
 * ここに `command` のような自由文字列の鍵を足さないこと ―― 足した瞬間に
 * `executeCommand` を線の向こうに開くことになる（`.strict()` なので、
 * いまは未知の鍵ごと落ちる）。
 *
 * **この語彙は「したいこと」であって「してよいこと」ではない。**
 * `close-other-tabs` が実際に人間のタブを閉じるかは、人間側の設定
 * （`showme.layout.closeHumanTabs` / `closeDirtyTabs`）だけが決める。
 *
 * **`requestSchema` の枝と、拡張の dispatch は同じコミットで入る。**
 * `extension.ts` の `handle` は union を網羅する switch なので、枝だけ先に
 * 足すと typecheck が落ちる（＝枝と捌き口は必ず揃う）。**コンパイラが揃えている**。
 *
 * 逆向き ――「広告はしているのに枝が無い」―― はコンパイラが捕まえない。
 * `TOOL_NAMES` に名前を載せた時点でブリッジはその道具を広告するが、枝が
 * 無ければ呼んだ瞬間に拡張の要求解析で落ちる。実際に一度その状態で
 * 出荷寸前まで行っている。`wire.test.ts` の「requestSchema は全ツールを覆う」が
 * その向きを見ている（`RESULT_SCHEMAS` の網羅と同じ形）。
 */
export const arrangeEditorsArgsSchema = z
  .object({
    action: z
      .enum(ARRANGE_ACTIONS)
      .describe(
        "How to arrange the screen. A **closed vocabulary**; VS Code command names are not accepted. " +
          "Whether close-other-tabs / close-tabs actually close the human's tabs is decided by the human's settings " +
          "(showme.layout.closeHumanTabs / closeDirtyTabs). " +
          "close-tabs takes paths and closes only the listed tabs; close-own tidies up your own things",
      ),
    // **`move-tab` には `path` と `toColumn` が要り、`move-panel` には `toColumn` が要り、
    // 他の語にどちらかを付けたら落とす** ―― この規則は**ハンドラが1回**判定して
    // `invalid-request` を返す。ここで transform / refine にしない: transform にすると
    // ZodEffects になって MCP SDK が広告できず、object＋transform に分けると
    // `requestSchema` と拡張が各1回 parse する二重の形になる。
    path: z
      .string()
      .min(1)
      .max(MAX_REL_PATH_CHARS)
      .optional()
      .describe(
        "Only for move-tab. Workspace-relative path of the tab to move. " +
          "**Tabs are addressed by path; they cannot be addressed by title (label)**",
      ),
    toColumn: z
      .number()
      .int()
      .min(1)
      .max(9)
      .optional()
      .describe(
        "Only for move-tab / move-panel. Destination column (1-based). " +
          "Up to the current column count + 1 is accepted (a larger number is invalid-request). " +
          "The column the human is in is refused by default (withheld: [human-column-target])",
      ),
    slot: panelSlotSchema
      .optional()
      .describe(
        "Only for move-panel. Slot of the panel to move (1-based; default 1). " +
          "The same value as the slot carried by own webviews in get_editor_state. " +
          "How many panels exist is the human's setting showme.html.maxPanels (list_workspaces.panels.max tells you); " +
          "a slot with no panel moves nothing (moved: 0)",
      ),
    // `close-tabs` だけが受ける。要否はハンドラが1回判定する（上と同じ）。
    // 空の配列は落とす ―― `paths: []` を「全部」に読ませない。
    paths: z
      .array(z.string().min(1).max(MAX_REL_PATH_CHARS))
      .min(1)
      .max(MAX_CLOSE_TABS_PATHS)
      .optional()
      .describe(
        "Only for close-tabs. Workspace-relative paths of the tabs to close (1-50). " +
          "Tabs without a path (terminals, panels) cannot be addressed and are never closed by this action; " +
          "use close-own for your own panels",
      ),
  })
  .strict();

export const listWorkspacesArgsSchema = z.object({}).strict();

export const getEditorStateArgsSchema = z.object({}).strict();

export const requestSchema = z.discriminatedUnion("tool", [
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("show_code"),
      args: showCodeArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("list_workspaces"),
      args: listWorkspacesArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("get_editor_state"),
      args: getEditorStateArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("annotate"),
      args: annotateArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("show_html"),
      args: showHtmlArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("show_note"),
      args: showNoteArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("find_definition"),
      args: findDefinitionArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("find_references"),
      args: findReferencesArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("show_view"),
      args: showViewArgsSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      tool: z.literal("arrange_editors"),
      args: arrangeEditorsArgsSchema,
    })
    .strict(),
]);
export type WireRequest = z.infer<typeof requestSchema>;
/**
 * **線に乗る形**（transform 前 = 広告面の形）。
 *
 * `WireRequest` は `requestSchema` の**出力**（`show_html` なら `{ kind, slot }` 入り）で、
 * これは各側が parse した**後**にだけ存在する。線に書くのは入力の形であって出力ではない
 * ―― 出力を線に書くと、向こう側の `.strict()` が `kind` を知らない鍵として落とす
 * （`run → invokeOnce` の二重 parse を消したとき、`invokeOnce → 拡張` に
 * 1段ずれただけだった）。ブリッジの `call` はこの型を受け取る。
 */
export type WireRequestInput = z.input<typeof requestSchema>;

/**
 * 応答のエラーメッセージの上限。
 *
 * ブリッジはこの文字列をそのままエージェントに渡す。上限が無いと、
 * `reason` を閉じた語彙にして塞いだのと同じクラスのチャネルが、ここだけ
 * 開いたままになる（拡張が `String(e)` を詰めれば任意長の文字列が通る）。
 * 診断に必要な長さは確保しつつ、上限は置く。
 */
/**
 * JSON の1文字が線上で取りうる最大バイト数。
 *
 * - 日本語などの BMP 文字は UTF-8 で **3 バイト**
 * - 制御文字は `JSON.stringify` が `\uXXXX` に展開するので **6 バイト**（実測）
 *
 * 線に載るのは**無害化する前の**エージェント入力なので、制御文字はそのまま来うる。
 * だから最悪値の 6 を取る。
 */
const MAX_WIRE_BYTES_PER_CHAR = 6;

/**
 * 線上の1行の上限（バイト）。**プロトコルの最大フィールドから導出する。**
 *
 * ## なぜ導出するのか（不変条件14 の5件目）
 *
 * 以前は拡張側が `MAX_LINE_BYTES = 256 KiB` と**独立に**決めていた。ところが
 * `MAX_HTML_CHARS` は 256 K **文字**である。単位が違うので、
 * **スキーマを通る入力が線で落ちる**:
 *
 * ```
 * "あ".repeat(262144)  → スキーマは通る（MAX_HTML_CHARS ちょうど）
 *                       → 線上 786,480 バイト（実測）> 262,144 で切断
 * ```
 *
 * 日本語がこの道具の主な言語である以上、これは端の話ではない。
 * 3A で直したハンドシェイクとまったく同じ形 ―― 同じ量（1メッセージの大きさ）を
 * 2箇所が別の方法で決めていて、**安全側に閉じすぎる**方向に壊れていた。
 *
 * ## 大きさについて
 *
 * 未認証の相手には `MAX_HANDSHAKE_BYTES`（4096）しか積ませない。ここが効くのは
 * **認証済みの1接続だけ**（`MAX_AUTHED_CONNECTIONS` = 1）なので、
 * この値のバッファが同時に複数できることはない。
 */
export const MAX_WIRE_LINE_BYTES = MAX_HTML_CHARS * MAX_WIRE_BYTES_PER_CHAR + 8192;

export const MAX_ERROR_MESSAGE_CHARS = 2000;

export const errorCodeSchema = z.enum([
  "no-window",
  "disabled",
  "invalid-request",
  "excluded-path",
  "invalid-path",
  "not-found",
  "rate-limited",
  "internal",
]);
export type WireErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * 応答の中身の形。
 *
 * 要求側は全階層 `strict()` なのに、応答は `z.record(z.unknown())` で完全に無検証だった
 * （実測: 10万文字の `fileContents` を含む応答が素通りする）。
 * 「どのツールもファイルの中身を返さない」を強制すべき場所はエージェントへ手渡す側＝
 * ブリッジだが、**その手段が protocol から与えられていなかった**。
 *
 * `responseSchema` 自体は `tool` を持たないので判別できない。ツール名から結果スキーマを
 * 引ける形にして、ブリッジが転送前に parse する（要求のツール名は分かっている）。
 * ツール名で引く分、ツールごとの形の取り違えまで落ちるので和より強い。
 */
export const resolutionSchema = z
  .object({
    resolvedBy: z.enum(["text", "symbol", "lines", "none"]),
    match: z.enum(["none", "one", "many"]),
    range: z
      .object({
        startLine: z.number().int(),
        endLine: z.number().int(),
        // 列は**両方そろったときだけ**入る（0始まり、設計 D34）。
        startColumn: z.number().int().min(0).optional(),
        endColumn: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    candidates: z
      .array(z.object({ line: z.number().int() }).strict())
      .max(3)
      .optional(),
    // 自由文字列にしない。ここが不変条件2の抜け道になる（reason に
    // ファイルの中身を詰めた結果が、結果スキーマを通ってしまう）。
    reason: z.enum(RESOLUTION_REASONS).optional(),
    // 正規化後のパスは入力のパスより長くならない（locationSchema.path と同じ上限）。
    normalizedPath: z.string().max(1024).optional(),
  })
  .strict();

export const showCodeResultSchema = z.object({ resolutions: z.array(resolutionSchema) }).strict();

/**
 * `annotate` の結果。**`show_code` と同じ形**（位置と解決手段だけ）。
 *
 * 吹き出しの本文を返さない ―― エージェントが送った文字列をそのまま返すのは
 * 無駄で、無害化の後の形を返すのは「何が落とされたか」を測る口になる。
 * 何件出せたかは `resolutions` の `match` から読める。
 */
/**
 * `annotate` の項目1つの結果（増分6 D71）。`show_code` の `resolutionSchema` に
 * **`id` と `index` を足したもの**。出せなかった項目（`none` / `many`）にはどちらも無い。
 *
 * - `id` は窓の中で単調増加する連番。`clear` の後も戻らない。吹き出しが出た項目に付く
 * - `index` は 1始まりの読む順で、**呼び出しの終わりに**拡張がストアの一覧を1回読んで
 *   付ける。作者名の `3/7` と同じ数（D69）。同じ呼び出しの中で上限の押し出しに遭った
 *   項目は `id` だけで `index` が無い（1回の上限 20 では起きない）
 *
 * `.extend()` は strict を保つ（知らない鍵は引き続き落ちる。`wire.test.ts` で確認）。
 */
export const annotateResolutionSchema = resolutionSchema.extend({
  id: z.number().int().min(1).optional(),
  index: z.number().int().min(1).max(MAX_ANNOTATION_THREADS).optional(),
});

export const annotateResultSchema = z
  .object({ resolutions: z.array(annotateResolutionSchema) })
  .strict();

export const listWorkspacesResultSchema = z
  .object({
    boundWorkspace: z.object({ name: z.string(), path: z.string() }).strict().optional(),
    isTrusted: z.boolean(),
    capabilities: z
      .object({ symbolResolution: z.boolean(), terminalEnvInjection: z.boolean() })
      .strict(),
    /**
     * エージェントの行動を制約する設定（D56）。**呼ぶ前に読める**ようにする。
     * 「やってみて断られる」は最後の砦であって、普段の知り方ではない。
     * 値は拡張の `readConfig()` から写すだけなので、ワークスペース値は載らない（不変条件9）。
     *
     * 3欄とも**必須**。optional にすると、古い拡張と新しいブリッジの組み合わせで
     * 欄が黙って消え、エージェントは「制約が無い」と読む。線で落として気づかせる。
     */
    permissions: z.object({ closeHumanTabs: z.boolean(), closeDirtyTabs: z.boolean() }).strict(),
    /**
     * 人間が切れる3機能（増分6 D74）。`showme.stage.enabled` / `showme.html.enabled` /
     * `showme.layout.enabled` を写す。`disabledTools` は**ここから導出**される
     * （`FEATURE_OF_TOOL`。D75）ので、2欄が食い違うことは構造上無い。
     * 3鍵とも必須 ―― 機能を足した人が線上の形を足し忘れたら落ちて気づく。
     */
    features: z.object({ stage: z.boolean(), html: z.boolean(), layout: z.boolean() }).strict(),
    /**
     * 語彙は `TOOL_NAMES`。`features` から `disabledToolsFor()` で導出した値を
     * 拡張が載せる。enum にしてあるのは、導出を通さず設定ファイルの綴りを
     * そのまま線に載せる拡張をブリッジ側の結果検査で落とすため。
     * 長さの上限は語彙の数（重複で膨らませられない）。
     */
    disabledTools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
    /** `active` なら `show_code` は人間の列に開く。`showme.stage.editorGroup` の enum と同じ。 */
    editorGroup: z.enum(["dedicated", "active"]),
    /**
     * `show_html` のパネルの上限（増分6.2 D80）。`showme.html.maxPanels` を写す
     * （線上は整数 1〜999 か `"unlimited"`。`panelLimitSchema`。設定の `0` は拡張の
     * `panelLimitOr` が `"unlimited"` に畳んでから載せる）。**必須** ―― 欄が消えると
     * エージェントは「上限が無い」とも「2」とも読めない。拡張が `slot` を断るのと
     * 同じ設定値を載せるので、申告と実際の判断がずれない（不変条件14）。
     */
    panels: z.object({ max: panelLimitSchema }).strict(),
    otherWindowsListed: z.boolean(),
  })
  .strict();

/**
 * 返す列の数の上限。**画面は有界なので、ここも有界である。**
 *
 * 表示の上限であって、`openPaths` の上限（`MAX_OPEN_PATHS`）ではない。
 * 片方からもう片方を導出しないこと ―― 導出すると「`openPaths.length` が
 * 上限に達していれば溢れている」という合図を2つの量が別々に決めることになる。
 */
export const MAX_EDITOR_GROUPS = 8;
/** 1列あたりのタブの数の上限。`MAX_EDITOR_GROUPS` と同じく**表示だけ**を切る。 */
export const MAX_TABS_PER_GROUP = 24;
/** タブの見出しの長さの上限。 */
export const MAX_TAB_LABEL_CHARS = 200;

/**
 * タブの種類。**閉じた語彙**（`Tab.input` の**型**から決める。名前では決めない）。
 *
 * ここが唯一の定義元である。拡張側の `TabKind` はこの配列から導く ――
 * 同じ語彙を2箇所に書くと、片方だけ増えたときに線と型が黙ってずれる
 * 。
 */
export const TAB_KINDS = [
  "file",
  "diff",
  "webview",
  "terminal",
  "notebook",
  "notebook-diff",
  "other",
] as const;
export type TabKind = (typeof TAB_KINDS)[number];

/**
 * タブ1枚の状態。**旗は `true` しか入らない**（false は鍵ごと省く）。
 *
 * `visibleLines` は**秘匿ファイルでは入らない**（設計 §1.4）。人間の
 * スクロールに連動して動く量なので、繰り返し観測するとファイルの行数が
 * 決まる ―― `KEY=value` の形式のファイルでは、それは鍵の本数である。
 * `isDirty` のような**動かない1ビット**とはここが違う。
 */
const tabStateSchema = z
  .object({
    label: z.string().max(MAX_TAB_LABEL_CHARS),
    kind: z.enum(TAB_KINDS),
    path: z.string().max(MAX_REL_PATH_CHARS).optional(),
    own: z.literal(true).optional(),
    /** own の webview だけ。どの枠か（`show_html` / `move-panel` の `slot` と同じ値。C5）。 */
    slot: panelSlotSchema.optional(),
    isActive: z.literal(true).optional(),
    isDirty: z.literal(true).optional(),
    isPinned: z.literal(true).optional(),
    isPreview: z.literal(true).optional(),
    visibleLines: z.object({ start: z.number().int(), end: z.number().int() }).strict().optional(),
  })
  .strict();

const editorGroupStateSchema = z
  .object({
    viewColumn: z.number().int().min(1),
    isActive: z.literal(true).optional(),
    tabs: z.array(tabStateSchema).max(MAX_TABS_PER_GROUP),
  })
  .strict();

/**
 * `get_editor_state` の結果。
 *
 * **ここが不変条件2「どのツールもファイルの中身を返さない」の唯一の例外**で、
 * 例外である以上、大きさと語彙が型で有界でなければならない:
 *
 * - `selectedText` は `MAX_SELECTED_TEXT_CHARS` で頭打ち。設定
 *   （`showme.maxSelectionChars`）はこれより上には行けない。上限を拡張側の
 *   善意にだけ委ねると、信頼境界（ソケット）の外側に上限が無いことになる
 * - `selectionWithheld` は閉じた語彙。自由文字列にすると、理由に中身を詰める
 *   経路がそのまま開く（`resolutionSchema.reason` と同じ理由）
 * - `openPaths` は本数にも上限を置く。1本ずつ短くしても、本数で溢れる。
 *   **増分4 から除外パスも載る**（設計 D37）―― 人間が自分の意思で画面に
 *   出しているタブの**観測**であって、ディレクトリの**列挙**ではない。
 *   伏せて得ていたのは「`.env` が存在する」の1ビットだけで、それは
 *   `show_code` に問えば `excluded-path` として既に読める。一方、伏せると
 *   レイアウトに穴が空いて片づけの判断に使えなくなる。
 *   **中身は1文字も変わらず伏せる**（`visibleLines` / `cursor` / `selection` /
 *   `selectedText`）
 * - `openPathsHidden` は**消した**（設計 D37）。名前が出るようになれば、
 *   この数は「上限で溢れた分」だけになり、それは `openPaths.length` から読める。
 *   同じ量を2箇所で返さない
 *
 * `selectedText` を返さなかったときに `selectionWithheld` を返すのは、
 * エージェントが**「選択が無い」と「共有されなかった」を区別できるようにする**
 * ため。区別できないと、エージェントは人間に「選択してください」と言い続ける。
 */
/**
 * 注釈1件の観測（増分6 D72）。id・順番・パス・行・色・読了**だけ**。
 *
 * - `id` / `index` は `annotate` の結果と同じ数（D71）
 * - `line` は吹き出しが付いている行（1始まり）
 * - `resolved` は人間が Resolve を押したか（`CommentThread.state`）。人間→エージェントに
 *   流れるのは**注釈ごとに1ビット**で、文字列は流れない（§C3）。省略できない ――
 *   省略を false と読ませると、古い拡張との組み合わせで「全部未読」に見える
 */
export const annotationStateSchema = z
  .object({
    id: z.number().int().min(1),
    index: z.number().int().min(1).max(MAX_ANNOTATION_THREADS),
    path: z.string().max(MAX_REL_PATH_CHARS),
    line: z.number().int().min(1),
    color: z.enum(ANNOTATION_COLORS).optional(),
    resolved: z.boolean(),
  })
  .strict();
export type AnnotationState = z.infer<typeof annotationStateSchema>;

export const getEditorStateResultSchema = z
  .object({
    activePath: z.string().max(MAX_REL_PATH_CHARS).optional(),
    cursor: z.object({ line: z.number().int(), character: z.number().int() }).strict().optional(),
    selection: z
      .object({
        startLine: z.number().int(),
        startCharacter: z.number().int(),
        endLine: z.number().int(),
        endCharacter: z.number().int(),
      })
      .strict()
      .optional(),
    selectedText: z.string().max(MAX_SELECTED_TEXT_CHARS).optional(),
    selectionWithheld: z.enum(SELECTION_WITHHELD_REASONS).optional(),
    visibleLines: z.object({ start: z.number().int(), end: z.number().int() }).strict().optional(),
    openPaths: z.array(z.string().max(MAX_REL_PATH_CHARS)).max(MAX_OPEN_PATHS),
    /**
     * 人間の画面のレイアウト（設計 D38）。
     *
     * **秘匿ファイルも並ぶ**（D37）。並ばないと、片づけの判断に使えない
     * 一覧になる ―― 穴の空いたレイアウトは、レイアウトではない。
     * 中身に当たるもの（可視行・カーソル・選択・選択テキスト）は落ちる。
     *
     * **ワークスペース外のファイル名・端末の見出し・他人の webview の題は
     * 入らない**（D37'）。タブ自体は並ぶが、見出しは種類を言う固定文字列になる。
     *
     * **フローティング窓の区別は入らない**（D39）。VS Code が `TabGroup` に
     * その情報を公開していないので、返せない。推測もしない。
     */
    groups: z.array(editorGroupStateSchema).max(MAX_EDITOR_GROUPS).optional(),
    /**
     * エージェント自身が出している注釈の一覧（増分6 D72）。読む順（`index`）に並ぶ。
     * 注釈が1件も無ければ鍵ごと省く（`groups` と同じ約束）。
     *
     * **本文は載らない**（§C6）。エージェント自身が書いたものだし、線に乗せる理由が無い。
     * 秘匿パスの分岐も無い ―― 注釈は秘匿パスにはそもそも作れない
     * （`annotate` が `excluded-path` で落とす）。
     */
    annotations: z.array(annotationStateSchema).max(MAX_ANNOTATION_THREADS).optional(),
  })
  .strict();

/**
 * 落とした CSS 宣言の件数。**件数だけ**（設計 D31）。
 *
 * 落としたのはエージェント自身が書いた文字列であって、ワークスペースの中身ではない
 * ので、不変条件2 に抵触しない。プロパティ名まで返すと許可リストの形状を
 * 問い合わせる口になるので、返さない。
 */
export const showHtmlResultSchema = z
  .object({ shown: z.literal(true), droppedDeclarations: z.number().int().min(0) })
  .strict();

export const showNoteResultSchema = z
  .object({ shown: z.literal(true), reusedDocument: z.boolean() })
  .strict();

/**
 * 位置を探した結果。**中身は返さない**（不変条件2）。
 *
 * `locations` は上限つきで、**正確な件数は返さない**（S1）。切ったことも
 * 切った数も載せない ―― 載せれば件数を復元できる。
 */
export const locationSearchResultSchema = z
  .object({
    match: z.enum(["none", "one", "many"]),
    locations: z
      .array(
        z
          .object({
            path: z.string().max(MAX_REL_PATH_CHARS),
            line: z.number().int().min(1),
            column: z.number().int().min(0),
          })
          .strict(),
      )
      .max(MAX_FOUND_LOCATIONS),
    reason: z.enum(RESOLUTION_REASONS).optional(),
  })
  .strict();

/**
 * 画面操作の結果。**何が起きたかだけ**を返す。
 *
 * `done: false` は「その操作ができなかった」で、理由は返さない ――
 * 画面の状態（サイドバーが開いているか等）はエージェントに教える必要が無いし、
 * 教えると人間の画面の状態を問い合わせる口になる。
 */
export const showViewResultSchema = z.object({ done: z.boolean() }).strict();

/**
 * 断った理由。**閉じた語彙にする。**
 *
 * 自由文字列にすると、理由に中身を詰める経路が開く（`errorCodeSchema` と
 * `selectionWithheld` を閉じた語彙にしたのと同じ理由）。
 */
export const ARRANGE_WITHHELD_REASONS = [
  /** `showme.layout.closeHumanTabs` が false なので、人間のタブに触れなかった */
  "human-tabs-not-allowed",
  /** `showme.layout.closeDirtyTabs` が false なので、未保存のタブを残した */
  "dirty-tabs-not-allowed",
  /**
   * 人間が**見ている**タブ（`activeTabGroup.activeTab`）なので触らなかった。
   * **どの設定でも外れない**（増分5 §C1 の床1）。人間に設定を頼んでも変わらない。
   */
  "viewing-tab",
  /**
   * レイアウトのプリセット（`two-columns` 等）で**人間の列**が別の列に合流するので、
   * 呼ばなかった（増分5 §C3 / D55-2）。合流は一方通行なので、呼んでから戻すことは
   * できない ―― `done: false` と一緒に返る。列を減らさない `even-widths` では出ない。
   */
  "human-column-would-merge",
  /**
   * `move-tab` / `move-panel` の移動先が**人間の列**（`activeTabGroup`）なので、動かさなかった
   * （増分5 D59）。人間の列にタブを流し込むのは `single-column` が起こしたことと同じ。
   * `showme.layout.closeHumanTabs` が true なら通る（人間の面に触ってよいと言われている）。
   */
  "human-column-target",
] as const;
export type ArrangeWithheldReason = (typeof ARRANGE_WITHHELD_REASONS)[number];

/**
 * `arrange_editors` の結果。**何枚閉じたかと、何を断ったか**を返す。
 *
 * `closed` を返すのは、エージェントが「片づいた」と「断られた」を区別できる
 * ようにするため ―― 区別できないと、同じ操作を呼び続ける
 * （`selectionWithheld` を返しているのと同じ理由）。
 * エージェントが `get_editor_state` で見ていた枚数と食い違っても、
 * この数で気づける（設計 D51）。
 *
 * **「何枚断ったか」の数は返さない。** 人間のタブが何枚あるかを数える口に
 * なるうえ、枚数は `get_editor_state` の `groups` で既に見えているので、
 * ここで返しても得るものが無い ―― 得が無くて口だけ増える。
 */
export const arrangeEditorsResultSchema = z
  .object({
    done: z.boolean(),
    closed: z.number().int().min(0),
    /**
     * **実際に動かした枚数**（`move-*` / `gather-own`。増分5 D59）。閉じる語では付けない。
     * `closed` と同じ理由で返す ―― 「動いた」と「断られた」を区別する。
     */
    moved: z.number().int().min(0).optional(),
    withheld: z
      .array(z.enum(ARRANGE_WITHHELD_REASONS))
      .max(ARRANGE_WITHHELD_REASONS.length)
      .optional(),
    /**
     * `close-tabs` で、**関門を通ったのに開いているタブが無かった**パス。
     * 載るのはエージェントが送った綴りそのもの（正準名ではない ―― 開いていないファイルの
     * 正準名を返すと、リンクの先を読む口になる）。関門で落ちたパスはここに載らず、
     * 呼び出し全体がその理由（`excluded-path` / `invalid-path`）で失敗する ―― パスごとに
     * 答えを割ると、秘匿ファイルの存在を1本ずつ確かめる口になる。
     * 閉じた側の名前は返さない（`closed` の数だけ）。
     */
    notOpen: z
      .array(z.string().min(1).max(MAX_REL_PATH_CHARS))
      .max(MAX_CLOSE_TABS_PATHS)
      .optional(),
  })
  .strict();

/** ツール名から結果スキーマを引く。ブリッジが転送前に parse するために使う。 */
export const RESULT_SCHEMAS = {
  show_code: showCodeResultSchema,
  list_workspaces: listWorkspacesResultSchema,
  get_editor_state: getEditorStateResultSchema,
  annotate: annotateResultSchema,
  show_html: showHtmlResultSchema,
  show_note: showNoteResultSchema,
  find_definition: locationSearchResultSchema,
  find_references: locationSearchResultSchema,
  show_view: showViewResultSchema,
  arrange_editors: arrangeEditorsResultSchema,
} as const;

export const responseSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.record(z.unknown()) }).strict(),
  z
    .object({
      id: z.string(),
      ok: z.literal(false),
      error: z
        .object({ code: errorCodeSchema, message: z.string().max(MAX_ERROR_MESSAGE_CHARS) })
        .strict(),
    })
    .strict(),
]);
export type WireResponse = z.infer<typeof responseSchema>;
