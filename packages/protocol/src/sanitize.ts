/**
 * 表示に載せる文字列の無害化。**この repo で唯一の実装**。
 *
 * ここに置く理由は場所の好みではない。増分1の時点で無害化関数は拡張側に2つ
 * （`log.ts` の `sanitizeForLog`、`status-bar.ts` の `forDisplay`）あり、増分2B は
 * 3つ目（注釈の本文）を足そうとしていた。3経路（出力チャネル・ステータスバー・
 * comment thread）が別々の実装を持つと、**どれか1つを直したときに他が置き去りになる**。
 * 置き去りになった経路は、直した人からは直ったように見える。
 *
 * ## 何を落とすか
 *
 * 対象はすべて**エージェント由来**（＝注入されうる相手が決めた値）の文字列である。
 * パスも検索文字列も注釈の本文も、そうである。
 *
 * | 種類 | 何が起きるか |
 * |---|---|
 * | 制御文字（C0 / DEL） | 出力チャネルの行を偽装できる。ANSI で色や消去も撃てる |
 * | 双方向オーバーライド | 読む人と実際の内容が食い違う（Trojan Source。設計書 §4.4） |
 * | ゼロ幅文字 | 見えない文字で語を割れる。人間の目とゲートの一致が崩れる |
 *
 * 落とすのではなく**エスケープ列にして可視化する**。消すと「そこに何かあった」
 * ことまで消え、攻撃の痕跡が画面から失われる。可視化はこの道具の防御である
 * （設計書 §5.4）。
 *
 * ## 何を落とさないか
 *
 * 日本語・全角空白・普通のパスはそのまま通す。ここを広く取ると、正常な入力が
 * エスケープ列だらけになって人間が読まなくなる。読まれない可視化は無い可視化と同じ。
 *
 * 判定範囲は `test/source-hygiene.test.ts`（自分たちのソースに当てる検査）と
 * **同じ集合**にしてある。自分に当てる基準と相手に当てる基準を分けない。
 *
 * ## 行き先で変わるものは、規則ではなく引数である
 *
 * 改行を潰すのは**行を偽装させないため**の規則である。出力チャネルは行の並びが
 * 意味を持つ面なので、エージェント由来の文字列に生の改行を通すと、偽の1行を
 * 紛れ込ませられる。ステータスバーはそもそも1行しか描けないので、生の改行を
 * 通すと表示そのものが壊れる。
 *
 * 注釈の吹き出しには、その危険が無い。ログではないので偽の行に意味が無く、
 * 危ないのは双方向オーバーライドと制御文字のほうである（そちらは行き先に
 * よらず可視化する）。そこで改行だけを潰すと、説明が実質1行になる。
 *
 * だから**行き先を引数にする**（`DisplayTarget`）。関数を増やして分けない
 * ―― 分けた瞬間にそれは2つ目のサニタイザであり、片方を直したときにもう片方が
 * 置き去りになる（不変条件7 が言っているのはそれである）。
 */

/**
 * 既定の上限。
 *
 * 出力チャネルもステータスバーも同じ値で揃える。経路ごとに別の上限を持つと、
 * 「片方では切れるがもう片方では切れない」長さが生まれる。
 */
export const DEFAULT_MAX_DISPLAY_CHARS = 300;

/**
 * 注釈の吹き出しが描ける行数。
 *
 * 改行を通す唯一の行き先なので、上限はここにしか要らない。**上限が要る理由は
 * 高さである** ―― 吹き出しは人間が読んでいるコードの行の下に開く。2000文字
 * （`MAX_ANNOTATION_TEXT_CHARS`）を1行に詰めた吹き出しは折り返しても数十行に
 * しかならないが、2000個の改行はそのまま2000行になる。人間の作業面を奪わない
 * （不変条件10）ことは、舞台の列だけの話ではない。
 *
 * 超えた分の改行は**捨てずにエスケープ列にする**（1行しか描けない行き先と
 * まったく同じ扱いに戻る）。捨てると「そこで改行されていた」ことまで消える。
 */
export const MAX_ANNOTATION_BODY_LINES = 20;

/**
 * 無害化の**行き先**。規則は1つで、行き先ごとに違うのはここだけ。
 */
export interface DisplayTarget {
  /**
   * 何文字ぶんの入力を載せるか。既定は `DEFAULT_MAX_DISPLAY_CHARS`。
   *
   * 出力の長さではない（エスケープで1文字が最大6文字になる）。
   */
  maxChars?: number;
  /**
   * その行き先が描ける**行数**。既定は 1。
   *
   * 1 なら改行は1本も描けないので、すべて `\n` のエスケープ列になる
   * （ログとステータスバーがこれである）。2 以上なら先頭から
   * `maxLines - 1` 本までの改行がそのまま通り、それを超えた分は
   * エスケープ列に戻る。
   *
   * **`\r` と `\t` は行き先によらず可視化する。** ここで許すのは「行を分ける」
   * ことだけで、行の中身を上書きしたり桁を詰めたりする文字は、複数行を描ける
   * 行き先でも読む人に見えない。
   */
  maxLines?: number;
}

/**
 * 1行しか描けない行き先。**`maxLines` を型として持たない。**
 *
 * ステータスバーは1行しか表示できない面なので、「複数行を許す」と言えること
 * 自体が誤りである。渡せないようにしておけば、次に書く人が表示を壊せない。
 */
