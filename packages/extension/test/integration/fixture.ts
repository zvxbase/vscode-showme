import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 統合テストが開くワークスペースを作る。
 *
 * リポジトリの中にフィクスチャを置かない。理由が2つある:
 *
 *   1. `.env` という名前のファイルをコミットしたくない。中身が偽物でも、
 *      検査器と人間の両方に本物の取り違えをさせる
 *   2. 検査の途中でワークスペース内にシンボリックリンクを作る（`realpath`
 *      後の除外再判定を確かめるため）。作りかけの実験材料がリポジトリの
 *      作業ツリーに残ると、次の `git add` に巻き込まれる
 *
 * だから `os.tmpdir()` の下に毎回まっさらな木を作る。runTest.ts（VS Code を
 * 起動する側）と suite（拡張ホストの中で走る側）の両方がこのモジュールを
 * 読むので、パスと目印の文字列の定義元は1つだけになる。
 */

/** `.env` と `docs/notes.md` の**両方**に入れる目印。 */
export const CANARY = "SHOWME_CANARY_5f3a91";

/** ワークスペースの外に置くファイルの中身の目印。 */
export const OUTSIDE_MARKER = "SHOWME_OUTSIDE_MARKER_c47b";

/** ちょうど1行だけに現れる文字列。 */
export const UNIQUE_TEXT = "function target";

/** 4行に現れる文字列（候補の上限3が実際に効くことを見るため）。 */
export const REPEATED_TEXT = "repeated";

/** ファイル末尾近くにだけ現れる文字列。revealRange が効いたことを見るために使う。 */
export const DEEP_TEXT = "REVEAL_TARGET";

export const SAMPLE_REL = "src/sample.ts";
export const NOTES_REL = "docs/notes.md";
export const ESCAPE_REL = "docs/escape.md";

/**
 * ワークスペースの中にあるが、**実体はワークスペースの外**を指すシンボリックリンク。
 *
 * 綴りだけを見る検査（`normalizeWorkspaceRelative` / `isRedactedPath`）は
 * これを通してしまう ―― 名前に `..` は無いし、除外パターンにも当たらない。
 * 止められるのは realpath を取る側だけである（`canonicalizeWorkspacePath`）。
 */
export const SYMLINK_ESCAPE_REL = "docs/innocent.txt";

/** 同じく、**除外パスの実体**を指すリンク。除外は綴りではなく実体で効かねばならない。 */
export const SYMLINK_TO_ENV_REL = "docs/harmless.txt";

/** リンクの先にだけ現れる文字列。これが当たったら、外を読めている。 */
export const OUTSIDE_ONLY_NEEDLE = "outside-only-needle-4f21";
export const ENV_REL = ".env";

/**
 * 制限モードでシンボル解決が言語ごとにどうなるかを測るためのファイル（設計書 §3.4）。
 *
 * `.ts` と `.json` の**両方**が要る。設計レビューは「制限モードで無効になるのは
 * `typescript-language-features` と `git` の2つだけで、JSON のプロバイダは動く」と
 * 報告したが、それは推定である。片方だけ置くと「返らなかった」が制限モードのせいか
 * 環境のせいかを判別できない。
 */
export const JSON_REL = "data/config.json";

/** `JSON_REL` の最上位キー。JSON のシンボルプロバイダはキー名をシンボルにする。 */
export const JSON_SYMBOL = "showmeSymbolTarget";

/** `SAMPLE_REL`（`.ts`）の中の関数名。TS のシンボルプロバイダが返すはずの名前。 */
export const TS_SYMBOL = "target";

/**
 * 舞台の列の検査だけに使うファイル群と、その中の目印。
 *
 * `src/sample.ts` を使い回さない。解決試行には1ファイルあたり 30回/分 の
 * 予算があり（`src/rate-limit.ts`）、`layout: "split"` を繰り返す検査は同じ
 * ファイルを何度も引く。使い回すと、列の検査が後続のテストの予算を食って
 * 「回数制限に当たった」を「舞台の不具合」に見せかける。
 */
export const STAGE_RELS = ["stage/one.ts", "stage/two.ts", "stage/three.ts"] as const;

/** `STAGE_RELS` の各ファイルにちょうど1回だけ現れる目印。 */
export const STAGE_MARKER = "STAGE_SLOT_MARKER";

/**
 * `stage` を切ったときの `show_code`（印だけ。増分6 D76）の検査だけに使うファイル。
 *
 * 「開かない」を言うには**開いていないファイル**が要る。他の検査が開いた
 * ファイルを使い回すと、タブが既にあるので「開かなかった」が判別しない。
 * 2本あるのは `layout: "split"` でも列が増えないことを見るため。
 */
