import type { ModelToolCall, ModelToolResult } from "../../shared/models/types";

export interface BrowserControlCommandConnection {
  resolveNodeByBackendId(backendNodeId: number): Promise<unknown>;
  scrollIntoViewIfNeeded(objectId: string): Promise<unknown>;
  getBoxModel(backendNodeId: number): Promise<unknown>;
  callFunctionOn(params: Record<string, unknown>): Promise<unknown>;
  evaluate(params: Record<string, unknown>): Promise<unknown>;
  dispatchMouseEvent(params: Record<string, unknown>): Promise<unknown>;
  dispatchKeyEvent(params: Record<string, unknown>): Promise<unknown>;
  insertText(text: string): Promise<unknown>;
}

export interface BrowserControlActionSnapshot {
  getBackendNodeId(uid: string): number;
  takeSnapshot(): Promise<string>;
}

type BrowserControlActionName = "click" | "fill" | "press_key" | "wait_for";

interface ElementInfo {
  tagName: string;
  type: string;
  role: string;
  isContentEditable: boolean;
}

const BROWSER_ACTION_DISABLED_MESSAGE = "浏览器控制未开启，无法执行浏览器操作。请先在顶部浏览器控制按钮中显式开启。";
const RETAKE_SNAPSHOT_MESSAGE = "请重新调用 take_snapshot 获取最新页面状态后再继续。";
const INCLUDE_SNAPSHOT_ERROR_SUFFIX = ` ${RETAKE_SNAPSHOT_MESSAGE}`;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 5000;
const WAIT_FOR_MAX_TIMEOUT_MS = 30000;
const SAFE_CLICK_OCCLUDED_ERROR = "元素当前被遮挡，无法安全点击。";
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;
const MODIFIER_ALIASES: Record<string, keyof typeof MODIFIER_BITS> = {
  Ctrl: "Control",
  Cmd: "Meta",
  Command: "Meta",
  Option: "Alt",
};

export function isBrowserControlActionName(name: string): name is BrowserControlActionName {
  return name === "click" || name === "fill" || name === "press_key" || name === "wait_for";
}

export function createBrowserActionDisabledResult(toolCall: ModelToolCall): ModelToolResult {
  return createBrowserActionErrorResult(toolCall, BROWSER_ACTION_DISABLED_MESSAGE);
}

export function createBrowserActionErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}

export class BrowserControlActionExecutor {
  constructor(
    private readonly connection: BrowserControlCommandConnection,
    private readonly snapshot: BrowserControlActionSnapshot,
  ) {}

