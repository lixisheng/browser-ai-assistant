import { useState } from "react";
import { MODEL_TOOL_GROUP_BROWSER_AUTOMATION_ID, getModelToolGroups, getRegisteredModelTools, isBrowserAutomationToolId } from "../../../shared/models/toolRegistry";
import type { ChatPreferenceValues, SendShortcut } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useComposedTextInput } from "../useComposedTextInput";
import { GlobalPreferenceNumberInput } from "./GlobalPreferenceNumberInput";

const sendShortcutOptions: Array<{ value: SendShortcut; label: string }> = [
  { value: "enter", label: "Enter" },
  { value: "shift_enter", label: "Shift+Enter" },
  { value: "ctrl_enter", label: "Ctrl+Enter" },
  { value: "ctrl_shift_enter", label: "Ctrl+Shift+Enter" },
  { value: "alt_enter", label: "Alt+Enter" },
];

export function ChatPreferenceSettings() {
  const chatPreferences = useAppStore((state) => state.chatPreferences);
  const browserControlEnabled = useAppStore((state) => state.browserControlEnabled);
  const updateChatPreferences = useAppStore((state) => state.updateChatPreferences);
  const registeredTools = getRegisteredModelTools();
  const registeredToolGroups = getModelToolGroups(registeredTools);
  const systemPromptInput = useComposedTextInput(chatPreferences.systemPrompt, (systemPrompt) => {
    void updateChatPreferences({ systemPrompt });
  });
  const handleToolToggle = (toolId: string, checked: boolean) => {
    if (isBrowserAutomationToolId(toolId)) {
      return;
    }
    const nextToolIds = checked ? [...chatPreferences.enabledToolIds, toolId] : chatPreferences.enabledToolIds.filter((id) => id !== toolId);
    void updateChatPreferences({ enabledToolIds: Array.from(new Set(nextToolIds)) });
  };

  return (
    <section className="grid w-full gap-3" aria-label="聊天偏好">
      <h3 className="text-base font-semibold">聊天偏好</h3>
      <label className="grid gap-1 text-sm">
        系统提示词
        <textarea
          className="ui-input min-h-32"
          aria-label="全局系统提示词"
          {...systemPromptInput}
        />
      </label>
      <div className="chat-preference-grid">
        <GlobalPreferenceNumberInput
          label="AI 请求失败重试次数"
          value={chatPreferences.aiRequestRetryCount}
          min={0}
          max={20}
          step={1}
          onChange={(value) => void updateChatPreferences({ aiRequestRetryCount: value })}
        />
        <GlobalPreferenceNumberInput
          label="浏览器自动化最大工具轮次"
          value={chatPreferences.browserAutomationMaxToolIterations}
          step={1}
          onChange={(value) => void updateChatPreferences({ browserAutomationMaxToolIterations: value })}
        />
        <GlobalPreferenceNumberInput
          label="temperature"
          value={chatPreferences.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(value) => void updateChatPreferences({ temperature: value })}
        />
        <GlobalPreferenceNumberInput
          label="max_token"
          value={chatPreferences.maxTokens}
          min={1}
          step={1}
          onChange={(value) => void updateChatPreferences({ maxTokens: value })}
        />
        <GlobalPreferenceNumberInput
          label="top_k"
          value={chatPreferences.topK}
          min={1}
          step={1}
          onChange={(value) => void updateChatPreferences({ topK: value })}
        />
      </div>
      <fieldset className="chat-preference-network-types">
        <legend className="text-sm">工具调用</legend>
        <label className="chat-preference-switch">
          <input
            className="chat-preference-switch-input"
            type="checkbox"
            checked={chatPreferences.toolCallingEnabled}
            onChange={(event) => void updateChatPreferences({ toolCallingEnabled: event.target.checked })}
          />
          <span className="chat-preference-switch-control" aria-hidden="true">
            <span className="chat-preference-switch-thumb" />
          </span>
          <span className="chat-preference-switch-label">启用工具调用</span>
        </label>
        <p className="ui-muted text-xs">启用工具后，工具决策阶段使用非流式请求；最终回复仍跟随流式响应开关。</p>
        {registeredTools.length > 0 ? (
          <div className="chat-preference-tool-group-list">
            {registeredToolGroups.map((group) => (
              <div key={group.id} className="chat-preference-tool-group">
                <div className="chat-preference-tool-group-title">{group.label}</div>
                {group.id === MODEL_TOOL_GROUP_BROWSER_AUTOMATION_ID && !browserControlEnabled ? (
                  <p className="ui-muted text-xs">开启浏览器控制后自动启用本组工具。</p>
                ) : null}
                {group.tools.map((tool) => (
                  <label key={tool.id} className="chat-preference-network-type-chip">
                    <input
                      type="checkbox"
                      aria-label={`启用工具 ${tool.name}`}
                      checked={isBrowserAutomationToolId(tool.id) ? browserControlEnabled : chatPreferences.enabledToolIds.includes(tool.id)}
                      disabled={!chatPreferences.toolCallingEnabled || isBrowserAutomationToolId(tool.id)}
                      onChange={(event) => handleToolToggle(tool.id, event.target.checked)}
                    />
                    <span>{tool.name}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="ui-muted text-xs">暂无可用工具</p>
        )}
      </fieldset>
      <label className="chat-preference-field">
        工具调用展示方式
        <select
          className="ui-input chat-preference-shortcut-select"
          aria-label="工具调用展示方式"
          value={chatPreferences.toolCallDisplayMode}
          onChange={(event) => void updateChatPreferences({ toolCallDisplayMode: event.target.value as ChatPreferenceValues["toolCallDisplayMode"] })}
        >
          <option value="assistant_grouped">AI 回复与工具分组</option>
          <option value="compact">紧凑工具过程</option>
        </select>
      </label>
      <label className="chat-preference-switch">
        <input
          className="chat-preference-switch-input"
          type="checkbox"
          checked={chatPreferences.showToolCallProcessInAssistantMode}
          onChange={(event) => void updateChatPreferences({ showToolCallProcessInAssistantMode: event.target.checked })}
        />
        <span className="chat-preference-switch-control" aria-hidden="true">
          <span className="chat-preference-switch-thumb" />
        </span>
        <span className="chat-preference-switch-label">非紧凑模式显示工具调用过程</span>
      </label>
      <label className="chat-preference-field">
        发送快捷键
        <select
          className="ui-input chat-preference-shortcut-select"
          aria-label="发送快捷键"
          value={chatPreferences.sendShortcut}
          onChange={(event) => void updateChatPreferences({ sendShortcut: event.target.value as SendShortcut })}
        >
          {sendShortcutOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="chat-preference-switch">
        <input
          className="chat-preference-switch-input"
          type="checkbox"
          checked={chatPreferences.historyDrawerDefaultOpen}
          onChange={(event) => void updateChatPreferences({ historyDrawerDefaultOpen: event.target.checked })}
        />
        <span className="chat-preference-switch-control" aria-hidden="true">
          <span className="chat-preference-switch-thumb" />
        </span>
        <span className="chat-preference-switch-label">默认展开左侧历史面板</span>
      </label>
      <label className="chat-preference-switch">
        <input
          className="chat-preference-switch-input"
          type="checkbox"
          checked={chatPreferences.injectPageContextByDefault}
          onChange={(event) => void updateChatPreferences({ injectPageContextByDefault: event.target.checked })}
        />
        <span className="chat-preference-switch-control" aria-hidden="true">
          <span className="chat-preference-switch-thumb" />
        </span>
        <span className="chat-preference-switch-label">新对话默认注入当前页面上下文</span>
      </label>
      <label className="chat-preference-switch">
        <input
          className="chat-preference-switch-input"
          type="checkbox"
          checked={chatPreferences.extractHtmlByDefault}
          onChange={(event) => void updateChatPreferences({ extractHtmlByDefault: event.target.checked })}
        />
        <span className="chat-preference-switch-control" aria-hidden="true">
          <span className="chat-preference-switch-thumb" />
        </span>
        <span className="chat-preference-switch-label">新对话默认提取 HTML 源码</span>
      </label>
    </section>
  );
}
