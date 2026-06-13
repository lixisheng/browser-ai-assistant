import { defineConfig } from "@playwright/test";
import { resolveBrowserExecutablePath } from "./tests/e2e/fixtures/browserExecutable";

const browserExecutablePath = resolveBrowserExecutablePath();

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...(browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {}),
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "web-preview",
      testMatch: /extension-smoke\.spec\.ts/,
    },
    {
      name: "chrome-extension",
      testMatch: /extension-runtime\.spec\.ts/,
    },
  ],
});