export const MARK_ONLY_RELS = ["mark/one.md", "mark/two.md"] as const;

/** `MARK_ONLY_RELS` の各ファイルにちょうど1回だけ、**3行目**に現れる目印。 */
export const MARK_ONLY_MARKER = "MARK_ONLY_TARGET";

/**
 * 案内（ShowMe: Next / Previous annotation。増分6 D73 / D77）の検査だけに使う2ファイル。
 *
 * 「舞台の列に開く」を言うには**開いていないファイル**が要り（`MARK_ONLY_RELS` と同じ
 * 理由）、「その行が見える」を言うには**1画面に収まらない長さ**が要る ―― 短いファイルは
 * 全行が常に可視なので、どの行に案内しても検査が緑になる。各 `TOUR_LINES` 行。
 * 予算（ファイル単位で 30回/分）も他の注釈の検査と共有しない。
 */
export const TOUR_RELS = ["tour/a.md", "tour/b.md"] as const;
export const TOUR_LINES = 200;

/**
 * 注釈（`annotate`）の検査だけに使うファイルと、その中の目印。
 *
 * `src/sample.ts` を使い回さない。解決試行の予算は**ファイル単位で 30回/分**で、
 * しかも `show_code` と `annotate` はその予算を共有する（`rate-limit.ts` の
 * `sharedFileLimiter`）。使い回すと、注釈の検査が既存のテストの予算を食って
 * 「回数制限に当たった」を「注釈の不具合」に見せかける。
 */
export const ANNOTATE_REL = "docs/annotate.md";

/** `ANNOTATE_REL` にちょうど1回だけ現れる目印。 */
export const ANNOTATE_MARKER = "ANNOTATE_TARGET";

/**
 * 注釈の**順番と id**（増分6 D69 / D71 / D72）の検査だけに使う2ファイル。
 *
 * `ANNOTATE_REL` を使い回さない ―― あちらの節は既に予算（ファイル単位で 30回/分）の
 * 8割を使っていて、ここで6回足すと「回数制限」が「番号の不具合」に見える。
 * 2ファイルなのは、`get_editor_state.annotations` の `path` がファイルごとに
 * 正しく出ることを1つの一覧で見るため。どちらも5行あり、`lines` で指す。
 */
export const ANNOTATE_ORDER_A_REL = "docs/annotate-order-a.md";
export const ANNOTATE_ORDER_B_REL = "docs/annotate-order-b.md";

/**
 * `get_editor_state`（設計書 §3.1）の検査だけに使うファイルと、その中の目印。
 *
 * ここでも `src/sample.ts` を使い回さない。2B の主たる流れ
 * （人間が選ぶ → `get_editor_state` → `annotate`）は同じファイルに対して
 * 解決を何度も走らせるので、予算（ファイル単位で 30回/分）を他の検査と
 * 共有すると、落ちたときに「回数制限」と「双方向の不具合」が同じ観測値になる。
 */
export const EDITOR_STATE_REL = "docs/editor-state.md";

/** `EDITOR_STATE_REL` にちょうど1回だけ現れる目印。人間はこの語を選ぶ。 */
export const EDITOR_STATE_MARKER = "EDITOR_STATE_TARGET";

/**
 * 合成攻撃（`show_code` で開いた側に人間が移る）の検査だけに使うファイルと目印。
 *
 * **このファイルは他のどのテストも触らない。** 触ると、そのテストが付けた選択が
 * ここに残り、「エージェントが作った選択が返った」と読める ―― 実際に
 * `show_code は TextEditor.selection を変更しない` が `src/sample.ts` に
 * 残した選択で、この検査は一度そう誤った。
 */
export const COMPOSITION_REL = "docs/composition.md";

/** `COMPOSITION_REL` にちょうど1回だけ現れる目印。 */
export const COMPOSITION_MARKER = "COMPOSITION_TARGET";

/**
 * 「舞台が人間の列を奪う」（設計書 §2A.7.1）の検査だけに使うファイルと目印。
 *
 * **2本要る。** 1本目（`COLUMN_STAGE_REL`）は舞台の列を作らせるためのもので、
 * 人間はそこを覗きに行く。2本目（`COLUMN_BAIT_REL`）は**人間が先に選択を
 * 作っておく**ファイルで、エージェントが後からそれを舞台に開く。舞台が人間の
 * 列を奪う実装では、この2本目が人間の列に開いて `activeTextEditor` の座に就き、
 * VS Code が復元した選択（＝人間が作ったもの）がエージェントに返る。
 *
 * 他のテストと共有しない。共有すると、そのテストが付けた選択と、ここで
 * わざと作った選択が見分けられなくなる（`COMPOSITION_REL` で一度そう誤った）。
 */
