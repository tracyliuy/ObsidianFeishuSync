# Feishu Sync (Obsidian Plugin)

[中文](./README.md)

Manual two-way sync between Obsidian Markdown files and Feishu Docs (Docx/Wiki), with multi-account support for different companies/workspaces.

- Plugin ID: `feishu-sync`
- Current version: `0.0.1`
- Minimum Obsidian version: `1.5.0`

## Features

- Multi-account management (enable/disable per account)
- Upload the current note to Feishu (create new remote doc)
- Download Feishu docs to local vault (always create new local file, never overwrite)
- Account selection integrated in upload/download dialogs (when multiple accounts exist)
- Upload target selection: Wiki Space + optional child node
- Download options:
  - Local folder selection (filters out `assets` folders)
  - Manual doc ID input (highest priority)
  - Wiki Space + hierarchical document tree selection
  - Local title search/filter
- Markdown handling for headings, lists, code blocks, quotes, tables, tasks, etc.
- Mermaid upload modes:
  - Text block
  - Image
  - Text block + image
- Image and file attachment upload/download
- Table support:
  - Upload: parse Markdown table into Feishu Sheet, with style/alignment/column-width handling
  - Download: optional export of Feishu Sheet as Excel and insert as Markdown attachment link
- Rate limit protection:
  - Asset upload throttling (enabled by default)
  - Auto retry on HTTP 429 (enabled by default)
- Sync history in settings (keeps latest 100 records)
- Network debug logs with optional sensitive-data masking

## Authentication Model (Current)

The plugin now uses **user authorization only** for Feishu API access.
The UI no longer exposes “tenant_access_token / app identity mode”.

Token exchange can be configured in two ways:

1. `local_secret` (local exchange)
- Configure `app_id + app_secret` in Obsidian
- Plugin exchanges code/token directly with Feishu

2. `remote_bridge` (server-side exchange, default)
- Configure `app_id + remoteAuthUrl` (optional `remoteAuthApiKey`)
- Token exchange happens on your own server
- Recommended for open-source/public distribution

## Project Structure

```text
feishuSync/
├─ src/                 # Plugin source code
├─ tests/               # Test cases
├─ server/              # OAuth bridge (single-file Node/PHP)
├─ docs/                # Documentation
├─ manifest.json
├─ package.json
└─ README.md
```

## Using in Obsidian

### 1) Install manually

Place this project under your vault:

```text
<YourVault>/.obsidian/plugins/feishuSync/
```

Make sure these files exist:

- `manifest.json`
- `main.js`

Then enable it in Obsidian Community Plugins.

### 2) Configure account

Open plugin settings -> `Account Settings`:

Required:

- Display name
- App ID

Recommended (default):

- Token exchange mode: `remote_bridge`
- Remote auth URL: e.g. `https://your-domain/api`
- Remote auth API key: required only if your bridge enforces API key auth

Optional:

- App Secret (required only for `local_secret` mode)
- OAuth redirect URI (local callback by default)
- OAuth scopes (default scopes already include common wiki/docx/drive/sheets scopes)

### 3) User authorization

Per account actions:

- `User Login`: open/copy auth URL and wait for local callback
- `Clear User Token`: remove locally stored user token/refresh token
- `Check Callback Port`: verify local callback endpoint availability
- `Refresh Status`: verify token validity and fetch current user info

### 4) Upload workflow

Click left ribbon button: `Upload to Feishu`

- Select account (if multiple)
- Select target Wiki Space and optional child node
- Select Mermaid upload mode
- Plugin creates a new remote doc and auto-resolves duplicate names with suffixes (`-01`, `-02`, ...)
- Upload progress modal shows stage, percentage, and details

### 5) Download workflow

Click left ribbon button: `Download from Feishu`

- Select account (if multiple)
- Select local target folder (assets folders filtered)
- Manual doc ID input has highest priority
- Or select from Wiki Space + hierarchical doc list
- Optional: “Download sheets as Excel”
- Plugin always creates a new local markdown file; duplicate names are auto-suffixed (`-01`, `-02`, ...)

## Remote OAuth Bridge (Recommended)

Included in this repo:

- Node version: `server/feishu-oauth-bridge.js`
- PHP version: `server/feishu-oauth-bridge.php`

### PHP bridge minimum requirements

- PHP 7.4+ (8.x recommended)
- `curl` extension enabled
- Nginx + php-fpm (or Apache + PHP)

### Recommended API base path

If your Nginx routes bridge requests under `/api`, set plugin remote URL to:

```text
https://your-domain/api
```

Plugin endpoints:

- `POST /oauth/exchange`
- `POST /oauth/refresh`

Full URLs:

- `https://your-domain/api/oauth/exchange`
- `https://your-domain/api/oauth/refresh`

### Health check

```bash
curl https://your-domain/api/health
```

`ok: true` means bridge is running.

### Multi-app support

Bridge supports multiple Feishu apps via `app_id` routing.
Use `FEISHU_APP_CREDENTIALS`, for example:

```json
{
  "cli_app_a": {"app_secret": "secret_a", "redirect_uri": "https://a.example.com/callback"},
  "cli_app_b": {"app_secret": "secret_b", "redirect_uri": "https://b.example.com/callback"}
}
```

See details in: `docs/oauth-bridge.md`

## Troubleshooting

### 1) Unauthorized / missing scopes

- Ensure required app/user scopes are enabled in Feishu Open Platform
- Re-authorize user account
- Verify scope set includes wiki/docx/drive/sheets scopes used by your operations

### 2) Local callback port in use

- Change callback port in plugin settings (e.g. `27123` -> `27124`)
- Update the same redirect URI in Feishu Open Platform

### 3) HTTP 429 rate limit

- Keep upload throttling enabled
- Increase retry delay
- Avoid uploading too many assets in a short burst

### 4) Account confusion in multi-account mode

- Use explicit account naming by company/environment
- Use account selection in upload/download dialogs

## Security and Privacy

1. `data.json` contains account config and token data. Never commit it.
2. Keep sensitive log masking enabled in production.
3. For remote bridge deployment, enforce:
   - HTTPS
   - API key auth
   - Restricted CORS
4. Rotate app secrets/API keys if they were ever exposed.

## Open Source Checklist

Before making the repository public:

- Ensure `.gitignore` includes `data.json`
- Scan repository (including history) for tokens/secrets
- Use test app credentials in examples
- Do not include real secrets/tokens in docs

## License

Choose your preferred license policy (MIT / Apache-2.0 / private).
If publishing publicly, add a `LICENSE` file.
