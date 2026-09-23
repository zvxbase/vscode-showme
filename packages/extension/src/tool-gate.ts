import {
  FEATURE_OF_TOOL,
  type Feature,
  type ToolName,
  type WindowRole,
} from "@zvx/vscode-showme-protocol";

/**
 * ツール呼び出しを受け付けるかどうかの判定（設計書 §6.1 の「4段階のオフ」の上2段 ＋
 * 窓の役割）。
 *
 * 判断だけを切り出してある（vscode 非依存）。extension.ts は vscode を値
 * import するので vitest から読み込めず、ここに置かないと「停止スイッチを
 * 押したあと本当に拒否されるか」を単体で確かめられない。
 *
 * 判定は毎回の呼び出しで読み直した設定と**そのときの役割**に対して行うこと。
 * activate 時の値を握ると、停止スイッチを押しても、あるいは預けるのをやめても、
 * 既に立っているソケットが受け付け続ける。
 */

export interface ToolGateConfig {
  enabled: boolean;
  /** 3機能の `enabled`（`readConfig().features`）。ツールへの割り当ては `FEATURE_OF_TOOL`。 */
  features: Readonly<Record<Feature, boolean>>;
}

export type ToolGate = { allowed: true } | { allowed: false; message: string };

/**
 * 預けていない（ShowMe がオフの）窓での拒否の文言。
 *
 * エージェントにも人間にも読まれる。**次に何をすればよいかを書く** ―― 押す
 * 場所が分からないと、既定が「不可」であることは単なる故障に見える。
 * 停止中（`ShowMe: Stopped`）はクリックしてもオンにならないので、その場合の
 * 次の一手（再開）にも触れる。ステータスバーの表示と同じ語（On / Off）を使う。
 */
export const WINDOW_OFF_MESSAGE =
  "ShowMe is off for this window. Click ShowMe in the VS Code status bar to turn it on (if it says Stopped, resume it first)";

/**
 * `tool` は `ToolName` に限る。エージェントが渡した任意の文字列をそのまま
 * 通すと、拒否メッセージを経由して注入された文字列が人間の画面に出る。
 * 線上のスキーマ（`requestSchema`）が判別する側の型をそのまま要求することで、
 * ここに来るのは既知の2つの名前だけになる。
 *
 * `role` は必須にしてある。既定値を持たせると、渡し忘れた呼び出し口が黙って
 * 一段緩くなる（あるいは黙って全部拒否する）ので、**新しい入口を作った人に
 * 型で気づかせる**。
 *
 * 段の順序は「停止中 > 役割 > 機能の無効化」。ステータスバーの表示の
 * 優先順位と揃えてある ―― 画面が「停止中」と言っているのに拒否の理由が
 * 「預けていません」だと、人間はどちらを直せばよいか分からない。
 */
export function checkToolGate(config: ToolGateConfig, tool: ToolName, role: WindowRole): ToolGate {
  if (!config.enabled) {
    return { allowed: false, message: "ShowMe is stopped (it can be resumed from the status bar)" };
  }
  // **`!== "stage"` で判定する。** `=== "idle"` にすると、知らない綴り（古い
  // 登録ファイル、将来増えた役割）が「預けている」側に落ちる。既定は不可である。
  //
  // `list_workspaces` もここで止まる。預けていない窓の存在やワークスペース
  // パスをエージェントに教える理由が無い ―― 通すと、既定の状態でも
  // 「窓が1つあり、そのパスはこれ」までは必ず漏れる（設計書 §2A.1）。
  if (role !== "stage") {
    return { allowed: false, message: WINDOW_OFF_MESSAGE };
  }
  // 機能の無効化（増分6 D75）。どのツールがどの機能かは protocol の表1つが決める。
  // `list_workspaces.disabledTools` も同じ表から導出するので、「一覧に無いのに
  // 断られる」「一覧にあるのに通る」は構造上起きない（不変条件14）。
  // 核（`"core"`）は切れない ―― `show_code` もここは通す。開かないのは
  // `show_code` の中で `features.stage` を見る（D76）。
  const feature = FEATURE_OF_TOOL[tool];
  if (feature !== "core" && !config.features[feature]) {
    return {
      allowed: false,
      // 文言は**直す場所**（設定の鍵）を言う。人間にも読まれる。
      message: `Tool ${tool} is disabled by settings (showme.${feature}.enabled is false)`,
    };
  }
  return { allowed: true };
}
