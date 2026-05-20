# Browser AI Assistant MVP 实施计划

> **给智能执行代理:** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项实施。本计划使用复选框语法跟踪进度。

**目标:** 交付一个可在 Chrome/Chromium 中运行的网页 AI 助手 MVP，支持侧边栏对话、网页内容提取、OpenAI/Anthropic 模型调用、本地聊天记录、Chrome Sync 加密备份与恢复。

**架构:** 使用 Manifest V3 扩展架构，`background service worker` 负责插件入口、模型请求和同步任务，`content script` 负责网页文本提取，`side panel` 负责聊天与设置界面。共享类型、存储、加密、模型适配器放在 `src/shared`，避免 UI 与浏览器能力直接耦合。

**技术栈:** React + Vite + TypeScript、Zustand、Dexie.js、Tailwind CSS + Radix UI、react-markdown、Shiki 或 highlight.js、Vitest、Playwright、Chrome Extension MV3。

---

## 1. 文件结构规划

### 根目录

- 创建 `package.json`：声明依赖、脚本和项目元信息。
- 创建 `tsconfig.json`：统一 TypeScript 编译配置。
- 创建 `vite.config.ts`：配置多入口构建、路径别名和测试环境。
- 创建 `tailwind.config.ts`：配置 Tailwind 扫描路径。
- 创建 `postcss.config.js`：接入 Tailwind 与 Autoprefixer。
- 创建 `vitest.config.ts`：配置单元测试。
- 创建 `playwright.config.ts`：配置扩展冒烟测试。
- 创建 `index.html`：侧边栏 React 挂载入口。

### 扩展静态资源

- 创建 `public/manifest.json`：MV3 权限、side panel、commands、background、content scripts。
- 创建 `public/icons/icon-16.png`、`public/icons/icon-48.png`、`public/icons/icon-128.png`：插件图标，可先使用简单占位图。

### 源码目录

- 创建 `src/background/index.ts`：service worker 入口，注册插件图标、快捷键、右键菜单和消息路由。
- 创建 `src/background/modelRequestHandler.ts`：处理 OpenAI/Anthropic 请求与流式响应转发。
- 创建 `src/background/syncBackupHandler.ts`：处理 Chrome Sync 加密备份与恢复。
- 创建 `src/content/index.ts`：content script 入口，监听提取请求并返回网页文本。
- 创建 `src/content/extractPageText.ts`：实现 URL 规则匹配、CSS/XPath 提取、全局回退、截断提示标记。
- 创建 `src/side-panel/main.tsx`：React 入口。
- 创建 `src/side-panel/App.tsx`：侧边栏主布局。
- 创建 `src/side-panel/components/ChatPanel.tsx`：聊天主界面。
- 创建 `src/side-panel/components/SettingsPanel.tsx`：设置界面。
- 创建 `src/side-panel/components/ModelSelector.tsx`：模型选择与流式/非流式切换。
- 创建 `src/side-panel/components/MessageList.tsx`：消息列表和 Markdown 渲染。
- 创建 `src/side-panel/components/SessionList.tsx`：历史会话排序、拖拽和标题修改。
- 创建 `src/side-panel/state/appStore.ts`：Zustand 状态。
- 创建 `src/shared/types.ts`：共享类型定义。
- 创建 `src/shared/constants.ts`：存储键、消息类型、默认限制值。
- 创建 `src/shared/storage/db.ts`：Dexie 数据库定义。
- 创建 `src/shared/storage/repositories.ts`：模型、规则、会话、同步配置读写。
- 创建 `src/shared/crypto/encryption.ts`：对称加密、解密、密钥校验。
- 创建 `src/shared/models/openaiChatAdapter.ts`：OpenAI Chat Completions 适配器。
- 创建 `src/shared/models/anthropicMessagesAdapter.ts`：Anthropic Messages 适配器。
- 创建 `src/shared/models/modelValidation.ts`：API Key 校验请求。
- 创建 `src/shared/models/titleGeneration.ts`：标题生成与默认标题兜底。
- 创建 `src/shared/utils/date.ts`：本地时间格式化。
- 创建 `src/shared/utils/text.ts`：文本清洗、拼接、截断。

### 测试目录

