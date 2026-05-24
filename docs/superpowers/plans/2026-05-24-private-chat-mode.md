# Private Chat Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加聊天隐私模式，使隐私对话默认只保存在内存中，用户点击保存后才持久化为普通历史会话。

**Architecture:** 在 Zustand store 中增加运行期隐私会话状态，并让发送流程按普通/隐私两条持久化策略分支。UI 在聊天头部导出按钮右侧渲染隐私/保存按钮，显示逻辑由当前会话是否为可隐私的新会话决定。保存隐私会话后，使用完整聊天记录请求标题模型生成普通历史会话标题，并把会话 ID 规范化为普通 `session-*` 前缀。历史切换默认不允许静默丢弃已有消息的隐私会话，UI 通过主题化确认弹窗确认后才显式丢弃。

**Tech Stack:** React 19、Zustand、Dexie repository、Vitest、Testing Library、Tailwind CSS 组件层样式。

---

### Task 1: Store 隐私状态与入口

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: `tests/unit/side-panel/appStore.test.ts`

- [ ] **Step 1: Write failing tests**

在 `tests/unit/side-panel/appStore.test.ts` 中增加测试，覆盖空白占位会话进入隐私模式时删除占位 item：

```ts
it("空白占位会话进入隐私模式时删除历史 item", async () => {
  const provider = createProvider();
  const model = createModel();
  await saveModelProvider(provider);
  await saveProviderModel(model);
  await useAppStore.getState().loadChannelConfig();

  const placeholder = await useAppStore.getState().createChatSession();
  await expect(getChatSession(placeholder.id)).resolves.toBeDefined();

  await useAppStore.getState().enterPrivateMode();

  const state = useAppStore.getState();
  expect(state.privateModeActive).toBe(true);
  expect(state.privateChatSession).toMatchObject({
    title: "新对话",
    selectedModelId: "model-1",
    messages: [],
  });
  expect(state.chatSessions).toHaveLength(0);
  await expect(getChatSession(placeholder.id)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "空白占位会话进入隐私模式时删除历史 item"`

Expected: FAIL because `enterPrivateMode` and privacy state do not exist.

- [ ] **Step 3: Implement minimal store state**

在 `AppState` 增加：

```ts
privateModeActive: boolean;
privateChatSession?: ChatSession;
enterPrivateMode: () => Promise<void>;
savePrivateChatSession: () => Promise<void>;
```

初始状态和 `reset` 中设置：

```ts
privateModeActive: false,
privateChatSession: undefined,
```

实现 `enterPrivateMode`：

```ts
enterPrivateMode: async () => {
  const state = get();
  if (state.privateModeActive) {
    return;
  }

  const activeSession = state.chatSessions.find((session) => session.id === state.activeSessionId);
  if (activeSession && activeSession.messages.length > 0) {
    return;
  }

  if (activeSession) {
    await deleteChatSession(activeSession.id);
  }

  const now = Date.now();
  const selectedModelId = resolveAvailableModelId(
    activeSession?.selectedModelId || state.selectedModelId || state.defaultChatModelId,
    state.models,
    state.providers,
  );
  const privateChatSession: ChatSession = {
    id: `private-session-${now}`,
    title: "新对话",
    archived: false,
    sortOrder: now,
    createdAt: now,
    updatedAt: now,
    selectedModelId,
    messages: [],
  };

  set((current) => ({
    privateModeActive: true,
    privateChatSession,
    activeSessionId: "",
    selectedModelId,
    pendingDeleteSessionId: undefined,
    chatSessions: activeSession ? current.chatSessions.filter((session) => session.id !== activeSession.id) : current.chatSessions,
  }));
},
```

`savePrivateChatSession` 先实现空壳，后续任务补齐：

```ts
savePrivateChatSession: async () => undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "空白占位会话进入隐私模式时删除历史 item"`

Expected: PASS.

### Task 2: 隐私发送不持久化

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: `tests/unit/side-panel/appStore.test.ts`

- [ ] **Step 1: Write failing test**

在 `tests/unit/side-panel/appStore.test.ts` 中增加：

