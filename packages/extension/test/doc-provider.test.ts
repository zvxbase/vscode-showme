import { describe, expect, it } from "vitest";
import {
  SHOWME_DOC_SCHEME,
  type ShowMeDocUriParts,
  showMeDocIdForUri,
  showMeDocUriPath,
} from "../src/doc-provider.js";

function parts(over: Partial<ShowMeDocUriParts> = {}): ShowMeDocUriParts {
  return {
    scheme: SHOWME_DOC_SCHEME,
    authority: "",
    path: showMeDocUriPath("agent-configuration"),
    query: "",
    fragment: "",
    ...over,
  };
}

describe("showMeDocUriPath（D98）", () => {
  it("id ごとに固定の綴り", () => {
    expect(showMeDocUriPath("agent-configuration")).toBe("/agent-configuration.md");
    expect(showMeDocUriPath("teardown")).toBe("/teardown.md");
  });
});

/**
 * D98 の安全: プロバイダが返してよいのはこの2つの固定の文書だけ。
 * 命中は2件、それ以外（他の path・query・fragment・authority・別の scheme）は
 * 全部 undefined ―― 表の両方向を1つの `it.each` で確かめる。
 */
describe("showMeDocIdForUri（D98）", () => {
  it.each([
    [
      "agent-configuration の正しい綴り",
      parts({ path: "/agent-configuration.md" }),
      "agent-configuration",
    ],
    ["teardown の正しい綴り", parts({ path: "/teardown.md" }), "teardown"],
    ["知らない path", parts({ path: "/other.md" }), undefined],
    ["path の末尾に余分な区切り", parts({ path: "/agent-configuration.md/x" }), undefined],
    ["先頭が二重スラッシュ", parts({ path: "//agent-configuration.md" }), undefined],
    ["query が付いている", parts({ query: "x=1" }), undefined],
    ["fragment が付いている", parts({ fragment: "x" }), undefined],
    ["authority が付いている", parts({ authority: "host" }), undefined],
    ["別のスキーム", parts({ scheme: "file" }), undefined],
  ] as const)("%s", (_label, uri, want) => {
    expect(showMeDocIdForUri(uri)).toBe(want);
  });
});
