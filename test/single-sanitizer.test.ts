import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * サニタイザが1つであることの強制。
 *
 * 増分1の時点で無害化関数は拡張側に2つあり（`log.ts` の `sanitizeForLog`、
 * `status-bar.ts` の `forDisplay`）、切り詰めの写しがブリッジにもう1つあった
 * （`result-guard.ts` の `truncate`）。増分2B は4つ目（注釈の本文）を足す。
 *
 * **文書に「1つにする」と書くだけでは、次に足す人には届かない。** 届く形は
 * 「2つ目を書いたら赤くなる」だけである。
 *
 * ## 判定の形
 *
 * 「サニタイザという名前の関数が1つ」ではなく、**文字を直接いじる痕跡が
 * `protocol/src/sanitize.ts` の外に無い**ことを見る。名前で数えると、
 * `sanitizeAnnotationBody` のように別の名前を付けるだけで抜けられる。
 *
 * 検出は候補の一覧であって欠陥の一覧ではない。将来ここが正当な理由で赤くなったら、
 * まず `sanitize.ts` に寄せられないかを考えること。寄せられないものを足すときは、
 * 下の `ALLOWED` に**理由と一緒に**書く。理由の無い追加は、この検査を空にする。
 */

/** 走査根はリポジトリのルート。 */
const REPO_ROOT = path.resolve(__dirname, "..");

/** 唯一の住所。ここだけは文字を直接いじってよい。 */
const SANITIZER_HOME = path.join("packages", "protocol", "src", "sanitize.ts");

/**
 * 文字を直接いじっている痕跡。小文字化した本文に対する部分一致で見る。
 *
 * 対象は「無害化を自前で書いた」ことを示すもの ―― コード単位への降下と、
 * 不可視文字のコードポイントである。`0x20` のような広すぎる並びは入れない
 * （普通の定数に当たって、この検査が狼少年になる）。
 */
const CHAR_LEVEL_MARKERS: readonly string[] = [
  // コード単位・コードポイントへの降下
  "charcodeat",
  "codepointat",
  "fromcharcode",
  "fromcodepoint",
  // サロゲート境界（切り詰めを自前で書くと必ず出る）
  "0xd800",
  "0xdbff",
  "0xdc00",
  "0xdfff",
  // ゼロ幅
  "0x200b",
  "0x200c",
  "0x200d",
  "0x2060",
  "0xfeff",
  // 双方向オーバーライド
  "0x202a",
  "0x202b",
  "0x202c",
  "0x202d",
  "0x202e",
  "0x2066",
  "0x2067",
  "0x2068",
  "0x2069",
];

/**
 * 例外。**空である。**
 *
 * 空のまま保てることが、統合が実際に効いていることの証拠になる。ここに足すときは
 * 「なぜ `sanitize.ts` に寄せられないか」を1行で書くこと。
 */
const ALLOWED: ReadonlyMap<string, string> = new Map();

/** 走査するのは我々が書いて出荷するソースだけ。テストと生成物は入れない。 */
const SCANNED_ROOTS: readonly string[] = [
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

function markersIn(text: string): string[] {
  const lower = text.toLowerCase();
  return CHAR_LEVEL_MARKERS.filter((marker) => lower.includes(marker));
}

describe("サニタイザは1つ（不変条件7）", () => {
  const files = SCANNED_ROOTS.flatMap((rel) => sourceFiles(path.join(REPO_ROOT, rel))).map((file) =>
    path.relative(REPO_ROOT, file),
  );

  it("走査対象のファイルが実際に見つかっている", () => {
    // 0件でも「1つしか無い」に見えてしまう。空振りしていないことを先に確かめる。
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain(SANITIZER_HOME);
    expect(files).toContain(path.join("packages", "extension", "src", "log.ts"));
    expect(files).toContain(path.join("packages", "extension", "src", "status-bar.ts"));
    expect(files).toContain(path.join("packages", "bridge", "src", "result-guard.ts"));
    expect(files).toContain(path.join("packages", "extension", "src", "handlers", "annotate.ts"));
  });

  it("検出器が実際に痕跡を捕まえられる（唯一の住所で当たる）", () => {
    // 「1件も無い」を信用する前に、判定が本当に当たることを確かめる。
    // `sanitize.ts` は文字を直接いじる**唯一の**ファイルなので、ここで当たらなければ
    // 検出器か走査根が壊れている。
    const home = fs.readFileSync(path.join(REPO_ROOT, SANITIZER_HOME), "utf8");
    const hit = markersIn(home);
    expect(hit).toContain("charcodeat");
    expect(hit).toContain("codepointat");
    expect(hit).toContain("0x202a");
    expect(hit).toContain("0x200b");

    // 普通のソースには当たらない。
    expect(
      markersIn("const a = 1;\nexport function f(x: string) { return x.slice(0, 10); }"),
    ).toEqual([]);
  });

  it("文字を直接いじるのは protocol の sanitize.ts だけ", () => {
    const offenders = files
      .filter((file) => file !== SANITIZER_HOME && !ALLOWED.has(file))
      .map((file) => ({
        file,
        markers: markersIn(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")),
      }))
      .filter((entry) => entry.markers.length > 0);

    expect(offenders).toEqual([]);
  });

  it("表示の経路が実際に protocol を呼んでいる（痕跡が無いだけの空実装を通さない）", () => {
    // 上の検査は「自前で書いていない」しか言わない。無害化を**やめて**も通る。
    // 呼んでいることを別に見る。
    const routes: ReadonlyArray<readonly [string, string]> = [
      [path.join("packages", "extension", "src", "log.ts"), "sanitizeDisplayText"],
      [path.join("packages", "extension", "src", "status-bar.ts"), "sanitizeStatusText"],
      [path.join("packages", "bridge", "src", "result-guard.ts"), "truncateDisplayText"],
      // 注釈の本文（2B で増えた3つ目の表示経路）。`string` を選んでも双方向
      // オーバーライドと制御文字は `innerText` にそのまま描かれるので、
      // ここも同じ関数を通る。
      [path.join("packages", "extension", "src", "handlers", "annotate.ts"), "sanitizeDisplayText"],
      // HTML の無害化（2C）。木の刈り込みは自分でやるが、**文字レベルの無害化は
      // 自前で書かず** `sanitize.ts` に委ねている。委譲を外して自前で書き直すと
      // 上の「痕跡」検査が赤くなるが、**委譲をやめて何もしなくしても**そちらは緑のまま
      // なので、呼んでいることをここで別に見る。
      [path.join("packages", "protocol", "src", "sanitize-html.ts"), "sanitizeDisplayText"],
      // メモ（不変条件7 の3経路目）。増分2C の初版はここだけ素通しだった ――
      // **文書に「3経路すべて」と書くだけでは届かない**ことの実例なので、
      // 呼んでいることをここで固定する。
      [path.join("packages", "protocol", "src", "sanitize-note.ts"), "sanitizeDisplayText"],
    ];
    for (const [file, fn] of routes) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      // protocol の内部からは相対 import になる（自分自身をパッケージ名で読まない）。
      const importsProtocol =
        text.includes("@zvx/vscode-showme-protocol") || text.includes('from "./sanitize.js"');
      expect(
        text.includes(`${fn}`) && importsProtocol,
        `${file} が protocol の ${fn} を呼んでいない`,
      ).toBe(true);
    }
  });

  it("例外表には理由が要る（理由の無い追加でこの検査を空にしない）", () => {
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file} の例外に理由が無い`).toBeGreaterThan(10);
    }
  });
});