  async execute(toolCall: ModelToolCall): Promise<ModelToolResult> {
    if (!isBrowserControlActionName(toolCall.name)) {
      return createBrowserActionErrorResult(toolCall, `未知的浏览器操作工具：${toolCall.name}。`);
    }

    const validation = validateArguments(toolCall);
    if (!validation.ok) {
      return createBrowserActionErrorResult(toolCall, validation.message);
    }

    try {
      const content = await this.executeAction(toolCall.name, toolCall.arguments);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: await this.appendSnapshotIfRequested(content, toolCall.arguments),
      };
    } catch (error) {
      return createBrowserActionErrorResult(toolCall, normalizeActionError(error, Boolean(toolCall.arguments.includeSnapshot)));
    }
  }

  private async executeAction(name: BrowserControlActionName, args: Record<string, unknown>): Promise<string> {
    if (name === "click") {
      return this.click(String(args.uid));
    }
    if (name === "fill") {
      return this.fill(String(args.uid), String(args.value));
    }
    if (name === "press_key") {
      return this.pressKey(String(args.key));
    }

    return this.waitFor(args.text, args.timeout);
  }

  private async click(uid: string): Promise<string> {
    const objectId = await this.getObjectIdFromUid(uid);
    const backendNodeId = this.snapshot.getBackendNodeId(uid);

    try {
      const { x, y } = await this.getElementCenter(objectId, backendNodeId);
      const hitTest = await this.connection.callFunctionOn({
        objectId,
        functionDeclaration: `function(x, y) {
          const hitElement = document.elementFromPoint(x, y);
          if (!hitElement) return false;
          return this.contains(hitElement) || hitElement.contains(this);
        }`,
        arguments: [{ value: x }, { value: y }],
        returnByValue: true,
      });
      if (getResultValue(hitTest) === false) {
        throw new Error(SAFE_CLICK_OCCLUDED_ERROR);
      }

      await this.connection.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await this.connection.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await this.connection.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } catch (error) {
      if (error instanceof Error && error.message === SAFE_CLICK_OCCLUDED_ERROR) {
        throw error;
      }

      await this.connection.callFunctionOn({
        objectId,
        // 这里是固定的受控 fallback，只允许补发鼠标事件和聚焦；不要扩展为模型可控脚本入口。
        functionDeclaration: `function() {
          this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const rect = this.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
            this.dispatchEvent(new MouseEvent(type, {
              view: window,
              bubbles: true,
              cancelable: true,
              composed: true,
              buttons: 1,
              clientX: x,
              clientY: y,
            }));
          }
          if (typeof this.focus === "function") this.focus();
        }`,
        userGesture: true,
      });
    }

    return `已点击元素 ${uid}。`;
  }

  private async fill(uid: string, value: string): Promise<string> {
    const objectId = await this.getObjectIdFromUid(uid);
    const info = await this.getElementInfo(objectId);

    if (info.tagName === "SELECT") {
      await this.fillSelect(objectId, value);
      return `已填写元素 ${uid}。`;
    }

    if (isToggleElement(info)) {
      await this.fillToggle(objectId, value);
      return `已填写元素 ${uid}。`;
    }

    await this.fillTextInput(objectId, value);
    return `已填写元素 ${uid}。`;
  }

  private async pressKey(key: string): Promise<string> {
    const tokens = parseKeyTokens(key);
    const mainKey = tokens[tokens.length - 1];
    const modifiers = tokens.slice(0, -1);
    const mainDefinition = getKeyDefinition(mainKey, 0);
    if (!mainDefinition) {
      throw new Error(`按键 ${key} 不在允许列表中。`);
    }

    for (const modifier of modifiers) {
      if (!(modifier in MODIFIER_BITS)) {
        throw new Error(`修饰键 ${modifier} 不在允许列表中。`);
      }
    }

    let modifierBits = 0;

    try {
      for (const modifier of modifiers) {
        modifierBits |= MODIFIER_BITS[modifier as keyof typeof MODIFIER_BITS];
        await this.connection.dispatchKeyEvent({
          type: "keyDown",
          ...getKeyDefinition(modifier, modifierBits),
        });
      }

      const modifiedMainDefinition = getKeyDefinition(mainKey, modifierBits);
      await this.connection.dispatchKeyEvent({ type: "keyDown", ...modifiedMainDefinition });
      await this.connection.dispatchKeyEvent({ type: "keyUp", ...modifiedMainDefinition });
    } finally {
      for (const modifier of [...modifiers].reverse()) {
        if (!(modifier in MODIFIER_BITS)) {
          continue;
        }
        modifierBits &= ~MODIFIER_BITS[modifier as keyof typeof MODIFIER_BITS];
        await this.connection.dispatchKeyEvent({
          type: "keyUp",
          ...getKeyDefinition(modifier, modifierBits),
        });
      }
    }

    return `已按下按键 ${key}。`;
  }

  private async waitFor(text: unknown, timeout: unknown): Promise<string> {
    const targets = normalizeWaitForTargets(text);
    if (!targets.length) {
      throw new Error("wait_for 的 text 必须包含至少一个非空文本。");
    }

    const timeoutMs = normalizeTimeout(timeout);
    const response = await this.connection.evaluate({
      expression: createWaitForExpression(targets, timeoutMs),
      awaitPromise: true,
      returnByValue: true,
    });
    const matchedText = getResultValue(response);
    if (typeof matchedText === "string" && matchedText) {
      return `已等待到页面文本：${matchedText}。`;
    }

    throw new Error(`等待页面文本超时：${targets.join("、")}。`);
  }

  private async appendSnapshotIfRequested(content: string, args: Record<string, unknown>): Promise<string> {
    if (args.includeSnapshot !== true) {
      return content;
    }

    return `${content}\n\n## 最新页面快照\n${await this.snapshot.takeSnapshot()}`;
  }

  private async getObjectIdFromUid(uid: string): Promise<string> {
    const backendNodeId = this.snapshot.getBackendNodeId(uid);
    const response = await this.connection.resolveNodeByBackendId(backendNodeId);
    const object = getObject(response);
    if (!object?.objectId) {
      throw new Error(`元素 ${uid} 已从页面中移除。`);
    }

    return object.objectId;
  }

  private async getElementCenter(objectId: string, backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.connection.scrollIntoViewIfNeeded(objectId);
    const response = await this.connection.getBoxModel(backendNodeId);
    const model = getBoxModel(response);
    if (!model?.content || model.content.length < 8) {
      throw new Error("无法读取元素布局。");
    }

    return {
      x: (model.content[0] + model.content[4]) / 2,
      y: (model.content[1] + model.content[5]) / 2,
    };
  }

  private async getElementInfo(objectId: string): Promise<ElementInfo> {
    const response = await this.connection.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        return {
          tagName: String(this.tagName || "").toUpperCase(),
          type: String(this.type || "").toLowerCase(),
          role: String((this.getAttribute && this.getAttribute("role")) || "").toLowerCase(),
          isContentEditable: Boolean(this.isContentEditable),
        };
      }`,
      returnByValue: true,
    });
    const value = getResultValue(response);
    if (!value || typeof value !== "object") {
      return { tagName: "", type: "", role: "", isContentEditable: false };
    }

    const info = value as Partial<ElementInfo>;
    return {
      tagName: typeof info.tagName === "string" ? info.tagName.toUpperCase() : "",
      type: typeof info.type === "string" ? info.type.toLowerCase() : "",
      role: typeof info.role === "string" ? info.role.toLowerCase() : "",
      isContentEditable: info.isContentEditable === true,
    };
  }

  private async fillSelect(objectId: string, value: string): Promise<void> {
    const response = await this.connection.callFunctionOn({
      objectId,
      functionDeclaration: `function(targetValue) {
        let matched = false;
        for (const option of Array.from(this.options || [])) {
          if (option.value === targetValue || option.text === targetValue) {
            this.value = option.value;
            matched = true;
            break;
          }
        }
        if (!matched) return false;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
    if (getResultValue(response) !== true) {
      throw new Error(`下拉框中没有匹配的选项：${value}。`);
    }
  }

  private async fillToggle(objectId: string, value: string): Promise<void> {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue !== "true" && normalizedValue !== "false") {
      throw new Error("复选框、单选框和开关只能填写 true 或 false。");
    }

    await this.connection.callFunctionOn({
      objectId,
      functionDeclaration: `function(nextChecked) {
        const dispatchStateEvents = () => {
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (this instanceof HTMLInputElement) {
          if (this.checked !== nextChecked && typeof this.click === "function") this.click();
          if (this.checked !== nextChecked) {
            this.checked = nextChecked;
            dispatchStateEvents();
          }
          return;
        }
        const nextValue = nextChecked ? "true" : "false";
        if (this.getAttribute && this.getAttribute("aria-checked") !== null) this.setAttribute("aria-checked", nextValue);
        if (this.getAttribute && this.getAttribute("aria-pressed") !== null) this.setAttribute("aria-pressed", nextValue);
        if (typeof this.click === "function") this.click();
        dispatchStateEvents();
      }`,
      arguments: [{ value: normalizedValue === "true" }],
      userGesture: true,
    });
  }

  private async fillTextInput(objectId: string, value: string): Promise<void> {
    await this.connection.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        this.focus();
        if (typeof this.select === "function") {
          this.select();
          return;
        }
        if (window.getSelection && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }`,
    });
    await this.connection.dispatchKeyEvent({
      type: "keyDown",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
      key: "Backspace",
      code: "Backspace",
    });
    await this.connection.dispatchKeyEvent({
      type: "keyUp",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
      key: "Backspace",
      code: "Backspace",
    });
    if (value) {
      await this.connection.insertText(value);
    }
    await this.connection.callFunctionOn({
      objectId,
      // 空字符串是明确的清空语义；这里兜底清理残留值，避免全选或 Backspace 被页面框架干扰后只删掉一个字符。
      arguments: [{ value }],
      functionDeclaration: `function() {
        if (arguments[0] === "" && "value" in this) {
          this.value = "";
          this.dispatchEvent(new Event("input", { bubbles: true }));
        }
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
    });
  }

}

