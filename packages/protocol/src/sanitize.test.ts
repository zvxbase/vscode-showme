import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_CHARS,
  MAX_ANNOTATION_BODY_LINES,
  sanitizeDisplayText,
  sanitizeStatusText,
  truncateDisplayText,
} from "./sanitize.js";

/**
 * 無害化の検査。**不可視文字は必ずエスケープ列で書く**（生の文字を書かない）。
 *
 * 生で書くと `test/source-hygiene.test.ts` が赤くなる ―― 検査したいものを
 * 検査器に食わせているので、それが正しい。この repo は既に何度もこれを踏んでいる。
 */
describe("sanitizeDisplayText", () => {
  it("改行を可視化して行の偽装を防ぐ", () => {
    expect(sanitizeDisplayText("a\nb")).toBe("a\\nb");
    expect(sanitizeDisplayText("a\r\nb")).toBe("a\\r\\nb");
    expect(sanitizeDisplayText("a\tb")).toBe("a\\tb");
  });

  it("ANSI 制御シーケンスを無害化する", () => {
    const result = sanitizeDisplayText("a\u001b[31mb");
    expect(result).not.toContain("\u001b");
    expect(result).toContain("\\u001b");
  });

  it("双方向オーバーライドを可視化する", () => {
    // 上書き（RLO）と隔離（LRI）は別の範囲にある。片方だけ通ると Trojan Source は成立する。
    expect(sanitizeDisplayText("a\u202eb")).toBe("a\\u202eb");
    expect(sanitizeDisplayText("a\u2066b")).toBe("a\\u2066b");
    expect(sanitizeDisplayText("a\u202ab")).toBe("a\\u202ab");
    expect(sanitizeDisplayText("a\u2069b")).toBe("a\\u2069b");
  });

  it("ゼロ幅文字を可視化する", () => {
    expect(sanitizeDisplayText("a\u200bb")).toBe("a\\u200bb");
    expect(sanitizeDisplayText("a\u200db")).toBe("a\\u200db");
    expect(sanitizeDisplayText("a\u2060b")).toBe("a\\u2060b");
    expect(sanitizeDisplayText("a\ufeffb")).toBe("a\\ufeffb");
  });

  it("消さずに可視化する（痕跡を残す）", () => {
    // 消すと「そこに何かあった」ことまで消える。長さが増えることが証拠になる。
    const raw = "ab";
    const attacked = "a\u202eb";
    expect(sanitizeDisplayText(attacked).length).toBeGreaterThan(raw.length);
  });

  it("日本語と普通のパスはそのまま通す", () => {
    expect(sanitizeDisplayText("src/index.ts")).toBe("src/index.ts");
    expect(sanitizeDisplayText("この行で定義される")).toBe("この行で定義される");
    // 全角空白は不可視ではない（幅がある）。ここを落とすと日本語が読めなくなる。
    expect(sanitizeDisplayText("全角の　空白")).toBe("全角の　空白");
    expect(sanitizeDisplayText("packages/extension/src/log.ts:42")).toBe(
      "packages/extension/src/log.ts:42",
    );
  });

  it("長すぎる入力を切り詰める", () => {
    expect(sanitizeDisplayText("x".repeat(1000)).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_CHARS,
    );
    expect(sanitizeDisplayText("x".repeat(1000))).toMatch(/…$/);
  });

  it("上限は呼び出し側が上書きできる", () => {
    expect(sanitizeDisplayText("x".repeat(100), { maxChars: 10 }).length).toBeLessThanOrEqual(10);
    // 上限に満たない入力には印を付けない（付けると切れていないものが切れて見える）。
    expect(sanitizeDisplayText("short", { maxChars: 10 })).toBe("short");
  });

  it("サロゲートペアを分断しない", () => {
    // 2 コード単位の絵文字を 800 コード単位分。上限 300 のちょうど内側でペアが割れる。
    const raw = "\u{1F600}".repeat(400);
    const result = sanitizeDisplayText(raw, { maxChars: 300 });
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = result.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });

  it("偽の成功行を注入しても出力は1行に収まる（監査ログ行偽装の防止）", () => {
    const forged = "ok.ts\n[INFO] tool=show_code result=success actor=owner\n[AUDIT] approved";
    const result = sanitizeDisplayText(forged);
    expect(result.split("\n").length).toBe(1);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
  });

  it("エスケープ列が途中で割れない（切ってからエスケープする順序の証拠）", () => {
    // 上限の内側ぎりぎり（299 文字目）に不可視文字を置く。**エスケープしてから
    // 切る**実装だと、6 文字に伸びた並びが 300 文字目で割れて `\` だけが末尾に
    // 残る。切ってからエスケープすれば、丸ごと残る。
    const raw = `${"x".repeat(298)}\u202e${"y".repeat(50)}`;
    const result = sanitizeDisplayText(raw, { maxChars: 300 });
    expect(result).toContain("\\u202e");
    expect(result.endsWith("\\")).toBe(false);
  });

  it("codicon 記法は壊さない（ステータスバー以外では意味を持たない）", () => {
    // 出力チャネルは `$(check)` を展開しない。ここで壊すと、パスに `$(` を
    // 含むだけの普通のファイルがログで読めなくなる。
    expect(sanitizeDisplayText("$(check) OK")).toBe("$(check) OK");
  });
});

