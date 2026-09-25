import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { LANG_DEF_REL, LANG_POSITIONS, LANG_USE_REL } from "../fixture.js";
import {
  type LocationResult,
  STAGE_SCHEME_READONLY,
  activateExtension,
  describeLocation as describe,
  goToDefinitionFrom as f12,
  stageUri,
  waitFor,
  workspaceRoot,
} from "./helpers.js";

/**
 * 映しのタブ（`showme-ro:`）で定義・参照を引いたとき、TS 自身の結果と、同じ位置を `file:` に聞いて
 * 返す代理のプロバイダの結果が**重なって1つになるか**の実測（D88）。
 *
 * TS は映しを単独のファイルとして扱い、定義・参照をそのファイルの中の映しの URI で返す。代理の
 * 結果の写し方を5通り試す:
 *
 *   - `asIs`      : `file:` のまま返す
 *   - `sameFile`  : 映しと同じファイルの結果だけ映しの URI に写し、別のファイルは `file:` のまま
 *   - `allMirror` : ワークスペースの中の結果はすべて映しの URI に写す（外は `file:` のまま）
 *   - `otherFile` : 映しと同じファイルの結果は返さず（TS が映しの上で返す）、別のファイルは `file:` のまま
 *   - `otherMirror`: 同じファイルの結果は返さず、別のファイルは映しの URI に写す
 *
 * 比べる基準として、代理を登録しない回（`none`）も測る。判定は**測った結果そのもの**を固定する
 * （VS Code が重ねる／重ねないを推定で書かない）。人間が Ctrl+クリックしたとき、定義が2件以上だと
 * VS Code は飛ばずに覗き見（peek）を出す ―― 同じファイルの中の関数で2件になるのは退行である。
 *
 * 測った結果（統合テストが起動する VS Code で）: 参照は URI と範囲が同じものを1つに畳むが、**定義は畳まない**
 * （同じ URI・同じ範囲が2件のまま返り、F12 は飛ばずに覗き見になる）。TS は映しの上で import された
 * 名前の定義を **import の行**（同じファイル）に返すので、別のファイルで定義された名前は、どの写し方でも
 * 2件（import の行と本当の定義）になる。同じファイルの中の名前で1件に保てるのは、同じファイルの結果を
 * 返さない写し方（`otherFile` / `otherMirror`）だけである。
 *
 * 信頼の回だけで走らせる（制限モードでは TS が何も返さない）。
 *
 * **拡張の本物の代理（`stage-language.ts`）は外して測る**（`showme.test.stageLanguageRegistered`）。
 * 外さないと、ここで登録する試しの代理の結果が本物の代理の結果に重なり、表が「VS Code が畳むか」
 * ではなく「2つの代理の和」を測ってしまう。この表は写し方を選んだ根拠（B3）の記録として残す ――
 * VS Code が定義を畳むようになれば `sameFile` / `allMirror` の行が変わり、選び直す合図になる。
 * 本物の代理のふるまい（`otherFile` / `otherMirror` の行と同じ形）は `stage-language.test.ts` が見る。
 */

type Strategy = "none" | "asIs" | "sameFile" | "allMirror" | "otherFile" | "otherMirror";
type Delegating = Exclude<Strategy, "none">;
type Target = LocationResult;
type Location = vscode.Location;

function isLink(t: Target): t is vscode.LocationLink {
  return "targetUri" in t;
}

/** ワークスペース相対のパス。外なら undefined。 */
function relOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const rel = path.relative(workspaceRoot().fsPath, uri.fsPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/** 写した URI。返さない結果は undefined。 */
async function mapUri(
  strategy: Delegating,
  uri: vscode.Uri,
  mirrorRel: string,
): Promise<vscode.Uri | undefined> {
  const rel = relOf(uri);
  const same = rel === mirrorRel;
  if ((strategy === "otherFile" || strategy === "otherMirror") && same) return undefined;
  if (strategy === "asIs" || strategy === "otherFile" || rel === undefined) return uri;
  if (strategy === "sameFile" && !same) return uri;
  return stageUri(rel, STAGE_SCHEME_READONLY);
}

async function mapTargets(
  strategy: Delegating,
  targets: readonly Target[],
  mirrorRel: string,
): Promise<Target[]> {
  const out: Target[] = [];
  for (const t of targets) {
    const uri = await mapUri(strategy, isLink(t) ? t.targetUri : t.uri, mirrorRel);
    if (uri === undefined) continue;
    out.push(isLink(t) ? { ...t, targetUri: uri } : new vscode.Location(uri, t.range));
  }
  return out;
}

/** 映しの URI → 同じ rel の `file:`。測定では映しは `LANG_USE_REL` の1本だけ。 */
function registerDelegate(strategy: Delegating, fileUri: vscode.Uri, mirrorRel: string) {
  const selector: vscode.DocumentSelector = { scheme: STAGE_SCHEME_READONLY };
  return vscode.Disposable.from(
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(_doc, position) {
        const r = await vscode.commands.executeCommand<Target[]>(
          "vscode.executeDefinitionProvider",
          fileUri,
          position,
        );
        return (await mapTargets(strategy, r ?? [], mirrorRel)) as vscode.LocationLink[];
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(_doc, position) {
        const r = await vscode.commands.executeCommand<Location[]>(
          "vscode.executeReferenceProvider",
          fileUri,
          position,
        );
        return (await mapTargets(strategy, r ?? [], mirrorRel)) as Location[];
      },
    }),
  );
}

