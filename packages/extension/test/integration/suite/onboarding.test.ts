import * as assert from "node:assert";
import * as vscode from "vscode";
import { EXTENSION_ID, SHOWME_DOC_SCHEME, activateExtension, waitFor } from "./helpers.js";

/**
 * 入れた直後の案内（増分14 D120 / D121 / D122）を実 VS Code で確かめる。信頼・制限の両方の回で走る
 * （どちらも信頼に依らない命令。制限モードでも外のエージェントは繋げる）。
 */
suite("実 VS Code / 入れた直後の案内（Get Started とコピー。増分14）", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("walkthrough が manifest にあり、ShowMe: Get started が投げずに Get Started のエディタを開く", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const wts = (ext.packageJSON as { contributes: { walkthroughs?: { id: string }[] } })
      .contributes.walkthroughs;
    assert.deepStrictEqual(
      wts?.map((w) => w.id),
      ["getStarted"],
    );
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("showme.getStarted"), "showme.getStarted が登録されていない");
    assert.ok(commands.includes("showme.copySetupCommand"), "showme.copySetupCommand が無い");

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("showme.getStarted");
    // Get Started のエディタは TabInputText ではない（入力の型が無い）。前面のタブが現れ、
    // テキストの文書ではないことで見る
    await waitFor("Get Started のエディタが開く", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== undefined && !(tab.input instanceof vscode.TabInputText);
    });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    console.log(`[showme] Get started で開いたタブ: ${tab?.label}`);
    assert.ok(tab);
  });

  for (const agent of ["claude", "codex", "copilot"] as const) {
    test(`コピーの命令（${agent}）はクリップボードに文書と同じ断片を入れる`, async () => {
      await vscode.env.clipboard.writeText("before");
      const result = (await vscode.commands.executeCommand("showme.test.copySetupCommand", {
        agent,
        form: "node",
      })) as {
        copied?: { agent: string; form: string; text: string; message: string };
        offered: unknown[][];
      };
      assert.deepStrictEqual(result.offered[0], ["claude", "codex", "copilot"]);
      // この環境（デスクトップの Linux、安定な場所）では形が2つあり、実行環境が先
      assert.deepStrictEqual(result.offered[1], ["runtime", "node"]);
      assert.ok(result.copied, "何も写さなかった");
      assert.strictEqual(result.copied.agent, agent);
      assert.strictEqual(result.copied.form, "node");
      const clip = await vscode.env.clipboard.readText();
      assert.strictEqual(clip, result.copied.text);
      assert.notStrictEqual(clip, "before");

      await vscode.commands.executeCommand("showme.showAgentConfig");
      await waitFor(
        "エージェント設定の文書が開く",
        () => vscode.window.activeTextEditor?.document.uri.scheme === SHOWME_DOC_SCHEME,
      );
      const doc = vscode.window.activeTextEditor?.document.getText() ?? "";
      // 文書のコードブロックの中身としてそのまま現れる（不変条件14: 同じ関数から作った断片）
      assert.ok(doc.includes(`\n${clip}\n\`\`\``), `文書に無い断片を写した:\n${clip}`);
    });
  }

  test("コピーの命令を取り消すとクリップボードは変わらない", async () => {
    await vscode.env.clipboard.writeText("untouched");
    const result = (await vscode.commands.executeCommand("showme.test.copySetupCommand", {})) as {
      copied?: unknown;
    };
    assert.strictEqual(result.copied, undefined);
    assert.strictEqual(await vscode.env.clipboard.readText(), "untouched");
  });
});