- 创建 `tests/unit/content/extractPageText.test.ts`：内容提取单元测试。
- 创建 `tests/unit/shared/encryption.test.ts`：加密解密单元测试。
- 创建 `tests/unit/shared/titleGeneration.test.ts`：标题生成兜底单元测试。
- 创建 `tests/unit/shared/modelAdapters.test.ts`：模型适配器请求结构测试。
- 创建 `tests/e2e/extension-smoke.spec.ts`：插件加载和侧边栏基础流程冒烟测试。

---

## 2. 任务拆分

### Task 1: 项目脚手架与基础工具链

**文件:**
- 创建: `package.json`
- 创建: `tsconfig.json`
- 创建: `vite.config.ts`
- 创建: `vitest.config.ts`
- 创建: `playwright.config.ts`
- 创建: `tailwind.config.ts`
- 创建: `postcss.config.js`
- 创建: `index.html`
- 创建: `src/side-panel/main.tsx`
- 创建: `src/side-panel/App.tsx`

- [ ] **Step 1: 初始化 npm 项目和依赖**

运行:

```powershell
npm init -y
npm install react react-dom zustand dexie @radix-ui/react-tabs @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-tooltip react-markdown highlight.js clsx
npm install -D vite typescript @vitejs/plugin-react tailwindcss postcss autoprefixer vitest jsdom playwright @playwright/test @types/react @types/react-dom @types/chrome
```

预期: `package.json`、`package-lock.json` 生成，依赖安装成功。

- [ ] **Step 2: 配置脚本**

