import { MAX_NOTE_CHARS, sanitizeNoteText } from "@zvx/vscode-showme-protocol";
import type { LastWrite, ObservedDocument } from "../note-target.js";
import { chooseNoteTarget } from "../note-target.js";
import { ToolError } from "../tool-error.js";

/**
 * `show_note`（設計書 §4.3）。
 *
 * `workspace.openTextDocument({ content, language })` で**名前なしドキュメント**を開く。
 * `untitled:<path>` 形式は使わない ―― そちらは開いた後にその場所へ**無確認で
 * 保存できる**。`{ content, language }` 版は保存時に必ずパスを尋ねる。
 *
 * 人間が書き足していたら上書きしない。判定は `note-target.ts` の純関数が1つだけ持つ。
 */

/** 既定の言語。メモは説明文なので markdown にする。 */
export const DEFAULT_NOTE_LANGUAGE = "markdown";

/** メモを開く面。`vscode` に触る実装は `note-surface.ts` にある。 */
export interface NoteSurface {
  /** いま開いているメモの観測値。開いていなければ `undefined`。 */
  observe(): ObservedDocument | undefined;
  /** 新しい名前なしドキュメントを開く。**書き終えた直後**の状態を返す。 */
  openNew(text: string, language: string): Promise<LastWrite>;
  /** 既にあるドキュメントの中身を差し替える。**書き終えた直後**の状態を返す。 */
  replace(text: string): Promise<LastWrite>;
}

export interface ShowNoteArgs {
  text: string;
  language?: string;
}

export interface ShowNoteDeps {
  notes: NoteSurface;
  /** 直前の書き込み。**呼び出しをまたいで持つのは呼び出し側**（extension.ts）。 */
  lastWrite: () => LastWrite | undefined;
  rememberWrite: (write: LastWrite) => void;
  allowCall?: () => boolean;
  log: { info: (message: string, fields?: Record<string, string>) => void };
}

export async function handleShowNote(
  args: ShowNoteArgs,
  deps: ShowNoteDeps,
): Promise<{ shown: true; reusedDocument: boolean }> {
  if (deps.allowCall !== undefined && !deps.allowCall()) {
    throw new ToolError("rate-limited", "Too many show_note calls");
  }
  const language = args.language ?? DEFAULT_NOTE_LANGUAGE;
  // **メモも無害化を通る**（不変条件7 の3経路目）。初版はここだけ素通しで、
  // markdown プレビューが生の HTML を描画するため、3枚構成も CSP も通らずに
  // 取得が起きる経路が残っていた（増分2C のレビューで判明）。
  const text = sanitizeNoteText(args.text, language, MAX_NOTE_CHARS);
  const target = chooseNoteTarget(deps.lastWrite(), deps.notes.observe());

  const write =
    target.kind === "reuse"
      ? await deps.notes.replace(text)
      : await deps.notes.openNew(text, language);

  deps.rememberWrite(write);
  deps.log.info("show_note", { target: target.kind, reason: target.reason });
  return { shown: true, reusedDocument: target.kind === "reuse" };
}
