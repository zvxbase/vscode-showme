import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_PATTERNS, loadExtraPatterns, scanTree } from "./scan-public-tree.mjs";

function tmpTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

describe("scan-public-tree", () => {
  it("内蔵パターン: 作業ディレクトリ・ホーム・セッション URL・メール・私設 IP に当たる", () => {
    const root = tmpTree({
      "a.md": "see /workspaces/foo/bar",
      "b.md": "at /home/someone/x",
      "c.md": "https://claude.ai/code/session_ABC",
      "d.md": "Claude-Session: x",
      "e.md": "mail me: someone@example.com",
      "f.md": "host 192.168.1.20",
    });
    const hits = scanTree(root, ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"], BUILTIN_PATTERNS);
    expect(hits.map((h) => h.file).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
      "f.md",
    ]);
  });

  it("良性の入力には当たらない（両方向の検査）", () => {
    const root = tmpTree({
      "ok.md": [
        "publisher zvxbase, repo github.com/zvxbase/vscode-showme",
        "users.noreply.github.com is mentioned as a concept, not an address",
        "10.0.0.0/8 is not the private range we forbid",
        "the workspace folder is ${workspaceFolder}",
        "fixture path /home/me/.aws/credentials is a placeholder, not a person",
      ].join("\n"),
    });
    expect(scanTree(root, ["ok.md"], BUILTIN_PATTERNS)).toEqual([]);
  });

  it("--extra の一覧（1行1正規表現、# はコメント）が加わる", () => {
    const root = tmpTree({
      "x.md": "the old org was secret-org-name",
      "terms.txt": "# comment\nsecret-org-name\n\n",
    });
    const extra = loadExtraPatterns(path.join(root, "terms.txt"));
    expect(extra).toHaveLength(1);
    const hits = scanTree(root, ["x.md"], [...BUILTIN_PATTERNS, ...extra]);
    expect(hits).toEqual([{ file: "x.md", line: 1, label: "extra:secret-org-name" }]);
  });

  it("バイナリ（NUL を含む）は読まずに飛ばす", () => {
    const root = tmpTree({ "bin.dat": "abc\u0000/workspaces/x" });
    expect(scanTree(root, ["bin.dat"], BUILTIN_PATTERNS)).toEqual([]);
  });

  it("第三者の表示（THIRD-PARTY-NOTICES.txt）は作者のメールを再現してよいが、私たちの固有名は当てる", () => {
    const root = tmpTree({
      "extension/THIRD-PARTY-NOTICES.txt":
        "Copyright (c) 2019 Someone (someone@example.com)\nsecret-org-name",
      "extension/README.md": "contact someone@example.com",
    });
    const extra = [{ label: "extra:secret-org-name", re: /secret-org-name/i }];
    const hits = scanTree(
      root,
      ["extension/THIRD-PARTY-NOTICES.txt", "extension/README.md"],
      [...BUILTIN_PATTERNS, ...extra],
    );
    expect(hits).toEqual([
      { file: "extension/THIRD-PARTY-NOTICES.txt", line: 2, label: "extra:secret-org-name" },
      { file: "extension/README.md", line: 1, label: "email-address" },
    ]);
  });

  it("許可した公開連絡先だけはメールとして当たらない", () => {
    const root = tmpTree({
      "s.md": "email security@zvxbase.com",
      "c.md": "Co-Authored-By: Claude <noreply@anthropic.com>",
      "t.md": "email other@zvxbase.com",
    });
    expect(scanTree(root, ["s.md", "c.md"], BUILTIN_PATTERNS)).toEqual([]);
    expect(scanTree(root, ["t.md"], BUILTIN_PATTERNS)).toHaveLength(1);
  });
});
