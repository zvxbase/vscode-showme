import { SOCKET_ENV_VAR } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { buildTeardownDocument } from "../src/teardown-doc.js";

const FACTS = {
  runtimeDirs: ["/run/user/1000/vscode-showme", "/tmp/vscode-showme-1000"],
  extensionId: "zvxbase.vscode-showme",
};

/** 言語ごとに丸ごと書き分けている（D58）ので、両方の版に同じ検査を当てる。 */
describe.each(["en", "ja"] as const)("buildTeardownDocument（D62）[%s]", (lang) => {
  const doc = buildTeardownDocument(FACTS, lang);

  it("消えるものと、消し方が書いてある", () => {
    // 実行時ディレクトリは**両候補とも**載る（拡張は両方に登録ファイルを書く。§2A.6）。
    expect(doc).toContain("/run/user/1000/vscode-showme");
    expect(doc).toContain("/tmp/vscode-showme-1000");
    expect(doc).toContain("code --uninstall-extension zvxbase.vscode-showme");
    expect(doc).toContain("claude mcp remove showme");
    expect(doc).toContain("[mcp_servers.showme]"); // Codex
    expect(doc).toContain("mcp-config.json"); // Copilot CLI
    expect(doc).toContain(SOCKET_ENV_VAR);
    expect(SOCKET_ENV_VAR).toBe("SHOWME_SOCK"); // 名前が変わったら文書の読み手も変わる
  });

  it("拡張が自分で消すものと、人間が消すものを分けている", () => {
    expect(doc).toContain("deactivate");
    expect(doc).toMatch(/開き直|reopen/); // 既に開いている端末には環境変数が残る
    expect(doc).toContain("permissions.allow"); // 許可ルールも人間が足したもの
  });

  it("削除コマンドを1つも出さない（拡張が自分で消すものは消し、人間には手順だけ見せる）", () => {
    // `rm -rf ~` だけを禁じると、`rm -rf ~/.claude` のような別の形が通る。
    // この文書に `rm` が要る理由は無いので、**綴りごと**禁じる。
    expect(doc).not.toMatch(/\brm\s/);
    expect(doc).not.toMatch(/\bdel\s|Remove-Item/);
  });

  it("npx の断片は無い（S12）", () => {
    expect(doc).not.toContain("npx");
  });

  it("候補が1つでも壊れない", () => {
    const one = buildTeardownDocument(
      { runtimeDirs: ["/tmp/vscode-showme-1000"], extensionId: "zvxbase.vscode-showme" },
      lang,
    );
    expect(one).toContain("/tmp/vscode-showme-1000");
    expect(one).not.toContain("/run/user");
  });

  it("プレースホルダを残さない", () => {
    expect(doc).not.toContain("<");
    expect(doc).not.toContain("undefined");
  });
});

describe("buildTeardownDocument の言語（D58）", () => {
  it("en と ja は別の文書で、どちらも自分の言語で書かれている", () => {
    const en = buildTeardownDocument(FACTS, "en");
    const ja = buildTeardownDocument(FACTS, "ja");
    expect(en).not.toBe(ja);
    expect(en).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(ja).toContain("撤去手順");
  });
});
