# エージェントを繋ぐ

| エージェント | すること |
|---|---|
| VS Code 内蔵の Copilot（エージェントモード） | 何もしなくてよい。ShowMe が VS Code に自分を登録する。 |
| Claude Code | **ShowMe: エージェントの設定の1行をコピー**（`ShowMe: Copy agent setup command`）で Claude Code を選び、`claude mcp add` の行を端末に貼って実行する。そのあと Claude Code を起動し直す。 |
| Codex CLI | Codex CLI を選び、写した節を `~/.codex/config.toml` に足す。そのあと Codex を起動し直す。 |
| Copilot CLI | Copilot CLI を選ぶと、`~/.copilot/mcp-config.json` 用の `{"mcpServers": {"showme": …}}` の塊を写す。ファイルが無ければ、塊をそのままそのファイルとして保存する。あれば、塊の中の `"showme"` の項目を、既にある `"mcpServers"` の中に写す。そのあと Copilot CLI を起動し直す。 |

ShowMe は他のツールの設定ファイルを書き換えない。写すのは文字列だけ。

ほかのことは **ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`）にある: 各項目の2つの形、
Claude Code の許可ルール、すべての repo やチームで使うスコープ。
