import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../../public/manifest.json";

const projectRoot = process.cwd();

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), "utf8");
}

describe("扩展构建产物合约", () => {
  it("manifest 中声明的运行时入口应由 Vite 构建配置产出", async () => {
    const viteConfig = await readProjectFile("vite.config.ts");

    expect(manifest.background.service_worker).toBe("background/index.js");
    expect(manifest.side_panel.default_path).toBe("index.html");
    expect(manifest.devtools_page).toBe("devtools.html");
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].js).toEqual(["content/index.js"]);

    expect(viteConfig).toContain('"background/index": resolve(rootDir, "src/background/index.ts")');
    expect(viteConfig).toContain('devtools: resolve(rootDir, "devtools.html")');
    expect(viteConfig).toContain('sidePanel: resolve(rootDir, "index.html")');
    expect(viteConfig).toContain('outDir: resolve(rootDir, "dist/content")');
    expect(viteConfig).toContain('entry: resolve(rootDir, "src/content/index.ts")');
    expect(viteConfig).toContain('formats: ["iife"]');
    expect(viteConfig).toContain('fileName: () => "index.js"');
  });

  it("内容脚本入口不应引入动态 import，保持普通 content script 可直接执行", async () => {
    const contentEntry = await readProjectFile("src/content/index.ts");

    expect(contentEntry).not.toMatch(/\bimport\s*\(/);
  });
});