interface Row {
  readonly strategy: Strategy;
  readonly query: string;
  readonly results: readonly string[];
}

async function measure(strategy: Strategy, mirror: vscode.Uri): Promise<Row[]> {
  const imported = new vscode.Position(
    LANG_POSITIONS.importedCall.line,
    LANG_POSITIONS.importedCall.character,
  );
  const local = new vscode.Position(
    LANG_POSITIONS.localCall.line,
    LANG_POSITIONS.localCall.character,
  );
  const def = async (p: vscode.Position) =>
    (
      (await vscode.commands.executeCommand<Target[]>(
        "vscode.executeDefinitionProvider",
        mirror,
        p,
      )) ?? []
    ).map(describe);
  const refs = async (p: vscode.Position) =>
    (
      (await vscode.commands.executeCommand<Location[]>(
        "vscode.executeReferenceProvider",
        mirror,
        p,
      )) ?? []
    ).map(describe);
  return [
    { strategy, query: "F12(imported greet)", results: [await f12(mirror, imported)] },
    { strategy, query: "F12(same-file local)", results: [await f12(mirror, local)] },
    { strategy, query: "def(imported greet)", results: await def(imported) },
    { strategy, query: "def(same-file local)", results: await def(local) },
    { strategy, query: "refs(greet)", results: await refs(imported) },
    { strategy, query: "refs(local)", results: await refs(local) },
  ];
}

