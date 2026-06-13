import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, test as base } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { resolveBrowserExecutablePath } from "./browserExecutable";

interface ExtensionFixtures {
  extensionContext: BrowserContext;
  extensionId: string;
}

const extensionPath = resolve(process.cwd(), "dist");
const extensionManifestPath = join(extensionPath, "manifest.json");
const browserExecutablePath = resolveBrowserExecutablePath();

export const test = base.extend<ExtensionFixtures>({
  extensionContext: async ({}, use) => {
    if (!existsSync(extensionManifestPath)) {
      throw new Error("未找到 dist/manifest.json，请先执行 npm run build:extension 后再运行真实扩展 E2E 测试。");
    }

    const userDataDir = await mkdtemp(join(tmpdir(), "browser-ai-assistant-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(browserExecutablePath ? { executablePath: browserExecutablePath } : { channel: "chromium" }),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    try {
      await use(context);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  extensionId: async ({ extensionContext }, use) => {
    let [serviceWorker] = extensionContext.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await extensionContext.waitForEvent("serviceworker");
    }

    const extensionId = new URL(serviceWorker.url()).host;
    await use(extensionId);
  },
});

export { expect } from "@playwright/test";