/**
 * 行き先を引数にしたこと（`DisplayTarget`）の検査。
 *
 * 改行を潰すのは**行を偽装させないため**の規則で、ログのように行の並びが
 * 意味を持つ面でだけ必要になる。注釈の吹き出しにその危険は無く、潰すと説明が
 * 実質1行になる。**規則は1つのまま、行き先だけを引数で言う。**
 */
describe("sanitizeDisplayText の行き先（DisplayTarget）", () => {
  it("既定は1行しか描けない行き先（改行はエスケープ列のまま）", () => {
    // 行き先を渡さない呼び出し（ログ）の振る舞いを、明示的に固定しておく。
    expect(sanitizeDisplayText("a\nb")).toBe("a\\nb");
    expect(sanitizeDisplayText("a\nb", {})).toBe("a\\nb");
    expect(sanitizeDisplayText("a\nb", { maxLines: 1 })).toBe("a\\nb");
  });

  it("行を描ける行き先では改行がそのまま通る", () => {
    expect(sanitizeDisplayText("1行目\n2行目\n3行目", { maxLines: 20 })).toBe(
      "1行目\n2行目\n3行目",
    );
  });

  it("改行を許しても、危ない文字はやはり可視化される", () => {
    // ここが崩れると、行き先の引数化は「注釈だけ無害化しない」に化ける。
    const result = sanitizeDisplayText("a\u202e\nb\u0000c\u200d", { maxLines: 20 });
    expect(result).toContain("\\u202e");
    expect(result).toContain("\\u0000");
    expect(result).toContain("\\u200d");
    // 改行「だけ」が通っている。
    expect(result.split("\n").length).toBe(2);
  });

  it("復帰とタブは、行を描ける行き先でも畳む", () => {
    // 許すのは「行を分ける」ことだけ。行の中身を上書きする文字は通さない。
    expect(sanitizeDisplayText("a\rb\tc", { maxLines: 20 })).toBe("a\\rb\\tc");
    // CRLF は「行き先が描ける改行1本」＋「可視化された復帰」になる。
    expect(sanitizeDisplayText("a\r\nb", { maxLines: 20 })).toBe("a\\r\nb");
  });

  it("描ける本数を超えた改行はエスケープ列に戻る（捨てない）", () => {
    // 高さの上限は要るが、超えた分を落とすと「そこで改行されていた」ことまで
    // 消える。1行しか描けない行き先とまったく同じ扱いに戻すだけにする。
    expect(sanitizeDisplayText("a\nb\nc", { maxLines: 2 })).toBe("a\nb\\nc");
    const many = sanitizeDisplayText("x\n".repeat(100), { maxLines: MAX_ANNOTATION_BODY_LINES });
    expect(many.split("\n").length).toBe(MAX_ANNOTATION_BODY_LINES);
    // 本文の文字は1つも失われていない（x が 100 個残っている）。
    expect((many.match(/x/g) ?? []).length).toBe(100);
  });

  it("0 や負の行数でも1行扱いに倒れる（危ない側へ倒さない）", () => {
    expect(sanitizeDisplayText("a\nb", { maxLines: 0 })).toBe("a\\nb");
    expect(sanitizeDisplayText("a\nb", { maxLines: -5 })).toBe("a\\nb");
  });

  it("注釈の吹き出しは複数行を描ける（規則が実際に効く値になっている）", () => {
    // 1 だと、行き先を引数にした意味が無くなる。
    expect(MAX_ANNOTATION_BODY_LINES).toBeGreaterThan(1);
  });
});

