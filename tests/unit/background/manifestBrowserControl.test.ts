import { describe, expect, it } from "vitest";
import manifest from "../../../public/manifest.json";

describe("浏览器控制 Manifest 权限", () => {
  it("阶段四导航与多页面控制声明 tabs 权限但不声明 tabGroups 权限", () => {
    expect(manifest.permissions).toEqual(expect.arrayContaining(["debugger", "tabs"]));
    expect(manifest.permissions).not.toContain("tabGroups");
  });
});
