// VSIX に束ねた第三者パッケージの表示（THIRD-PARTY-NOTICES.txt）を作る。
//
// 束ねる（esbuild）と各パッケージの LICENSE ファイルは配布物から落ちる。MIT / ISC は
// 「すべての複製に表示を含めよ」、BSD は「バイナリ形式の再配布では、配布物に同梱する
// 文書に表示・条件・免責を再現せよ」と求めるので、それを1本の文書として VSIX に入れる。
//
// **一覧は手で持たない。** 何を配っているかを決めているのは esbuild の束ねる処理
// なので、その metafile の inputs から導く（package.json の dependencies から導くと、
// 推移的な依存と、import されずに束に入らない依存の両方で食い違う）。
import * as fs from "node:fs";
import * as path from "node:path";

/** 配ってよいライセンス。ここに無いものが束に入ったら、ビルドを止めて人が決める。 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
]);

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

function readFirst(dir, re) {
  const f = fs.readdirSync(dir).find((name) => re.test(name));
  return f ? fs.readFileSync(path.join(dir, f), "utf8").trim() : "";
}

/**
 * metafile の inputs（`absWorkingDir` からの相対パス）から、束に入ったパッケージを返す。
 * 入れ子の node_modules は**最も内側**のパッケージに帰属させる（同名の別版を区別する）。
 */
export function bundledPackages(metafiles, absWorkingDir) {
  const dirs = new Set();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const i = input.lastIndexOf("node_modules/");
      if (i < 0) continue;
      const rest = input.slice(i + "node_modules/".length).split("/");
      const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
      dirs.add(path.resolve(absWorkingDir, input.slice(0, i), "node_modules", name));
    }
  }
  const pkgs = [...dirs].map((dir) => {
    const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return {
      name: json.name,
      version: json.version,
      license:
        typeof json.license === "string" ? json.license : JSON.stringify(json.licenses ?? null),
      licenseText: readFirst(dir, LICENSE_FILE),
      noticeText: readFirst(dir, NOTICE_FILE),
    };
  });
  return pkgs.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

/** 方針に反するものを人が読める文で返す（空なら配ってよい）。 */
export function licensePolicyViolations(pkgs) {
  const out = [];
  for (const p of pkgs) {
    if (!ALLOWED_LICENSES.has(p.license))
      out.push(`${p.name}@${p.version}: license ${p.license} is not in the allowlist`);
    else if (p.licenseText === "") out.push(`${p.name}@${p.version}: no license file to reproduce`);
  }
  return out;
}

export function renderNotices(pkgs) {
  const rule = "-".repeat(72);
  const head = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    "This extension bundles the following third-party components. Each is",
    "distributed under the license reproduced below, which applies to that",
    "component only. The extension itself is licensed under the MIT License",
    "(see LICENSE).",
    "",
  ];
  const body = pkgs.flatMap((p) => [
    rule,
    `${p.name} ${p.version} (${p.license})`,
    rule,
    "",
    p.licenseText,
    ...(p.noticeText ? ["", "NOTICE:", "", p.noticeText] : []),
    "",
  ]);
  return `${[...head, ...body].join("\n")}\n`;
}
