import { z } from "zod";

/**
 * パネルの上限は人間が決める（増分6.2 D80）。
 *
 * 増分5 D61 では上限2を protocol の `panelSlotSchema`（`1 | 2` の literal）が決めていた。
 * D80 で上限は人間の設定 `showme.html.maxPanels`（既定 2、整数 0〜999 で `0` が無制限、globalValue のみ）
 * に移り、**スキーマは上限を知らない**。線上の `slot` は整数 1〜`MAX_PANEL_SLOT` で、それは
 * 線の健全性のための絶対上限であって「無制限」の定義ではない。
 *
 * **設定の上限と `slot` を比べるのはここの `panelSlotAllowed` 1つ**（不変条件14）。
 * 拡張の `handlers/show-html.ts` がこれを呼び、`list_workspaces.panels.max` が同じ設定値を写す。
 * 別の場所に `slot > max` を書かないこと。
 */

/**
 * 線上の `slot` の絶対上限。**無制限の定義ではない。** `"unlimited"` は「設定の上限を当てない」
 * であって、この値を越える `slot` はスキーマで落ちる（`get_editor_state` の own webview の
 * `slot`、`move-panel { slot }` も同じ1つのスキーマ）。
 */
export const MAX_PANEL_SLOT = 999;

/**
 * **線上の**上限の形。整数 1〜`MAX_PANEL_SLOT` か `"unlimited"`。`list_workspaces.panels.max` は
 * この形で載せる。設定 `showme.html.maxPanels` 自体は整数1つ（`0` が無制限）で、設定の値を
 * この形に畳むのは拡張の `config.ts` `panelLimitOr` 1箇所 ―― ここに `0` を足さない。
 */
export const panelLimitSchema = z.union([
  z.number().int().min(1).max(MAX_PANEL_SLOT),
  z.literal("unlimited"),
]);
export type PanelLimit = z.infer<typeof panelLimitSchema>;

/** 設定の既定（不変条件10「パネルの上限は人間の設定（既定2）」の 2 はここ1つ）。 */
export const DEFAULT_PANEL_LIMIT: PanelLimit = 2;

/**
 * `slot` の枠を出してよいか。**上限の判定はこの1箇所。**
 *
 * `"unlimited"` は上限を当てない。数なら `slot <= limit`。線の健全性（1〜999）は
 * ここでは見ない ―― それはスキーマの仕事で、同じ量を2箇所で切らない。
 */
export function panelSlotAllowed(slot: number, limit: PanelLimit): boolean {
  if (limit === "unlimited") return true;
  return slot <= limit;
}
