import { z } from "zod";

/**
 * 窓の役割。
 *
 * `stage` = 人間がこの窓をエージェントに預けている。`idle` = 預けていない。
 *
 * **既定は `idle`。** 拡張を入れただけでは、どの窓も操作されない（設計書 §2A.1）。
 * 役割は**設定を経由しない** — ワークスペース設定は読まず（敵が書ける・不変条件9）、
 * グローバル設定は全窓で共有されるため、どちらも窓ごとの役割を表せない（設計書 §2A.2）。
 * 窓ごとのメモリに持ち、登録ファイルに書く。永続化しない（不変条件13）。
 */
export const windowRoleSchema = z.enum(["stage", "idle"]);
export type WindowRole = z.infer<typeof windowRoleSchema>;

export interface WindowCandidate {
  windowId: string;
  role: WindowRole;
  socketPath: string;
  workspacePath: string;
}

export interface StageHints {
  sock?: string | undefined;
  workspacePath?: string | undefined;
}

export type StageSelection =
  | { ok: true; entry: WindowCandidate }
  | {
      ok: false;
      reason: "no-entries" | "no-stage" | "multiple-stages";
      idleCount?: number;
      stages?: WindowCandidate[];
    };

/**
 * ヒント1つで同点を解く。
 *
 * **一致が「ちょうど1つ」のときだけ解けたとみなす。** `find` で先頭を取ると、
 * 同じフォルダを2窓で開いて両方を預けた場合に `workspacePath` が両方に一致し、
 * 黙って先頭が選ばれる（設計書 §2A.5 の「黙って先頭を選ばない」に反する）。
 */
function resolveByHint(
  stages: readonly WindowCandidate[],
  field: (c: WindowCandidate) => string,
  hint: string | undefined,
): WindowCandidate | undefined {
  if (hint === undefined || hint.length === 0) return undefined;
  const hits = stages.filter((c) => field(c) === hint);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * どの窓に繋ぐかを決める。
 *
 * **役割が第一の軸である**（設計書 §2A.5）。`$SHOWME_SOCK` は制限モードで死に
 * （統合ターミナルがブロックされる）、tmux でも伝播しない。`workspacePath` は
 * 同じフォルダを2窓で開くと判別できない。どちらも主経路にはできない。
 *
 * ヒントは **stage の中の同点を解くためだけ**に使う。idle の窓をヒントで
 * 拾い上げることはしない — 預けられていない窓を操作しないのが既定の意味である。
 */
export function chooseStageWindow(
  candidates: readonly WindowCandidate[],
  hints: StageHints,
): StageSelection {
  if (candidates.length === 0) return { ok: false, reason: "no-entries" };

  // 役割が欠けている登録（古い拡張）も、知らない綴りの登録も idle 扱い。フェイルクローズ。
  const stages = candidates.filter((c) => c.role === "stage");
  if (stages.length === 0) {
    return { ok: false, reason: "no-stage", idleCount: candidates.length };
  }
  const only = stages[0];
  if (stages.length === 1 && only !== undefined) return { ok: true, entry: only };

  // ソケットパスは窓ごとに一意だが、フォルダは2窓で共有されうる。強い方を先に使う。
  const bySock = resolveByHint(stages, (c) => c.socketPath, hints.sock);
  if (bySock !== undefined) return { ok: true, entry: bySock };
  const byWorkspace = resolveByHint(stages, (c) => c.workspacePath, hints.workspacePath);
  if (byWorkspace !== undefined) return { ok: true, entry: byWorkspace };

  return { ok: false, reason: "multiple-stages", stages: [...stages] };
}
