import {
  type EditorRuntime,
  type FormSnippet,
  type SetupAgent,
  type SnippetForm,
  agentSetupSnippets,
  agentSnippetBody,
} from "./agent-config-doc.js";
import { t } from "./l10n.js";

/**
 * **ShowMe: Copy agent setup command**（増分14 D122）。
 *
 * エージェントと形を選ばせ、その1つの断片をクリップボードに写して、どこへ貼るかを言う。
 * **写す文字列は文書（ShowMe: Show agent configuration）と同じ関数から作る**
 * （`agentSetupSnippets` / `agentSnippetBody`。不変条件14）。形の候補と順も文書と同じ
 * `snippetRuntime` の forms（先頭が勧めるもの）。
 *
 * 書くのはクリップボードだけ。他ツールの設定ファイルを書かない（不変条件11）。選んだものを
 * 覚えない（不変条件13）。このファイルは vscode に依存しない（I/O は `CopySetupDeps` で注入する）。
 */

export const SETUP_AGENTS: readonly SetupAgent[] = ["claude", "codex", "copilot"];

/** 選択肢の1つ（QuickPick の項目に写す）。 */
export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

export interface CopySetupDeps {
  /** 文書と同じ入力（`extension.ts` が文書と同じ値を渡す） */
  inputs: { bridgePath: string; platform: NodeJS.Platform; runtime: EditorRuntime };
  /** 1つ選ばせる。取り消しは undefined */
  pick: <T>(items: readonly PickItem<T>[], placeHolder: string) => Promise<T | undefined>;
  writeClipboard: (text: string) => Promise<void>;
  /** 情報のメッセージとボタン1つ。押されたボタンの文字列（閉じたら undefined） */
  inform: (message: string, button: string) => Thenable<string | undefined>;
  /** 文書（ShowMe: Show agent configuration）を開く */
  openFullConfiguration: () => Promise<void>;
}

export interface CopiedSetup {
  agent: SetupAgent;
  form: SnippetForm;
  text: string;
  message: string;
}

/** 写す文字列（文書のコードブロックの中身と同じ。Claude Code はスコープ無し ＝ local）。 */
export function setupCommandText(agent: SetupAgent, snippet: FormSnippet): string {
  return agentSnippetBody(agent, snippet);
}

function agentItems(): PickItem<SetupAgent>[] {
  return [
    {
      label: "Claude Code",
      description: t("a claude mcp add command for a terminal"),
      value: "claude",
    },
    { label: "Codex CLI", description: t("a section for ~/.codex/config.toml"), value: "codex" },
    {
      label: "Copilot CLI",
      description: t('a {"mcpServers": …} block for ~/.copilot/mcp-config.json'),
      value: "copilot",
    },
  ];
}

function formItem(kind: SnippetForm, recommended: boolean): PickItem<SnippetForm> {
  const label = kind === "runtime" ? t("With VS Code's runtime") : t("With node");
  const detail =
    kind === "runtime"
      ? t("No Node.js needed.")
      : t("Needs Node.js 20 or later on your PATH. Keeps working when VS Code updates.");
  return recommended
    ? { label, description: t("recommended here"), detail, value: kind }
    : { label, detail, value: kind };
}

function copiedMessage(agent: SetupAgent): string {
  switch (agent) {
    case "claude":
      return t(
        "ShowMe: copied the claude mcp add command. Paste it into a terminal and run it, then restart Claude Code.",
      );
    case "codex":
      return t(
        "ShowMe: copied the [mcp_servers.showme] section. Add it to ~/.codex/config.toml, then restart Codex.",
      );
    case "copilot":
      return t(
        'ShowMe: copied a {"mcpServers": {"showme": …}} block for ~/.copilot/mcp-config.json. If the file doesn\'t exist, save the block as the file; otherwise copy its "showme" entry into your existing "mcpServers". Then restart Copilot CLI.',
      );
  }
}

/**
 * 選ばせて写す。取り消したら何も写さず undefined。メッセージの返事は待たない
 * （写した時点で完了。ボタンが押されたら文書を開く）。
 */
export async function copySetupCommand(deps: CopySetupDeps): Promise<CopiedSetup | undefined> {
  const agent = await deps.pick(agentItems(), t("Which agent do you want to set up?"));
  if (agent === undefined) return undefined;
  const { bridgePath, platform, runtime } = deps.inputs;
  const snippets = agentSetupSnippets(bridgePath, platform, runtime);
  let snippet: FormSnippet | undefined = snippets[0];
  if (snippets.length > 1) {
    const form = await deps.pick(
      snippets.map((s, i) => formItem(s.kind, i === 0)),
      t("How should your agent start ShowMe?"),
    );
    if (form === undefined) return undefined;
    snippet = snippets.find((s) => s.kind === form);
  }
  if (snippet === undefined) return undefined;
  const text = setupCommandText(agent, snippet);
  await deps.writeClipboard(text);
  const message = copiedMessage(agent);
  const button = t("Open full configuration");
  void Promise.resolve(deps.inform(message, button)).then((choice) => {
    if (choice === button) return deps.openFullConfiguration();
    return undefined;
  });
  return { agent, form: snippet.kind, text, message };
}
