import { describe, expect, it } from "vitest";
import {
  BROWSER_CLICK_TOOL_ID,
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_FILL_TOOL_ID,
  BROWSER_FILL_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_ID,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_TAKE_SNAPSHOT_TOOL_ID,
  BROWSER_TAKE_SNAPSHOT_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_ID,
  BROWSER_WAIT_FOR_TOOL_NAME,
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

  it("注册阶段三浏览器基础操作工具并收紧参数 schema", () => {
    const tools = getRegisteredModelTools();
    const clickTool = tools.find((tool) => tool.id === BROWSER_CLICK_TOOL_ID);
    const fillTool = tools.find((tool) => tool.id === BROWSER_FILL_TOOL_ID);
    const pressKeyTool = tools.find((tool) => tool.id === BROWSER_PRESS_KEY_TOOL_ID);
    const waitForTool = tools.find((tool) => tool.id === BROWSER_WAIT_FOR_TOOL_ID);

    expect(clickTool).toMatchObject({
      id: BROWSER_CLICK_TOOL_ID,
      name: BROWSER_CLICK_TOOL_NAME,
      displayName: "浏览器点击元素",
      parameters: {
        type: "object",
        required: ["uid"],
        additionalProperties: false,
      },
    });
    expect(clickTool?.parameters.properties).toMatchObject({
      uid: { type: "string" },
      includeSnapshot: { type: "boolean" },
    });

    expect(fillTool).toMatchObject({
      id: BROWSER_FILL_TOOL_ID,
      name: BROWSER_FILL_TOOL_NAME,
      displayName: "浏览器填写元素",
      parameters: {
        type: "object",
        required: ["uid", "value"],
        additionalProperties: false,
      },
    });
    expect(fillTool?.parameters.properties).toMatchObject({
      uid: { type: "string" },
      value: { type: "string" },
      includeSnapshot: { type: "boolean" },
    });

    expect(pressKeyTool).toMatchObject({
      id: BROWSER_PRESS_KEY_TOOL_ID,
      name: BROWSER_PRESS_KEY_TOOL_NAME,
      displayName: "浏览器按键",
      parameters: {
        type: "object",
        required: ["key"],
        additionalProperties: false,
      },
    });
    expect(pressKeyTool?.parameters.properties).toMatchObject({
      key: { type: "string" },
      includeSnapshot: { type: "boolean" },
    });

    expect(waitForTool).toMatchObject({
      id: BROWSER_WAIT_FOR_TOOL_ID,
      name: BROWSER_WAIT_FOR_TOOL_NAME,
      displayName: "浏览器等待文本",
      parameters: {
        type: "object",
        required: ["text"],
        additionalProperties: false,
      },
    });
    expect(waitForTool?.parameters.properties).toMatchObject({
      text: { type: "array", items: { type: "string" } },
      timeout: { type: "number", minimum: 1, maximum: 30000 },
    });
  });
});
