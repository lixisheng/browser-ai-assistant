import { describe, expect, it } from "vitest";
import {
  formatTavilyIncludeAnswerLabel,
  formatTavilyIncludeRawContentLabel,
  parseOptionalTavilyIncludeAnswerInput,
  parseOptionalTavilyIncludeRawContentInput,
  parseTavilyIncludeAnswerInput,
  parseTavilyIncludeRawContentInput,
} from "../../../src/shared/webSearch/settings";

describe("Tavily 网络搜索设置", () => {
  it("从共享模块解析 Tavily 表单参数", () => {
    expect(parseTavilyIncludeAnswerInput("advanced")).toBe("advanced");
    expect(parseTavilyIncludeAnswerInput("true")).toBe(true);
    expect(parseTavilyIncludeAnswerInput("invalid")).toBe("basic");
    expect(parseOptionalTavilyIncludeAnswerInput("")).toBeUndefined();

    expect(parseTavilyIncludeRawContentInput("markdown")).toBe("markdown");
    expect(parseTavilyIncludeRawContentInput("true")).toBe(true);
    expect(parseTavilyIncludeRawContentInput("invalid")).toBe(false);
    expect(parseOptionalTavilyIncludeRawContentInput("")).toBeUndefined();
  });

  it("从共享模块格式化 Tavily 参数中文标签", () => {
    expect(formatTavilyIncludeAnswerLabel("basic")).toBe("基础答案");
    expect(formatTavilyIncludeAnswerLabel(false)).toBe("关闭");
    expect(formatTavilyIncludeRawContentLabel("text")).toBe("纯文本");
    expect(formatTavilyIncludeRawContentLabel(true)).toBe("开启");
  });
});