```ts
it("隐私模式发送消息不会持久化或新增历史 item", async () => {
  const provider = createProvider();
  const model = createModel();
  const sendMessage = vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
    callback({ ok: true, content: message.type === "chat.send" ? "隐私回复" : "" });
    return undefined;
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });

  await saveModelProvider(provider);
  await saveProviderModel(model);
  await useAppStore.getState().loadChannelConfig();
  useAppStore.getState().setStreamMode(false);
  await useAppStore.getState().enterPrivateMode();

  await useAppStore.getState().sendChatMessage("隐私问题");

  const state = useAppStore.getState();
  expect(state.privateModeActive).toBe(true);
  expect(state.chatSessions).toHaveLength(0);
  expect(state.privateChatSession?.messages.map((message) => message.content)).toEqual(["隐私问题", "隐私回复"]);
  await expect(getChatSession(state.privateChatSession?.id ?? "")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "隐私模式发送消息不会持久化或新增历史 item"`

Expected: FAIL because `sendChatMessageWithState` still writes via `runChatRequest`.

- [ ] **Step 3: Implement memory-only request path**

在 `sendChatMessageWithState` 中，选择 base session 时优先使用隐私会话：

```ts
const baseSession = state.privateModeActive
  ? state.privateChatSession
  : state.chatSessions.find((session) => session.id === state.activeSessionId);
```

调用 `runChatRequest` 时增加参数：

```ts
privateMode: state.privateModeActive,
```

扩展 `RunChatRequestInput`：

```ts
privateMode?: boolean;
```

在 `runChatRequest` 中保存 `nextSession` 前分支：

```ts
if (input.privateMode) {
  input.set({ privateChatSession: nextSession });
} else {
  await saveChatSession(nextSession);
  input.set((current) => ({
    activeSessionId: nextSession.id,
    chatSessions: upsertSession(current.chatSessions, nextSession),
  }));
}
```

非流式助手回复完成后也分支：

```ts
if (input.privateMode) {
  input.set((current) => {
    const currentSession = current.privateChatSession;
    if (!currentSession || currentSession.id !== nextSession.id) {
      return {};
    }

    return {
      privateChatSession: {
        ...currentSession,
        updatedAt: assistantMessage.createdAt,
        messages: [...currentSession.messages, assistantMessage],
      },
    };
  });
  return;
}
```

标题生成只在普通模式触发：

```ts
const titleGenerationPromise = !input.privateMode && input.shouldGenerateTitle
  ? generateTitleForSession(...)
  : Promise.resolve();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "隐私模式发送消息不会持久化或新增历史 item"`

Expected: PASS.

### Task 3: 保存隐私会话

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: `tests/unit/side-panel/appStore.test.ts`

- [ ] **Step 1: Write failing test**

在 `tests/unit/side-panel/appStore.test.ts` 中增加：

```ts
it("保存隐私会话后退出隐私模式并成为普通历史会话", async () => {
  const provider = createProvider();
  const model = createModel();
  const sendMessage = vi.fn((_message: { type: string }, callback: (response: unknown) => void) => {
    callback({ ok: true, content: "隐私回复" });
    return undefined;
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });

  await saveModelProvider(provider);
  await saveProviderModel(model);
  await useAppStore.getState().loadChannelConfig();
  useAppStore.getState().setStreamMode(false);
  await useAppStore.getState().enterPrivateMode();
  await useAppStore.getState().sendChatMessage("需要保留");
  const privateSessionId = useAppStore.getState().privateChatSession?.id ?? "";

  await useAppStore.getState().savePrivateChatSession();

  const state = useAppStore.getState();
  expect(state.privateModeActive).toBe(false);
  expect(state.privateChatSession).toBeUndefined();
  expect(state.activeSessionId).toBe(privateSessionId);
  expect(state.chatSessions).toHaveLength(1);
  expect(state.chatSessions[0].messages.map((message) => message.content)).toEqual(["需要保留", "隐私回复"]);
  await expect(getChatSession(privateSessionId)).resolves.toMatchObject({
    id: privateSessionId,
    messages: expect.any(Array),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后退出隐私模式并成为普通历史会话"`

Expected: FAIL because `savePrivateChatSession` is still empty.

- [ ] **Step 3: Implement save**

实现：