在 `package.json` 中配置:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit"
  }
}
```

预期: `npm run typecheck` 可以执行 TypeScript 检查。

- [ ] **Step 3: 创建最小 React 入口**

`src/side-panel/App.tsx` 先渲染侧边栏空壳:

```tsx
export function App() {
  return (
    <main className="min-h-screen bg-white text-slate-950">
      <section className="p-4">
        <h1 className="text-lg font-semibold">Browser AI Assistant</h1>
      </section>
    </main>
  );
}
```

预期: `npm run build` 可以生成 `dist`。

- [ ] **Step 4: 验证**

运行:

```powershell
npm run typecheck
npm run build
```

预期: 两个命令均成功退出。

### Task 2: MV3 扩展基础壳与侧边栏入口

**文件:**
- 创建: `public/manifest.json`
- 创建: `src/background/index.ts`
- 修改: `vite.config.ts`
- 修改: `src/side-panel/App.tsx`

- [ ] **Step 1: 创建 Manifest V3 配置**

`public/manifest.json` 需要包含:

```json
{
  "manifest_version": 3,
  "name": "Browser AI Assistant",
  "version": "0.1.0",
  "description": "基于当前网页内容进行 AI 对话的浏览器侧边栏助手。",
  "permissions": ["sidePanel", "storage", "contextMenus", "activeTab", "scripting"],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_title": "打开 AI 助手"
  },
  "background": {
    "service_worker": "background/index.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "index.html"
  },
  "commands": {
    "open-side-panel": {
      "suggested_key": {
        "default": "Ctrl+Shift+Y",
        "mac": "Command+Shift+Y"
      },
      "description": "打开 AI 助手侧边栏"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/index.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: 注册图标、快捷键、右键菜单打开侧边栏**

`src/background/index.ts` 实现三类入口:

```ts
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-side-panel",
    title: "打开 AI 助手",
    contexts: ["page"],
  });
});

async function openSidePanel(tabId?: number) {
  if (!tabId) return;
  await chrome.sidePanel.open({ tabId });
}

chrome.action.onClicked.addListener((tab) => {
  void openSidePanel(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-side-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openSidePanel(tab?.id);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "open-side-panel") return;
  await openSidePanel(tab?.id);
});
```

- [ ] **Step 3: 验证构建产物**

运行:

```powershell
npm run build
```

预期: `dist/manifest.json`、`dist/background/index.js`、`dist/index.html` 存在。

### Task 3: 共享类型、常量与 IndexedDB 存储

**文件:**
- 创建: `src/shared/types.ts`
- 创建: `src/shared/constants.ts`
- 创建: `src/shared/storage/db.ts`
- 创建: `src/shared/storage/repositories.ts`
- 创建: `tests/unit/shared/storage.test.ts`

- [ ] **Step 1: 定义核心类型**

`src/shared/types.ts` 至少定义:

```ts
export type EndpointType = "openai_chat" | "anthropic_messages";
export type ChatRole = "system" | "user" | "assistant";

export interface ModelConfig {
  id: string;
  name: string;
  channelName: string;
  endpointType: EndpointType;
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  isTitleModel: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ExtractionRule {
  id: string;
  urlPattern: string;
  selectorsText: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  modelId: string;
  endpointType: EndpointType;
  streamMode: boolean;
  systemPrompt: string;
  contextPrompt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
```

- [ ] **Step 2: 建立 Dexie 数据库**

`src/shared/storage/db.ts` 定义 `modelConfigs`、`extractionRules`、`chatSessions`、`appSettings` 四张表。

- [ ] **Step 3: 编写存储测试**

`tests/unit/shared/storage.test.ts` 覆盖模型保存、会话保存、规则保存。

运行:

```powershell
npm run test -- tests/unit/shared/storage.test.ts
```

预期: 所有用例通过。

### Task 4: 网页内容提取与回退策略

**文件:**
- 创建: `src/content/index.ts`
- 创建: `src/content/extractPageText.ts`
- 创建: `src/shared/utils/text.ts`
- 创建: `tests/unit/content/extractPageText.test.ts`

- [ ] **Step 1: 实现文本清洗和截断**

`src/shared/utils/text.ts` 提供:

```ts
export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxLength: number): TruncateResult {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxLength), truncated: true };
}
```

- [ ] **Step 2: 实现 CSS/XPath 提取**

`src/content/extractPageText.ts` 需要按多行文本顺序执行选择器，CSS 失败后尝试 XPath。URL 未匹配、选择器未命中、表达式失败、结果为空时，统一回退到 `<html>` 全局可见文本。

- [ ] **Step 3: 写单元测试**

覆盖:

- URL 未匹配时回退全局文本。
- CSS 命中时按行顺序拼接。
- XPath 命中时提取文本。
- CSS/XPath 失败时回退全局文本。
- 超长文本从开头截取并返回 `truncated: true`。

运行:

```powershell
npm run test -- tests/unit/content/extractPageText.test.ts
```

预期: 所有内容提取用例通过。

### Task 5: 模型配置、API Key 校验与模型适配器

**文件:**
- 创建: `src/shared/models/openaiChatAdapter.ts`
- 创建: `src/shared/models/anthropicMessagesAdapter.ts`
- 创建: `src/shared/models/modelValidation.ts`
- 创建: `src/background/modelRequestHandler.ts`
- 创建: `tests/unit/shared/modelAdapters.test.ts`

- [ ] **Step 1: 实现 OpenAI Chat 请求构造**

`openaiChatAdapter.ts` 根据 `ChatMessage[]`、`ModelConfig` 生成请求:

```ts
export interface ModelRequestPayload {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
```

要求:

- 支持 OpenAI-compatible Endpoint URL。
- 支持 `temperature`、`max_tokens`、`stream`。
- 使用 `Authorization: Bearer <apiKey>`。

- [ ] **Step 2: 实现 Anthropic Messages 请求构造**

要求:

- 使用 `x-api-key`。
- 使用 `anthropic-version`。
- 将 system prompt 放入 Anthropic `system` 字段。
- 将用户和助手消息转换为 `messages`。

- [ ] **Step 3: 实现 API Key 校验**

`modelValidation.ts` 对 OpenAI-compatible 使用低成本模型列表或最小请求校验；对 Anthropic 使用最小可行请求校验。校验失败返回结构化错误，但保存入口仍允许继续保存。

- [ ] **Step 4: 支持流式与非流式**

`modelRequestHandler.ts` 对非流式返回完整文本；对流式响应逐片段转发给 Side Panel。失败时返回错误状态，不写入正式聊天记录。

- [ ] **Step 5: 验证**

运行:

```powershell
npm run test -- tests/unit/shared/modelAdapters.test.ts
npm run typecheck
```

预期: 请求结构测试通过，类型检查通过。

### Task 6: 侧边栏聊天 UI 与会话管理

**文件:**
- 创建: `src/side-panel/components/ChatPanel.tsx`
- 创建: `src/side-panel/components/MessageList.tsx`
- 创建: `src/side-panel/components/ModelSelector.tsx`
- 创建: `src/side-panel/components/SessionList.tsx`
- 创建: `src/side-panel/state/appStore.ts`
- 修改: `src/side-panel/App.tsx`

- [ ] **Step 1: 实现主布局**

侧边栏包含:

- 会话列表。
- 消息列表。
- 输入框。
- 模型选择。
- 流式/非流式开关。
- 设置入口。

- [ ] **Step 2: 实现未配置 API Key 提示**

当没有任何可用模型配置时，输入框区域显示“请先配置 API Key 后再开始对话”，并禁用发送按钮。

- [ ] **Step 3: 实现失败重试**

请求失败时显示失败状态和“重试”按钮；点击重试覆盖当前失败状态，不保存失败消息到 `ChatSession.messages`。

- [ ] **Step 4: 实现会话排序和标题修改**

默认按 `sortOrder` 排序；新会话按产生顺序追加；支持手动修改标题；拖拽排序可在本任务中先使用按钮式上移/下移实现，拖拽交互可在 UI 打磨任务中替换。

- [ ] **Step 5: 验证**

运行:

```powershell
npm run typecheck
npm run build
```

预期: 构建通过，侧边栏可渲染聊天空状态、输入框提示和会话列表。

### Task 7: 标题生成与默认命名

**文件:**
- 创建: `src/shared/models/titleGeneration.ts`
- 创建: `src/shared/utils/date.ts`
- 创建: `tests/unit/shared/titleGeneration.test.ts`

- [ ] **Step 1: 实现本地时间格式化**

`formatLocalDateTime(date)` 输出 `yyyy-MM-dd HH:mm:ss`，使用用户本地时区和 24 小时制。

- [ ] **Step 2: 实现标题生成策略**

规则:

- 已配置标题总结模型时，基于对话数据生成标题。
- 未配置标题总结模型时，使用 `网站 title + yyyy-MM-dd HH:mm:ss`。
- 标题生成失败时，使用默认名并允许用户手动修改。

- [ ] **Step 3: 验证**

运行:

```powershell
npm run test -- tests/unit/shared/titleGeneration.test.ts
```

预期: 未配置标题模型、生成失败、生成成功三类用例均通过。

### Task 8: 对称加密与 Chrome Sync 备份恢复

**文件:**
- 创建: `src/shared/crypto/encryption.ts`
- 创建: `src/background/syncBackupHandler.ts`
- 创建: `tests/unit/shared/encryption.test.ts`
- 修改: `src/shared/types.ts`
- 修改: `src/shared/storage/repositories.ts`

- [ ] **Step 1: 实现加密和解密**

使用 Web Crypto API，采用 AES-GCM。密钥由用户输入的密码派生，本地持久化密钥材料不参与同步。

- [ ] **Step 2: 定义同步载荷**

同步载荷只包含加密后的数据、版本号、创建时间、前缀。明文中包含模型配置、提取规则、聊天记录、链接凭据；写入 `chrome.storage.sync` 前必须整体加密。

- [ ] **Step 3: 实现单前缀单备份策略**

规则:

- 一个前缀只有一个备份。
- 定时备份、手动备份都覆盖当前前缀备份。
- 手动恢复直接覆盖本地数据，不合并。
- 修改本地密钥后立即触发一次备份。

- [ ] **Step 4: 实现配额失败提示**

当 `chrome.storage.sync` 写入失败且错误指向配额限制时，返回“备份失败：同步数据超过 Chrome Sync 配额，请减少历史记录或关闭部分同步内容”。

- [ ] **Step 5: 验证**

运行:

```powershell
npm run test -- tests/unit/shared/encryption.test.ts
npm run typecheck
```

预期: 正确密钥可解密，错误密钥无法恢复；类型检查通过。

### Task 9: 设置界面

**文件:**
- 创建: `src/side-panel/components/SettingsPanel.tsx`
- 修改: `src/side-panel/App.tsx`
- 修改: `src/side-panel/state/appStore.ts`

- [ ] **Step 1: 实现模型管理**

支持新增、编辑、删除模型配置。保存时触发 API Key 校验；校验失败允许保存，并展示校验失败提示。

- [ ] **Step 2: 实现提取规则管理**

支持 URL 正则和多行 CSS/XPath 文本域。保存后立即生效。

- [ ] **Step 3: 实现同步设置**

支持:

- 设置本地加密密钥。
- 修改密钥并立即备份。
- 设置备份前缀。
- 手动备份。
- 手动恢复。
- 展示“忘记密钥无法恢复”的醒目警告。

- [ ] **Step 4: 验证**

运行:

```powershell
npm run typecheck
npm run build
```

预期: 设置界面构建通过，所有修改立即反映到本地状态和存储。

### Task 10: 端到端冒烟验证与交付检查

**文件:**
- 创建: `tests/e2e/extension-smoke.spec.ts`
- 创建: `docs/验收用例.md`
- 修改: `package.json`

- [ ] **Step 1: 编写冒烟用例**

覆盖:

- 扩展可加载。
- 点击插件图标可打开侧边栏。
- 未配置模型时输入框提示配置 API Key。
- 添加模型后可切换模型。
- 内容提取请求返回文本。
- 同步备份超限时展示失败提示。

- [ ] **Step 2: 编写验收用例文档**

`docs/验收用例.md` 记录 MVP 验收清单，至少覆盖内容提取、模型请求、失败重试、标题生成、加密备份恢复、Chrome Sync 配额失败。

- [ ] **Step 3: 执行完整验证**

运行:

```powershell
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

预期: 类型检查、单元测试、构建、端到端冒烟均通过。

---

## 3. 任务依赖顺序

1. Task 1 必须最先完成，建立工具链。
2. Task 2 依赖 Task 1，建立可加载扩展。
3. Task 3 依赖 Task 1，建立数据模型和存储。
4. Task 4 可在 Task 3 后开始，依赖共享类型和工具。
5. Task 5 可在 Task 3 后开始，依赖模型配置类型。
6. Task 6 依赖 Task 2、Task 3、Task 4、Task 5。
7. Task 7 依赖 Task 5、Task 6。
8. Task 8 依赖 Task 3。
9. Task 9 依赖 Task 3、Task 5、Task 8。
10. Task 10 依赖全部 MVP 功能任务。

---

## 4. MVP 验收标准

- 用户可以通过插件图标、快捷键、右键菜单打开侧边栏。
- 首次未配置 API Key 时，对话输入框提示用户配置。
- 用户可以配置多个渠道、多个模型，并在输入框处切换模型和流式模式。
- OpenAI Chat Completions 和 Anthropic Messages 均支持非流式与流式请求。
- OpenAI-compatible 第三方服务可通过自定义 Endpoint 调用。
- URL 正则和多行 CSS/XPath 可配置；未匹配或匹配失败时回退全局可见文本。
- 超长网页从开头截取，并提示“内容被截断，请细化 CSS/XPath”。
- 模型请求失败时可以重试，失败消息不保存为正式聊天记录。
- 聊天记录仅保存大模型对话数据字段白名单。
- 标题总结模型未配置或失败时，使用 `网站 title + yyyy-MM-dd HH:mm:ss` 默认标题。
- Chrome Sync 只保存加密后的单前缀单备份；恢复时覆盖本地。
- 用户忘记密钥无法恢复的警告在配置处清晰可见。
- Chrome Sync 配额超限时备份失败并给出明确提示。

---

## 5. 非 MVP 范围

- 用户选中文本提问。
- 页面内容变化检测。
- 手动刷新上下文。
- WebDAV 同步。
- S3 兼容存储同步。
- OpenAI Responses API。
- OpenAI Response Compaction。
- Gemini GenerateContent。
- 聊天记录导出。
- 远程多版本备份。
- 多端同时增删改查合并。

---

## 6. 风险与处理

- **Chrome Sync 配额风险:** 加密后的聊天记录可能超过配额。处理方式是备份失败并提示用户减少历史记录或关闭部分同步内容。
- **密钥遗失风险:** 用户忘记本地加密密钥后无法恢复同步数据。处理方式是在配置界面显示强提醒，并在恢复失败时说明原因。
- **OpenAI-compatible 差异风险:** 第三方服务可能只兼容部分 OpenAI 参数。处理方式是将适配器参数控制在 `model`、`messages`、`temperature`、`max_tokens`、`stream` 等基础字段。
- **流式响应差异风险:** OpenAI 与 Anthropic 流式格式不同。处理方式是适配器输出统一的文本片段事件给 UI。
- **全局文本噪声风险:** 回退到 `<html>` 全局文本时可能包含导航、页脚等噪声。处理方式是在截断提示中引导用户细化 CSS/XPath。

---

## 7. 完成后的验证命令

```powershell
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

全部命令通过后，MVP 才能视为达到可交付状态。若用户明确授权提交，再执行 `git add .` 和 `git commit`。
