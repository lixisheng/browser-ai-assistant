import { expect, test } from "@playwright/test";

test("侧边栏页面可以渲染首次使用提示和设置入口", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Browser AI Assistant" })).toBeVisible();
  await expect(page.getByText("请先配置 API Key 后再开始对话")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();

  await page.getByRole("button", { name: "设置", exact: true }).click();

  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "渠道管理" })).toBeVisible();
  await page.getByRole("tab", { name: "同步设置" }).click();
  await expect(page.getByText("备份当前插件域本地存储的全部内容，密钥和远程凭据除外")).toBeVisible();
  await expect(page.getByText("加密关闭时，API Key、聊天记录和配置会以明文进入远程备份")).toBeVisible();
});

test("构建后的侧边栏页面应包含 Tailwind 工具类样式", async ({ page }) => {
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Browser AI Assistant" });
  await expect(heading).toBeVisible();

  const headerPadding = await heading.evaluate((element) => {
    const header = element.parentElement;
    return header ? getComputedStyle(header).paddingTop : "";
  });

  expect(headerPadding).toBe("16px");
});
