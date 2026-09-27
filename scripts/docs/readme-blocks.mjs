// README の共通部分を宣言から生成し、手で書いた部分が宣言とずれていないかを検査する（D96）。
//
// 真実が `package.json` と文言ファイル（`package.nls*.json`・`l10n/bundle.l10n*.json`）にあるものは
// README に手で書かない。手で書くと、宣言を直したときに README だけが古いまま残り、しかも
// 英語版と日本語版で別々に古くなる。だから目印で囲んだ範囲はこの生成器が書き、`--check` が
// 「生成し直しても同じか」を見る。
//
// 使い方: node scripts/docs/readme-blocks.mjs --write | --check | --stamp
//   --write  README.md と README.ja.md の生成範囲を書き直す（範囲の外は変えない）
//   --check  生成し直すと変わるなら、どの範囲かを言って exit 1。本文の `ShowMe: …` も照合し、
//            2つの README の構造と、日本語版の訳の印（D97）も見る
//   --stamp  日本語版の訳の印を、英語版の今の内容で書き直す（訳を直した人が打つ）
//
// 公開 repo にも入る。公開 repo の CI の `npm run test` でも同じ検査を
// 回すため（単体の検査がこの repo の README に `checkAll` を当てる）。
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REGION_NAMES = ["commands", "settings"];
export const FILES = { en: "README.md", ja: "README.ja.md" };

/**
 * 入口で改行を LF にそろえ、先頭の BOM を外す。Windows の作業ツリー（core.autocrlf）や
 * エディタが CRLF・BOM を付けても、生成・照合・ハッシュが同じ判定になるように。`--write` は LF で書く。
 */
export function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * フェンスで囲んだコードの行か（フェンスの行も含む）を行ごとに返す。CommonMark と同じく、
 * 閉じるのは**同じ文字で、開いたときと同じか長い**フェンスだけ（\`\`\`\` の中の \`\`\` は閉じない）。
 * 見出し・コードブロック・名前の照合が、この1つを使う。値は false（地の文）か、"open" / "body" /
 * "close"（開くフェンス・中身・閉じるフェンス）。
 */
export function fencedLines(lines) {
  const out = [];
  let open = null;
  for (const line of lines) {
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) open = { ch: m[1][0], len: m[1].length };
      out.push(open !== null ? "open" : false);
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) {
        open = null;
        out.push("close");
      } else out.push("body");
    }
  }
  return out;
}

// ---- 元データ ---------------------------------------------------------------

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 生成と照合に使う宣言を読む。検査が差し替えられるように、ただの値にして返す。 */
export function loadSources(root) {
  const ext = path.join(root, "packages", "extension");
  return {
    manifest: readJson(path.join(ext, "package.json")),
    nls: {
      en: readJson(path.join(ext, "package.nls.json")),
      ja: readJson(path.join(ext, "package.nls.ja.json")),
    },
    // 画面の文言は英語が鍵そのもの（vscode.l10n）。日本語は鍵 → 訳
    l10nJa: readJson(path.join(ext, "l10n", "bundle.l10n.ja.json")),
    // 命令の説明は宣言に無い（VS Code は命令に説明を持たない）。英日を1か所に置く
    commandDescriptions: readJson(path.join(root, "scripts", "docs", "command-descriptions.json")),
  };
}

function nlsValue(src, lang, ref) {
  const m = /^%(.+)%$/.exec(ref ?? "");
  if (!m) return ref;
  const v = src.nls[lang][m[1]];
  if (typeof v !== "string") throw new Error(`${m[1]} is missing from package.nls (${lang})`);
  return v;
}

/**
 * コマンドパレットに出る命令。`menus.commandPalette` で `when: "false"` の命令（吹き出しのボタンの
 * ように引数が要るもの）は出ないので載せない。条件付きで出る命令は載せ、その条件を説明に書く ――
 * 説明の元データに条件を写しておき（`paletteWhen`）、宣言の条件が変わったら止める
 * （説明が古い条件を言い続けないように）。
 */
export function paletteCommands(src) {
  const { commands, menus } = src.manifest.contributes;
  const whenOf = new Map((menus?.commandPalette ?? []).map((m) => [m.command, m.when]));
  const out = [];
  for (const c of commands) {
    const when = whenOf.get(c.command);
    if (when === "false") continue;
    const d = src.commandDescriptions[c.command];
    if (!d?.en || !d?.ja) {
      throw new Error(`${c.command} has no description in scripts/docs/command-descriptions.json`);
    }
    if ((d.paletteWhen ?? undefined) !== (when ?? undefined)) {
      throw new Error(
        `${c.command}: the Command Palette "when" is ${JSON.stringify(when)} in package.json but ${JSON.stringify(d.paletteWhen)} in scripts/docs/command-descriptions.json. Update the description for the new condition, then its paletteWhen.`,
      );
    }
    out.push({
      id: c.command,
      title: { en: nlsValue(src, "en", c.title), ja: nlsValue(src, "ja", c.title) },
      description: { en: d.en, ja: d.ja },
    });
  }
  const listed = new Set(out.map((c) => c.id));
  for (const id of Object.keys(src.commandDescriptions)) {
    if (!listed.has(id)) {
      throw new Error(`${id} is in scripts/docs/command-descriptions.json but not in the palette`);
    }
  }
  return out;
}

// ---- 表の生成 ---------------------------------------------------------------

/**
 * 宣言の文言を表のセルに入れる。`|` は表を壊し、`*`（`*.pem / … id_rsa*`）と `_`（`__pycache__`）は強調になり、
 * バッククォートはコードになる。宣言の文言は設定画面では平文なので、README でも平文に見せる。
 */
export function escapeCell(s) {
  return s.replace(/[\\`*_|<]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, " ");
}

