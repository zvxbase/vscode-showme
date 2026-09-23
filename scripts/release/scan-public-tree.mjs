// 公開ツリーに内部識別子が無いことを機構で確かめる。
//
// 2層: ここに内蔵するのは「どの repo でも公開してはいけない形」だけ（作業ディレクトリ、
// ホーム、エージェントのセッション URL、メールアドレス、私設 IP）。固有名（人名・アカウント名・
// private org 名・内部ホスト名）は公開 repo に一覧ごと漏れるので内蔵しない ―― private 側の
// 一覧を --extra で渡す。
//
// 使い方: node scripts/release/scan-public-tree.mjs [--root DIR] [--extra FILE] [--list FILE]
//   --root  走査するツリー（既定: cwd）
//   --extra 追加パターン。1行1正規表現、空行と # 行は無視
//   --list  走査対象の相対パス一覧（既定: `git ls-files` を root で実行）
//   --text  ツリーではなく1つのテキストファイル（コミット本文・コメント本文）を走査する
// 終了コード: 0 = 当たり無し、1 = 当たり有り、2 = 使い方の誤り
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
/**
 * 公開ツリーに入らないパスは走査しない。一覧は private の repo にだけある
 * 。公開 repo には落とす対象そのものが無いので、無くてよい。
 */
const isDropped = await import("../private/public-tree.mjs").then(
  (m) => m.isDropped,
  () => () => false,
);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export const BUILTIN_PATTERNS = [
  { label: "workspace-path", re: /\/workspaces\/[A-Za-z0-9._-]+/ },
  // 占位子（me / user / you）は許す ―― テストの fixture が使う。実在のユーザー名だけを咎める。
  { label: "home-path", re: /\/home\/(?!(?:me|user|you)\/)[a-z_][a-z0-9_-]*\// },
  { label: "agent-session-url", re: /claude\.ai\/code\//i },
  { label: "agent-session-trailer", re: /Claude-Session:/ },
  { label: "email-address", re: EMAIL },
  { label: "private-ipv4", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
];

/** 意図して公開する連絡先。ここに無いアドレスは全部当たり。 */
const ALLOWED_EMAILS = new Set(["security@zvxbase.com", "noreply@anthropic.com"]);

/**
 * 第三者のライセンス文を**逐語で再現する**ファイル。著作権表示に作者のメールが入っていて
 * （例: parse5）、ライセンスはそれを消さずに再現することを求める。だからメールの規則だけを
 * 外す ―― 私たちの固有名・パス・セッション参照の規則は、このファイルにも当て続ける。
 */
const REPRODUCED_LEGAL_TEXT = /(^|\/)THIRD-PARTY-NOTICES\.txt$/;

/** 走査から外すもの: 走査器自身（パターンの説明文が自分に当たる）と、その検査。 */
const SELF = new Set([
  "scripts/release/scan-public-tree.mjs",
  "scripts/release/scan-public-tree.test.ts",
]);

export function loadExtraPatterns(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push({ label: `extra:${line}`, re: new RegExp(line, "i") });
  }
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function lineHits(text, patterns, rel) {
  const labels = [];
  for (const p of patterns) {
    if (!p.re.test(text)) continue;
    if (p.label === "email-address") {
      if (REPRODUCED_LEGAL_TEXT.test(rel)) continue;
      const all = text.match(new RegExp(EMAIL.source, "g")) ?? [];
      if (all.every((e) => ALLOWED_EMAILS.has(e))) continue;
    }
    labels.push(p.label);
  }
  return labels;
}

export function scanTree(root, files, patterns) {
  const hits = [];
  for (const rel of files) {
    if (SELF.has(rel)) continue;
    if (isDropped(rel)) continue; // 公開ツリーに入らないもの（一覧は public-tree.mjs）
    const abs = path.join(root, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // 一覧にあるが無い（削除済み）ものは対象外
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const label of lineHits(text, patterns, rel))
        hits.push({ file: rel, line: i + 1, label });
    });
  }
  return hits;
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter((s) => s !== "");
}

function main(argv) {
  let root = process.cwd();
  let extra = null;
  let list = null;
  let text = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = path.resolve(argv[++i]);
    else if (a === "--extra") extra = argv[++i];
    else if (a === "--list") list = argv[++i];
    else if (a === "--text") text = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }
  const patterns = [...BUILTIN_PATTERNS, ...(extra ? loadExtraPatterns(extra) : [])];
  let files;
  if (text) {
    // 1ファイルだけ: root をそのファイルのディレクトリに、一覧をそのファイル名にする
    root = path.dirname(path.resolve(text));
    files = [path.basename(text)];
  } else {
    files = list
      ? fs.readFileSync(list, "utf8").split(/\r?\n/).filter(Boolean)
      : trackedFiles(root);
  }
  const hits = scanTree(root, files, patterns);
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.label}`);
  console.log(
    `scan-public-tree: ${files.length} file(s), ${patterns.length} pattern(s) (${extra ? "with" : "WITHOUT"} extra list), ${hits.length} hit(s)`,
  );
  return hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)));
}