```ts
savePrivateChatSession: async () => {
  const state = get();
  const privateChatSession = state.privateChatSession;
  if (!state.privateModeActive || !privateChatSession || privateChatSession.messages.length === 0) {
    set({ privateModeActive: false, privateChatSession: undefined });
    return;
  }

  const sessionToSave: ChatSession = {
    ...privateChatSession,
    id: privateChatSession.id.replace(/^private-session-/, "session-"),
    updatedAt: Date.now(),
  };
  await saveChatSession(sessionToSave);
  set((current) => ({
    privateModeActive: false,
    privateChatSession: undefined,
    activeSessionId: sessionToSave.id,
    selectedModelId: resolveSessionModelId(sessionToSave, current),
    chatSessions: upsertSession(current.chatSessions, sessionToSave),
  }));
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后退出隐私模式并成为普通历史会话"`

Expected: PASS.

### Task 4: 新建对话退出隐私模式

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: `tests/unit/side-panel/appStore.test.ts`

- [ ] **Step 1: Write failing test**

在 `tests/unit/side-panel/appStore.test.ts` 中增加：

```ts
it("隐私模式下新建对话会退出隐私模式并创建普通占位会话", async () => {
  const provider = createProvider();
  const model = createModel();
  await saveModelProvider(provider);
  await saveProviderModel(model);
  await useAppStore.getState().loadChannelConfig();

  await useAppStore.getState().enterPrivateMode();
  const session = await useAppStore.getState().createChatSession();

  const state = useAppStore.getState();
  expect(state.privateModeActive).toBe(false);
  expect(state.privateChatSession).toBeUndefined();
  expect(state.chatSessions).toEqual([session]);
  await expect(getChatSession(session.id)).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "隐私模式下新建对话会退出隐私模式并创建普通占位会话"`

Expected: FAIL because `createChatSession` does not clear privacy state.

- [ ] **Step 3: Clear privacy state in createChatSession**

在 `createChatSession` 的 `set` 返回中增加：

```ts
privateModeActive: false,
privateChatSession: undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "隐私模式下新建对话会退出隐私模式并创建普通占位会话"`

Expected: PASS.

### Task 5: 历史切换确认与 ID 规范化

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Modify: `src/side-panel/components/SessionList.tsx`
- Test: `tests/unit/side-panel/appStore.test.ts`
- Test: `tests/unit/side-panel/App.test.tsx`

- [ ] **Step 1: Write failing tests**

更新“保存隐私会话后退出隐私模式并成为普通历史会话”测试，断言保存后的 ID 从 `private-session-*` 变为 `session-*`，并新增 store 防线测试：

```ts
it("隐私模式有消息时直接切换历史会话不会静默丢弃隐私对话", async () => {
  // 直接调用 selectChatSession 不传 discardPrivateSession 时，应保留 privateChatSession。
});
```

新增 UI 测试：

```ts
it("隐私模式有消息时切换历史会话需要确认，取消后保留隐私对话", async () => {
  // window.confirm 返回 false 时，仍显示“保存隐私对话”，消息列表仍保留隐私消息。
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后退出隐私模式并成为普通历史会话"
npm test -- tests/unit/side-panel/App.test.tsx -t "隐私模式有消息时切换历史会话需要确认"
```

Expected: FAIL because saved session keeps `private-session-*` and history switching has no confirmation.

- [ ] **Step 3: Implement minimal fixes**

在 `savePrivateChatSession` 中规范化 ID：

```ts
const sessionToSave: ChatSession = {
  ...privateChatSession,
  id: privateChatSession.id.replace(/^private-session-/, "session-"),
  updatedAt: Date.now(),
};
```

扩展 store 方法签名：

```ts
selectChatSession: (sessionId: string, options?: { discardPrivateSession?: boolean }) => void;
```

在 `selectChatSession` 中默认拒绝丢弃已有消息的隐私对话：

```ts
if (state.privateModeActive && state.privateChatSession && state.privateChatSession.messages.length > 0 && !options?.discardPrivateSession) {
  return { pendingDeleteSessionId: undefined };
}
```

在 `SessionList` 中点击历史会话时打开主题化确认弹窗，不使用原生 `window.confirm`：