function renderCommands(lang, src) {
  const head =
    lang === "en"
      ? ["| Command | What it does |", "|---|---|"]
      : ["| コマンド | すること |", "|---|---|"];
  const body = paletteCommands(src).map((c) => {
    // 日本語版は英語名を並べる。日本語化の拡張を入れていない VS Code では英語名で出るため
    const name = lang === "en" ? `**${c.title.en}**` : `**${c.title.ja}**（\`${c.title.en}\`）`;
    return `| ${name} | ${escapeCell(c.description[lang])} |`;
  });
  return [...head, ...body].join("\n");
}

function renderSettings(lang, src) {
  const head =
    lang === "en"
      ? ["| Setting | Default | Meaning |", "|---|---|---|"]
      : ["| 設定 | 既定 | 意味 |", "|---|---|---|"];
  const configs = [src.manifest.contributes.configuration].flat();
  const body = [];
  // 全部の設定を載せる（載せない設定の一覧は持たない ―― 今は無い。作るならここに理由と共に置く）
  for (const conf of configs) {
    for (const [key, p] of Object.entries(conf.properties)) {
      let text = escapeCell(nlsValue(src, lang, p.markdownDescription ?? p.description));
      if (Array.isArray(p.enum) && Array.isArray(p.enumDescriptions)) {
        const parts = p.enum.map(
          (v, i) =>
            `\`${JSON.stringify(v)}\`: ${escapeCell(nlsValue(src, lang, p.enumDescriptions[i]))}`,
        );
        text = `${text} ${parts.join(" ")}`;
      }
      body.push(`| \`${key}\` | \`${JSON.stringify(p.default)}\` | ${text} |`);
    }
  }
  return [...head, ...body].join("\n");
}

export function renderRegion(name, lang, src) {
  if (name === "commands") return renderCommands(lang, src);
  if (name === "settings") return renderSettings(lang, src);
  throw new Error(`unknown region: ${name}`);
}

// ---- 生成範囲 ---------------------------------------------------------------

const MARKER = /^<!-- (BEGIN|END) GENERATED: ([\w-]+) -->$/;

