import { expect, test } from "./fixtures/extension";

test("构建产物可以作为 Chrome 扩展加载并渲染侧边栏页面", async ({ extensionContext, extensionId }) => {
  const page = await extensionContext.newPage();

  await page.goto(`chrome-extension://${extensionId}/index.html`);

  await expect(page.getByRole("heading", { name: "Browser AI Assistant" })).toBeVisible();
  await expect(page.getByText("请先配置 API Key 后再开始对话")).toBeVisible();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
});
