import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "./tools.js";

/**
 * **削除は「消した」で終わらせない。残っていないことを検査で言う**（設計 D50 §6.4）。
 *
 * 消し漏れは黙っている ―― ツール一覧から外しても、ハンドラが残っていれば
 * 次の人が「使われているのだろう」と読んで復活させる。3.29 MiB の
 * バンドルが `media/` に残っていても、誰も気づかない。
 *
 * `source-hygiene.test.ts` と同じ形で、**リポジトリ全体に当てる**。
 */
describe("show_mermaid は残っていない", () => {
  it("ツール一覧に無い", () => {
    expect(TOOL_NAMES as readonly string[]).not.toContain("show_mermaid");
  });

  it("docs/ 以外に mermaid の綴りが1件も無い", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    // 追跡下のファイルだけを見る（node_modules と out は git が持っていない）。
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => f.length > 0)
      // 設計書とレビュー所見には歴史として残す（人間の判断。設計 §6.3）。
      .filter((f) => !f.startsWith("docs/"))
      // この検査自身は "mermaid" という綴りを持つ。
      .filter((f) => !f.endsWith("no-mermaid.test.ts"));

    const offenders: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        // **作業ツリーを読む。** git の索引や直前のコミットを読むと、
        // いま消した変更が検査に反映されない。
        // バイナリは読めずに投げるので飲む。
        text = fs.readFileSync(path.join(repoRoot, file), "utf8");
      } catch {
        continue;
      }
      if (/mermaid/i.test(text)) offenders.push(file);
    }
    expect(offenders, `mermaid が残っている: ${offenders.join(", ")}`).toEqual([]);
  });
});
