# vscode-showme

> English: [README.md](README.md)

**AI エージェントに VS Code の手足を与える。**

Claude Code はコードを変えられるが、あなたの画面を変えられない。vscode-showme はその一点だけを埋める。

未知のリポジトリを読むとき、隣に座ったエージェントが実際にファイルを開き、該当行をハイライトし、2箇所を並べ、行に注釈を付け、図を描いてメモを残す — そういう読み方をするための層。

**残るものは、戻れて、消せる。** `show_code` のハイライト（スポットライト）は「今ここ」を指すためのもので、
次の `show_code` で消える。後で戻るためのものは注釈で、色つきの注釈は行にも同じ色で塗られ、
注釈と一緒に消える。注釈には読む順番（`1/7 ·`）が付き、人間は吹き出しの **Resolve** で「読んだ」を返せる。
人間向けの命令はコマンドパレットに4つ: **ShowMe: Next annotation / Previous annotation**
（エージェントの順で案内）と **ShowMe: Clear highlights / Clear annotations**（消す）。

## これは何ではないか

- コード編集・シェル実行・診断/LSP は**提供しない**。Claude Code / Copilot CLI / Codex と既存の VS Code 向け MCP サーバが既に持っている
- ツアーの事前生成も、独自の LLM 呼び出しもしない。教え方はエージェントが持っている

## 構成

| パッケージ | 役割 |
|---|---|
| `packages/protocol` | 共有スキーマ・ツール定義・注釈（唯一の定義元） |
| `packages/bridge` | stdio MCP サーバ。エージェントが起動する |
| `packages/extension` | VS Code 拡張。vscode API を実際に叩く |

拡張が「手」で、MCP サーバが「口」。VS Code の API 境界により、両方が必要。

## 安全性の要点

- **ネットワークリスナーを持たない**（Unix socket / 名前付きパイプのみ）
- **どのツールもファイルの中身を返さない**
- webview は **egress ゼロ**（`connect-src 'none'` / `img-src data:`）の二重 iframe
- エージェントの舞台（editor group）は**有界**（上限2列）で、**人間が使っている列を含まない**
- 画面を片づける `arrange_editors` は、**既定ではエージェント自身が出したパネルしか閉じない**
  （人間のタブに届くのは `showme.layout.closeHumanTabs`、未保存にはさらに
  `showme.layout.closeDirtyTabs` を人間が立てたときだけ。どちらも既定は `false`）
- 機能は3つの設定で切れる: `showme.stage.enabled`（開く・スクロール・split・`show_note`。
  切ると `show_code` は**印だけ**）/ `showme.html.enabled`（`show_html`）/
  `showme.layout.enabled`（`arrange_editors`・`show_view`）。注釈・読み取り・`show_code` の印は切れない。
  設定が縛るのはエージェントで、人間の Next / Clear は設定に関わらず動く
- 全ツール `openWorldHint: false`
- ステータスバー1クリックで停止。Restricted Mode で動く

## 言語

エージェントが読む文字列（ツールの説明・エラー）は**英語のみ**。人間が読む文字列
（ステータスバー・通知・コマンド名・設定の説明・設定断片と撤去手順の文書）は**英語が既定**で、
VS Code の表示言語が日本語なら日本語になる（`vscode.l10n` / `package.nls.ja.json`。設計 D58）。

## 開発の場所

この公開 repo は**リリースのミラー**です。開発は private の repo で行い、リリースごとに
1 コミットとしてここに載せます。Issue / PR は歓迎で読みます。
取り込んだ PR は private 側に当て直して次のリリースに入り、`CHANGELOG.md` でクレジットします。

## 現在地

版は `0.1.0`（preview）。増分6 まで完了（2026-09-13）。

**エージェント操作の既定は「不可」です。** 拡張を入れただけでは、どの窓も操作されません。
VS Code のステータスバー右下の `$(shield) ShowMe: Off`（日本語表示なら
`ShowMe: オフ`）をクリックして、その窓で ShowMe をオンにしてください
（＝その窓をエージェントに預ける。`ShowMe: Stopped` と出ていれば、先にコマンドパレットの
「ShowMe: Stop / Resume the extension」で再開する）。

ツールは10本（`packages/protocol/src/tools.ts` の `TOOL_NAMES`）: `list_workspaces` /
`get_editor_state` / `show_code` / `annotate` / `show_html` / `show_note` / `find_definition` /
`find_references` / `show_view` / `arrange_editors`。

| | |
|---|---|
| 単体テスト | 1563（75ファイル） |
| 統合テスト（実 VS Code・1窓） | 294（信頼198 / 制限96） |
| 統合テスト（実 VS Code・2窓） | 9 |
| 統合テスト（実 VS Code・日本語の言語パック） | 3 |

同じフォルダを2窓で開き、片方だけを預ける運用ができます。ブリッジは**役割で**窓を選ぶので、
`$SHOWME_SOCK`（制限モードと tmux で死ぬ）にも `workspace_path`（同一フォルダでは判別できない）
にも依存しません。

使い方と、まだできないことの一覧は [`docs/runbook.md`](docs/runbook.md) にあります。

## ドキュメント

- セキュリティ: [`SECURITY.md`](SECURITY.md)
- 運用手順: [`docs/runbook.md`](docs/runbook.md)

## ライセンス

MIT
