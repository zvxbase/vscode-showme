import { randomUUID } from "node:crypto";
import type { WindowRole } from "@zvx/vscode-showme-protocol";

/** 役割が変わったときに呼ばれる。**変化したときだけ**呼ばれる。 */
export type WindowRoleListener = (role: WindowRole) => void;

/** `vscode.Disposable` と構造的に互換な購読の解き方。 */
export interface RoleSubscription {
  dispose(): void;
}

/**
 * この窓の役割を持つ（設計書 §2A.1 / §2A.2）。
 *
 * **既定は `idle`（預けていない）。** 拡張を入れただけでは、どの窓も
 * エージェントに操作されない。人間がステータスバーをクリックした窓だけが
 * 舞台になる。
 *
 * 役割は**設定を経由しない**。ワークスペース設定は主敵（読ませている OSS）が
 * 書ける（不変条件9）し、グローバル設定は全窓で共有されるので、どちらも
 * 「この窓だけ預ける」を表せない。だから窓ごとのメモリに持つ。
 *
 * **永続化しない**（不変条件13）。窓を再読込すると `idle` に戻る。登録ファイルは
 * 元々一時的な実行時情報であり、役割もその一部である。
 *
 * `vscode` に依存しない。値として import すると、このファイルを読む単体テストが
 * 「Failed to load url vscode」で丸ごと落ちる（`config.ts` の getVSCode に経緯）。
 * 役割の保持・遷移・購読だけをここに置き、vscode 側の配線は呼び出し側に持たせる。
 */
export class WindowRoleState {
  /**
   * この窓の識別子。生成後は変わらない（設計書 §2A.4）。
   *
   * `vscode.env.sessionId` は窓ごとに異なることを実験で確認したが、役割を
   * 表さないので我々が別に持つ。再読込時の挙動に関する未確認事項も避けられる。
   */
  readonly windowId: string = randomUUID();

  private role: WindowRole = "idle";
  private readonly listeners = new Set<WindowRoleListener>();
  private disposed = false;

  /** いまの役割。 */
  current(): WindowRole {
    return this.role;
  }

  /** 預けているか。ツールの門（tool-gate）が読む述語。 */
  isStage(): boolean {
    return this.role === "stage";
  }

  /**
   * 役割を置く。変化したときだけ購読者を呼ぶ。返り値は置いた後の役割。
   *
   * dispose 後は何もしない。破棄済みの窓が `stage` に戻るのを防ぐ
   * （フェイルクローズ: 迷ったら預けない側に倒す）。
   */
  set(role: WindowRole): WindowRole {
    if (this.disposed || role === this.role) return this.role;
    this.role = role;
    // 通知中に購読を解かれても、その回の残りを飛ばさないよう複製の上を回る。
    for (const listener of [...this.listeners]) listener(role);
    return this.role;
  }

  /** 預ける/預けるのをやめる を切り替える。返り値は切り替えた後の役割。 */
  toggle(): WindowRole {
    return this.set(this.role === "stage" ? "idle" : "stage");
  }

  /**
   * 役割の変化を購読する。返り値を dispose すると解ける。
   *
   * dispose 後の購読は登録しない（呼ばれることが無いので、保持だけして
   * 漏らす意味が無い）。
   */
  onChange(listener: WindowRoleListener): RoleSubscription {
    if (this.disposed) return { dispose: () => {} };
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** 窓を畳む。以後は役割が動かず、購読者も呼ばれない。繰り返し呼んでも安全。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
