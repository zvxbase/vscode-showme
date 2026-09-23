import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type WireRequest,
  requestSchema,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { NoWindowError } from "./client.js";
import type { RegistryEntry } from "./discover.js";
import { type InvokerDeps, createSocketInvoker } from "./invoke.js";
import { type ToolInvoker, createShowMeServer } from "./mcp-server.js";

const listWorkspacesResult = {
  isTrusted: true,
  capabilities: { symbolResolution: true, terminalEnvInjection: false },
  permissions: { closeHumanTabs: false, closeDirtyTabs: false },
  features: { stage: true, html: true, layout: true },
  disabledTools: [],
  editorGroup: "dedicated",
  panels: { max: 2 },
  otherWindowsListed: false,
};

const showCodeResult = {
  resolutions: [{ resolvedBy: "text", match: "one", range: { startLine: 3, endLine: 3 } }],
};

/** ブリッジを、拡張の代わりに `invoke` を返す偽物で立ち上げてエージェント側から叩く。 */
async function connect(invoke: ToolInvoker): Promise<Client> {
  const server = createShowMeServer(invoke);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** VS Code が居ない状態。どのツール呼び出しも届かない。 */
const noWindow: ToolInvoker = () => {
  throw new NoWindowError("VS Code ウィンドウが見つかりません");
};

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("createShowMeServer", () => {
  it("VS Code が居なくても tools/list は返る（エージェントの起動を止めない）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("注釈は protocol の TOOL_ANNOTATIONS そのまま（ここで書き直さない）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject(
        TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS],
      );
    }
  });

  it("説明は protocol の TOOL_DESCRIPTIONS そのまま", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS]);
    }
  });

  it("show_code の引数の形は線上のスキーマから来ている（上限3・正規表現なし）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    const showCode = tools.find((t) => t.name === "show_code");
    const schema = showCode?.inputSchema as {
      properties: {
        locations: { maxItems: number; items: { properties: Record<string, unknown> } };
      };
      additionalProperties: boolean;
    };
    expect(schema.properties.locations.maxItems).toBe(3);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.locations.items.properties)).not.toContain("pattern");
  });

  /**
   * `annotateArgsSchema` は object の上の transform（D54）。SDK は `.shape` を持つ
   * ZodObject しか広告できないので、transform をそのまま登録すると
   * `inputSchema` が `{ type: "object", properties: {} }` になる（実測）。
   * 呼び出しの検証は通るのに、エージェントからは引数の形が見えなくなる ――
   * 安全側の検査が全部緑のまま機能だけが死ぬ向き。**広告面に形が載ること**を固定する。
   */
  it("annotate の広告面に items / mode が載っている（transform の内側を広告する）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    const annotate = tools.find((t) => t.name === "annotate");
    const schema = annotate?.inputSchema as {
      properties: Record<string, { maxItems?: number; enum?: string[] }>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["items", "mode"]);
    expect(schema.properties.items?.maxItems).toBe(20);
    expect(schema.properties.mode?.enum).toEqual(["replace", "add", "clear"]);
    expect(schema.additionalProperties).toBe(false);
  });

  /**
   * 色を持つのは `show_code` だけ（増分6 D65'）。`annotate` の `location` は
   * `markerLocationSchema` で、広告面からも `color` が消えている ―― 検証で落ちるだけ
   * でなく、エージェントが `tools/list` で見る形にも無いことを固定する。
   */
  it("annotate / find_* の広告面の location に color が無く、show_code には有る（D65'）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    type ObjectSchema = { properties: Record<string, unknown> };
    const locationProps = (schema: unknown): string[] =>
      Object.keys(
        (schema as { properties: { location: ObjectSchema } }).properties.location.properties,
      );

    const annotate = tools.find((t) => t.name === "annotate")?.inputSchema as {
      properties: { items: { items: { properties: { location: ObjectSchema } } } };
    };
    const annotateLocation = annotate.properties.items.items.properties.location;
    expect(Object.keys(annotateLocation.properties)).not.toContain("color");
    // 肯定対照: 消えたのは color だけ（位置の指定はそのまま）。
    expect(Object.keys(annotateLocation.properties)).toEqual(
      expect.arrayContaining(["path", "text", "symbol", "lines", "occurrence"]),
    );

    expect(
      locationProps(tools.find((t) => t.name === "find_definition")?.inputSchema),
    ).not.toContain("color");
    expect(
      locationProps(tools.find((t) => t.name === "find_references")?.inputSchema),
    ).not.toContain("color");

    const showCode = tools.find((t) => t.name === "show_code")?.inputSchema as {
      properties: { locations: { items: ObjectSchema } };
    };
    expect(Object.keys(showCode.properties.locations.items.properties)).toContain("color");
  });

  it("location.color を付けた annotate / find_definition は、拡張へ届く前にエラーで返る（D65'）", async () => {
    let reached = false;
    const client = await connect(async () => {
      reached = true;
      // 届くのは肯定対照の annotate だけなので、その結果の形でよい（結果スキーマは strict）。
      return { resolutions: [] };
    });
    const annotate = await client.callTool({
      name: "annotate",
      arguments: { items: [{ location: { path: "a.ts", text: "x", color: "red" }, text: "y" }] },
    });
    expect(isError(annotate)).toBe(true);
    const find = await client.callTool({
      name: "find_definition",
      arguments: { location: { path: "a.ts", text: "x", color: "red" } },
    });
    expect(isError(find)).toBe(true);
    expect(reached).toBe(false);
    // 肯定対照: color を外した同じ形は届く。
    const ok = await client.callTool({
      name: "annotate",
      arguments: { items: [{ location: { path: "a.ts", text: "x" }, text: "y" }] },
    });
    expect(isError(ok)).toBe(false);
    expect(reached).toBe(true);
  });

  /**
   * `showHtmlArgsSchema` も object の上の transform（D52: `html | path` の排他）。
   * annotate と同じ理由で、広告面に3つの鍵が載ることを固定する。
   */
  it("show_html の広告面に html / path / slot / title が載っている（transform の内側を広告する）", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    const showHtml = tools.find((t) => t.name === "show_html");
    const schema = showHtml?.inputSchema as {
      properties: Record<string, { maxLength?: number; description?: string }>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["html", "path", "slot", "title"]);
    expect(schema.properties.path?.maxLength).toBe(1024);
    expect(schema.properties.path?.description).toContain(
      "re-renders it every time the file is saved",
    );
    // `slot` の上限の出所（人間の設定。`list_workspaces.panels.max`）が広告面に載る（D61 → D80）。
    expect(schema.properties.slot?.description).toContain("showme.html.maxPanels");
    expect(schema.properties.slot?.description).toContain("list_workspaces.panels.max");
    expect(schema.properties.slot?.description).not.toContain("Up to 2 panels");
    expect(schema.additionalProperties).toBe(false);
  });

  /**
   * `arrangeEditorsArgsSchema` は plain な ZodObject（D59。「move-tab には path と
   * toColumn が要る」はハンドラで1回判定する ―― transform にすると線の両端で二重に parse する形）。
   * 広告面に `path` / `toColumn` が載っていないと、エージェントは動かし方を知れない。
   */
  it("arrange_editors の広告面に action / path / paths / slot / toColumn が載っている", async () => {
    const client = await connect(noWindow);
    const { tools } = await client.listTools();
    const arrange = tools.find((t) => t.name === "arrange_editors");
    const schema = arrange?.inputSchema as {
      properties: Record<
        string,
        {
          enum?: string[];
          maximum?: number;
          maxLength?: number;
          minItems?: number;
          maxItems?: number;
          items?: { maxLength?: number; minLength?: number };
        }
      >;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "action",
      "path",
      "paths",
      "slot",
      "toColumn",
    ]);
    expect(schema.properties.action?.enum).toContain("move-tab");
    expect(schema.properties.action?.enum).toContain("gather-own");
    expect(schema.properties.action?.enum).toContain("close-tabs");
    expect(schema.properties.action?.enum).not.toContain("single-column");
    expect(schema.properties.action?.enum).not.toContain("close-all");
    expect(schema.properties.toColumn?.maximum).toBe(9);
    expect(schema.properties.path?.maxLength).toBe(1024);
    // `paths` の上限（1〜50 本、各 1〜1024 文字）が広告面まで届く。
    expect(schema.properties.paths?.minItems).toBe(1);
    expect(schema.properties.paths?.maxItems).toBe(50);
    expect(schema.properties.paths?.items?.maxLength).toBe(1024);
    expect(schema.properties.paths?.items?.minLength).toBe(1);
    expect(schema.additionalProperties).toBe(false);
  });

  it("html と path を両方付けた show_html は、拡張へ届く前にエラーで返る（規則は transform 側）", async () => {
    let received: unknown;
    const client = await connect(async (_tool, args) => {
      received = args;
      return { shown: true, droppedDeclarations: 0 };
    });
    const both = await client.callTool({
      name: "show_html",
      arguments: { html: "<p>x</p>", path: "a.html" },
    });
    expect(isError(both)).toBe(true);
    expect(received).toBeUndefined();
    // 肯定対照: path だけなら届く。invoker に渡るのは**変換前の引数そのもの**
    // （transform は `invokeOnce` の `requestSchema` と拡張の入口が各1回当てる。変換後を
    // 渡すと `.strict()` が `kind` を落として何も届かない ―― 下の「本物で組む」の節。
    // 同じことが線にも言える: `invokeOnce` は検証した出力ではなく変換前の envelope を
    // 線に書く）。
    const ok = await client.callTool({ name: "show_html", arguments: { path: "docs/a.html" } });
    expect(isError(ok)).toBe(false);
    expect(received).toEqual({ path: "docs/a.html" });
  });

  it("clear に items を付けた annotate は、拡張へ届く前にエラーで返る（規則は transform 側）", async () => {
    let reached = false;
    const client = await connect(async () => {
      reached = true;
      return { resolutions: [] };
    });
    const result = await client.callTool({
      name: "annotate",
      arguments: { mode: "clear", items: [{ location: { path: "a.ts", text: "x" }, text: "y" }] },
    });
    expect(isError(result)).toBe(true);
    expect(reached).toBe(false);
    // 肯定対照: items 無しの clear は届く。
    const ok = await client.callTool({ name: "annotate", arguments: { mode: "clear" } });
    expect(isError(ok)).toBe(false);
    expect(reached).toBe(true);
  });

  it("VS Code が居ないときの tools/call は、ハングせずエラーで返る", async () => {
    const client = await connect(noWindow);
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("VS Code");
  });

  it("真っ当な結果はそのまま JSON で渡す", async () => {
    const client = await connect(async () => listWorkspacesResult);
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(isError(result)).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual(listWorkspacesResult);
  });

  it("show_code の引数はそのまま拡張へ渡る", async () => {
    let seen: unknown;
    const client = await connect(async (_tool, args) => {
      seen = args;
      return showCodeResult;
    });
    await client.callTool({
      name: "show_code",
      arguments: { locations: [{ path: "src/a.ts", text: "hello" }], layout: "split" },
    });
    expect(seen).toEqual({ locations: [{ path: "src/a.ts", text: "hello" }], layout: "split" });
  });

  it("fileContents を含む結果はエージェントに渡らない（不変条件2）", async () => {
    const secret = "SUPER_SECRET_SOURCE_LINE";
    const client = await connect(async () => ({ ...showCodeResult, fileContents: secret }));
    const result = await client.callTool({
      name: "show_code",
      arguments: { locations: [{ path: "src/a.ts", text: "hello" }] },
    });
    expect(isError(result)).toBe(true);
    // 結果ごと落とす。「一部だけ渡す」ではない。
    expect(textOf(result)).not.toContain(secret);
    expect(textOf(result)).not.toContain("resolvedBy");
  });

  it("結果が壊れていても、その中身をエラー本文に写さない", async () => {
    const secret = "ANOTHER_SECRET";
    const client = await connect(async () => ({ resolutions: secret }));
    const result = await client.callTool({
      name: "show_code",
      arguments: { locations: [{ path: "src/a.ts" }] },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).not.toContain(secret);
  });

  it("上限を超える locations は線に届く前に落ちる", async () => {
    let called = false;
    const client = await connect(async () => {
      called = true;
      return showCodeResult;
    });
    const result = await client.callTool({
      name: "show_code",
      arguments: {
        locations: [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }],
      },
    });
    expect(isError(result)).toBe(true);
    expect(called).toBe(false);
  });

  it("知らない鍵を混ぜた引数も落ちる（線上のスキーマは strict）", async () => {
    let called = false;
    const client = await connect(async () => {
      called = true;
      return showCodeResult;
    });
    const result = await client.callTool({
      name: "show_code",
      arguments: { locations: [{ path: "a" }], pattern: ".*" },
    });
    expect(isError(result)).toBe(true);
    expect(called).toBe(false);
  });

  it("拡張が投げた素の例外でもエージェント側は止まらない", async () => {
    const client = await connect(async () => {
      throw new Error("なにか");
    });
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(isError(result)).toBe(true);
  });
});