/** 目印の対を探す。形が壊れていれば errors に入れる（生成も検査もしない）。 */
export function findRegions(text) {
  const lines = normalizeText(text).split("\n");
  const regions = [];
  const errors = [];
  let open = null;
  lines.forEach((line, i) => {
    const m = MARKER.exec(line.trimEnd());
    if (!m) return;
    const [, kind, name] = m;
    if (kind === "BEGIN") {
      if (open) errors.push(`line ${i + 1}: region "${name}" starts inside region "${open.name}"`);
      else open = { name, begin: i };
    } else if (!open || open.name !== name) {
      errors.push(`line ${i + 1}: END of region "${name}" without its BEGIN`);
    } else {
      regions.push({ name, begin: open.begin, end: i });
      open = null;
    }
  });
  if (open) errors.push(`line ${open.begin + 1}: region "${open.name}" is not closed`);
  const seen = new Set();
  for (const r of regions) {
    if (!REGION_NAMES.includes(r.name)) errors.push(`unknown region "${r.name}"`);
    if (seen.has(r.name)) errors.push(`region "${r.name}" appears twice`);
    seen.add(r.name);
  }
  for (const name of REGION_NAMES) {
    if (!seen.has(name)) errors.push(`region "${name}" is missing`);
  }
  return { lines, regions, errors };
}

/** 生成範囲の中を書き直したテキストを返す。形が壊れていれば元のまま errors を返す。 */
export function applyRegions(rawText, lang, src) {
  const text = normalizeText(rawText);
  const { lines, regions, errors } = findRegions(text);
  if (errors.length > 0) return { text, errors };
  const out = [];
  let last = 0;
  for (const r of regions) {
    out.push(...lines.slice(last, r.begin + 1));
    out.push(renderRegion(r.name, lang, src));
    last = r.end;
  }
  out.push(...lines.slice(last));
  return { text: out.join("\n"), errors: [] };
}