function validateArguments(toolCall: ModelToolCall): { ok: true } | { ok: false; message: string } {
  const args = toolCall.arguments;
  const allowedKeysByName: Record<BrowserControlActionName, string[]> = {
    click: ["uid", "includeSnapshot"],
    fill: ["uid", "value", "includeSnapshot"],
    press_key: ["key", "includeSnapshot"],
    wait_for: ["text", "timeout"],
  };
  const allowedKeys = allowedKeysByName[toolCall.name as BrowserControlActionName] ?? [];
  const extraKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length > 0) {
    return { ok: false, message: `浏览器操作工具 ${toolCall.name} 不接受参数：${extraKeys.join("、")}。` };
  }

  if ((toolCall.name === "click" || toolCall.name === "fill") && (typeof args.uid !== "string" || !args.uid.trim())) {
    return { ok: false, message: "浏览器操作需要非空 UID。" };
  }
  if (toolCall.name === "fill" && typeof args.value !== "string") {
    return { ok: false, message: "fill 的 value 必须是字符串。" };
  }
  if (toolCall.name === "press_key" && (typeof args.key !== "string" || !args.key.trim())) {
    return { ok: false, message: "press_key 的 key 必须是非空字符串。" };
  }
  if ((toolCall.name === "click" || toolCall.name === "fill" || toolCall.name === "press_key") &&
    args.includeSnapshot !== undefined &&
    typeof args.includeSnapshot !== "boolean") {
    return { ok: false, message: "includeSnapshot 必须是布尔值。" };
  }
  if (toolCall.name === "wait_for" && !Array.isArray(args.text)) {
    return { ok: false, message: "wait_for 的 text 必须是字符串数组。" };
  }
  if (toolCall.name === "wait_for" && args.timeout !== undefined && typeof args.timeout !== "number") {
    return { ok: false, message: "wait_for 的 timeout 必须是数字。" };
  }

  return { ok: true };
}