suite("映しのタブの定義・参照の重なり（実測）", () => {
  suiteSetup(async () => {
    await activateExtension();
    await vscode.commands.executeCommand("showme.test.stageLanguageRegistered", {
      registered: false,
    });
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("showme.test.stageLanguageRegistered", {
      registered: true,
    });
  });

  test("代理の写し方ごとに executeDefinitionProvider / executeReferenceProvider が返すもの", async function () {
    this.timeout(90_000);
    const fileUri = await stageUri(LANG_USE_REL, "file");
    const mirror = await stageUri(LANG_USE_REL, STAGE_SCHEME_READONLY);
    const defFile = await stageUri(LANG_DEF_REL, "file");
    await vscode.workspace.openTextDocument(defFile);
    await vscode.workspace.openTextDocument(fileUri);
    const mirrorDoc = await vscode.workspace.openTextDocument(mirror);
    assert.strictEqual(mirrorDoc.uri.scheme, STAGE_SCHEME_READONLY);

    const imported = new vscode.Position(
      LANG_POSITIONS.importedCall.line,
      LANG_POSITIONS.importedCall.character,
    );
    const local = new vscode.Position(
      LANG_POSITIONS.localCall.line,
      LANG_POSITIONS.localCall.character,
    );
    // TS が温まるまで待つ: file: で別ファイルの定義が出る、映しで同じファイルの定義が出る。
    await waitFor(
      "TS が file: で別ファイルの定義を返す",
      async () => {
        const r = await vscode.commands.executeCommand<Target[]>(
          "vscode.executeDefinitionProvider",
          fileUri,
          imported,
        );
        return (r ?? []).some((t) => describe(t).startsWith("file:a.ts@"));
      },
      60_000,
    );
    await waitFor(
      "TS が映しで同じファイルの定義を返す",
      async () => {
        const r = await vscode.commands.executeCommand<Target[]>(
          "vscode.executeDefinitionProvider",
          mirror,
          local,
        );
        return (r ?? []).length > 0;
      },
      60_000,
    );

    const rows: Row[] = [...(await measure("none", mirror))];
    for (const strategy of ["asIs", "sameFile", "allMirror", "otherFile", "otherMirror"] as const) {
      const d = registerDelegate(strategy, fileUri, LANG_USE_REL);
      try {
        rows.push(...(await measure(strategy, mirror)));
      } finally {
        d.dispose();
      }
    }
    for (const r of rows) {
      const dup = r.results.length - new Set(r.results).size;
      console.log(
        `[lang-measure] ${r.strategy.padEnd(11)} ${r.query.padEnd(21)} n=${r.results.length} dup=${dup} ${JSON.stringify(r.results)}`,
      );
    }

    // 測った表をそのまま固定する（並びは提供元の順に依るので、行ごとに並べ替えて比べる）。
    const actual = Object.fromEntries(
      rows.map((r) => [`${r.strategy} ${r.query}`, [...r.results].sort()]),
    );
    const expected: Record<string, string[]> = {};
    const put = (strategy: Strategy, query: string, results: string[]) => {
      expected[`${strategy} ${query}`] = [...results].sort();
    };
    const tsGreetRefs = ["showme-ro:b.ts@0:9", "showme-ro:b.ts@4:21", "showme-ro:b.ts@5:22"];
    const tsLocalRefs = ["showme-ro:b.ts@1:9", "showme-ro:b.ts@6:21", "showme-ro:b.ts@6:31"];
    // 代理なし: TS は映しの中だけ。import された名前の定義は import の行。
    put("none", "F12(imported greet)", ["jump showme-ro:b.ts@0:9"]);
    put("none", "F12(same-file local)", ["jump showme-ro:b.ts@1:9"]);
    put("none", "def(imported greet)", ["showme-ro:b.ts@0:9"]);
    put("none", "def(same-file local)", ["showme-ro:b.ts@1:9"]);
    put("none", "refs(greet)", tsGreetRefs);
    put("none", "refs(local)", tsLocalRefs);
    // (a) file: のまま: 何も重ならない（URI が違う）。定義は2件で F12 は覗き見。
    put("asIs", "F12(imported greet)", ["stayed"]);
    put("asIs", "F12(same-file local)", ["stayed"]);
    put("asIs", "def(imported greet)", ["file:a.ts@0:16", "showme-ro:b.ts@0:9"]);
    put("asIs", "def(same-file local)", ["file:b.ts@1:9", "showme-ro:b.ts@1:9"]);
    put("asIs", "refs(greet)", [
      "file:a.ts@0:16",
      "file:b.ts@0:9",
      "file:b.ts@4:21",
      "file:b.ts@5:22",
      ...tsGreetRefs,
    ]);
    put("asIs", "refs(local)", [
      "file:b.ts@1:9",
      "file:b.ts@6:21",
      "file:b.ts@6:31",
      ...tsLocalRefs,
    ]);
    // (b) 同じファイルだけ映しへ: 参照は畳まれる。定義は同じものが2件のまま（畳まれない）。
    put("sameFile", "F12(imported greet)", ["stayed"]);
    put("sameFile", "F12(same-file local)", ["stayed"]);
    put("sameFile", "def(imported greet)", ["file:a.ts@0:16", "showme-ro:b.ts@0:9"]);
    put("sameFile", "def(same-file local)", ["showme-ro:b.ts@1:9", "showme-ro:b.ts@1:9"]);
    put("sameFile", "refs(greet)", ["file:a.ts@0:16", ...tsGreetRefs]);
    put("sameFile", "refs(local)", tsLocalRefs);
    // (c) すべて映しへ: (b) と同じ形で、別のファイルが映しになるだけ。
    put("allMirror", "F12(imported greet)", ["stayed"]);
    put("allMirror", "F12(same-file local)", ["stayed"]);
    put("allMirror", "def(imported greet)", ["showme-ro:a.ts@0:16", "showme-ro:b.ts@0:9"]);
    put("allMirror", "def(same-file local)", ["showme-ro:b.ts@1:9", "showme-ro:b.ts@1:9"]);
    put("allMirror", "refs(greet)", ["showme-ro:a.ts@0:16", ...tsGreetRefs]);
    put("allMirror", "refs(local)", tsLocalRefs);
    // 同じファイルを返さない: 同じファイルの名前は TS の1件だけで F12 が飛ぶ。
    // import された名前は import の行と本当の定義の2件（覗き見）。
    put("otherFile", "F12(imported greet)", ["stayed"]);
    put("otherFile", "F12(same-file local)", ["jump showme-ro:b.ts@1:9"]);
    put("otherFile", "def(imported greet)", ["file:a.ts@0:16", "showme-ro:b.ts@0:9"]);
    put("otherFile", "def(same-file local)", ["showme-ro:b.ts@1:9"]);
    put("otherFile", "refs(greet)", ["file:a.ts@0:16", ...tsGreetRefs]);
    put("otherFile", "refs(local)", tsLocalRefs);
    put("otherMirror", "F12(imported greet)", ["stayed"]);
    put("otherMirror", "F12(same-file local)", ["jump showme-ro:b.ts@1:9"]);
    put("otherMirror", "def(imported greet)", ["showme-ro:a.ts@0:16", "showme-ro:b.ts@0:9"]);
    put("otherMirror", "def(same-file local)", ["showme-ro:b.ts@1:9"]);
    put("otherMirror", "refs(greet)", ["showme-ro:a.ts@0:16", ...tsGreetRefs]);
    put("otherMirror", "refs(local)", tsLocalRefs);
    assert.deepStrictEqual(actual, expected);
  });
});
