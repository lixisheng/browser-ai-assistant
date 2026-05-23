# 数据同步功能设计

## 目标

落地完整数据同步能力，让用户可以把当前插件域本地数据备份到 Chrome Sync、WebDAV 或 S3 兼容存储，并在需要时按当前备份前缀恢复到本地。同步功能、自动同步和加密能力彼此独立：开启同步后允许手动备份和恢复；自动同步默认关闭；加密关闭时允许明文备份，但界面必须明确提示风险。

## 范围

本次实现包含：

- 当前插件域 IndexedDB 中全部业务数据的备份和恢复，包含模型渠道、模型、提取规则、聊天会话、聊天文件夹、应用设置与同步配置中的非密钥字段。
- 排除本地密钥与远程访问凭据，包括本地加密密钥、WebDAV 密码、S3 Secret Key。
- Chrome Sync、WebDAV、S3 兼容存储三种备份目标。
- 手动备份、手动恢复、定时自动备份。
- 当前备份前缀对应一个远程备份，备份覆盖同前缀远程文件，恢复覆盖本地数据，不做多端合并。

本次不包含：

- 多版本备份、备份列表、差异预览、冲突合并。
- S3 桶创建、IAM 权限管理、临时凭证刷新。
- 自动同步期间的双向实时同步。

## 本地配置模型

新增同步配置保存在 `appSettings`，建议键名为 `syncSettings`。配置包含：

- `syncEnabled`：是否开启同步功能，默认 `false`。
- `autoSyncEnabled`：是否开启自动同步，默认 `false`。
- `provider`：`chrome_sync`、`webdav`、`s3`，默认 `chrome_sync`。
- `backupPrefix`：备份前缀，用于区分不同端，默认生成一个可读前缀，例如 `device-<短随机串>`。
- `encryptionEnabled`：是否启用加密，默认 `false`。
- `intervalMinutes`：定时同步间隔，单位分钟，默认 `60`，最小 `1`。
- `webdav`：服务器地址、用户名、备份文件路径或目录等非密钥配置。
- `s3`：Endpoint、Access Key、Bucket、Region、对象 Key 前缀等非密钥配置。Region 默认 `auto`，兼容 Cloudflare R2；AWS S3 和 MinIO 用户可改为实际区域。

本地密钥与远程访问凭据使用独立键保存，例如：

- `syncEncryptionSecret`：本地加密密钥。
- `syncWebDavPassword`：WebDAV 密码。
- `syncS3SecretKey`：S3 Secret Key。

这些键只保存在本地 IndexedDB，导出备份时必须过滤。

## 备份载荷

备份载荷分为外层元数据和内层数据。

外层元数据用于远程识别：

- `version`：当前备份格式版本。
- `createdAt`：备份创建时间。
- `prefix`：当前备份前缀。
- `provider`：产生备份的远程目标类型。
- `encrypted`：是否加密。
- `payload`：明文数据或加密数据。

内层明文数据包含：

- `modelProviders`
- `providerModels`
- `modelConfigs`
- `extractionRules`
- `chatSessions`
- `chatFolders`
- `appSettings`

序列化前必须过滤密钥类 `appSettings`。恢复时先校验格式版本和基本字段，再覆盖本地业务数据；覆盖前必须读取并保留当前本地密钥与远程凭据类 `appSettings`，避免恢复备份后丢失 `syncEncryptionSecret`、`syncWebDavPassword`、`syncS3SecretKey`。恢复是破坏性操作，界面必须在恢复按钮附近提示“会用当前前缀备份覆盖本地数据，不会合并”，但本地同步密钥和远程访问凭据不会被远程备份覆盖或清空。

## 加密策略

继续使用现有 `AES-GCM + PBKDF2` 的 `encryptJson` 和 `decryptJson`。加密开启时：

- 备份前必须存在本地加密密钥。
- 内层明文数据整体加密后再上传。
- 恢复时必须使用当前本地密钥解密，失败时提示“无法解密同步数据，请确认本地密钥是否正确”。
- 修改本地加密密钥只更新本地密钥，不触发远端备份；后续手动备份或定时自动同步会使用当前本地密钥加密数据。

加密关闭时：

- 允许备份明文 JSON。
- UI 必须显示明确风险提示，说明 API Key、聊天记录和配置会以明文进入用户选择的远程存储。
- 用户仍可手动备份和恢复。

## 远程目标

### Chrome Sync

远程键名使用 `browserAiAssistantBackup:<prefix>`。Chrome Sync 受严格配额限制，备份前先计算序列化后的字节数；写入失败或预估超限时返回统一文案：

`备份失败：同步数据超过 Chrome Sync 配额，请减少本地历史记录或改用 WebDAV/S3`

MVP 不把单个备份拆成多份远程键。若单项配额导致无法写入，也使用同一提示。

### WebDAV

WebDAV 使用用户配置的服务器地址、用户名、密码和远程路径。备份用 `PUT` 上传 JSON 文件，恢复用 `GET` 读取同一路径。认证先支持 Basic Auth。远程路径由“备份目录或文件路径 + 前缀”计算，最终一个前缀只对应一个 JSON 文件。若服务端因父目录不存在返回 `409` 或 `AncestorsNotFound`，插件会按层级使用 `MKCOL` 尽力创建远程目录后重试一次写入。

输入校验要求：

