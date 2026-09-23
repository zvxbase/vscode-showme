# Security Policy

## Reporting

Please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Do not open a public issue.
You will get an acknowledgement within 7 days.

## Scope

vscode-showme is a VS Code extension plus a stdio MCP bridge. Findings we care about most:

- Any way for an agent to read file contents, selection text, or the count of matches through a tool result.
- Any way for agent-supplied HTML/Markdown to run script, load remote resources, or execute VS Code commands.
- Any way to reach the extension from another user or process (the socket is `0700`, per-user).
- Any way for a workspace (`.vscode/settings.json`) to widen what the agent may do.

## Non-goals

The extension does not protect against a malicious extension already installed in the same
VS Code, nor against an agent that has shell access through other means — those are outside what
this layer can promise.

## Supported versions

Only the latest release on the Marketplace / Open VSX receives fixes.
