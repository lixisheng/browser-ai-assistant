import { describe, expect, it } from "vitest";
import { TAVILY_SEARCH_TOOL_ID, TAVILY_SEARCH_TOOL_NAME, getRegisteredModelTools } from "../../../src/shared/models/toolRegistry";

describe("模型工具注册表", () => {
  it("注册 Tavily 搜索工具供工具调用菜单和 background allow-list 使用", () => {
    const tavilyTool = getRegisteredModelTools().find((tool) => tool.id === TAVILY_SEARCH_TOOL_ID);

    expect(tavilyTool).toMatchObject({
      id: TAVILY_SEARCH_TOOL_ID,
      name: TAVILY_SEARCH_TOOL_NAME,
      parameters: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
      },
    });
  });
});
