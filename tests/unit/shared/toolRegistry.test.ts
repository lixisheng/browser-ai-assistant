import { describe, expect, it } from "vitest";
import {
  BROWSER_TAKE_SNAPSHOT_TOOL_ID,
  BROWSER_TAKE_SNAPSHOT_TOOL_NAME,
  CURRENT_TIME_TOOL_ID,
  CURRENT_TIME_TOOL_NAME,
  TAVILY_SEARCH_TOOL_ID,
  TAVILY_SEARCH_TOOL_NAME,
  getRegisteredModelTools,
} from "../../../src/shared/models/toolRegistry";

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

  it("注册当前系统时间工具且不要求模型提供参数", () => {
    const currentTimeTool = getRegisteredModelTools().find((tool) => tool.id === CURRENT_TIME_TOOL_ID);

    expect(currentTimeTool).toMatchObject({
      id: CURRENT_TIME_TOOL_ID,
      name: CURRENT_TIME_TOOL_NAME,
      displayName: "当前系统时间",
      parameters: {
        type: "object",
        required: [],
        additionalProperties: false,
      },
    });
  });

  it("注册浏览器页面快照工具且不接受模型参数", () => {
    const snapshotTool = getRegisteredModelTools().find((tool) => tool.id === BROWSER_TAKE_SNAPSHOT_TOOL_ID);

    expect(snapshotTool).toMatchObject({
      id: BROWSER_TAKE_SNAPSHOT_TOOL_ID,
      name: BROWSER_TAKE_SNAPSHOT_TOOL_NAME,
      displayName: "浏览器页面快照",
      parameters: {
        type: "object",
        required: [],
        additionalProperties: false,
      },
    });
  });
});