function normalizeActionError(error: unknown, includeSnapshot: boolean): string {
  const message = error instanceof Error ? error.message : "";
  let normalized = message || "浏览器操作失败，请确认当前页面仍可访问后重试。";
  if (message.includes("不在允许列表") || message.includes("只能填写") || message.includes("text 必须") || message.includes("没有匹配的选项")) {
    normalized = message;
  } else if (message === SAFE_CLICK_OCCLUDED_ERROR) {
    normalized = `${message}${RETAKE_SNAPSHOT_MESSAGE}`;
  } else if (message.includes("旧快照") || message.includes("不存在") || message.includes("移除") || message.includes("UID")) {
    normalized = `${message} ${RETAKE_SNAPSHOT_MESSAGE}`;
  }

  if (includeSnapshot && !normalized.includes("take_snapshot")) {
    return `${normalized}${INCLUDE_SNAPSHOT_ERROR_SUFFIX}`;
  }

  return normalized;
}

function isToggleElement(info: ElementInfo): boolean {
  return (info.tagName === "INPUT" && (info.type === "checkbox" || info.type === "radio")) ||
    info.role === "checkbox" ||
    info.role === "radio" ||
    info.role === "switch";
}

function normalizeTimeout(timeout: unknown): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return WAIT_FOR_DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.floor(timeout), WAIT_FOR_MAX_TIMEOUT_MS);
}

function normalizeWaitForTargets(text: unknown): string[] {
  if (!Array.isArray(text)) {
    return [];
  }

  if (text.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("wait_for 的 text 只能包含非空字符串。");
  }

  return text.map((item) => item.trim());
}

