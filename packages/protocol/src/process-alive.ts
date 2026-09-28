/**
 * プロセスが生きているか。拡張の掃除（`cleanStaleRegistrations`）とブリッジの走査
 * （`scanRegistry`。D111）が**同じ判定を通す**（不変条件14）。
 *
 * `process.kill(pid, 0)` はシグナルを送らず、存在と権限だけを確かめる。
 * `EPERM` は「いるが自分のものではない」なので**生きている**側に倒す。`ESRCH` のときだけ死んでいる。
 * この判定は pid の再利用で「生きている」と外れる（設計書 S7 が「pid だけで生死を決めるな」と言う理由）ので、
 * 使うのは「死んでいると分かったものを外す」向きだけにする。
 *
 * 0 以下・整数でない pid は kill に渡さず、死んでいるとする。`kill(0, 0)` はプロセスグループ全体に、
 * `kill(-1, 0)` は全プロセスに飛ぶ。
 */
export function processIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = (p, s) => process.kill(p, s),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