export const COLUMN_STAGE_REL = "docs/column-stage.md";

/** `COLUMN_STAGE_REL` にちょうど1回だけ現れる目印。 */
export const COLUMN_STAGE_MARKER = "COLUMN_STAGE_TARGET";

/** 人間が先に選んでおくファイル。エージェントが後から舞台に開こうとする。 */
export const COLUMN_BAIT_REL = "docs/column-bait.md";

/** `COLUMN_BAIT_REL` にちょうど1回だけ現れる目印。人間はこの語を選ぶ。 */
export const COLUMN_BAIT_MARKER = "COLUMN_BAIT_TARGET";

/**
 * `isActiveEditor` の導出（設計書 §3.1.1 (d)）の検査だけに使うファイルと目印。
 *
 * 人間がエディタから離れている（パネルに焦点がある）あいだに、別の列で
 * このファイルが開かれる状況を作る。`activeTextEditor` は「焦点を持つエディタ、
 * 無ければ最後に入力が変わったエディタ」なので、そのときの `activeTextEditor`
 * は人間の使っているタブグループの**外**にある。
 */
export const NOT_ACTIVE_REL = "docs/not-active.md";

/** `NOT_ACTIVE_REL` にちょうど1回だけ現れる目印。 */
export const NOT_ACTIVE_MARKER = "NOT_ACTIVE_TARGET";

/**
 * `windowFocused` の導出（設計書 §3.1 条件1）の検査だけに使うファイルと目印。
 *
 * 2窓の検査でしか使わない ―― 単一の窓は常に前面にあるので、そこでは
 * `window.state.focused` が false になる状況を作れない（実測: 2窓のとき、
 * 測る側の窓は前面に無い）。
 */
export const NOT_FOCUSED_REL = "docs/not-focused.md";

/** `NOT_FOCUSED_REL` にちょうど1回だけ現れる目印。 */
export const NOT_FOCUSED_MARKER = "NOT_FOCUSED_TARGET";

/**
 * markdown 経路の攻撃（設計書 §3.2.1 / §3.3）の検査だけに使うファイルと目印。
 *
 * 攻撃の本文は1回の呼び出しで送るが、その前に `show_code` でファイルを開く
 * （吹き出しは、そのファイルを映しているエディタが無いと**描かれない** ――
 * 描かれなければ画像も取りに行かないので、egress の検査が空振りする）。
 */
export const MARKDOWN_ATTACK_REL = "docs/markdown-attack.md";

/** `MARKDOWN_ATTACK_REL` にちょうど1回だけ現れる目印。 */
export const MARKDOWN_ATTACK_MARKER = "MARKDOWN_ATTACK_TARGET";

/** DEEP_TEXT の前に挟む埋め草の行数。初期表示に収まらない位置へ押し出す。 */
const FILLER_LINES = 400;

function sampleSource(): string {
  const head = [
    "function target() {",
    "  return 1;",
    "}",
    "",
    "const repeated = 1;",
    "const repeated2 = repeated;",
    "const repeated3 = repeated;",
    "const repeated4 = repeated;",
    "",
  ];
  const filler: string[] = [];
  for (let i = 0; i < FILLER_LINES; i++) filler.push(`const filler${i} = ${i};`);
  return `${[...head, ...filler, `const deepMarker = "${DEEP_TEXT}";`, ""].join("\n")}`;
}

export interface FixtureWorkspace {
  /** VS Code に開かせるフォルダ。 */
  readonly root: string;
  /** ワークスペースの**外**。脱出リンクの向き先を置く。 */
  readonly outsideDir: string;
}

/**
 * `root` からワークスペース外のディレクトリを導く。
 *
 * suite 側は `workspaceFolders[0].uri` しか知らないので、そこから同じ答えを
 * 出せる必要がある。並びを1箇所で決めておく。
 */
export function outsideDirFor(root: string): string {
  return path.join(path.dirname(root), "outside");
}

