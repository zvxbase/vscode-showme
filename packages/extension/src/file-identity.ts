/**
 * 実体の同一性（dev / ino）を確かめられないか（D107）。
 *
 * 番号（ino）を返さないファイルシステム（SMB など）では、別々の実体がどれも `ino` 0 になる。
 * dev / ino の一致で「判定した実体と同じか」を見る検査は、0 == 0 で**何でも一致する**。
 * だから番号が 0 なら「確かめられない」として、呼び出し側は閉じる側に倒す（開かない・受け入れない・
 * 秘匿へのリンクとみなす）。
 *
 * 使う場所（**同じ量をこの1つで決める**。不変条件14）:
 * - `redacted-links.ts`（秘匿ファイルへのハードリンクの照合）
 * - `workspace-path-gate.ts` の外の判断（関門が lstat で見た実体）
 * - `stage-mirror.ts`（判定した実体だけを開く口が見る fstat と、映しの全入口の共通の検査）
 */
export function identityUnverifiable(stat: { readonly ino: number | bigint }): boolean {
  return BigInt(stat.ino) === 0n;
}