describe("sanitizeStatusText", () => {
  it("基底の無害化をそのまま含む", () => {
    expect(sanitizeStatusText("a\nb")).toBe("a\\nb");
    expect(sanitizeStatusText("a\u202eb")).toBe("a\\u202eb");
    expect(sanitizeStatusText("a\u200bb")).toBe("a\\u200bb");
    expect(sanitizeStatusText("src/index.ts")).toBe("src/index.ts");
  });

  it("codicon 記法を壊す（偽の状態表示を作らせない）", () => {
    expect(sanitizeStatusText("$(check) OK")).not.toContain("$(check)");
    expect(sanitizeStatusText("$(check) OK")).toBe("$ (check) OK");
  });

  it("複数の codicon をすべて壊す（1つ目だけ直す実装を通さない）", () => {
    const result = sanitizeStatusText("$(check) と $(error) と $(eye)");
    expect(result).not.toContain("$(");
  });

  it("我々の codicon と同じ綴りでも壊す（見分けられないので区別しない）", () => {
    // `$(eye)` は我々が使っている記法である。エージェント由来の値に混ざっていても
    // 我々のリテラルと区別できないので、動的な値は一律に壊す。
    expect(sanitizeStatusText("/tmp/$(eye) ShowMe")).not.toContain("$(eye)");
  });

  it("codicon でない `$` は残す（普通のパスを読めなくしない）", () => {
    expect(sanitizeStatusText("src/$var/index.ts")).toBe("src/$var/index.ts");
    expect(sanitizeStatusText("cost is $5")).toBe("cost is $5");
  });
});

describe("truncateDisplayText", () => {
  it("上限以下ならそのまま返す（印も付けない）", () => {
    expect(truncateDisplayText("abc", 10)).toBe("abc");
    expect(truncateDisplayText("abcdefghij", 10)).toBe("abcdefghij");
  });

  it("上限を超えたら切って印を付ける", () => {
    expect(truncateDisplayText("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(truncateDisplayText("abcdefghijk", 10).length).toBe(10);
  });

  it("サロゲートペアの内側では切らない", () => {
    // 絵文字は 2 コード単位なので、上限を 1 ずつ動かせば境界がペアの内側にも
    // 外側にも来る。片方の上限でだけ通る実装を残さないよう、範囲で当てる。
    const raw = "\u{1F600}".repeat(10); // 20 コード単位
    for (let limit = 2; limit <= 19; limit++) {
      const result = truncateDisplayText(raw, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      for (let i = 0; i < result.length; i++) {
        const code = result.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = result.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
        if (code >= 0xdc00 && code <= 0xdfff) {
          const prev = result.charCodeAt(i - 1);
          expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
        }
      }
    }
  });

  it("エスケープしない（切り詰めだけを行う）", () => {
    // ここを無害化すると、既にスキーマ検証を通った文字列まで読めなくなる。
    expect(truncateDisplayText("a\nb", 10)).toBe("a\nb");
  });

  it("上限が 0 以下でも末尾を削る挙動に落ちない", () => {
    expect(truncateDisplayText("abcdef", 0)).toBe("…");
    expect(truncateDisplayText("abcdef", -5)).toBe("…");
  });
});
