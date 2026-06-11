# 浏览器自动化控制阶段一：地基搭建计划

## 目标

建立浏览器控制的最小稳定地基：声明 `debugger` 权限、增加显式用户开关和风险提示、补齐 background 调试器连接生命周期，并确保关闭开关时立即断开调试会话。本阶段不实现 `take_snapshot`、点击、填写、导航或 MCP。

## 实现范围

- `manifest.json` 默认声明 `debugger` 权限。
- 聊天偏好和当前会话覆盖项新增 `browserControlEnabled`，默认 `false`。
- 设置页增加浏览器控制开关与中文风险提示。
- 新增 background 浏览器控制模块：
  - 判断受限 URL。
  - 查询或接收目标 tab。
  - attach / detach `chrome.debugger`。
  - 监听外部 detach 和 tab 关闭。
  - 关闭开关时主动 detach。
  - 返回统一中文状态与错误。
- 新增 `browserControl.setEnabled` runtime 消息，供 Side Panel 开关调用。
- 同步更新 `AGENTS.md` 的阶段一实现约束。

## 验收标准

- 浏览器控制默认关闭，旧偏好数据归一化后仍为关闭。
- 开关开启时，background 对普通 http(s) 页面尝试 attach。
- 受限页面不会 attach，并返回中文错误。
- 关闭开关时立即 detach 当前调试会话。
- tab 关闭或用户取消调试时，background 清理连接状态。
- `npm run typecheck` 通过。
- 相关单元测试通过。
- `npm run build:extension` 通过。
