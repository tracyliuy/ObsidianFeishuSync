# Feishu Sync (Obsidian Plugin)

[English](./README.en.md)

手动双向同步 Obsidian Markdown 与飞书文档（Docx/Wiki），支持多账号、多公司空间。

- 插件 ID: `feishu-sync`
- 当前版本: `0.0.1`
- 最低 Obsidian 版本: `1.5.0`

## 功能概览

- 多账号管理（可启用/禁用）
- 上传当前编辑文档到飞书（创建新文档）
- 下载飞书文档到本地（始终新建文件，自动避免重名）
- 账号选择集成在上传/下载配置界面（多账号时）
- 上传时支持选择 Wiki Space 与子节点（可不选子节点，默认根节点）
- 下载时支持：
  - 目录选择（过滤 `assets` 目录）
  - 文档 ID 输入优先
  - Wiki Space + 文档树选择（含层级）
  - 本地标题搜索过滤
- Markdown 样式处理（标题、列表、代码、引用、表格、任务等）
- Mermaid 上传模式：
  - 文本块
  - 图片
  - 文本块 + 图片
- 图片/附件上传与下载
- 表格处理：
  - 上传：Markdown 表格写入飞书 Sheet，并处理样式/对齐/列宽
  - 下载：可选将飞书 Sheet 导出为 Excel 并作为本地附件链接
  - 列宽规则：
    - 基础按单元格内容宽度计算（保留最小列宽 100）
    - 仅当表格总宽度超过 900 时，启用分级上限策略：
      - 若 `>300` 的列数 `>=3`，列宽上限为 `300`
      - 否则若 `>400` 的列数 `>=2`，列宽上限为 `400`
      - 否则若存在 `>500` 的列，列宽上限为 `500`
- 限速保护：
  - 资产上传节流（默认开启）
  - 429 自动重试（默认开启）
- 同步历史记录（设置页仅保留最近 100 条）
- 控制台网络日志（可配置敏感信息脱敏）

## 认证模式（当前实现）

插件仅使用**用户授权**访问飞书 API，不再提供“使用应用身份（tenant_access_token）”作为 UI 入口。

令牌交换支持两种方式（可二选一）：

1. `local_secret`（本地模式）
- Obsidian 本地配置 `app_id + app_secret`
- 插件直接向飞书换取 `user_access_token`

2. `remote_bridge`（远程代理模式，默认）
- Obsidian 只配置 `app_id + remoteAuthUrl`（可选 `remoteAuthApiKey`）
- 通过你自己的服务端中转换 token
- 更适合开源插件发布和多端分发

## 目录结构

```text
feishuSync/
├─ src/                 # 插件源码
├─ tests/               # 测试
├─ server/              # OAuth bridge（Node/PHP 单文件）
├─ docs/                # 文档
├─ manifest.json
├─ package.json
└─ README.md
```

## 在 Obsidian 中使用

### 1. 安装插件（手动）

将本项目目录放在你的 Vault 路径下：

```text
<YourVault>/.obsidian/plugins/feishuSync/
```

确保存在：

- `manifest.json`
- `main.js`

然后在 Obsidian -> 社区插件中启用该插件。

### 2. 配置账号

进入插件设置 -> `账号配置`：

必填：

- `显示名称`
- `App ID`

推荐（默认）：

- `认证令牌交换方式`：`远程代理（Auth URL）`
- `远程认证 URL`：例如 `https://your-domain/api`
- `远程认证 API Key`：若服务端启用鉴权则填写

可选：

- `App Secret`（仅本地模式需要）
- `OAuth 回调地址`（默认本地回调）
- `OAuth 授权 Scope`（默认已内置常用 scopes）

### 3. 用户登录授权

在账号行点击：

- `用户登录`：打开授权链接并等待本地回调
- `清除用户令牌`：清除已保存 token
- `检测回调端口`：检查本地回调端口可用性
- `刷新状态`：检查用户 token 有效性和用户信息

### 4. 上传文档

点击左侧 Ribbon 的上传按钮（`上传到飞书`）：

- 多账号时先选择账号
- 选择 Wiki Space / 子节点（可不选子节点）
- 选择 Mermaid 上传模式
- 插件会创建新文档并自动处理同名（追加 `-01`, `-02`...）
- 上传进度窗口显示当前阶段、百分比、详细状态

### 5. 下载文档

点击左侧 Ribbon 的下载按钮（`从飞书下载`）：

- 多账号时先选择账号
- 选择本地目录（过滤 `assets`）
- 文档 ID 输入优先
- 或选择 Wiki Space + 文档树（支持层级和标题搜索）
- 支持“表格下载为 Excel”选项
- 本地永远新建文件，不覆盖旧文件；重名自动追加 `-01`, `-02`...

## 远程 OAuth Bridge（推荐）

项目已提供：

- Node 版本：`server/feishu-oauth-bridge.js`
- PHP 版本：`server/feishu-oauth-bridge.php`

### PHP 版本最小要求

- PHP 7.4+（建议 8.x）
- 开启 `curl`
- Nginx + php-fpm 或 Apache + PHP

### 推荐 API 路径

如果 Nginx 配置了 `/api` 前缀（推荐），插件里把远程 URL 配为：

```text
https://your-domain/api
```

插件会请求：

- `POST /oauth/exchange`
- `POST /oauth/refresh`

即完整地址：

- `https://your-domain/api/oauth/exchange`
- `https://your-domain/api/oauth/refresh`

### 健康检查

```bash
curl https://your-domain/api/health
```

返回 `ok: true` 即可。

### 多应用支持

Bridge 支持按 `app_id` 路由到不同应用密钥。

可通过环境变量 `FEISHU_APP_CREDENTIALS` 配置，例如：

```json
{
  "cli_app_a": {"app_secret": "secret_a", "redirect_uri": "https://a.example.com/callback"},
  "cli_app_b": {"app_secret": "secret_b", "redirect_uri": "https://b.example.com/callback"}
}
```

更多细节见：`docs/oauth-bridge.md`

## 常见问题

### 1) 提示未授权 / scope 不足

- 检查飞书应用是否开通了对应用户权限
- 重新发起用户授权
- 检查 Scope 是否包含 Wiki / Docx / Drive / Sheets 所需权限

### 2) 本地回调端口占用

- 修改 `OAuth 回调地址` 端口（如 `27123 -> 27124`）
- 飞书后台重定向地址也要同步修改

### 3) 429 限流

- 启用上传节流（默认开启）
- 调大重试等待秒数
- 避免短时间高频上传大量附件

### 4) 账号多时选择混乱

- 已支持在上传/下载对话框内直接选账号
- 建议账号命名为“公司/环境”明确区分

## 安全与隐私

1. `data.json` 包含账号配置与 token 信息，不要提交到 Git。
2. 默认建议开启日志脱敏，不要在生产长期开启明文敏感日志。
3. 若使用远程 bridge，请务必：
   - 开启 HTTPS
   - 配置 API Key 鉴权
   - 限制 CORS 来源
4. 若历史曾泄露密钥，请立即轮换 `app_secret` 和 API Key。

## 发布建议（开源前）

- 确认 `.gitignore` 包含 `data.json`
- 全仓扫描 token / secret
- 使用测试应用和测试密钥做示例
- README 中不要放真实密钥与真实用户 token

## 许可证

按你的仓库策略选择（MIT/Apache-2.0/私有）。如果准备公开仓库，建议补充 `LICENSE` 文件。