```ts
if (privateModeActive && (privateChatSession?.messages.length ?? 0) > 0) {
  setPendingPrivateSwitchSessionId(sessionId);
  return;
}
```

弹窗确认按钮调用：

```ts
selectChatSession(pendingPrivateSwitchSessionId, { discardPrivateSession: true });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后退出隐私模式并成为普通历史会话|隐私模式有消息时直接切换历史会话不会静默丢弃隐私对话"
npm test -- tests/unit/side-panel/App.test.tsx -t "隐私模式有消息时切换历史会话需要确认"
```

Expected: PASS. UI 测试应同时断言 `window.confirm` 未被调用。

### Task 6: 保存后生成隐私会话标题

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: `tests/unit/side-panel/appStore.test.ts`

- [ ] **Step 1: Write failing test**

在 `tests/unit/side-panel/appStore.test.ts` 中增加：

```ts
it("保存隐私会话后使用完整聊天记录重新生成标题", async () => {
  const provider = createProvider();
  const chatModel = createModel();
  const titleModel = createTitleModel();
  const sendMessage = vi.fn((message: { type: string; model?: ProviderModel; messages?: ChatMessage[] }, callback: (response: unknown) => void) => {
    callback({
      ok: true,
      content: message.model?.id === "model-title" ? "{\"title\":\"完整隐私对话标题\"}" : "隐私回复",
    });
    return undefined;
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });

  await saveModelProvider(provider);
  await saveProviderModel(chatModel);
  await saveProviderModel(titleModel);
  await useAppStore.getState().loadChannelConfig();
  useAppStore.getState().selectModel("model-1");
  useAppStore.getState().setTitleModel("model-title");
  useAppStore.getState().setStreamMode(false);
  await useAppStore.getState().enterPrivateMode();
  await useAppStore.getState().sendChatMessage("第一轮隐私问题");
  await useAppStore.getState().sendChatMessage("第二轮隐私追问");

  await useAppStore.getState().savePrivateChatSession();

  const titleRequest = sendMessage.mock.calls
    .map(([message]) => message as { type: string; model?: ProviderModel; messages?: ChatMessage[] })
    .filter((message) => message.type === "chat.send")
    .find((message) => message.model?.id === "model-title");
  expect(titleRequest?.messages?.[1].content).toContain("用户：第一轮隐私问题");
  expect(titleRequest?.messages?.[1].content).toContain("助手：隐私回复");
  expect(titleRequest?.messages?.[1].content).toContain("用户：第二轮隐私追问");
  expect(useAppStore.getState().chatSessions[0]).toMatchObject({
    title: "完整隐私对话标题",
    titleGenerating: false,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后使用完整聊天记录重新生成标题"`

Expected: FAIL because `savePrivateChatSession` does not request the title model.

- [ ] **Step 3: Implement title generation after save**

在 `savePrivateChatSession` 保存普通会话后调用专用 helper：

```ts
await generateTitleFromSavedPrivateSession({
  session: sessionToSave,
  get,
  set,
});
```

helper 读取当前标题模型，将完整消息格式化为“用户/助手”对话文本，调用标题模型后写回当前普通会话。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "保存隐私会话后使用完整聊天记录重新生成标题|隐私"`

Expected: PASS.

### Task 7: UI 按钮和样式

**Files:**
- Modify: `src/side-panel/components/ChatPanel.tsx`
- Modify: `src/side-panel/styles.css`
- Test: `tests/unit/side-panel/App.test.tsx`

- [ ] **Step 1: Write failing UI tests**

在 `tests/unit/side-panel/App.test.tsx` 中增加：

```ts
it("隐私按钮位于导出按钮右侧，激活后切换为保存按钮", async () => {
  const user = userEvent.setup();
  render(<App />);

  const exportButton = await screen.findByRole("button", { name: "导出当前聊天" });
  const privateButton = screen.getByRole("button", { name: "进入隐私模式" });
  expect(exportButton.parentElement?.nextElementSibling).toBe(privateButton);

  await user.click(privateButton);

  const saveButton = screen.getByRole("button", { name: "保存隐私对话" });
  expect(saveButton).toHaveTextContent("保存");
  expect(saveButton).toHaveClass("chat-private-trigger-active");
});