- WebDAV 地址必须是 `https://` 或用户显式输入的 `http://`。
- 用户名不能为空。
- 密码必须保存在本地凭据键，不能写入备份。
- 远程路径不能为空，不能包含明显路径穿越片段。

### S3 兼容存储

S3 配置包含 Endpoint、Access Key、Secret Key、Bucket、Region、对象 Key 前缀。备份使用 S3 `PutObject`，恢复使用 `GetObject`。请求在前端或 background 中实现 AWS Signature Version 4 签名。

输入校验要求：

- Endpoint 必须是合法 URL。
- Bucket、Access Key、Secret Key 不能为空。
- Region 默认 `auto`，允许用户修改。
- 对象 Key 使用 `<objectKeyPrefix>/<backupPrefix>.json`，需要规范化斜杠并避免空 Key。

## 自动同步

开启同步功能只允许手动备份/恢复，不自动启动后台同步。用户单独开启自动同步后，按配置的分钟间隔执行定时备份。

### 定时同步

使用 `chrome.alarms` 注册定时任务，需要在 `manifest.json` 增加 `alarms` 权限。用户修改间隔、远程目标、前缀或关闭自动同步时，应同步更新或清理 alarm。触发时读取本地配置，若同步或自动同步已关闭则跳过。

## UI 设计

同步设置仍放在现有“同步设置”Tab，延续项目 Claude Light 主题：暖奶油画布、浅卡片、少量珊瑚主操作、错误和警告使用语义色。

页面结构：

- 同步总开关：开启后展示远程目标、前缀、手动备份和恢复。
- 自动同步开关：默认关闭；开启后设置定时同步间隔，单位分钟。
- 加密开关：默认关闭；开启后显示本地加密密钥输入和“忘记密钥无法恢复”警告；关闭时显示明文备份风险警告。
- 备份目标配置：Chrome Sync 展示配额说明；WebDAV 展示地址、用户名、密码、路径；S3 展示 Endpoint、Access Key、Secret Key、Bucket、Region、对象 Key 前缀。
- 备份内容说明：展示“备份当前插件域本地存储的全部内容，密钥和远程凭据除外”，不提供内容范围裁剪开关。
- 操作区：手动备份、手动恢复、最近状态、最近备份时间、错误信息。

恢复操作需要二次确认，文案明确“恢复会覆盖本地数据且不合并”。

## 数据流

手动备份：

1. UI 调用 store 的 `backupNow`。
2. store 校验同步开关和配置，读取本地密钥/凭据。
3. backup 服务导出 IndexedDB，过滤密钥，按加密开关处理 payload。
4. 远程 provider 覆盖写入当前前缀备份。
5. 更新本地最近同步状态。

手动恢复：

1. UI 调用 store 的 `restoreNow`。
2. store 校验同步开关和远程配置。
3. 远程 provider 读取当前前缀备份。
4. 若加密则用本地密钥解密。
5. 校验载荷格式，保留本地同步密钥和远程凭据后覆盖 IndexedDB。
6. 重新加载渠道、规则、聊天等状态。

自动备份：

1. `chrome.alarms` 定时触发 background。
2. background 调用共享 backup 服务。
3. 写入最近状态，供 Side Panel 展示。

## 错误处理

- 同步未开启时：提示“请先开启同步功能”。
- 自动同步开启但配置不完整：提示具体缺失项。
- 加密开启但无本地密钥：提示“请先设置本地加密密钥”。
- 解密失败：提示“无法解密同步数据，请确认本地密钥是否正确”。
- Chrome Sync 超限：提示减少本地历史记录或改用 WebDAV/S3。
- WebDAV/S3 网络失败：返回脱敏中文错误，不暴露密码、Secret Key 或完整授权头。
- 恢复载荷格式不合法：提示“备份文件格式无效，未覆盖本地数据”。

## 测试计划

- 备份导出测试：覆盖全表导出、密钥字段过滤、恢复时保留本地同步密钥和远程凭据。
- 加密测试：覆盖加密备份可恢复、错误密钥失败、明文备份风险路径。
- Chrome Sync provider 测试：覆盖写入、读取、配额超限提示。
- WebDAV provider 测试：覆盖 PUT/GET、Basic Auth、配置校验、错误脱敏。
- S3 provider 测试：覆盖 SigV4 请求头、PUT/GET、Region 默认 `auto`、配置校验、错误脱敏。
- store 测试：覆盖同步开关、自动同步开关、密钥修改不触发备份、手动备份使用当前密钥、恢复后重新加载状态。
- UI 测试：覆盖三种目标表单、加密/明文警告、恢复二次确认、自动同步策略设置。
- background 测试：覆盖 alarm 注册、触发自动备份、关闭自动同步时清理 alarm。
- 构建验证：运行 `npm test`、`npm run typecheck`、`npm run build`，并检查 content script 产物不包含运行时 import。

## 风险

- Chrome Sync 配额很小，聊天记录稍多就可能失败；MVP 按需求直接失败并提示，不拆分。
- WebDAV 服务器实现差异较大，MVP 只依赖基础 `PUT` 和 `GET`。
- S3 兼容服务在 path-style、虚拟主机风格、Region 和签名细节上存在差异；MVP 优先使用 path-style URL，减少桶名和证书兼容问题。
- 加密关闭时远程备份是明文，必须依赖 UI 风险提示和用户主动选择。