/** 生成範囲の中身を取り除いたテキスト（目印の行は残す）。 */
export function withoutRegionBodies(text) {
  const { lines, regions } = findRegions(text);
  const drop = new Set();
  for (const r of regions) for (let i = r.begin + 1; i < r.end; i++) drop.add(i);
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

// ---- 本文の `ShowMe: …` の照合 -----------------------------------------------

const PREFIX = "ShowMe: ";
const ELLIPSIS = "…";

/**
 * 照合できる名前: 命令名（nls）と、`ShowMe: ` で始まる画面の文言（l10n。ステータスバーの
 * `ShowMe: Off` など）。同じものの英日を同じ id にまとめる（組の一致はこの id で見る）。
 */
function nameTable(src) {
  const entries = [];
  for (const c of src.manifest.contributes.commands) {
    const en = nlsValue(src, "en", c.title);
    if (!en.startsWith(PREFIX)) continue;
    entries.push({ id: `command ${c.command}`, en, ja: nlsValue(src, "ja", c.title) });
  }
  for (const [en, ja] of Object.entries(src.l10nJa)) {
    if (en.startsWith(PREFIX)) entries.push({ id: `l10n ${en}`, en, ja });
  }
  return entries;
}

/**
 * 名前を id に解決する。`…` で終わる名前は省略で、`{0}` を持つ文言のうち前の部分が一致する
 * ものに当てる（`ShowMe: not found …` → `ShowMe: not found in {0}`）。1つに決まらなければ曖昧。
 */
function resolveName(name, lang, table) {
  if (name.endsWith(ELLIPSIS)) {
    const prefix = name.slice(0, -ELLIPSIS.length).trimEnd();
    const hits = table.filter((e) => e[lang].startsWith(prefix) && /\{\d+\}/.test(e[lang]));
    if (hits.length === 1) return { id: hits[0].id };
    if (hits.length > 1) return { error: "is ambiguous (matches more than one string)" };
    return { error: "is not a command title or a status string" };
  }
  const hit = table.find((e) => e[lang] === name);
  return hit ? { id: hit.id } : { error: "is not a command title or a status string" };
}

/**
 * 照合しない所を空白で塗る（改行は残して位置と行番号を保つ）: HTML の注釈、フェンスの中、
 * 生成範囲の中身（生成器が名前を保証する。宣言の説明文に命令名が入っても、ここでは咎めない）。
 */
function maskUnchecked(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const { regions } = findRegions(text);
  const inRegion = new Set();
  for (const r of regions) for (let i = r.begin + 1; i < r.end; i++) inRegion.add(i);
  const masked = lines.map((l, i) => (fenced[i] || inRegion.has(i) ? blank(l) : l)).join("\n");
  return masked.replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * 本文の `ShowMe: ` を、囲みごとに拾う。照合できる囲み: 強調（`**…**` / `__…__`）、コード
 * （`` `…` ``。強調の中のコードも）、リンクの文字（`[…](…)`）、見出しの行。斜体は、文の中の
 * `*` と区別できず名前の終わりが決まらないので、斜体だと言って断る。
 */
function findSpans(text) {
  const spans = [];
  const errors = [];
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/ShowMe: /g)) {
    const i = m.index;
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    const lineEnd = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    const before2 = text.slice(i - 2, i);
    let end;
    let after;
    if (text[i - 1] === "`") {
      end = text.indexOf("`", i);
      after = end + 1;
      const wrap = text.slice(i - 3, i - 1);
      if ((wrap === "**" || wrap === "__") && text.slice(after, after + 2) === wrap) after += 2;
    } else if (before2 === "**" || before2 === "__") {
      end = text.indexOf(before2, i);
      after = end + 2;
    } else if (text[i - 1] === "[") {
      end = text.indexOf("]", i);
      after = end + 1;
    } else if (/^ {0,3}#{1,6} +$/.test(text.slice(lineStart, i))) {
      // 見出しの名前は行末まで。ただし （ かバッククォートの前で終わる（日本語版の組の英語名）
      const rest = text.slice(i, lineEnd);
      const stop = rest.search(/[（`]/);
      end =
        i +
        (stop >= 0 ? rest.slice(0, stop) : rest.trimEnd().replace(/ +#+$/, "")).trimEnd().length;
      after = i + (stop >= 0 ? stop : end - i);
    } else if (text[i - 1] === "*" || text[i - 1] === "_") {
      errors.push(
        `line ${lineOf(i)}: "ShowMe: …" in italics cannot be checked; use **bold** or \`code\``,
      );
      continue;
    } else {
      errors.push(
        `line ${lineOf(i)}: "ShowMe: …" must be in **bold**, \`code\`, a link text or a heading so it can be checked`,
      );
      continue;
    }
    if (end < 0 || end > lineEnd) {
      errors.push(`line ${lineOf(i)}: "ShowMe: …" is not closed on the same line`);
      continue;
    }
    spans.push({ start: i, end, after, name: text.slice(i, end), line: lineOf(i) });
  }
  return { spans, errors };
}

/**
 * 英語版: `ShowMe: …` はどれも実在する英語名。
 * 日本語版: 日本語名の直後に（`英語名`）を置き、両方が実在して同じものを指す。
 * 英語名だけを書くのは、日本語名の後ろの括弧の中に限る。
 */
export function checkNames(rawText, lang, src) {
  const table = nameTable(src);
  const text = maskUnchecked(normalizeText(rawText));
  const { spans, errors } = findSpans(text);
  const byStart = new Map(spans.map((s) => [s.start, s]));
  const consumed = new Set();
  for (const s of spans) {
    if (consumed.has(s.start)) continue;
    const where = `line ${s.line}: "${s.name}"`;
    if (lang === "en") {
      const r = resolveName(s.name, "en", table);
      if (r.error) errors.push(`${where} ${r.error}`);
      continue;
    }
    const ja = resolveName(s.name, "ja", table);
    if (ja.error) {
      const en = resolveName(s.name, "en", table);
      errors.push(
        en.error
          ? `${where} ${ja.error}`
          : `${where} is an English name; write the Japanese name followed by （\`${s.name}\`）`,
      );
      continue;
    }
    const pair = /^（`/.test(text.slice(s.after, s.after + 2)) ? byStart.get(s.after + 2) : null;
    if (!pair || text.slice(pair.end, pair.end + 2) !== "`）") {
      errors.push(`${where} must be followed by its English name, as （\`ShowMe: …\`）`);
      continue;
    }
    consumed.add(pair.start);
    const en = resolveName(pair.name, "en", table);
    if (en.error) errors.push(`line ${pair.line}: "${pair.name}" ${en.error}`);
    else if (en.id !== ja.id) {
      const want = table.find((e) => e.id === ja.id)?.en;
      errors.push(`${where} is paired with "${pair.name}", but its English name is "${want}"`);
    }
  }
  return errors;
}