function createWaitForExpression(targets: string[], timeoutMs: number): string {
  // targets 和 timeoutMs 只能通过 JSON.stringify 注入表达式，禁止后续改成字符串拼接，避免等待文本变成脚本片段。
  return `
    (async () => {
      const targets = ${JSON.stringify(targets)};
      const timeoutMs = ${JSON.stringify(timeoutMs)};
      const getPageText = () => document.body ? document.body.innerText || document.body.textContent || "" : "";
      const findMatch = () => targets.find((target) => getPageText().includes(target)) || null;
      const existing = findMatch();
      if (existing) return existing;
      return await new Promise((resolve) => {
        let done = false;
        let observer = null;
        const finish = (value) => {
          if (done) return;
          done = true;
          if (observer) observer.disconnect();
          resolve(value);
        };
        const check = () => {
          const match = findMatch();
          if (match) finish(match);
        };
        if (document.body) {
          observer = new MutationObserver(check);
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
        setTimeout(() => finish(null), timeoutMs);
      });
    })()
  `;
}

function parseKeyTokens(key: string): string[] {
  const rawTokens = key.split("+");
  const tokens: string[] = [];

  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    if (token) {
      tokens.push(MODIFIER_ALIASES[token] || token);
    } else if (index === rawTokens.length - 1 || rawTokens[index + 1] === "") {
      tokens.push("+");
      break;
    }
  }

  return tokens;
}

function getKeyDefinition(key: string, modifiers = 0): Record<string, unknown> | null {
  const keyMap: Record<string, Record<string, unknown>> = {
    Control: { windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, key: "Control", code: "ControlLeft", modifiers },
    Shift: { windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, key: "Shift", code: "ShiftLeft", modifiers },
    Alt: { windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, key: "Alt", code: "AltLeft", modifiers },
    Meta: { windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91, key: "Meta", code: "MetaLeft", modifiers },
    Enter: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r", modifiers },
    Backspace: { windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace", modifiers },
    Tab: { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab", modifiers },
    Escape: { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: "Escape", code: "Escape", modifiers },
    Delete: { windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, key: "Delete", code: "Delete", modifiers },
    ArrowDown: { windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown", modifiers },
    ArrowUp: { windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp", modifiers },
    ArrowLeft: { windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, key: "ArrowLeft", code: "ArrowLeft", modifiers },
    ArrowRight: { windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: "ArrowRight", code: "ArrowRight", modifiers },
    PageUp: { windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33, key: "PageUp", code: "PageUp", modifiers },
    PageDown: { windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34, key: "PageDown", code: "PageDown", modifiers },
    End: { windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, key: "End", code: "End", modifiers },
    Home: { windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36, key: "Home", code: "Home", modifiers },
    Space: { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, key: " ", code: "Space", text: " ", modifiers },
  };
  if (keyMap[key]) {
    return keyMap[key];
  }
  if (key.length !== 1) {
    return null;
  }

  const upper = key.toUpperCase();
  if (!/^[A-Z0-9+]$/.test(upper)) {
    return null;
  }
  const windowsVirtualKeyCode = key === "+" ? 187 : upper.charCodeAt(0);
  const shouldEmitText = (modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) === 0;
  return {
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    key,
    code: /^[A-Z]$/.test(upper) ? `Key${upper}` : key === "+" ? "Equal" : `Digit${upper}`,
    modifiers,
    ...(shouldEmitText ? { text: key } : {}),
  };
}

function getResultValue(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("result" in response)) {
    return undefined;
  }
  const result = response.result;
  return result && typeof result === "object" && "value" in result ? result.value : undefined;
}

function getObject(response: unknown): { objectId?: string } | undefined {
  if (!response || typeof response !== "object" || !("object" in response) || !response.object || typeof response.object !== "object") {
    return undefined;
  }

  return response.object as { objectId?: string };
}

function getBoxModel(response: unknown): { content?: number[] } | undefined {
  if (!response || typeof response !== "object" || !("model" in response) || !response.model || typeof response.model !== "object") {
    return undefined;
  }

  return response.model as { content?: number[] };
}