export type SingleLineTarget = Omit<DisplayTarget, "maxLines">;

/** 許すもの: 改行・復帰・タブ（呼び出し側が先に畳む）。それ以外の C0 制御文字と DEL。 */
function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** 双方向の埋め込み・上書き・隔離（Trojan Source）。 */
function isBidiOverrideChar(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** ゼロ幅スペース / ZWNJ / ZWJ / 語結合子 / BOM。 */
function isZeroWidthChar(code: number): boolean {
  return (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff;
}

/** `\u202e` のような6文字の並びにする。**生の文字を出力に残さない。** */
function escapeCodePoint(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * 文字列を切り詰める。**サロゲートペアの内側では切らない。**
 *
 * `slice()` は UTF-16 コード単位で切るため、ペアの途中で切ると対のない下位
 * サロゲートが末尾に残る（不正な文字列になる）。境界がペアの内側に来る場合は、
 * ペアごと切り落とす。
 *
 * 無害化と分けて公開してあるのは、**エスケープしない切り詰め**も要るからである
 * （ブリッジの拒否理由は既にスキーマ検証を通っていて、切る理由は長さだけ）。
 * 分けても実装は1つに保つ ―― サロゲートの境界計算が2箇所にあると、片方だけ直る。
 */
export function truncateDisplayText(raw: string, maxChars = DEFAULT_MAX_DISPLAY_CHARS): string {
  // 0 や負の上限で `slice(0, -1)` のような「末尾を削る」挙動に落ちないようにする。
  const limit = Math.max(1, Math.floor(maxChars));
  if (raw.length <= limit) return raw;

  let end = limit - 1;
  const prev = raw.charCodeAt(end - 1);
  const cur = raw.charCodeAt(end);
  const prevIsHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
  const curIsLowSurrogate = cur >= 0xdc00 && cur <= 0xdfff;
  if (prevIsHighSurrogate && curIsLowSurrogate) end -= 1;
  return `${raw.slice(0, end)}…`;
}

/**
 * 表示に載せる前の基底の無害化。制御文字・双方向オーバーライド・ゼロ幅文字を
 * 可視化し、上限で切り詰める。**行き先は引数で渡す**（`DisplayTarget`）。
 *
 * **切り詰めてからエスケープする。** 順序が逆だと、エスケープで伸びた分を
 * 切ることになって、`\u202e` のような6文字の並びが途中で割れる ―― 割れた
 * 残骸は元の文字を復元しないが、読む人には別の意味に見える。
 *
 * その代わり、返る文字列は `maxChars` を**超えうる**（1文字が最大6文字になる）。
 * 上限は「どれだけの入力を載せるか」であって「出力の長さ」ではない。
 */
export function sanitizeDisplayText(raw: string, target: DisplayTarget = {}): string {
  const truncated = truncateDisplayText(raw, target.maxChars ?? DEFAULT_MAX_DISPLAY_CHARS);
  // 描ける行数から1を引いたものが、そのまま**描ける改行の本数**である。
  // 既定（1行）では 0 本になり、改行はすべてエスケープ列になる。
  let renderableBreaks = Math.max(1, Math.floor(target.maxLines ?? 1)) - 1;
  let out = "";
  // `for...of` はコードポイント単位で回る（サロゲートペアを1つとして扱う）。
  for (const ch of truncated) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") {
      // 行を描ける行き先でだけ、行の分かれ目として通す。使い切ったら
      // エスケープ列に戻る ―― 捨てないので、本文の文字は1つも失われない。
      if (renderableBreaks > 0) {
        renderableBreaks -= 1;
        out += "\n";
      } else out += "\\n";
    }
    // `\r` と `\t` は行き先によらず畳む。生の1文字より 2 文字の `\r` のほうが
    // 人間に伝わるし、行を描ける行き先でも、行の中身を上書きしたり桁を詰めたり
    // する文字は読む人に見えないままである。
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (isControlChar(code) || isBidiOverrideChar(code) || isZeroWidthChar(code)) {
      out += escapeCodePoint(code);
    } else out += ch;
  }
  return out;
}

/**
 * ステータスバー用。`sanitizeDisplayText` に加えて codicon 記法 `$(name)` を壊す。
 *
 * ステータスバーは `$(check)` をアイコンとして展開するので、エージェント由来の
 * 文字列をそのまま載せると `$(check) ShowMe: OK` のような**偽の状態表示**を
 * 描かれる。可視性そのものがこの道具の防御である以上、可視化の経路を偽装させない
 * （設計書 §5.4）。
 *
 * **我々のリテラルをここに通さないこと。** 通すと `$(shield)` のような我々の
 * codicon まで壊れて、状態を表すアイコンが消える。通すのは動的な部分だけである。
 */
export function sanitizeStatusText(raw: string, target: SingleLineTarget = {}): string {
  // 置換文字列の `$$` は「リテラルの `$`」である（`$&` などと同じ規則）。
  // 結果は `$ (` になり、記法として成立しなくなる。
  //
  // `maxLines` を渡さない（型としても受け取らない）。ステータスバーは1行しか
  // 描けない面なので、既定の「改行はエスケープ列」がそのまま正しい。
  return sanitizeDisplayText(raw, target).replace(/\$\(/g, "$$ (");
}
