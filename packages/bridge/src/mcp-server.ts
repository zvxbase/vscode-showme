import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolName,
  annotateArgsSchema,
  arrangeEditorsArgsSchema,
  findDefinitionArgsSchema,
  findReferencesArgsSchema,
  getEditorStateArgsSchema,
  listWorkspacesArgsSchema,
  showCodeArgsSchema,
  showHtmlArgsSchema,
  showNoteArgsSchema,
  showViewArgsSchema,
} from "@zvx/vscode-showme-protocol";
import { z } from "zod";
import { parseToolResult } from "./result-guard.js";

/** `packages/bridge/package.json` の version と揃える。 */
const BRIDGE_VERSION = "0.0.0";

/**
 * ツール1回分を拡張へ投げる関数。
 *
 * 発見も接続も再試行もこの外側（`index.ts`）にある。ここには**エージェントに
 * 何を見せるか**だけを置く。おかげで「拡張が何を返そうと検問を通る」ことを、
 * 偽の実装1つで端から端まで検査できる。
 */
export type ToolInvoker = (tool: ToolName, args: unknown) => Promise<unknown>;

/** ツールごとの引数スキーマ。線上のスキーマ（protocol）をそのまま使う。 */
const ARG_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  list_workspaces: listWorkspacesArgsSchema,
  show_code: showCodeArgsSchema,
  get_editor_state: getEditorStateArgsSchema,
  annotate: annotateArgsSchema,
  show_html: showHtmlArgsSchema,
  show_note: showNoteArgsSchema,
  find_definition: findDefinitionArgsSchema,
  find_references: findReferencesArgsSchema,
  show_view: showViewArgsSchema,
  arrange_editors: arrangeEditorsArgsSchema,
};

/**
 * stdio の MCP サーバを組み立てる。
 *
 * ツール定義・注釈・説明はすべて protocol から取る。ここで書き直さない
 * 。
 * 登録は `TOOL_NAMES` を回して行うので、ツールを増やして
 * 登録し忘れる、という食い違いが起こらない。
 */
export function createShowMeServer(invoke: ToolInvoker): McpServer {
  const server = new McpServer({ name: "vscode-showme", version: BRIDGE_VERSION });

  for (const tool of TOOL_NAMES) {
    server.registerTool(
      tool,
      {
        description: TOOL_DESCRIPTIONS[tool],
        inputSchema: advertised(ARG_SCHEMAS[tool]),
        annotations: TOOL_ANNOTATIONS[tool],
      },
      (args: unknown) => run(invoke, tool, args),
    );
  }

  return server;
}

/**
 * SDK に**広告させる**形。
 *
 * MCP SDK は `.shape` を持つ ZodObject しか `tools/list` に写せない。transform
 * （`annotateArgsSchema`、設計 D54）をそのまま渡すと `inputSchema` が
 * `{ type: "object", properties: {} }` になり、エージェントから引数の形が消える（実測）。
 * だから広告には transform の内側の object を渡す。**検証は `run` が本物で行う**
 * ―― 広告面は形だけで、規則（`clear` は `items` を取らない）は transform にしか無い。
 */
function advertised(schema: z.ZodTypeAny): z.ZodTypeAny {
  // `instanceof` で見ない。protocol とブリッジで zod のクラスの実体が別になりうる
  // （実測: vitest で `_def.typeName` は ZodEffects なのに `instanceof z.ZodEffects` が false）。
  // SDK 自身と同じく型タグで見る。
  const def = schema._def as { typeName?: string };
  return def.typeName === z.ZodFirstPartyTypeKind.ZodEffects
    ? (schema as z.ZodEffects<z.ZodTypeAny>).innerType()
    : schema;
}

/**
 * 呼んで、検証して、渡す。
 *
 * **結果はどの経路でも `parseToolResult` を通る。** ここが「どのツールもファイルの中身を返さない」
 * の関所で、通す／通さないの判断をこの1か所に集めてある。
 * 落ちたら結果ごと捨てて、エージェントにはエラーだけを見せる。
 *
 * 例外は投げずに `isError` で返す。VS Code が居ないのは正常な状態のひとつ
 * （後から立ち上がりうる）で、エージェント本体を止める理由にはならない。
 */
async function run(invoke: ToolInvoker, tool: ToolName, args: unknown): Promise<CallToolResult> {
  try {
    // 引数は線上のスキーマ**そのもの**で検証する。SDK が先に当てるのは広告面
    // （`advertised`）なので、transform の規則はここを通さないと効かない。
    //
    // **渡すのは検証した値ではなく、受け取った `args` そのもの。** `invokeOnce` は
    // `requestSchema` で同じスキーマをもう一度当てる（拡張も同じ。信頼境界はソケット）。
    // transform の出力（`{ kind: "path", path }`）を渡すと、2回目の検証が `.strict()` の
    // 内側で `kind` を知らない鍵として落とし、**`{ html }` も `{ path }` も拡張に一度も
    // 届かない**（レビューで発見。それまでの検査はすべて偽の invoker で、
    // `run → invokeOnce` を組んだものが無かった ―― 安全側は全部緑のまま機能だけが
    // 死ぬ向き）。`annotate` は出力が広告面の部分集合だったので偶然通っていた。
    // **transform は各側でちょうど1回。** 「検証した値を渡すほうが素直」に戻さないこと
    // （`mcp-server.test.ts` の「本物で組む」の節が赤になる）。
    //
    // **ここを直しただけでは足りなかった。** 同じ二重 parse が `invokeOnce → 拡張`
    // に1段ずれて残っていて、`invokeOnce` が `requestSchema.parse` の出力を線に書いていた。
    // 線に乗せる形は `invokeOnce` が決める（transform 前の envelope）。この関数は
    // 「検証した値を次に渡さない」を守るだけで、線の形までは保証しない。
    ARG_SCHEMAS[tool].parse(args);
    const result = parseToolResult(tool, await invoke(tool, args));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
}
