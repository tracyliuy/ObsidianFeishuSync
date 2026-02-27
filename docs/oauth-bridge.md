# Feishu OAuth Bridge (Server-Side Token Exchange)

## 1. 目的
- 插件不直接持有 `app_secret`。
- 授权码由客户端拿到后，交给服务端换 `user_access_token`。

## 2. 单文件服务
- 文件：`server/feishu-oauth-bridge.js`
- 运行环境：Node.js 18+
- 依赖：无（仅 Node 内置模块 + 全局 `fetch`）

### PHP 版本（单文件）
- 文件：`server/feishu-oauth-bridge.php`
- 运行环境：PHP 7.4+（建议 8.x），需要启用 `curl`
- 启动示例（内置 server）：
```bash
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
FEISHU_REDIRECT_URI=https://your-domain/feishu/callback \
BRIDGE_API_KEY=replace_me \
php -S 0.0.0.0:8787 server/feishu-oauth-bridge.php
```

## 3. 启动
```bash
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
FEISHU_REDIRECT_URI=https://your-domain/feishu/callback \
BRIDGE_API_KEY=replace_me \
PORT=8787 \
node server/feishu-oauth-bridge.js
```

### 多应用配置（推荐）
- 可通过 `FEISHU_APP_CREDENTIALS` 一次配置多个应用，按 `app_id` 选择：
```bash
FEISHU_APP_CREDENTIALS='{
  "cli_app_a": {"app_secret":"secret_a","redirect_uri":"https://a.example.com/callback"},
  "cli_app_b": {"app_secret":"secret_b","redirect_uri":"https://b.example.com/callback"}
}'
```
- 也兼容简写：
```bash
FEISHU_APP_CREDENTIALS='{"cli_app_a":"secret_a","cli_app_b":"secret_b"}'
```
- 当请求体或 query 中携带 `app_id` 时，bridge 会使用对应密钥。

## 4. 接口

### `GET /health`
- 健康检查

### `GET /oauth/authorize-url`
- 生成飞书授权地址
- Query:
  - `state` 可选
  - `scope` 可选
  - `app_id` 可选（多应用场景建议传）
  - `redirect_uri` 可选（不传时用环境变量 `FEISHU_REDIRECT_URI`）

### `POST /oauth/exchange`
- 授权码换 token（需要 `X-API-Key`）
- Body(JSON):
```json
{
  "code": "xxx",
  "app_id": "cli_xxx",
  "redirect_uri": "https://your-domain/feishu/callback"
}
```

### `POST /oauth/refresh`
- 刷新 token（需要 `X-API-Key`）
- Body(JSON):
```json
{
  "refresh_token": "r-xxx",
  "app_id": "cli_xxx"
}
```

### `GET /oauth/callback`
- 可选调试页面（展示 code/state 是否收到）

## 5. 插件对接建议
1. 插件请求 `GET /oauth/authorize-url`（建议带 `app_id`），拿到 `authorize_url` 后打开浏览器。
2. 用户授权后跳回你配置的 `redirect_uri`。
3. 插件拿到 `code` 后，调用 `POST /oauth/exchange`。
4. 保存返回的 `access_token/refresh_token`。
5. 到期前或失败时，调用 `POST /oauth/refresh`。

## 6. 安全建议
- 强制 HTTPS（生产环境）。
- 必配 `BRIDGE_API_KEY`，插件请求时带 `X-API-Key`。
- 限制 `ALLOWED_ORIGINS`（默认 `*`，建议收敛）。
- 日志不要打印明文 token。
