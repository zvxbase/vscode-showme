import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 注釈の本文が**プレーンな文字列**であることの強制（設計書 §3.2.1）。
 *
 * VS Code の comment の本文は `string` と markdown の文字列型のどちらでも取れる。
 * 実装はこの分岐を本当に持っていて、前者は `innerText` に入り、後者だけが
 * markdown レンダラに渡る。後者を選ぶと、**既定で**次が付いてくる（実バイナリで確認）:
 *
 *   - リモート画像が実際に取得される（`remoteImageIsAllowed` は comment 経路に
 *     渡されていない）。EchoLeak と同型の情報漏洩で、本体 §5.2「外部への送信を
 *     持たない」がこの1点で偽になる
 *   - 信頼していない markdown でも `http(s)` リンクはアンカーとして描かれる
 *     （`isTrusted` が足すのは `command:` スキームだけ）
 *   - テーマアイコンを許すと `$(zap)` がアイコンに展開される（ステータスバーの
 *     codicon なりすましと同型）
 *
 * だから注釈の経路には、それらの語が**一度も現れない**ことを要求する。
 *
 * ## なぜ「使っていない」ではなく「書かれていない」を見るのか
 *
 * 「設定しない」と書いたコメントは、次に書き足す人には届かない。届く形は
 * 「書いたら赤くなる」だけである。**説明したいことはこのファイルに書く**
 * ―― 走査対象のソース側に禁止語を（コメントであっても）書かないのは、
 * この検査を語の有無で単純に保つためである。単純な検査は、次の人が
 * 「コメントだから例外」を作れない。
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * 注釈が描かれるまでに通るソース。**ここに書かれていないものは検査されない。**
 *
 * `handlers/annotate.ts` は本文を組み立てる側、`annotations.ts` は VS Code に
 * 渡す側。どちらか一方だけを見ると、渡す側で型を作り替える経路が素通りする。
 */
const ANNOTATION_ROUTE: readonly string[] = [
  path.join("packages", "extension", "src", "annotations.ts"),
  path.join("packages", "extension", "src", "handlers", "annotate.ts"),
];

/**
 * 注釈の経路に現れてはならない語（小文字化した本文への部分一致で見る）。
 *
 * `isTrusted` は `vscode.workspace.isTrusted` としても綴られる語なので、
 * **注釈の経路だけ**に当てる（`handlers/list-workspaces.ts` などでは正当に使う）。
 * 信頼の有無を注釈の描き方に持ち込まないことも、この検査の意味のうちである。
 */
const FORBIDDEN: readonly string[] = [
  "markdownstring",
  "istrusted",
  "supporthtml",
  "supportthemeicons",
  "baseuri",
  // 返信欄を生やす口とリアクションの口。設定すると読み取り専用でなくなる。
  "commentingrangeprovider",
  "reactionhandler",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function hitsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((word) => lower.includes(word));
}

