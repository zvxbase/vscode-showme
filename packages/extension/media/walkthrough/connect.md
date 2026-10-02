# Connect your agent

| Your agent | What to do |
|---|---|
| Copilot in VS Code (agent mode) | Nothing. ShowMe registers itself with VS Code. |
| Claude Code | Run **ShowMe: Copy agent setup command**, choose Claude Code, paste the `claude mcp add` line into a terminal and run it. Then restart Claude Code. |
| Codex CLI | Choose Codex CLI and add the copied section to `~/.codex/config.toml`. Then restart Codex. |
| Copilot CLI | Choose Copilot CLI. It copies a `{"mcpServers": {"showme": …}}` block for `~/.copilot/mcp-config.json`: if the file doesn't exist, save the block as the file; otherwise copy its `"showme"` entry into your existing `"mcpServers"`. Then restart Copilot CLI. |

ShowMe never edits other tools' configuration files: it only copies the text for you.

**ShowMe: Show agent configuration** has everything else: both forms of each entry, the
permission rules for Claude Code, and scopes for all your repositories or your team.
