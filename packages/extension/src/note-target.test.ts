import { describe, expect, it } from "vitest";
import { chooseNoteTarget } from "./note-target.js";

/**
 * メモの書き込み先の判断（設計書 §4.3.1）。
 *
 * **`isDirty` は使えない。** `openTextDocument({content, language})` が作る名前なし
 * ドキュメントは生まれた瞬間から `isDirty === true` である（2C Task 0 の実測）。
 * 判断は `version` の一致で行う。
 */

const LAST = { uri: "untitled:Untitled-1", version: 3 };

describe("chooseNoteTarget", () => {
  it("前回の書き込みが無ければ新しく開く", () => {
    expect(chooseNoteTarget(undefined, undefined)).toEqual({
      kind: "new",
      reason: "no-previous-note",
    });
  });

  it("版が最後の書き込みと同じなら使い回す", () => {
    const target = chooseNoteTarget(LAST, {
      uri: LAST.uri,
      version: LAST.version,
      isClosed: false,
    });
    expect(target).toEqual({ kind: "reuse", reason: "unchanged-since-last-write" });
  });

  it("版が進んでいたら人間が触ったとみなして新しく開く", () => {
    const target = chooseNoteTarget(LAST, { uri: LAST.uri, version: 4, isClosed: false });
    expect(target).toEqual({ kind: "new", reason: "human-edited" });
  });

  it("版が巻き戻っていても新しく開く（取り消しで戻る経路がある）", () => {
    // `>` で見ると、ここが使い回しに倒れる。**一致だけを肯定にする。**
    const target = chooseNoteTarget(LAST, { uri: LAST.uri, version: 2, isClosed: false });
    expect(target).toEqual({ kind: "new", reason: "human-edited" });
  });

  it("ドキュメントが閉じられていたら新しく開く", () => {
    const target = chooseNoteTarget(LAST, {
      uri: LAST.uri,
      version: LAST.version,
      isClosed: true,
    });
    expect(target).toEqual({ kind: "new", reason: "document-gone" });
  });

  it("観測できなければ新しく開く", () => {
    expect(chooseNoteTarget(LAST, undefined)).toEqual({ kind: "new", reason: "document-gone" });
  });

  it("別の URI を観測したら新しく開く（版がたまたま一致しても使い回さない）", () => {
    // 版は文書ごとの通し番号なので、別の文書で同じ値になることがある。
    // URI を見ないと、**別の文書を上書きしうる**。
    const target = chooseNoteTarget(LAST, {
      uri: "untitled:Untitled-2",
      version: LAST.version,
      isClosed: false,
    });
    expect(target).toEqual({ kind: "new", reason: "document-gone" });
  });
});