describe("注釈の本文はプレーンな文字列（設計書 §3.2.1）", () => {
  it("走査対象のソースが実在する（空振りしていない）", () => {
    for (const rel of ANNOTATION_ROUTE) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} が無い`).toBe(true);
      expect(read(rel).length, `${rel} が空`).toBeGreaterThan(500);
    }
  });

  it("検出器が実際に禁止語を捕まえられる", () => {
    // 「1件も無い」を信用する前に、判定が本当に当たることを確かめる。
    expect(hitsIn("const b = new vscode.MarkdownString(x);")).toEqual(["markdownstring"]);
    expect(hitsIn("body.isTrusted = true;")).toEqual(["istrusted"]);
    expect(hitsIn("md.supportHtml = true; md.supportThemeIcons = true;")).toEqual([
      "supporthtml",
      "supportthemeicons",
    ]);
    expect(hitsIn("controller.reactionHandler = f;")).toEqual(["reactionhandler"]);
    // 普通のソースには当たらない。
    expect(
      hitsIn("const body = sanitizeDisplayText(item.text);\nthread.canReply = false;"),
    ).toEqual([]);
  });

  it("注釈の経路に禁止語が現れない", () => {
    const offenders = ANNOTATION_ROUTE.map((rel) => ({ rel, hits: hitsIn(read(rel)) })).filter(
      (entry) => entry.hits.length > 0,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * `CommentMode` は `Editing = 0` / `Preview = 1` である。**未設定は 0 側に
   * 倒れる**ので、明示しないと人間の画面に編集可能なコメント欄が出る。
   */
  it("comment の mode を Preview で明示している（未設定は Editing に倒れる）", () => {
    const source = read(path.join("packages", "extension", "src", "annotations.ts"));
    expect(source).toContain("vscode.CommentMode.Preview");
    expect(source).not.toContain("CommentMode.Editing");
  });

  it("返信できない吹き出しにしている", () => {
    const source = read(path.join("packages", "extension", "src", "annotations.ts"));
    expect(source).toContain("canReply = false");
  });

  /**
   * 無い UI の**観測**（増分6 D70）。`annotation-ui-observation.ts` は禁止語の2つを
   * **読む位置でだけ**綴ってよい（`hasCommentingRangeProvider` を実機で言うため）。
   * 代入（`= `。`===` / `!==` は比較なので除く）と、`Readonly` を外す `as` の型変換は
   * 書けない ―― 型で読み取り専用にした controller を `as` で戻せば、観測の口が
   * 設定の口になる。
   */
  const OBSERVATION = path.join("packages", "extension", "src", "annotation-ui-observation.ts");
  const ASSIGNS_PORT = /(commentingrangeprovider|reactionhandler)\s*=[^=]/i;
  const CASTS_CONTROLLER = [
    /as\s+vscode\.CommentController/,
    /controller\s+as\s/,
    /as\s+CommentController/,
  ];

  it("観測の検出器が代入と型変換を本当に捕まえる", () => {
    expect(ASSIGNS_PORT.test("controller.reactionHandler = f;")).toBe(true);
    expect(ASSIGNS_PORT.test("c.commentingRangeProvider={provideCommentingRanges}")).toBe(true);
    expect(
      ASSIGNS_PORT.test(
        "(observed.controller as vscode.CommentController).commentingRangeProvider = {}",
      ),
    ).toBe(true);
    // 比較は読む位置。
    expect(ASSIGNS_PORT.test("controller?.commentingRangeProvider !== undefined")).toBe(false);
    expect(ASSIGNS_PORT.test("controller?.reactionHandler !== undefined")).toBe(false);
    const casts = (text: string): boolean => CASTS_CONTROLLER.some((re) => re.test(text));
    expect(casts("(observed.controller as vscode.CommentController).x")).toBe(true);
    expect(casts("const c = controller as Mutable;")).toBe(true);
    expect(casts("x as CommentController")).toBe(true);
    expect(casts("controller: Readonly<vscode.CommentController> | undefined")).toBe(false);
  });

  it("観測のファイルは禁止語の2つを読む位置でだけ綴り、controller を as で戻さない", () => {
    const source = read(OBSERVATION);
    // 空振りでない: 観測は実際にその2つを読んでいる。
    expect(source).toContain("commentingRangeProvider");
    expect(source).toContain("reactionHandler");
    expect(source).toContain("Readonly<vscode.CommentController>");
    expect(ASSIGNS_PORT.exec(source)?.[0]).toBeUndefined();
    for (const re of CASTS_CONTROLLER) expect(re.exec(source)?.[0], String(re)).toBeUndefined();
  });

  /**
   * 本文が無害化を通っていること。
   *
   * 上の検査は「危ない型を使っていない」しか言わない。`string` でも双方向
   * オーバーライドと制御文字はそのまま描かれるので、無害化そのものは要る。
   * 実装は `protocol` に1つだけある（不変条件7。`test/single-sanitizer.test.ts`）。
   */
  it("本文が protocol の無害化を通っている", () => {
    const handler = read(path.join("packages", "extension", "src", "handlers", "annotate.ts"));
    expect(handler).toContain("sanitizeDisplayText");
    expect(handler).toContain("@zvx/vscode-showme-protocol");
  });

  /**
   * 作者名を引数にしない。
   *
   * 吹き出しには作者名が出る。エージェントに決めさせると、人間や VS Code を
   * 名乗った説明を描ける（ステータスバーの codicon なりすましと同じ形）。
   */
  it("作者名は固定のリテラルで、面の引数になっていない", () => {
    const surface = read(path.join("packages", "extension", "src", "handlers", "annotate.ts"));
    expect(surface).not.toContain("author");
    const source = read(path.join("packages", "extension", "src", "annotations.ts"));
    expect(source).toContain("AUTHOR");
  });
});
