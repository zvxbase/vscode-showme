/**
 * グロブ照合。**正規表現を使わない。**
 *
 * 以前は正規表現に変換していたが、量化子が並ぶと破滅的バックトラックを起こした。
 * 実測: `"*a"` を10個並べたパターン × 50文字の入力で 95,783 ms。
 * 隣接する量化子を畳む対策を入れたが、間にリテラルを1文字挟むだけで無効になった。
 * 形ではなくクラスを消すため、後戻りしない2ポインタ照合に置き換える。
 *
 * 計算量は最悪でも O(n*m)。指数にならない。
 *
 * 大文字小文字は区別しない。VS Code の主要プラットフォーム（APFS 既定・NTFS）が
 * 区別しないため、区別すると `.ENV` で除外リストを迂回できる。
 */

/** 1セグメント内の照合。`*` は任意長、`?` は1文字。どちらもセパレータを跨がない。 */
function matchSegment(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let starPattern = -1;
  let starText = -1;

  while (t < text.length) {
    const pc = p < pattern.length ? pattern.charAt(p) : "";
    if (p < pattern.length && (pc === "?" || pc === text.charAt(t))) {
      t += 1;
      p += 1;
    } else if (p < pattern.length && pc === "*") {
      starPattern = p;
      starText = t;
      p += 1;
    } else if (starPattern !== -1) {
      // 直近の `*` に1文字余分に食わせて再開する。後戻りはここだけで、
      // 各 `*` は高々 text 長ぶんしか巻き戻らないので指数にならない。
      starText += 1;
      t = starText;
      p = starPattern + 1;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern.charAt(p) === "*") p += 1;
  return p === pattern.length;
}

/** セグメント列の照合。`**` は0個以上のセグメントに当たる。 */
function matchSegments(text: readonly string[], pattern: readonly string[]): boolean {
  let t = 0;
  let p = 0;
  let starPattern = -1;
  let starText = -1;

  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "**") {
      starPattern = p;
      starText = t;
      p += 1;
    } else if (p < pattern.length && matchSegment(text[t] as string, pattern[p] as string)) {
      t += 1;
      p += 1;
    } else if (starPattern !== -1) {
      starText += 1;
      t = starText;
      p = starPattern + 1;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "**") p += 1;
  return p === pattern.length;
}

/** パスがグロブに当たるか。大文字小文字は区別しない。 */
export function matchGlob(text: string, pattern: string): boolean {
  return matchSegments(text.toLowerCase().split("/"), pattern.toLowerCase().split("/"));
}