/**
 * **`run()` → `invokeOnce()` → 線 → 拡張の入口 を本物で組み合わせる。**
 *
 * `run()` は transform つきのスキーマで検証し、`invokeOnce()` は `requestSchema`
 * （同じ transform の内側は `.strict()`）でもう一度検証する。`run()` が**変換後の値**
 * （`{ kind: "path", path }`）を渡すと、2回目の検証が `kind` を「知らない鍵」として
 * 落とし、**`{ html }` も `{ path }` も拡張に一度も届かない**。上の検査はすべて偽の
 * invoker を使っていたので、この組み合わせを誰も見ていなかった ―― 安全側の検査が
 * 全部緑のまま機能だけが死ぬ、不変条件14 の 3A / 3A' の向き。
 *
 * **同じ二重 parse が `invokeOnce → 拡張` に1段ずれていた。** 前の修正で置いたこの節は
 * 偽の `call` で止まっていて、`call` が線に書いた値を拡張が `requestSchema.safeParse` で
 * もう一度読む、その parse を組んでいなかった。`invokeOnce` が `requestSchema.parse` の
 * **出力**（`{ kind, slot }` 入り）を `call` に渡し、`client.ts` がそれをそのまま
 * `JSON.stringify` して線に書き、拡張の `.strict()` が `kind` を落とす ―― 実機で
 * `show_html` は `{ path }` も `{ html }` も `invalid-request` だった。しかもこの節は
 * `received[0].args` が `kind` 入りであることを**正しい**として固定していた。
 *
 * だから偽の `call` は、**拡張の入口が線の向こうで当てる parse をそのまま持つ**
 * （`server.ts` の `dispatch` と同じ `requestSchema.safeParse(JSON.parse(line))`）。
 * 見るのは (1) 線に乗った形が広告面の形（transform 前）であること、(2) その線を
 * 拡張側が parse すると transform 後の形になること。各側が transform を
 * **ちょうど1回**当てることを、線の両端で固定する。
 */