export function createFixtureWorkspace(label: string): FixtureWorkspace {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `showme-int-${label}-`));
  const root = path.join(base, "workspace");
  const outsideDir = outsideDirFor(root);

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "stage"), { recursive: true });
  fs.mkdirSync(path.join(root, "mark"), { recursive: true });
  fs.mkdirSync(path.join(root, "tour"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  fs.writeFileSync(path.join(root, SAMPLE_REL), sampleSource(), "utf8");

  // ワークスペースの外に、リンクの的を1つ置く。
  fs.writeFileSync(
    path.join(outsideDir, "target.txt"),
    `${OUTSIDE_ONLY_NEEDLE}\nsecond line\n`,
    "utf8",
  );
  // **綴りは無害、実体は外。** 綴りだけを見る検査はこれを通す。
  try {
    fs.symlinkSync(path.join(outsideDir, "target.txt"), path.join(root, SYMLINK_ESCAPE_REL));
    // **綴りは無害、実体は除外パス。** 除外は綴りではなく実体で効かねばならない。
    fs.symlinkSync(path.join(root, ENV_REL), path.join(root, SYMLINK_TO_ENV_REL));
  } catch {
    // シンボリックリンクが作れない環境（Windows の一部）では、この検査は
    // 成立しない。**黙って飛ばすのではなく、テスト側が実在を確かめて落とす。**
  }
  for (const rel of STAGE_RELS) {
    // 目印は1ファイルに1回だけ。多重一致にすると解決が many になり、
    // エディタが開かないので「列がどこに開いたか」を見る検査にならない。
    fs.writeFileSync(path.join(root, rel), `// ${STAGE_MARKER}\nexport {};\n`, "utf8");
  }
  for (const rel of MARK_ONLY_RELS) {
    // 目印は3行目（1始まり）。1行目に置くと「行を渡していない実装」でも一致する。
    fs.writeFileSync(path.join(root, rel), `# mark\n\n${MARK_ONLY_MARKER}\n`, "utf8");
  }
  for (const rel of TOUR_RELS) {
    const lines = Array.from({ length: TOUR_LINES }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(root, rel), `${lines.join("\n")}\n`, "utf8");
  }
  // 除外リストの既定パターンに当たる名前。中身は偽物だが、目印は notes.md と
  // 共有する ―― 同じ問い合わせが「実ファイルなら当たり、リンク経由なら当たらない」
  // ことを見せるため。
  fs.writeFileSync(path.join(root, ENV_REL), `SECRET=do-not-read\n${CANARY}=1\n`, "utf8");
  // 除外リストに当たらない普通のファイル。第一の関門がこのパスを通すことの証拠に使う。
  fs.writeFileSync(
    path.join(root, NOTES_REL),
    `# notes\n\nこれは普通のファイルである。${CANARY}\n`,
    "utf8",
  );
  // シンボル測定用。最上位キーが `JSON_SYMBOL` ちょうど1つ分になるようにしておく
  // （複数あっても測れるが、名前で引いた結果を目で追いにくくなる）。
  fs.writeFileSync(
    path.join(root, JSON_REL),
    `${JSON.stringify({ [JSON_SYMBOL]: { nested: true }, other: 1 }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, ANNOTATE_REL),
    `# annotate\n\nこの行に注釈を出す: ${ANNOTATE_MARKER}\n`,
    "utf8",
  );
  for (const rel of [ANNOTATE_ORDER_A_REL, ANNOTATE_ORDER_B_REL]) {
    fs.writeFileSync(
      path.join(root, rel),
      "# order\n\n1行目\n2行目\n3行目\n4行目\n5行目\n",
      "utf8",
    );
  }
  // 人間が選ぶ行。目印は1回だけ（複数あると、選んだ行と注釈が出た行が
  // 一致することを見る検査が成立しない）。
  fs.writeFileSync(
    path.join(root, EDITOR_STATE_REL),
    `# editor state\n\n人間がこの行を選ぶ: ${EDITOR_STATE_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, COMPOSITION_REL),
    `# composition\n\nエージェントがここを見せる: ${COMPOSITION_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, COLUMN_STAGE_REL),
    `# column stage\n\nエージェントがここを見せる: ${COLUMN_STAGE_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, COLUMN_BAIT_REL),
    `# column bait\n\n人間がこの行を選ぶ: ${COLUMN_BAIT_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, NOT_ACTIVE_REL),
    `# not active\n\n人間の列の外で開かれる行: ${NOT_ACTIVE_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, NOT_FOCUSED_REL),
    `# not focused\n\n前面に無い窓で選ばれる行: ${NOT_FOCUSED_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, MARKDOWN_ATTACK_REL),
    `# markdown attack\n\nこの行に注釈を出す: ${MARKDOWN_ATTACK_MARKER}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), `${OUTSIDE_MARKER}\n`, "utf8");

  return { root, outsideDir };
}