it("已存在且包含消息的历史会话不显示隐私按钮", async () => {
  await saveChatSession(
    createChatSession({
      id: "session-existing",
      title: "已有会话",
      messages: [
        createChatMessage({
          id: "message-existing",
          role: "user",
          content: "已有消息",
        }),
      ],
    }),
  );

  render(<App />);

  await screen.findByRole("button", { name: "导出当前聊天" });
  expect(screen.queryByRole("button", { name: "进入隐私模式" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/side-panel/App.test.tsx -t "隐私"`

Expected: FAIL because button does not exist.

- [ ] **Step 3: Implement ChatPanel button**

在 `ChatPanel` 中读取：

```ts
const privateModeActive = useAppStore((state) => state.privateModeActive);
const privateChatSession = useAppStore((state) => state.privateChatSession);
const enterPrivateMode = useAppStore((state) => state.enterPrivateMode);
const savePrivateChatSession = useAppStore((state) => state.savePrivateChatSession);
```

active session 计算改为：

```ts
const storedActiveSession = useAppStore((state) => state.chatSessions.find((session) => session.id === state.activeSessionId));
const activeSession = privateModeActive ? privateChatSession : storedActiveSession;
const canShowPrivateButton = privateModeActive || !storedActiveSession || storedActiveSession.messages.length === 0;
```

在导出菜单 wrapper 后增加：

```tsx
{canShowPrivateButton ? (
  <button
    className={privateModeActive ? "ui-button-secondary chat-private-trigger chat-private-trigger-active" : "ui-button-secondary chat-private-trigger"}
    type="button"
    aria-label={privateModeActive ? "保存隐私对话" : "进入隐私模式"}
    onClick={() => void (privateModeActive ? savePrivateChatSession() : enterPrivateMode())}
  >
    {privateModeActive ? "保存" : "隐私"}
  </button>
) : null}
```

- [ ] **Step 4: Add CSS**

在 `src/side-panel/styles.css` 的聊天头部按钮区域增加：

```css
.chat-private-trigger {
  @apply h-10 shrink-0 px-3 text-sm;
}

.chat-private-trigger-active {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
```

- [ ] **Step 5: Run UI tests**

Run: `npm test -- tests/unit/side-panel/App.test.tsx -t "隐私"`

Expected: PASS.

### Task 8: 流式路径内存更新与回归验证

**Files:**
- Modify: `src/side-panel/state/appStore.ts`
- Test: existing test suites

- [ ] **Step 1: Update streaming helpers**

给 `sendStreamingChatMessage` 增加 `privateMode?: boolean` 参数。隐私模式下：

- 初始化助手消息时只更新 `privateChatSession`。
- `appendAssistantChunk`、`appendAssistantThinkingChunk`、`finalizeAssistantMessage`、`removeAssistantMessage` 需要在隐私模式下走内存更新 helper。

新增 helper：

```ts
function updatePrivateAssistantMessageInState(
  state: AppState,
  sessionId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): Partial<AppState> {
  const session = state.privateChatSession;
  if (!state.privateModeActive || !session || session.id !== sessionId) {
    return {};
  }

  return {
    privateChatSession: {
      ...session,
      messages: session.messages.map((message) => (message.id === messageId ? updater(message) : message)),
    },
  };
}
```

- [ ] **Step 2: Run focused store tests**

Run: `npm test -- tests/unit/side-panel/appStore.test.ts -t "隐私"`

Expected: PASS.

- [ ] **Step 3: Run focused UI tests**

Run: `npm test -- tests/unit/side-panel/App.test.tsx -t "隐私|导出按钮位于当前聊天设置右侧"`

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test -- tests/unit/side-panel/appStore.test.ts tests/unit/side-panel/App.test.tsx
npm run typecheck
npm run build
```

Expected: all commands exit 0.

### Self-Review

- Spec coverage: 计划覆盖隐私入口、占位会话删除、发送不持久化、保存持久化、保存后标题生成、保存 ID 规范化、历史切换确认、新建退出、UI 显示和流式路径。
- Placeholder scan: 无 TBD/TODO/待补充占位。
- Type consistency: store 字段名统一为 `privateModeActive`、`privateChatSession`、`enterPrivateMode`、`savePrivateChatSession`。
