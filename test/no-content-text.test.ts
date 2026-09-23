import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **D20 の本体が残っていることの検査。**
 *
 * 増分3C で「色はエージェントに選ばせる」（D35）を入れた。D20 は
 * 「エージェントには範囲しか渡させない」と決めていたので、**その一部を覆している**。
 *
 * だが D20 の理由は色のものではない:
 *
 * > `contentText` を引数化すると、ファイルに存在しないテキストをエディタ内に
 * > 描けてしまい、「原典が隣に開いている」という唯一の緩和が無効になる。
 *
 * 色を変えてもエディタに描かれる文字はファイルの中身のままである。
 * **混ざっていた2つを分けた**ので、分けたことを検査で固定する ――
 * 次に「色を通したのだから `contentText` も」と考える人が現れたときに、赤くなる。
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const SCANNED = [
  path.join("packages", "protocol", "src"),
  path.join("packages", "bridge", "src"),
  path.join("packages", "extension", "src"),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("装飾にファイルに無い文字を描かせない（D20 の本体）", () => {
  const files = SCANNED.flatMap((rel) => sourceFiles(path.join(REPO_ROOT, rel)));

  it("走査対象が実際に見つかっている", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => path.relative(REPO_ROOT, f))).toContain(
      path.join("packages", "extension", "src", "decorations.ts"),
    );
  });

  it("contentText / before / after を装飾に渡していない", () => {
    // これらは `TextEditorDecorationType` に「ファイルに無い文字」を描かせる口である。
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // コメントの中の言及は許す（理由を書いてある）。実際の記法だけを見る。
      if (/contentText\s*:/.test(text)) offenders.push(`${file}: contentText:`);
      if (/\bbefore\s*:\s*\{/.test(text)) offenders.push(`${file}: before:`);
      if (/\bafter\s*:\s*\{/.test(text)) offenders.push(`${file}: after:`);
    }
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("色は通っている（D35 が入っていることも同時に見る）", () => {
    // 片方だけを検査すると、「全部禁止に戻した」も緑になる。
    const decorations = fs.readFileSync(
      path.join(REPO_ROOT, "packages", "extension", "src", "decorations.ts"),
      "utf8",
    );
    expect(decorations).toContain("HIGHLIGHT_RGBA");
  });
});
