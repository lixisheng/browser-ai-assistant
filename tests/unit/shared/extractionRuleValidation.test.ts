import { describe, expect, it } from "vitest";
import { validateExtractionRuleDraft } from "../../../src/shared/extractionRules/validation";

describe("提取规则校验", () => {
  it("拒绝非法 URL 正则", () => {
    const result = validateExtractionRuleDraft({
      alias: "",
      urlPattern: "[",
      selectorsText: "main",
    });

    expect(result).toEqual({
      ok: false,
      message: "URL 正则格式不正确",
    });
  });

  it("拒绝空 CSS 或 XPath", () => {
    const result = validateExtractionRuleDraft({
      alias: "",
      urlPattern: "https://example.com/.*",
      selectorsText: "  \n",
    });

    expect(result).toEqual({
      ok: false,
      message: "请至少填写一条 CSS 或 XPath",
    });
  });

  it("拒绝既不是合法 CSS 也不是合法 XPath 的选择器行", () => {
    const result = validateExtractionRuleDraft({
      alias: "",
      urlPattern: "https://example.com/.*",
      selectorsText: "[",
    });

    expect(result).toEqual({
      ok: false,
      message: "第 1 行 CSS/XPath 格式不正确",
    });
  });

  it("允许合法 CSS 或合法 XPath", () => {
    expect(
      validateExtractionRuleDraft({
        alias: "",
        urlPattern: "https://example.com/.*",
        selectorsText: "main\n//*[@id='content']",
      }),
    ).toEqual({ ok: true });
  });
});