// ---- 訳の印と構造（D97） ------------------------------------------------------
//
// README.ja.md の先頭に、元にした README.md の**節ごとの内容のハッシュ**を置く。英語版の節を
// 直すとハッシュが変わり、検査がその節の名前を挙げて止まる ―― 訳の更新漏れが黙って残らない。
// 訳を直した人が `--stamp` で記録を更新する。記録の更新は「訳を追いつかせた」という宣言であり、
// 訳の中身までは検査しない（それは人のレビュー）。
//
// コミットのハッシュではなく内容のハッシュにするのは、公開 repo がリリースごとに1コミットに
// 畳まれてコミットのハッシュが private と一致しないため。内容のハッシュは両方で同じ。
// 生成範囲（D96）はハッシュから除く ―― 生成器が両方を同時に書くので、訳の追従は要らない。

// 記録はファイルの先頭に1つ。読むときは BOM と先頭の空行を許し、書くときは既存の記録を
// （どこにあっても）全部外してから先頭に1つ置く ―― 2つ目を足さない。
const STAMP = /<!-- translated-from README\.md: (\{[\s\S]*?\}) -->\n*/g;

/** 見出し（H1〜H3）ごとの節。フェンスの中の `#` は見出しにしない。見出しの前は level 0。 */
export function parseSections(text) {
  const lines = normalizeText(text).split("\n");
  const fenced = fencedLines(lines);
  const sections = [{ level: 0, heading: "", lines: [] }];
  for (const [i, line] of lines.entries()) {
    const h = fenced[i] ? null : /^ {0,3}(#{1,3}) +(.+?)\s*$/.exec(line);
    if (h) sections.push({ level: h[1].length, heading: h[2], lines: [line] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/** 節の見出しを記録の鍵にする。同じ見出しが2つあれば2つ目以降に番号を付ける。 */
function sectionKeys(sections) {
  const seen = new Map();
  return sections.map((s) => {
    const base = s.level === 0 ? "(before the title)" : s.heading;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

const sha16 = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** 英語版の節ごとの内容のハッシュ（生成範囲の中身と、行末の空白・節の前後の空行は除く）。 */
export function sectionHashes(enText) {
  const sections = parseSections(withoutRegionBodies(enText));
  const keys = sectionKeys(sections);
  const out = {};
  sections.forEach((s, i) => {
    const body = s.lines
      .map((l) => l.trimEnd())
      .join("\n")
      .trim();
    if (s.level === 0 && body === "") return;
    out[keys[i]] = sha16(body);
  });
  return out;
}

function findStamps(jaText) {
  return [...normalizeText(jaText).matchAll(STAMP)];
}

export function readStamp(jaText) {
  const [m] = findStamps(jaText);
  return m ? JSON.parse(m[1]) : null;
}

/** 日本語版の先頭の記録を、英語版の今のハッシュで書き直す（無ければ先頭に足す）。 */
export function writeStamp(jaText, enText) {
  const stamp = `<!-- translated-from README.md: ${JSON.stringify(sectionHashes(enText), null, 2)} -->\n`;
  const rest = normalizeText(jaText).replace(STAMP, "").replace(/^\n+/, "");
  return `${stamp}${rest}`;
}

/** 英語版の今のハッシュと記録を比べ、変わった節（足した節・消した節も）の名前を挙げる。 */
export function checkStamp(enText, jaText) {
  const stamp = readStamp(jaText);
  const fix =
    "Update README.ja.md to match, then run: npm run docs:stamp (node scripts/docs/readme-blocks.mjs --stamp)";
  if (!stamp) return [`${FILES.ja}: no translated-from stamp. ${fix}`];
  if (findStamps(jaText).length > 1) {
    return [`${FILES.ja}: more than one translated-from stamp. Run: npm run docs:stamp`];
  }
  const now = sectionHashes(enText);
  const changed = [
    ...Object.keys(now).filter((k) => stamp[k] !== now[k]),
    ...Object.keys(stamp).filter((k) => !(k in now)),
  ];
  if (changed.length === 0) return [];
  return [
    `${FILES.ja}: the translation is behind ${FILES.en} in these sections: ${changed
      .map((k) => JSON.stringify(k))
      .join(", ")}. ${fix}`,
  ];
}

/** フェンスで囲んだコードブロック（言語の札も含めて）を、出てくる順に。 */
function codeBlocks(text) {
  const lines = normalizeText(text).split("\n");
  const fenced = fencedLines(lines);
  const blocks = [];
  let cur = null;
  // 整えるのはフェンスの行だけ。中身の字下げの違いは違いとして残す
  for (const [i, line] of lines.entries()) {
    if (fenced[i] === "open") cur = [line.trim()];
    else if (fenced[i] === "body") cur.push(line);
    else if (fenced[i] === "close") {
      cur.push(line.trim());
      blocks.push(cur.join("\n"));
      cur = null;
    }
  }
  if (cur !== null) blocks.push(cur.join("\n")); // 閉じていないブロック
  return blocks;
}

/**
 * 構造の検査。節は順番で対応させる（見出しの文言は言語で違ってよい）:
 *   - H1〜H3 の数と、順に並べた深さが一致する
 *   - コードブロックの中身が、順に一致する（言語に依らない）
 *   - 節ごとの表の行の数が一致する（生成範囲の外。片方にだけ行を足すと、その事実が片方に無い）
 */
export function checkStructure(enText, jaText) {
  const en = parseSections(withoutRegionBodies(enText)).filter((s) => s.level > 0);
  const ja = parseSections(withoutRegionBodies(jaText)).filter((s) => s.level > 0);
  const errors = [];
  const n = Math.max(en.length, ja.length);
  for (let i = 0; i < n; i++) {
    const a = en[i];
    const b = ja[i];
    if (!a || !b || a.level !== b.level) {
      const show = (s) => (s ? `${"#".repeat(s.level)} ${s.heading}` : "(nothing)");
      errors.push(
        `headings differ: heading ${i + 1} is "${show(a)}" in ${FILES.en} but "${show(b)}" in ${FILES.ja} ` +
          `(${en.length} vs ${ja.length} headings; both READMEs need the same H1-H3 in the same order)`,
      );
      return errors; // 対応が崩れた後の比較は意味が無い
    }
  }
  const rowsOf = (s) => s.lines.filter((l) => l.startsWith("|")).length;
  en.forEach((a, i) => {
    if (rowsOf(a) !== rowsOf(ja[i])) {
      errors.push(
        `table rows differ in "${a.heading}" / "${ja[i].heading}": ${rowsOf(a)} in ${FILES.en}, ` +
          `${rowsOf(ja[i])} in ${FILES.ja}`,
      );
    }
  });
  const ca = codeBlocks(enText);
  const cb = codeBlocks(jaText);
  if (ca.length !== cb.length) {
    errors.push(`code blocks differ: ${ca.length} in ${FILES.en}, ${cb.length} in ${FILES.ja}`);
  } else {
    ca.forEach((c, i) => {
      if (c !== cb[i])
        errors.push(`code block ${i + 1} differs between ${FILES.en} and ${FILES.ja}`);
    });
  }
  return errors;
}

// ---- まとめ -----------------------------------------------------------------

/**
 * 両方の README に全部の検査を当てる。`texts.ja` が null なら英語版だけ。
 * `options.only` で検査の種類を絞れる（単体の検査用）。返すのは人に見せる失敗の文。
 */
export function checkAll(rawTexts, src, options = {}) {
  const want = (k) => !options.only || options.only.includes(k);
  const errors = [];
  const texts = {
    en: rawTexts.en == null ? null : normalizeText(rawTexts.en),
    ja: rawTexts.ja == null ? null : normalizeText(rawTexts.ja),
  };
  for (const lang of ["en", "ja"]) {
    const text = texts[lang];
    if (text == null) continue;
    const file = FILES[lang];
    if (want("regions")) {
      const r = applyRegions(text, lang, src);
      for (const e of r.errors) errors.push(`${file}: ${e}`);
      if (r.errors.length === 0 && r.text !== text) {
        const before = findRegions(text);
        const after = findRegions(r.text);
        for (const [i, reg] of before.regions.entries()) {
          const a = before.lines.slice(reg.begin, reg.end + 1).join("\n");
          const b = after.lines.slice(after.regions[i].begin, after.regions[i].end + 1).join("\n");
          if (a !== b) {
            errors.push(
              `${file}: generated region "${reg.name}" differs from package.json / package.nls (edited by hand, or the declarations changed). Run: npm run docs:write (node scripts/docs/readme-blocks.mjs --write)`,
            );
          }
        }
      }
    }
    if (want("names")) {
      for (const e of checkNames(text, lang, src)) errors.push(`${file}: ${e}`);
    }
  }
  if (texts.en != null && texts.ja != null) {
    if (want("structure")) errors.push(...checkStructure(texts.en, texts.ja));
    if (want("stamp")) errors.push(...checkStamp(texts.en, texts.ja));
  }
  return errors;
}

// ---- CLI --------------------------------------------------------------------
//
// node scripts/docs/readme-blocks.mjs --write | --check | --stamp [--root DIR]
//   --root は検査用（既定はこのファイルから2つ上 = repo のルート）。
// 自分が直接起動されたかは、URL の綴りではなくファイルのパスで比べる（空白や Windows の
// ドライブ名を含むパスで `URL#pathname` はパーセント符号化・先頭の / でずれる）。

const SELF = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root =
    rootAt >= 0
      ? path.resolve(args[rootAt + 1] ?? ".")
      : path.resolve(path.dirname(SELF), "..", "..");
  const mode = args.find(
    (a, i) => a.startsWith("--") && a !== "--root" && !(rootAt >= 0 && i === rootAt + 1),
  );
  if (!["--write", "--check", "--stamp"].includes(mode) || (rootAt >= 0 && !args[rootAt + 1])) {
    console.error(
      "usage: node scripts/docs/readme-blocks.mjs --write | --check | --stamp [--root DIR]",
    );
    process.exit(2);
  }
  const src = loadSources(root);
  const file = (lang) => path.join(root, FILES[lang]);
  const read = (lang) => fs.readFileSync(file(lang), "utf8");
  if (mode === "--write") {
    let failed = false;
    for (const lang of ["en", "ja"]) {
      const before = read(lang);
      const r = applyRegions(before, lang, src);
      for (const e of r.errors) console.error(`${FILES[lang]}: ${e}`);
      if (r.errors.length > 0) failed = true;
      else if (r.text !== before) {
        fs.writeFileSync(file(lang), r.text); // LF（applyRegions が入口でそろえている）
        console.log(`wrote ${FILES[lang]}`);
      }
    }
    process.exit(failed ? 1 : 0);
  } else if (mode === "--check") {
    const errors = checkAll({ en: read("en"), ja: read("ja") }, src);
    for (const e of errors) console.error(e);
    console.log(`readme-blocks: ${errors.length} problem(s)`);
    process.exit(errors.length === 0 ? 0 : 1);
  } else {
    const before = read("ja");
    const after = writeStamp(before, read("en"));
    if (after !== before) fs.writeFileSync(file("ja"), after);
    console.log(after !== before ? `stamped ${FILES.ja}` : `${FILES.ja} stamp is up to date`);
  }
}
