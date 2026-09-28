import { normalizeAbsolutePath } from "@zvx/vscode-showme-protocol";
import { stageUriPartsOfKey } from "../src/stage-uri.js";

/**
 * ワークスペースの外の検査が期待する綴り（検査の道具。本体は使わない）。
 *
 * 関門がエージェントに返す外の名前（`normalizedPath`・映しの鍵・観測の名前）は、正規化した絶対パス
 * （`normalizeAbsolutePath`）である。Windows ではドライブ文字を小文字にした `c:\…` で、
 * `path.join` や realpath が返す `C:\…` とは綴りが違う。POSIX では入力そのもの。
 * 実体の名前（`realPath`・`absPath`）は realpath のままなので、こちらは通さない。
 */
export function agentSpelling(abs: string): string {
  const spelled = normalizeAbsolutePath(abs);
  if (spelled === undefined) throw new Error(`not an acceptable absolute path: ${abs}`);
  return spelled;
}

/** 外の鍵の映しの URI の path（posix は絶対パスそのもの、Windows は `/c:/…`）。 */
export function outsideMirrorPath(abs: string): string {
  return stageUriPartsOfKey(agentSpelling(abs)).path;
}
