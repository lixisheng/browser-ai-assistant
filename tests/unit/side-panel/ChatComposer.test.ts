import { describe, expect, it } from "vitest";
import { removeSlashCommandSegment } from "../../../src/side-panel/components/ChatComposer";

describe("ChatComposer", () => {
  it("选择 Prompt 后按当前输入值移除完整斜杠搜索片段", () => {
    expect(removeSlashCommandSegment("帮我用 /风险 审查", 4)).toBe("帮我用 审查");
    expect(removeSlashCommandSegment("/风险", 0)).toBe("");
    expect(removeSlashCommandSegment("前缀 /fengxian", 3)).toBe("前缀");
    expect(removeSlashCommandSegment("/风险 后续内容", 0)).toBe("后续内容");
  });
});
