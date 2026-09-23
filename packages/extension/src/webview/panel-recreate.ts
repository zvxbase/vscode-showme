import type { PanelSlot } from "@zvx/vscode-showme-protocol";
import type { StagePlacement } from "../handlers/show-code.js";

/**
 * `move-panel` の「作り直す」の、`vscode` に触らない部分。
 *
 * ## なぜ作り直すのか
 *
 * `WebviewPanel.reveal(column)` で動かしたパネルは移動先で **preview タブ**になる
 * （VS Code の `revealWebview` は `openEditor` に `pinned` を渡さない）。
 * preview はその列に次に preview で開かれたものに差し替えられて閉じるので、`gather-own` で
 * 両枠を1列に集めると先に動かした枠が消える（`moved: 2` と報告しながら）。拡張の API に
 * webview のタブを pin する口は無い。`createWebviewPanel` は `pinned: true` で開くので、
 * **移動先で作り直せば pinned になる。** DOM は捨てるので、中身は正から描き直す。
 *
 * ## 正（source of truth）は1つ
 *
 * - `html` 由来: `ShowMePanel` がメモリに持つ**最後のサニタイズ済み HTML**（上限は
 *   `MAX_HTML_CHARS`。ディスクには書かない ―― 不変条件13 はディスクの話である）
 * - `path` 由来: ハンドラの閉包（関門 → サニタイザ → `refreshHtml`）で**読み直す**。
 *   覚えている HTML は使わない。ファイルが正であり、読めなくなっていれば描かない
 *   （関門が「読めない」と言うものを、覚えていた写しから描くのは関門を迂回する形になる）
 *
 * D49 は「拡張が HTML を覚えて再表示時に投入する」案を退けた ―― webview の DOM と
 * 拡張のフィールドが**同じ量を2箇所で持つ**からである（不変条件14）。ここではそれに
 * 当たらない: 移動は DOM を**設計として捨てる**ので、覚えている値が唯一の写しになる。
 * 隠れて戻るときは `retainContextWhenHidden` が DOM を保ち（D49 のまま）、覚えている値は
 * 読まない。つまり「DOM が生きているあいだは DOM が正、捨てたあとは覚えている値が正」で、
 * 2つが同時に正になる瞬間は無い。
 *
 * ## 順序は「作ってから破棄する」
 *
 * D59 のテキストタブ（`showTextDocument` してから `tabGroups.close`）と同じ向き。
 * 逆にすると、古い列が空になって VS Code が閉じ（`closeEmptyGroups` 既定）、列が
 * 繰り上がった**あと**に元の番号で作ることになる。番号がそのとき存在する列数を超えて
 * いれば、VS Code は足りない列を**順に**足す（`columnToEditorGroup`）ので、途中の列が
 * **空のまま**残る ―― 人間が最初に困った「窓が増える」を自分で起こす。作ってから
 * 破棄すれば、新しいパネルが先に居るので、空いた列が閉じて繰り上がるだけで済む
 * （結果の列番号は呼んだ番号とずれうる。D59「呼んだあと読み直す」のとおり）。
 */

/** 作り直すときに描く正。`ShowMePanel` が**1つだけ**持つ（`html` と `path` で形が違う）。 */
export type PanelSource =
  | { kind: "html"; sanitized: string }
  | {
      kind: "path";
      /** ハンドラの閉包。関門とサニタイザを通してから `refreshHtml` する。 */
      rerender: () => Promise<void>;
    };

/** `ShowMePanel` が差し出す手。**順序だけをここで決める**ので、判断はこの3つに無い。 */
export interface RecreateOps {
  /** 移動先に新しいパネルを作り、自分の「いまのパネル」に据える。 */
  create(): void;
  /** それまでのパネルを破棄する（据え替えたあとなので、破棄の通知で状態を消さない）。 */
  disposeOld(): void;
  /** 新しいパネルの表示フレームに、サニタイズ済み HTML を入れて届くのを待つ。 */
  post(sanitized: string): Promise<void>;
}

/**
 * 作って、破棄して、正から描き直す。
 *
 * 描き直しの失敗は握らない ―― 移動そのものは済んでいるので、呼び手（面）が
 * `false` に畳んで `done: false` にする。
 */
export async function recreatePanel(
  source: PanelSource | undefined,
  ops: RecreateOps,
): Promise<void> {
  ops.create();
  ops.disposeOld();
  if (source === undefined) return;
  if (source.kind === "html") {
    await ops.post(source.sanitized);
    return;
  }
  await source.rerender();
}

/**
 * 枠の既定の置き場。
 *
 * 枠1は舞台の1列目、**枠2は舞台の2列目**（`show_code` の `layout: "split"` の2列目と
 * 同じ列。人間の「並べる」は横並びである）。以前はどちらも1列目に開いていたが、
 * 2枚目を出すたびに `move-panel { slot: 2 }` が要った。混雑したら `gather-own` で集められる。
 * `StagePlacement.slot` は**舞台の列の番号**（0 始まり）で、パネルの枠（1 始まり）とは別の量。
 */
export function panelPlacement(slot: PanelSlot): StagePlacement {
  return slot === 1 ? { layout: "single", slot: 0 } : { layout: "split", slot: 1 };
}
