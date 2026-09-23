import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPackages, licensePolicyViolations, renderNotices } from "./third-party-notices.mjs";

function fakePackage(root: string, rel: string, json: object, files: Record<string, string>): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
}

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tpn-"));
  fakePackage(
    root,
    "node_modules/a",
    { name: "a", version: "1.0.0", license: "MIT" },
    { LICENSE: "Copyright (c) A\nMIT text" },
  );
  fakePackage(
    root,
    "node_modules/@s/b",
    { name: "@s/b", version: "2.0.0", license: "BSD-3-Clause" },
    { "LICENSE.md": "Copyright (c) B\nBSD text" },
  );
  fakePackage(
    root,
    "node_modules/a/node_modules/c",
    { name: "c", version: "3.0.0", license: "Apache-2.0" },
    { LICENSE: "Apache text", NOTICE: "C notice" },
  );
  return root;
}

describe("third-party-notices", () => {
  it("束ねた入力から、実際に入ったパッケージだけを（入れ子も区別して）拾う", () => {
    const root = tree();
    const metafile = {
      inputs: {
        "src/own.ts": {},
        "../../node_modules/a/index.js": {},
        "../../node_modules/a/lib/x.js": {},
        "../../node_modules/@s/b/dist/b.js": {},
        "../../node_modules/a/node_modules/c/c.js": {},
      },
    };
    const pkgs = bundledPackages([metafile], path.join(root, "packages", "extension"));
    expect(pkgs.map((p) => `${p.name}@${p.version}`)).toEqual(["@s/b@2.0.0", "a@1.0.0", "c@3.0.0"]);
  });

  it("本文にはパッケージごとにライセンス全文と NOTICE を入れる", () => {
    const root = tree();
    const metafile = {
      inputs: {
        "../../node_modules/a/index.js": {},
        "../../node_modules/a/node_modules/c/c.js": {},
      },
    };
    const text = renderNotices(
      bundledPackages([metafile], path.join(root, "packages", "extension")),
    );
    expect(text).toContain("a 1.0.0 (MIT)");
    expect(text).toContain("Copyright (c) A\nMIT text");
    expect(text).toContain("c 3.0.0 (Apache-2.0)");
    expect(text).toContain("Apache text");
    expect(text).toContain("C notice");
  });

  it("許可していないライセンスと、ライセンス文の無いパッケージは違反として返す（両方向）", () => {
    const ok = [{ name: "a", version: "1", license: "MIT", licenseText: "x", noticeText: "" }];
    expect(licensePolicyViolations(ok)).toEqual([]);
    const bad = [
      { name: "g", version: "1", license: "GPL-3.0", licenseText: "x", noticeText: "" },
      { name: "n", version: "1", license: "MIT", licenseText: "", noticeText: "" },
    ];
    expect(licensePolicyViolations(bad)).toEqual([
      "g@1: license GPL-3.0 is not in the allowlist",
      "n@1: no license file to reproduce",
    ]);
  });
});