describe("run → invokeOnce → 拡張の入口 を本物で組む（transform は各側で1回だけ）", () => {
  const stage: RegistryEntry = {
    protocolVersion: 1,
    workspacePath: "/w/stage",
    pid: 1,
    startedAt: "2026-09-09T00:00:00Z",
    socketPath: "/rt/stage.sock",
    authToken: "a".repeat(64),
    windowId: "win-stage",
    role: "stage",
  };

  /** 線に乗った1行を JSON に戻したもの（`client.ts` が `JSON.stringify` する直前の形）。 */
  interface WireLine {
    id: string;
    tool: string;
    args: unknown;
  }

  /**
   * 偽の拡張。**拡張の入口と同じ parse を線の向こうで当てる**。
   *
   * `client.ts` は `JSON.stringify(request)` を線に書き、拡張の `server.ts` `dispatch` は
   * `requestSchema.safeParse(JSON.parse(line))` で読んで、落ちたら `invalid-request` を返す。
   * ここもまったく同じ順に組む。`received` は線に乗った形（拡張が読む**前**）、
   * `handled` は拡張側の parse が返した形（transform 後）。
   */
  function fakeExtension(): {
    call: InvokerDeps["call"];
    received: WireLine[];
    handled: WireRequest[];
  } {
    const received: WireLine[] = [];
    const handled: WireRequest[] = [];
    const call: InvokerDeps["call"] = async (_entry, request) => {
      const line = JSON.parse(JSON.stringify(request)) as WireLine;
      received.push(line);
      const req = requestSchema.safeParse(line);
      if (!req.success) {
        return {
          id: line.id,
          ok: false,
          error: { code: "invalid-request", message: req.error.message },
        };
      }
      handled.push(req.data);
      const result =
        req.data.tool === "show_html"
          ? { shown: true, droppedDeclarations: 0 }
          : { resolutions: [] };
      return { id: req.data.id, ok: true, result };
    };
    return { call, received, handled };
  }

  async function connectComposed(): Promise<{
    client: Client;
    received: WireLine[];
    handled: WireRequest[];
  }> {
    const { call, received, handled } = fakeExtension();
    let n = 0;
    const invoke = createSocketInvoker({
      resolveWindow: () => stage,
      newId: () => {
        n += 1;
        return `id-${n}`;
      },
      call,
    });
    const server = createShowMeServer(invoke);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, received, handled };
  }

  it("対照: 偽の拡張は transform 後の形（kind 入り）を本物と同じく invalid-request で落とす", async () => {
    // この偽物が1段ずれた二重 parseを捕まえられることの証拠。前の修正で置いた偽の `call` は何でも
    // `ok: true` を返したので、`kind` 入りの形を「届いた」と読んでいた。
    const { call, received, handled } = fakeExtension();
    const before = {
      id: "x",
      tool: "show_html",
      args: { kind: "html", html: "<p>x</p>", slot: 1 },
    };
    const response = await call(stage, before as unknown as Parameters<typeof call>[1]);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid-request");
      expect(response.error.message).toContain("kind");
    }
    expect(received).toHaveLength(1);
    expect(handled).toHaveLength(0);
  });

  it("show_html の { html } が拡張に届く（線に乗るのは広告面の形）", async () => {
    const { client, received, handled } = await connectComposed();
    const result = await client.callTool({ name: "show_html", arguments: { html: "<p>x</p>" } });
    expect(isError(result), textOf(result)).toBe(false);
    expect(received).toHaveLength(1);
    // 線に乗った形は**広告面そのもの**（transform 前）。`kind` も畳んだ `slot` も無い。
    expect(received[0]?.args).toEqual({ html: "<p>x</p>" });
    // 拡張側の parse が transform を当てて初めて `kind` と既定の `slot: 1`（D61）が付く。
    expect(handled).toHaveLength(1);
    expect(handled[0]?.args).toEqual({ kind: "html", html: "<p>x</p>", slot: 1 });
  });

  it("show_html の { slot: 2 } と { slot: 3 } が拡張に届き、slot: 0 / 1000 は拡張の手前で落ちる（D61 → D80）", async () => {
    const { client, received, handled } = await connectComposed();
    const ok = await client.callTool({
      name: "show_html",
      arguments: { html: "<p>x</p>", slot: 2 },
    });
    expect(isError(ok), textOf(ok)).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]?.args).toEqual({ html: "<p>x</p>", slot: 2 });
    expect(handled[0]?.args).toEqual({ kind: "html", html: "<p>x</p>", slot: 2 });
    // 3 は**線を通る**（上限は人間の設定で、拡張の `handleShowHtml` が判定する。D80）。
    // ブリッジで落とすと、人間が `maxPanels: 3` にしても3枚目が届かない（安全側に閉じすぎる向き）。
    const third = await client.callTool({
      name: "show_html",
      arguments: { html: "<p>x</p>", slot: 3 },
    });
    expect(isError(third), textOf(third)).toBe(false);
    expect(received).toHaveLength(2);
    expect(received[1]?.args).toEqual({ html: "<p>x</p>", slot: 3 });
    expect(handled[1]?.args).toEqual({ kind: "html", html: "<p>x</p>", slot: 3 });
    // 線の健全性（整数 1〜999）はブリッジで落ちる。
    for (const bad of [0, 1000, 1.5]) {
      const r = await client.callTool({
        name: "show_html",
        arguments: { html: "<p>x</p>", slot: bad },
      });
      expect(isError(r), String(bad)).toBe(true);
    }
    expect(received).toHaveLength(2);
  });

  it("show_html の { path, title } が拡張に届き、拡張側の parse で transform 後の形になる", async () => {
    const { client, received, handled } = await connectComposed();
    const result = await client.callTool({
      name: "show_html",
      arguments: { path: "docs/a.html", title: "図" },
    });
    expect(isError(result), textOf(result)).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]?.args).toEqual({ path: "docs/a.html", title: "図" });
    // 「各側が transform をちょうど1回」の証拠: 線の形を拡張の入口が読むと、
    // `kind: "path"` と既定の `slot: 1` が付いた形になる。
    expect(handled).toHaveLength(1);
    expect(handled[0]?.args).toEqual({ kind: "path", path: "docs/a.html", slot: 1, title: "図" });
  });

  it("show_html の規則（html と path は排他）は組んだ経路でも拡張の手前で効く", async () => {
    const { client, received } = await connectComposed();
    const result = await client.callTool({
      name: "show_html",
      arguments: { html: "<p>x</p>", path: "docs/a.html" },
    });
    expect(isError(result)).toBe(true);
    expect(received).toHaveLength(0);
  });

  it("annotate の { mode: clear } と { items } が拡張に届く", async () => {
    const { client, received, handled } = await connectComposed();
    const clear = await client.callTool({ name: "annotate", arguments: { mode: "clear" } });
    expect(isError(clear), textOf(clear)).toBe(false);
    const item = { location: { path: "a.ts", text: "x" }, text: "説明" };
    const items = await client.callTool({ name: "annotate", arguments: { items: [item] } });
    expect(isError(items), textOf(items)).toBe(false);
    expect(received).toHaveLength(2);
    expect(received[0]?.args).toEqual({ mode: "clear" });
    expect(received[1]?.args).toEqual({ items: [item] });
    expect(handled).toHaveLength(2);
  });

  it("transform の無いツール（show_code）も同じ経路で届く（対照）", async () => {
    const { client, received, handled } = await connectComposed();
    const result = await client.callTool({
      name: "show_code",
      arguments: { locations: [{ path: "a.ts", text: "x" }] },
    });
    expect(isError(result), textOf(result)).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]?.tool).toBe("show_code");
    expect(handled).toHaveLength(1);
  });
});
