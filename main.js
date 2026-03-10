"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => FeishuSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");
var import_node_http = require("node:http");

// src/services/feishuAuth.ts
var DEFAULT_OAUTH_SCOPES = [
  "docx:document",
  "docx:document:readonly",
  "drive:file",
  "drive:file:readonly",
  "wiki:wiki",
  "wiki:wiki:readonly",
  "wiki:space:retrieve",
  "bitable:app",
  "bitable:app:readonly",
  "bitable:table",
  "bitable:table:readonly",
  "bitable:record",
  "bitable:record:readonly",
  "sheets:spreadsheet",
  "sheets:spreadsheet:readonly"
];
var FeishuAuthManager = class {
  constructor(request, onAccountAuthUpdated) {
    this.request = request;
    this.onAccountAuthUpdated = onAccountAuthUpdated;
    this.tokenCache = /* @__PURE__ */ new Map();
  }
  buildUserAuthorizeUrl(account, redirectUri, state) {
    const base = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
    const customScopes = (account.oauthScopes ?? "").split(/[,\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
    const scopes = customScopes.length > 0 ? customScopes : DEFAULT_OAUTH_SCOPES;
    const query = new URLSearchParams({
      app_id: account.appId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: state ?? `feishu-sync-${Date.now()}`,
      scope: scopes.join(" ")
    });
    return `${base}?${query.toString()}`;
  }
  async exchangeUserCode(account, code, redirectUri) {
    const mode = this.resolveAuthMode(account);
    console.log("[FeishuSync][auth:exchange_code_request]", {
      accountId: account.id,
      redirectUri,
      mode
    });
    const response = await this.exchangeByMode(account, code, redirectUri, mode);
    const accessToken = response.access_token ?? response.data?.access_token ?? "";
    const refreshToken = response.refresh_token ?? response.data?.refresh_token ?? "";
    if (!accessToken || !refreshToken) {
      throw new Error("User OAuth exchange failed: missing access_token/refresh_token.");
    }
    const scope = response.data?.scope ?? "";
    console.log("[FeishuSync][auth:exchange_code_success]", {
      accountId: account.id,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      scope
    });
    const expiresIn = Math.max(60, Number(response.expires_in ?? response.data?.expires_in ?? 7200));
    const expireAt = Date.now() + Math.max(30, expiresIn - 120) * 1e3;
    this.tokenCache.set(`user:${account.id || account.appId}`, {
      token: accessToken,
      expiresAt: expireAt
    });
    return {
      accessToken,
      refreshToken,
      expireAt,
      openId: response.open_id ?? response.data?.open_id ?? "",
      userName: response.name ?? response.data?.name ?? ""
    };
  }
  invalidateAccountCache(account) {
    const suffix = account.id || account.appId;
    this.tokenCache.delete(`user:${suffix}`);
    this.tokenCache.delete(`tenant:${suffix}`);
  }
  async fetchCurrentUserInfo(account) {
    try {
      const token = await this.getAccessToken(account);
      console.log("[FeishuSync][auth:user_info_request]", { accountId: account.id, hasToken: !!token });
      const response = await this.request("/authen/v1/user_info", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const name = response.data?.name ?? "";
      const openId = response.data?.open_id ?? "";
      if (name) {
        account.userName = name;
      }
      if (openId) {
        account.userOpenId = openId;
      }
      account.lastAuthCheckAt = Date.now();
      account.lastAuthError = "";
      account.lastAuthErrorAt = 0;
      await this.onAccountAuthUpdated?.(account);
      console.log("[FeishuSync][auth:user_info_success]", {
        accountId: account.id,
        userName: account.userName,
        openId: account.userOpenId
      });
      return { name, openId };
    } catch (error) {
      account.lastAuthCheckAt = Date.now();
      account.lastAuthError = String(error);
      account.lastAuthErrorAt = Date.now();
      await this.onAccountAuthUpdated?.(account);
      console.log("[FeishuSync][auth:user_info_failed]", { accountId: account.id, error: String(error) });
      throw error;
    }
  }
  async getAccessToken(account) {
    if ((account.authType ?? "user") === "user") {
      const userToken = await this.getUserAccessToken(account);
      if (userToken) {
        return userToken;
      }
      account.lastAuthError = "User auth is selected but user token is not available. Please login again.";
      account.lastAuthErrorAt = Date.now();
      await this.onAccountAuthUpdated?.(account);
      throw new Error("User auth is selected but user token is not available. Please login again.");
    }
    return await this.getTenantAccessToken(account);
  }
  async getUserAccessToken(account) {
    const cacheKey = `user:${account.id || account.appId}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    const now = Date.now();
    if (account.userAccessToken && (account.userTokenExpireAt ?? 0) > now + 30 * 1e3) {
      this.tokenCache.set(cacheKey, {
        token: account.userAccessToken,
        expiresAt: account.userTokenExpireAt ?? now + 36e5
      });
      return account.userAccessToken;
    }
    if (!account.userRefreshToken) {
      return "";
    }
    let refreshed;
    try {
      const mode = this.resolveAuthMode(account);
      console.log("[FeishuSync][auth:refresh_request]", {
        accountId: account.id,
        hasRefreshToken: !!account.userRefreshToken,
        mode
      });
      refreshed = await this.refreshByMode(account, account.userRefreshToken, mode);
    } catch (error) {
      account.lastAuthError = String(error);
      account.lastAuthErrorAt = Date.now();
      account.lastAuthCheckAt = Date.now();
      await this.onAccountAuthUpdated?.(account);
      console.log("[FeishuSync][auth:refresh_failed]", { accountId: account.id, error: String(error) });
      throw error;
    }
    const accessToken = refreshed.access_token ?? refreshed.data?.access_token ?? "";
    if (!accessToken) {
      account.lastAuthError = "Refresh user token failed: missing access_token.";
      account.lastAuthErrorAt = Date.now();
      account.lastAuthCheckAt = Date.now();
      await this.onAccountAuthUpdated?.(account);
      return "";
    }
    const nextRefreshToken = refreshed.refresh_token ?? refreshed.data?.refresh_token ?? account.userRefreshToken ?? "";
    const expiresIn = Math.max(
      60,
      Number(refreshed.expires_in ?? refreshed.data?.expires_in ?? 7200)
    );
    const expireAt = Date.now() + Math.max(30, expiresIn - 120) * 1e3;
    account.userAccessToken = accessToken;
    account.userRefreshToken = nextRefreshToken;
    account.userTokenExpireAt = expireAt;
    account.userOpenId = refreshed.data?.open_id ?? account.userOpenId ?? "";
    account.userName = refreshed.data?.name ?? account.userName ?? "";
    account.lastAuthCheckAt = Date.now();
    account.lastAuthError = "";
    account.lastAuthErrorAt = 0;
    await this.onAccountAuthUpdated?.(account);
    console.log("[FeishuSync][auth:refresh_success]", { accountId: account.id, expireAt });
    this.tokenCache.set(cacheKey, { token: accessToken, expiresAt: expireAt });
    return accessToken;
  }
  async getTenantAccessToken(account) {
    if (this.resolveAuthMode(account) === "remote_bridge" && !account.appSecret) {
      throw new Error("\u5F53\u524D\u8D26\u53F7\u4F7F\u7528\u8FDC\u7A0B\u8BA4\u8BC1\u4E14\u672A\u914D\u7F6E App Secret\uFF0C\u65E0\u6CD5\u83B7\u53D6 tenant_access_token\u3002\u8BF7\u5207\u6362\u4E3A\u7528\u6237\u8EAB\u4EFD\u6216\u914D\u7F6E App Secret\u3002");
    }
    const cacheKey = `tenant:${account.id || account.appId}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    const response = await this.request("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: account.appId,
        app_secret: account.appSecret
      })
    });
    const token = response.tenant_access_token;
    if (!token) {
      throw new Error("Feishu auth response missing tenant_access_token.");
    }
    this.tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + 110 * 60 * 1e3
    });
    return token;
  }
  resolveAuthMode(account) {
    if (account.authMode === "local_secret" || account.authMode === "remote_bridge") {
      return account.authMode;
    }
    return "remote_bridge";
  }
  async exchangeByMode(account, code, redirectUri, mode) {
    if (mode === "remote_bridge") {
      return await this.requestRemoteBridge(account, "/oauth/exchange", {
        code,
        redirect_uri: redirectUri,
        app_id: account.appId
      });
    }
    if (!account.appSecret) {
      throw new Error("\u672C\u5730\u8BA4\u8BC1\u6A21\u5F0F\u7F3A\u5C11 App Secret\u3002");
    }
    const response = await this.request("/authen/v2/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: account.appId,
        client_secret: account.appSecret,
        code,
        redirect_uri: redirectUri
      })
    });
    return response;
  }
  async refreshByMode(account, refreshToken, mode) {
    if (mode === "remote_bridge") {
      return await this.requestRemoteBridge(account, "/oauth/refresh", {
        refresh_token: refreshToken,
        app_id: account.appId
      });
    }
    if (!account.appSecret) {
      throw new Error("\u672C\u5730\u8BA4\u8BC1\u6A21\u5F0F\u7F3A\u5C11 App Secret\u3002");
    }
    const response = await this.request("/authen/v2/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: account.appId,
        client_secret: account.appSecret,
        refresh_token: refreshToken
      })
    });
    return response;
  }
  async requestRemoteBridge(account, path, payload) {
    const base = (account.remoteAuthUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      throw new Error("\u8FDC\u7A0B\u8BA4\u8BC1\u6A21\u5F0F\u7F3A\u5C11\u8BA4\u8BC1 URL\u3002");
    }
    const headers = {
      "Content-Type": "application/json"
    };
    if ((account.remoteAuthApiKey ?? "").trim()) {
      headers["X-API-Key"] = (account.remoteAuthApiKey ?? "").trim();
    }
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Remote auth bridge response is not valid JSON: ${text}`);
    }
    if (!response.ok) {
      throw new Error(
        `Remote auth bridge failed with HTTP ${response.status}: ${parsed.msg || parsed.message || JSON.stringify(parsed)}`
      );
    }
    if (typeof parsed.code === "number" && parsed.code !== 0) {
      throw new Error(parsed.msg || parsed.message || `Remote auth bridge code=${parsed.code}`);
    }
    return parsed;
  }
};

// src/services/docxMarkdownParser.ts
function parseDocxBlocksToMarkdown(doc, blocks) {
  const parser = new Parser(blocks);
  return parser.parseDocument(doc).trim() + "\n";
}
var Parser = class {
  constructor(blocks) {
    this.blocks = blocks;
    this.blockMap = /* @__PURE__ */ new Map();
    for (const block of blocks) {
      this.blockMap.set(block.block_id, block);
    }
  }
  parseDocument(doc) {
    const root = this.blockMap.get(doc.document_id) ?? this.blocks.find((b) => b.block_type === 1);
    if (!root) {
      return `# ${doc.title}
`;
    }
    const chunks = [`# ${doc.title}`, this.parseChildren(root, 0)];
    return compact(chunks).join("\n\n");
  }
  parseBlockById(blockId, indent, orderedNumber) {
    const block = this.blockMap.get(blockId);
    if (!block) {
      return "";
    }
    return this.parseBlock(block, indent, orderedNumber);
  }
  parseBlock(block, indent, orderedNumber) {
    if (block.heading1)
      return this.parseHeading(block.heading1, 1, block, indent);
    if (block.heading2)
      return this.parseHeading(block.heading2, 2, block, indent);
    if (block.heading3)
      return this.parseHeading(block.heading3, 3, block, indent);
    if (block.heading4)
      return this.parseHeading(block.heading4, 4, block, indent);
    if (block.heading5)
      return this.parseHeading(block.heading5, 5, block, indent);
    if (block.heading6)
      return this.parseHeading(block.heading6, 6, block, indent);
    if (block.text)
      return this.parseText(block.text, block, indent);
    if (block.bullet)
      return this.parseListItem(block.bullet, block, indent, "-");
    if (block.ordered)
      return this.parseListItem(block.ordered, block, indent, `${orderedNumber ?? 1}.`);
    if (block.bitable)
      return this.parseBitable(block.bitable);
    if (block.file)
      return this.parseFile(block.file);
    if (block.todo)
      return this.parseTodo(block.todo, block, indent);
    if (block.task && block.block_type !== 15)
      return this.parseTodo(block.task, block, indent);
    if (block.sheet)
      return this.parseSheet(block.sheet);
    if (block.code) {
      return this.parseCode(
        block.code,
        block
      );
    }
    if (block.add_ons && block.block_type === 40)
      return this.parseAddOnComponent(block);
    if (block.quote || block.quote_container)
      return this.parseQuote(block, indent);
    if (block.image)
      return this.parseImage(block.image);
    if (block.divider && block.block_type === 22)
      return "---";
    const fromType = this.parseByBlockType(block, indent, orderedNumber);
    if (fromType) {
      return fromType;
    }
    return this.parseChildren(block, indent);
  }
  parseByBlockType(block, indent, orderedNumber) {
    switch (block.block_type) {
      case 2:
        return this.parseText(block.text ?? emptyContainer(), block, indent);
      case 3:
        return this.parseHeading(block.heading1 ?? emptyContainer(), 1, block, indent);
      case 4:
        return this.parseHeading(block.heading2 ?? emptyContainer(), 2, block, indent);
      case 5:
        return this.parseHeading(block.heading3 ?? emptyContainer(), 3, block, indent);
      case 12:
        return this.parseListItem(block.bullet ?? emptyContainer(), block, indent, "-");
      case 13:
        return this.parseListItem(
          block.ordered ?? emptyContainer(),
          block,
          indent,
          `${orderedNumber ?? 1}.`
        );
      case 14:
        if (block.code) {
          return this.parseCode(
            block.code ?? emptyContainer(),
            block
          );
        }
        return this.parseCode(emptyContainer(), block);
      case 15:
        return this.parseQuote(block, indent);
      case 17:
        return this.parseTodo(
          block.todo ?? block.task ?? emptyContainer(),
          block,
          indent
        );
      case 18:
        if (block.bitable) {
          return this.parseBitable(block.bitable ?? {});
        }
        return this.parseChildren(block, indent);
      case 22:
        return "---";
      case 23:
        return this.parseFile(block.file ?? {});
      case 27:
        return this.parseImage(block.image ?? {});
      case 30:
        return this.parseSheet(block.sheet ?? {});
      case 31:
        return this.parseTable(block);
      case 32:
        return this.parseTableCell(block);
      case 40:
        return this.parseAddOnComponent(block);
      default:
        return this.parseChildren(block, indent);
    }
  }
  parseHeading(text, level, block, indent) {
    const heading = `${"#".repeat(level)} ${this.parseRichText(text).trim()}`.trim();
    const children = this.parseChildren(block, indent);
    return compact([heading, children]).join("\n\n");
  }
  parseText(text, block, indent) {
    const content = this.parseRichText(text);
    const children = this.parseChildren(block, indent);
    return compact([content, children]).join("\n\n");
  }
  parseListItem(text, block, indent, marker) {
    const prefix = `${"    ".repeat(indent)}${marker} `;
    const self = `${prefix}${this.parseRichText(text).trim()}`.trimEnd();
    const children = (block.children ?? []).map((childId) => this.parseBlockById(childId, indent + 1)).filter((item) => item.length > 0).join("\n");
    return compact([self, children]).join("\n");
  }
  parseTodo(text, block, indent) {
    const done = resolveDoneState(text);
    const marker = done ? "- [x]" : "- [ ]";
    const line = `${"    ".repeat(indent)}${marker} ${this.parseRichText(text).trim()}`;
    const children = this.parseChildren(block, indent + 1);
    return compact([line, children]).join("\n");
  }
  parseCode(block, source) {
    const lang = resolveCodeLanguage(block.style?.language);
    const text = this.parseRichText(block).trimEnd();
    const children = this.parseChildren(source, 0);
    return compact([`\`\`\`${lang}`.trimEnd(), text, "```", children]).join("\n");
  }
  parseQuote(block, indent) {
    const base = this.parseRichText(block.quote ?? emptyContainer()).trim();
    const lines = (block.children ?? []).map((id) => this.parseBlockById(id, indent)).filter((v) => v.length > 0).join("\n").split("\n").filter((v) => v.length > 0).map((v) => `> ${v}`);
    if (base.length > 0) {
      lines.unshift(`> ${base}`);
    }
    return lines.join("\n");
  }
  parseImage(image) {
    const token = image.token ?? "";
    return token ? `![](${token})` : "";
  }
  parseSheet(sheet) {
    const token = (sheet.token ?? "").trim();
    if (!token) {
      return "";
    }
    return `{{sheet:${token}}}`;
  }
  parseBitable(bitable) {
    const token = (bitable.token ?? "").trim();
    if (!token) {
      return "";
    }
    return `{{bitable:${token}}}`;
  }
  parseFile(file) {
    const token = (file.token ?? "").trim();
    if (!token) {
      return "";
    }
    const name = (file.name ?? "").trim();
    const encodedName = encodeURIComponent(name);
    return `{{file:${token}:${encodedName}}}`;
  }
  parseTable(block) {
    const table = block.table ?? {};
    const orderedCells = Array.isArray(table.cells) ? table.cells.filter((item) => typeof item === "string" && item.length > 0) : (block.children ?? []).filter((item) => typeof item === "string" && item.length > 0);
    if (orderedCells.length === 0) {
      return "";
    }
    const explicitCols = toPositiveInt(table.property?.column_size);
    const explicitRows = toPositiveInt(table.property?.row_size);
    const columnSize = explicitCols > 0 ? explicitCols : explicitRows > 0 ? Math.max(1, Math.ceil(orderedCells.length / explicitRows)) : orderedCells.length;
    const rowSize = explicitRows > 0 ? explicitRows : Math.max(1, Math.ceil(orderedCells.length / Math.max(1, columnSize)));
    const totalSlots = Math.max(1, rowSize * columnSize);
    const matrix = [];
    for (let row = 0; row < rowSize; row += 1) {
      const rowCells = [];
      for (let col = 0; col < columnSize; col += 1) {
        const idx = row * columnSize + col;
        const cellId = idx < totalSlots ? orderedCells[idx] : "";
        rowCells.push(cellId ? this.parseTableCellById(cellId) : "");
      }
      matrix.push(rowCells);
    }
    while (matrix.length > 1 && matrix[matrix.length - 1].every((cell) => !cell.trim())) {
      matrix.pop();
    }
    if (matrix.length === 0) {
      return "";
    }
    const header = matrix[0].map((cell) => sanitizeMarkdownTableCell(cell));
    const separator = new Array(columnSize).fill("---");
    const rows = matrix.slice(1).map((cells) => cells.map((cell) => sanitizeMarkdownTableCell(cell)));
    const lines = [renderMarkdownTableRow(header), renderMarkdownTableRow(separator)];
    for (const row of rows) {
      lines.push(renderMarkdownTableRow(row));
    }
    return lines.join("\n");
  }
  parseTableCell(block) {
    const values = (block.children ?? []).map((id) => this.parseTableChildById(id)).filter((v) => v.length > 0);
    return values.join("<br>");
  }
  parseTableCellById(blockId) {
    const cellBlock = this.blockMap.get(blockId);
    if (!cellBlock) {
      return "";
    }
    if (cellBlock.block_type !== 32) {
      return this.parseTableChildById(blockId);
    }
    return this.parseTableCell(cellBlock);
  }
  parseTableChildById(blockId) {
    const raw = this.parseBlockById(blockId, 0).trim();
    if (!raw) {
      return "";
    }
    return raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("<br>");
  }
  parseAddOnComponent(block) {
    const addOns = block.add_ons;
    if (!addOns?.record) {
      return "";
    }
    const isMermaid = addOns.component_type_id === "blk_631fefbbae02400430b8f9f4";
    if (!isMermaid) {
      return "";
    }
    try {
      const record = JSON.parse(addOns.record);
      const data = (record.data ?? "").trim();
      if (!data) {
        return "";
      }
      return `\`\`\`mermaid
${data}
\`\`\``;
    } catch {
      return "";
    }
  }
  parseChildren(block, indent) {
    const outputs = [];
    let orderedNumber = 1;
    for (const childId of block.children ?? []) {
      const childBlock = this.blockMap.get(childId);
      if (!childBlock) {
        continue;
      }
      const isOrdered = childBlock.block_type === 13 || Boolean(childBlock.ordered);
      const parsed = this.parseBlockById(childId, indent, isOrdered ? orderedNumber : void 0);
      if (parsed.length > 0) {
        outputs.push({ text: parsed, isList: isListBlock(childBlock) });
      }
      if (isOrdered) {
        orderedNumber += 1;
      } else {
        orderedNumber = 1;
      }
    }
    if (outputs.length === 0) {
      return "";
    }
    let result = outputs[0].text;
    for (let i = 1; i < outputs.length; i += 1) {
      const prev = outputs[i - 1];
      const curr = outputs[i];
      const separator = prev.isList && curr.isList ? "\n" : "\n\n";
      result += `${separator}${curr.text}`;
    }
    return result;
  }
  parseRichText(container) {
    const segments = (container.elements ?? []).map((element) => {
      if (element.text_run) {
        return this.parseTextRun(element.text_run);
      }
      if (element.mention_doc) {
        const title = element.mention_doc.title ?? "doc";
        const url = decodeUrl(element.mention_doc.url ?? "");
        return `[${title}](${url})`;
      }
      if (element.equation?.content) {
        return `$${element.equation.content}$`;
      }
      return "";
    }).filter((item) => item.length > 0);
    let output = "";
    for (const segment of segments) {
      if (needsBoundarySpace(output, segment)) {
        output += " ";
      }
      output += segment;
    }
    return output.trim();
  }
  parseTextRun(textRun) {
    const style = textRun.text_element_style ?? {};
    const content = textRun.content ?? "";
    if (!content) {
      return "";
    }
    let out = content;
    if (style.link?.url) {
      out = `[${out}](${decodeUrl(style.link.url)})`;
    }
    if (style.inline_code) {
      out = `\`${out}\``;
    }
    if (style.bold) {
      out = `**${out}**`;
    }
    if (style.italic) {
      out = `_${out}_`;
    }
    if (style.strikethrough) {
      out = `~~${out}~~`;
    }
    if (style.underline) {
      out = `<u>${out}</u>`;
    }
    return out;
  }
};
function compact(items) {
  return items.map((item) => item.trimEnd()).filter((item) => item.length > 0);
}
function toPositiveInt(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}
function sanitizeMarkdownTableCell(value) {
  const clean = value.replace(/\r/g, "").replace(/\n+/g, "<br>").replace(/\|/g, "\\|").trim();
  return clean.length > 0 ? clean : " ";
}
function renderMarkdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}
function decodeUrl(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function emptyContainer() {
  return { elements: [] };
}
function needsBoundarySpace(previous, next) {
  if (!previous || !next) {
    return false;
  }
  const prevNeedsSpace = /(\*\*|~~|`|<\/u>|\]?\))$/.test(previous);
  if (!prevNeedsSpace) {
    return false;
  }
  if (/^[\s,.;:!?)}\]，。；：！？、]/.test(next)) {
    return false;
  }
  return true;
}
function resolveDoneState(container) {
  const style = container.style ?? {};
  return Boolean(
    style.done ?? style.is_done ?? style.completed ?? style.checked ?? style.is_checked ?? false
  );
}
function isListBlock(block) {
  if (block.bullet || block.ordered || block.todo || block.task) {
    return true;
  }
  return block.block_type === 12 || block.block_type === 13 || block.block_type === 17 || block.block_type === 35;
}
var CODE_LANGUAGE_MAP = {
  1: "",
  2: "abap",
  3: "ada",
  4: "apache",
  5: "apex",
  6: "asm",
  7: "bash",
  8: "csharp",
  9: "cpp",
  10: "c",
  11: "cobol",
  12: "css",
  13: "coffeescript",
  14: "d",
  15: "dart",
  16: "delphi",
  17: "django",
  18: "dockerfile",
  19: "erlang",
  20: "fortran",
  21: "foxpro",
  22: "go",
  23: "groovy",
  24: "html",
  25: "htmlbars",
  26: "http",
  27: "haskell",
  28: "json",
  29: "java",
  30: "javascript",
  31: "julia",
  32: "kotlin",
  33: "latex",
  34: "lisp",
  35: "logo",
  36: "lua",
  37: "matlab",
  38: "makefile",
  39: "markdown",
  40: "nginx",
  41: "objectivec",
  42: "openedge-abl",
  43: "php",
  44: "perl",
  45: "postscript",
  46: "powershell",
  47: "prolog",
  48: "protobuf",
  49: "python",
  50: "r",
  51: "rpg",
  52: "ruby",
  53: "rust",
  54: "sas",
  55: "scss",
  56: "sql",
  57: "scala",
  58: "scheme",
  59: "scratch",
  60: "shell",
  61: "swift",
  62: "thrift",
  63: "typescript",
  64: "vbscript",
  65: "vbnet",
  66: "xml",
  67: "yaml",
  68: "cmake",
  69: "diff",
  70: "gherkin",
  71: "graphql",
  72: "glsl",
  73: "properties",
  74: "solidity",
  75: "toml"
};
function resolveCodeLanguage(language) {
  if (typeof language === "number") {
    return CODE_LANGUAGE_MAP[language] ?? String(language);
  }
  if (typeof language === "string") {
    const asNum = Number(language);
    if (!Number.isNaN(asNum) && language.trim() !== "") {
      return CODE_LANGUAGE_MAP[asNum] ?? language;
    }
    return language;
  }
  return "";
}

// src/services/feishuClientUtils.ts
function extractImageRefs(markdown) {
  const regex = /!\[[^\]]*]\(([^)]+)\)/g;
  const refs = [];
  let match = regex.exec(markdown);
  while (match) {
    refs.push(match[1]);
    match = regex.exec(markdown);
  }
  return refs;
}
function buildMultipartBody(fileName, bytes, options) {
  const parentType = options?.parentType ?? "docx_image";
  const parentNode = options?.parentNode ?? "0";
  const boundary = `----FeishuSyncBoundary${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const extra = options?.extra ? JSON.stringify(options.extra) : "";
  const head = `--${boundary}\r
Content-Disposition: form-data; name="file_name"\r
\r
${fileName}\r
--${boundary}\r
Content-Disposition: form-data; name="parent_type"\r
\r
${parentType}\r
--${boundary}\r
Content-Disposition: form-data; name="parent_node"\r
\r
${parentNode}\r
--${boundary}\r
Content-Disposition: form-data; name="size"\r
\r
${bytes.byteLength}\r
` + (extra ? `--${boundary}\r
Content-Disposition: form-data; name="extra"\r
\r
${extra}\r
` : "") + `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${fileName}"\r
Content-Type: application/octet-stream\r
\r
`;
  const tail = `\r
--${boundary}--\r
`;
  const headBytes = encoder.encode(head);
  const tailBytes = encoder.encode(tail);
  const fileBytes = new Uint8Array(bytes);
  const merged = new Uint8Array(headBytes.length + fileBytes.length + tailBytes.length);
  merged.set(headBytes, 0);
  merged.set(fileBytes, headBytes.length);
  merged.set(tailBytes, headBytes.length + fileBytes.length);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: merged.buffer
  };
}
function looksLikeMarkdown(value) {
  if (!value || value.startsWith("PK")) {
    return false;
  }
  const hints = [/^#\s/m, /^\s*[-*]\s/m, /^\s*\d+\.\s/m, /\[[^\]]+]\([^)]+\)/];
  if (hints.some((rule) => rule.test(value))) {
    return true;
  }
  return value.includes("\n\n") && value.length > 40;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sanitizeHeaders(headers, maskSensitive = true) {
  if (!headers) {
    return void 0;
  }
  const out = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = maskSensitive && key.toLowerCase() === "authorization" ? "***" : value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = maskSensitive && key.toLowerCase() === "authorization" ? "***" : value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key] = maskSensitive && key.toLowerCase() === "authorization" ? "***" : String(value);
  }
  return out;
}
function sanitizeBody(body, maskSensitive = true) {
  if (!body) {
    return void 0;
  }
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (maskSensitive && typeof parsed.app_secret === "string") {
        parsed.app_secret = "***";
      }
      if (maskSensitive && typeof parsed.access_token === "string") {
        parsed.access_token = "***";
      }
      if (maskSensitive && typeof parsed.refresh_token === "string") {
        parsed.refresh_token = "***";
      }
      return parsed;
    } catch {
      return body;
    }
  }
  if (body instanceof ArrayBuffer) {
    return `ArrayBuffer(${body.byteLength})`;
  }
  if (ArrayBuffer.isView(body)) {
    return `ArrayBufferView(${body.byteLength})`;
  }
  return String(body);
}
function extractMediaToken(value) {
  if (!value) {
    return null;
  }
  if (/^[a-zA-Z0-9]{20,}$/.test(value)) {
    return value;
  }
  const m1 = value.match(/\/medias\/([^/]+)\/download/i);
  if (m1?.[1]) {
    return m1[1];
  }
  const m2 = value.match(/[?&]file_token=([^&#]+)/i);
  if (m2?.[1]) {
    return decodeURIComponent(m2[1]);
  }
  return null;
}
function buildDocxUrl(docToken) {
  return `https://feishu.cn/docx/${encodeURIComponent(docToken)}`;
}
function inferFileExtension(headers) {
  const contentType = (headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("png"))
    return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg"))
    return ".jpg";
  if (contentType.includes("gif"))
    return ".gif";
  if (contentType.includes("webp"))
    return ".webp";
  if (contentType.includes("svg"))
    return ".svg";
  return ".bin";
}
function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
function uniqueFolderSummaries(items) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const item of items) {
    if (seen.has(item.token)) {
      continue;
    }
    seen.add(item.token);
    output.push(item);
  }
  return output;
}
function encodeWikiSpaceToken(spaceId) {
  return `wiki_space:${spaceId}`;
}
function encodeWikiNodeToken(spaceId, nodeToken) {
  return `wiki_node:${spaceId}:${nodeToken}`;
}
function parseWikiTargetToken(token) {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{10,}$/.test(trimmed)) {
    return { spaceId: trimmed };
  }
  if (trimmed.startsWith("wiki_space:")) {
    const spaceId = trimmed.slice("wiki_space:".length);
    return spaceId ? { spaceId } : null;
  }
  if (trimmed.startsWith("wiki_node:")) {
    const rest = trimmed.slice("wiki_node:".length);
    const idx = rest.indexOf(":");
    if (idx <= 0) {
      return null;
    }
    const spaceId = rest.slice(0, idx);
    const nodeToken = rest.slice(idx + 1);
    if (!spaceId || !nodeToken) {
      return null;
    }
    return { spaceId, nodeToken };
  }
  if (trimmed.startsWith("space:")) {
    const spaceId = trimmed.slice("space:".length);
    return spaceId ? { spaceId } : null;
  }
  return null;
}
function isWikiDocumentType(value) {
  const type = (value ?? "").toLowerCase();
  return type === "doc" || type === "docx";
}
function uniqueDocsByToken(items) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (seen.has(item.docToken)) {
      continue;
    }
    seen.add(item.docToken);
    out.push(item);
  }
  return out;
}
function parseMarkdownToBlockGraph(markdown, options = {}) {
  const mermaidUploadMode = options.mermaidUploadMode ?? "text";
  const lines = markdown.split(/\r?\n/);
  const blockMap = /* @__PURE__ */ new Map();
  const childIdMap = /* @__PURE__ */ new Map();
  const firstLevelBlockIds = [];
  const tableRowsByBlockId = /* @__PURE__ */ new Map();
  const tableStylesByBlockId = /* @__PURE__ */ new Map();
  const tableColumnAlignByBlockId = /* @__PURE__ */ new Map();
  const imageRefByBlockId = /* @__PURE__ */ new Map();
  const fileRefByBlockId = /* @__PURE__ */ new Map();
  const listParents = [];
  const orderedSequences = [];
  let idSeq = 0;
  let i = 0;
  const addChild = (parentId, childId) => {
    if (!parentId) {
      firstLevelBlockIds.push(childId);
      return;
    }
    const existing = childIdMap.get(parentId) ?? [];
    existing.push(childId);
    childIdMap.set(parentId, existing);
  };
  const addBlock = (payload, parentId) => {
    idSeq += 1;
    const blockId = `local_${idSeq}`;
    blockMap.set(blockId, { ...payload, block_id: blockId, parent_id: parentId ?? "" });
    addChild(parentId, blockId);
    return blockId;
  };
  const flushParagraph = (buffer) => {
    const text = buffer.join("\n").trim();
    if (!text) {
      return;
    }
    addBlock({
      block_type: 2,
      text: {
        elements: parseInlineElements(text),
        style: { align: 1, folded: false }
      }
    });
  };
  const paragraphBuffer = [];
  const resetListParents = (level = 0) => {
    listParents.splice(level);
    orderedSequences.splice(level);
  };
  const getListLevel = (indentRaw) => {
    const indentLength = indentRaw.replace(/\t/g, "    ").length;
    if (indentLength < 3) {
      return 0;
    }
    return Math.ceil(indentLength / 4);
  };
  const parseListLineMeta = (lineValue) => {
    const todo = lineValue.match(/^(\s*)-\s+\[( |x|X)\]\s+(.*)$/);
    if (todo) {
      return { kind: "todo", level: getListLevel(todo[1]) };
    }
    const ordered = lineValue.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered) {
      return { kind: "ordered", level: getListLevel(ordered[1]) };
    }
    const bullet = lineValue.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      return { kind: "bullet", level: getListLevel(bullet[1]) };
    }
    return null;
  };
  const shouldPreserveOrderedContextOnSingleBlankLine = (lineIndex) => {
    const nextLine = lines[lineIndex + 1] ?? "";
    if (!nextLine.trim()) {
      return false;
    }
    const nextMeta = parseListLineMeta(nextLine);
    if (!nextMeta) {
      return false;
    }
    if (nextMeta.kind !== "ordered" || nextMeta.level !== 0) {
      return false;
    }
    const activeTopLevelParent = listParents[0];
    const activeTopLevelSequence = orderedSequences[0] ?? 0;
    if (!activeTopLevelParent || activeTopLevelSequence <= 0) {
      return false;
    }
    const topLevelBlock = blockMap.get(activeTopLevelParent);
    return Number(topLevelBlock?.block_type ?? 0) === 13;
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph(paragraphBuffer.splice(0));
      if (!shouldPreserveOrderedContextOnSingleBlankLine(i)) {
        resetListParents();
      }
      i += 1;
      continue;
    }
    const codeFence = trimmed.match(/^(```|~~~)\s*([A-Za-z0-9_+#.-]*)\s*$/);
    if (codeFence) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      const marker = codeFence[1];
      const lang = codeFence[2] ?? "";
      const contentLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        contentLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      const code = contentLines.join("\n");
      const isMermaid = lang.trim().toLowerCase() === "mermaid";
      const shouldText = !isMermaid || mermaidUploadMode === "text" || mermaidUploadMode === "both";
      const shouldImage = isMermaid && (mermaidUploadMode === "image" || mermaidUploadMode === "both");
      if (shouldText) {
        if (isMermaid) {
          addBlock({
            block_type: 40,
            add_ons: {
              component_type_id: "blk_631fefbbae02400430b8f9f4",
              record: JSON.stringify({ data: code })
            }
          });
        } else {
          addBlock({
            block_type: 14,
            code: {
              elements: [{ text_run: { content: code, text_element_style: {} } }],
              style: { language: resolveCodeLanguageId(lang), wrap: true }
            }
          });
        }
      }
      if (shouldImage) {
        const imageBlockId = addBlock({
          block_type: 27,
          image: {}
        });
        imageRefByBlockId.set(imageBlockId, encodeMermaidImageRef(code));
      }
      continue;
    }
    const heading = line.match(/^(#{1,9})\s+(.*)$/);
    if (heading) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      const level = Math.min(heading[1].length, 9);
      const key = `heading${level}`;
      addBlock({
        block_type: level + 2,
        [key]: {
          elements: parseInlineElements(heading[2].trim()),
          style: { align: 1, folded: false }
        }
      });
      i += 1;
      continue;
    }
    if (/^(\*\s*\*\s*\*|-{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      addBlock({ block_type: 22, divider: {} });
      i += 1;
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      addBlock({
        block_type: 15,
        quote: {
          elements: parseInlineElements(quote[1]),
          style: { align: 1, folded: false }
        }
      });
      i += 1;
      continue;
    }
    const todo = line.match(/^(\s*)-\s+\[( |x|X)\]\s+(.*)$/);
    if (todo) {
      flushParagraph(paragraphBuffer.splice(0));
      const level = getListLevel(todo[1]);
      const parent = level > 0 ? listParents[level - 1] : void 0;
      const id = addBlock(
        {
          block_type: 17,
          todo: {
            elements: parseInlineElements(todo[3]),
            style: { align: 1, folded: false, done: /x/i.test(todo[2]) }
          }
        },
        parent
      );
      listParents[level] = id;
      orderedSequences[level] = 0;
      resetListParents(level + 1);
      i += 1;
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered) {
      flushParagraph(paragraphBuffer.splice(0));
      const level = getListLevel(ordered[1]);
      const parent = level > 0 ? listParents[level - 1] : void 0;
      const sequence = (orderedSequences[level] ?? 0) + 1;
      const id = addBlock(
        {
          block_type: 13,
          ordered: {
            elements: parseInlineElements(ordered[3]),
            style: { align: 1, folded: false, sequence: String(sequence) }
          }
        },
        parent
      );
      listParents[level] = id;
      orderedSequences[level] = sequence;
      resetListParents(level + 1);
      i += 1;
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph(paragraphBuffer.splice(0));
      const level = getListLevel(bullet[1]);
      const parent = level > 0 ? listParents[level - 1] : void 0;
      const id = addBlock(
        {
          block_type: 12,
          bullet: {
            elements: parseInlineElements(bullet[2]),
            style: { align: 1, folded: false }
          }
        },
        parent
      );
      listParents[level] = id;
      orderedSequences[level] = 0;
      resetListParents(level + 1);
      i += 1;
      continue;
    }
    const table = parseMarkdownTable(lines, i);
    if (table) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      const parsedRows = table.rows.map((row) => row.map((cell) => parseTableCellMarkdown(cell)));
      const rows = parsedRows.map((row) => row.map((cell) => cell.text));
      const styles = parsedRows.map((row) => row.map((cell) => hasAnyCellStyle(cell.style) ? cell.style : null));
      const rowSize = Math.min(9, Math.max(1, rows.length));
      const columnSize = Math.min(9, Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0)));
      const tableBlockId = addBlock({
        block_type: 30,
        sheet: {
          row_size: rowSize,
          column_size: columnSize
        }
      });
      tableRowsByBlockId.set(tableBlockId, rows);
      tableStylesByBlockId.set(tableBlockId, styles);
      tableColumnAlignByBlockId.set(tableBlockId, table.aligns);
      i = table.nextIndex;
      continue;
    }
    const inlineSegments = splitMarkdownByAssetRefs(line);
    if (inlineSegments.some((segment) => segment.kind !== "text")) {
      flushParagraph(paragraphBuffer.splice(0));
      resetListParents();
      for (const segment of inlineSegments) {
        if (segment.kind === "text") {
          const text = segment.value;
          if (!text.trim()) {
            continue;
          }
          addBlock({
            block_type: 2,
            text: {
              elements: parseInlineElements(text),
              style: { align: 1, folded: false }
            }
          });
          continue;
        }
        if (segment.kind === "image") {
          const imageBlockId = addBlock({
            block_type: 27,
            image: {}
          });
          imageRefByBlockId.set(imageBlockId, segment.value);
          continue;
        }
        const fileBlockId = addBlock({
          block_type: 23,
          file: {
            token: ""
          }
        });
        fileRefByBlockId.set(fileBlockId, segment.value);
      }
      i += 1;
      continue;
    }
    resetListParents();
    paragraphBuffer.push(line);
    i += 1;
  }
  flushParagraph(paragraphBuffer.splice(0));
  return {
    kind: "blocks",
    blockMap,
    childIdMap,
    firstLevelBlockIds,
    tableRowsByBlockId,
    tableStylesByBlockId,
    tableColumnAlignByBlockId,
    imageRefByBlockId,
    fileRefByBlockId
  };
}
function hasAnyCellStyle(style) {
  return style.bold || style.italic || style.strikeThrough || style.underline;
}
function parseTableCellMarkdown(cell) {
  let output = cell.trim();
  const style = {
    bold: false,
    italic: false,
    strikeThrough: false,
    underline: false
  };
  if (/<u>[\s\S]*?<\/u>/i.test(output)) {
    style.underline = true;
    output = output.replace(/<u>([\s\S]*?)<\/u>/gi, "$1");
  }
  if (/~~[\s\S]+?~~/.test(output)) {
    style.strikeThrough = true;
    output = output.replace(/~~([\s\S]+?)~~/g, "$1");
  }
  if (/\*\*[\s\S]+?\*\*/.test(output) || /__[\s\S]+?__/.test(output)) {
    style.bold = true;
    output = output.replace(/\*\*([\s\S]+?)\*\*/g, "$1").replace(/__([\s\S]+?)__/g, "$1");
  }
  if (/(^|[^*])\*([^*]+)\*(?!\*)/.test(output)) {
    style.italic = true;
    output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1$2");
  }
  return { text: output.trim(), style };
}
function encodeMermaidImageRef(source) {
  return `mermaid://${encodeURIComponent(source)}`;
}
function decodeMermaidImageRef(ref) {
  const prefix = "mermaid://";
  if (!ref.startsWith(prefix)) {
    return null;
  }
  try {
    return decodeURIComponent(ref.slice(prefix.length));
  } catch {
    return ref.slice(prefix.length);
  }
}
function parseInlineElements(input) {
  const out = [];
  const regex = /(\[[^\]]+\]\([^)]+\)|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*)/g;
  let cursor = 0;
  let m = regex.exec(input);
  const pushPlain = (text) => {
    if (!text)
      return;
    out.push({
      text_run: {
        content: text,
        text_element_style: { bold: false, italic: false, strikethrough: false, underline: false, inline_code: false }
      }
    });
  };
  while (m) {
    const token = m[0];
    const idx = m.index;
    if (idx > cursor) {
      pushPlain(input.slice(cursor, idx));
    }
    const style = {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      inline_code: false
    };
    let content = token;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      content = link[1];
      const linkTarget = link[2].trim();
      if (/^(https?|ftp):\/\/.+/i.test(linkTarget)) {
        style.link = { url: encodeURIComponent(linkTarget) };
      }
    } else if (token.startsWith("***") && token.endsWith("***")) {
      content = token.slice(3, -3);
      style.bold = true;
      style.italic = true;
    } else if (token.startsWith("**") && token.endsWith("**")) {
      content = token.slice(2, -2);
      style.bold = true;
    } else if (token.startsWith("*") && token.endsWith("*")) {
      content = token.slice(1, -1);
      style.italic = true;
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      content = token.slice(2, -2);
      style.strikethrough = true;
    } else if (token.startsWith("`") && token.endsWith("`")) {
      content = token.slice(1, -1);
      style.inline_code = true;
    }
    out.push({ text_run: { content, text_element_style: style } });
    cursor = idx + token.length;
    m = regex.exec(input);
  }
  if (cursor < input.length) {
    pushPlain(input.slice(cursor));
  }
  return out.length > 0 ? out : [{ text_run: { content: input, text_element_style: {} } }];
}
function resolveCodeLanguageId(language) {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return 1;
  }
  const map = {
    plaintext: 1,
    text: 1,
    bash: 7,
    sh: 60,
    shell: 60,
    csharp: 8,
    cs: 8,
    cpp: 9,
    c: 10,
    css: 12,
    go: 22,
    html: 24,
    http: 26,
    json: 28,
    java: 29,
    javascript: 30,
    js: 30,
    kotlin: 32,
    latex: 33,
    lua: 36,
    markdown: 39,
    nginx: 40,
    php: 43,
    perl: 44,
    python: 49,
    py: 49,
    ruby: 52,
    rust: 53,
    sql: 56,
    scala: 57,
    swift: 61,
    typescript: 63,
    ts: 63,
    xml: 66,
    yaml: 67,
    yml: 67,
    diff: 69,
    graphql: 71,
    toml: 75,
    mermaid: 39
  };
  return map[normalized] ?? 1;
}
function parseMarkdownTable(lines, start) {
  const headerLine = lines[start] ?? "";
  const separatorLine = lines[start + 1] ?? "";
  if (!isLikelyTableLine(headerLine) || !isTableSeparatorLine(separatorLine)) {
    return null;
  }
  const rows = [];
  rows.push(splitMarkdownTableLine(headerLine));
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!isLikelyTableLine(line)) {
      break;
    }
    const cells = splitMarkdownTableLine(line);
    if (cells.length === 0) {
      break;
    }
    rows.push(cells);
    i += 1;
  }
  if (rows.length < 1) {
    return null;
  }
  const width = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    if (r.length >= width) {
      return r;
    }
    return [...r, ...Array.from({ length: width - r.length }, () => "")];
  });
  const aligns = parseMarkdownTableAligns(separatorLine, width);
  return { rows: normalized, aligns, nextIndex: i };
}
function parseMarkdownTableAligns(separatorLine, width) {
  const tokens = splitMarkdownTableLine(separatorLine).map((token) => token.trim());
  const aligns = [];
  for (let i = 0; i < width; i += 1) {
    const token = tokens[i] ?? "";
    const left = token.startsWith(":");
    const right = token.endsWith(":");
    if (left && right) {
      aligns.push(1);
    } else if (right) {
      aligns.push(2);
    } else {
      aligns.push(0);
    }
  }
  return aligns;
}
function splitMarkdownByAssetRefs(line) {
  const out = [];
  const regex = /!\[\[[^\]]+\]\]|!\[[^\]]*]\([^)]+\)|\[\[[^\]]+]\]|\[[^\]]+]\([^)]+\)/g;
  let cursor = 0;
  let m = regex.exec(line);
  while (m) {
    const token = m[0];
    const index = m.index;
    if (index > cursor) {
      out.push({ kind: "text", value: line.slice(cursor, index) });
    }
    const parsed = parseAssetToken(token);
    if (parsed) {
      out.push(parsed);
    } else {
      out.push({ kind: "text", value: token });
    }
    cursor = index + token.length;
    m = regex.exec(line);
  }
  if (cursor < line.length) {
    out.push({ kind: "text", value: line.slice(cursor) });
  }
  if (out.length === 0) {
    out.push({ kind: "text", value: line });
  }
  return out;
}
function parseAssetToken(token) {
  const wikiEmbed = token.match(/^!\[\[([^\]]+)]]$/);
  if (wikiEmbed?.[1]) {
    const core = wikiEmbed[1].split("|")[0]?.trim() ?? "";
    if (!core)
      return null;
    return isLikelyImageRef(core) ? { kind: "image", value: core } : { kind: "file", value: core };
  }
  const mdEmbed = token.match(/^!\[[^\]]*]\(([^)]+)\)$/);
  if (mdEmbed?.[1]) {
    const core = mdEmbed[1].trim().replace(/^<|>$/g, "");
    if (!core || !isLikelyLocalAssetRef(core))
      return null;
    return isLikelyImageRef(core) ? { kind: "image", value: core } : { kind: "file", value: core };
  }
  const wikiLink = token.match(/^\[\[([^\]]+)]]$/);
  if (wikiLink?.[1]) {
    const core = wikiLink[1].split("|")[0]?.trim() ?? "";
    if (!core || !isLikelyLocalAssetRef(core) || isLikelyMarkdownRef(core)) {
      return null;
    }
    return { kind: "file", value: core };
  }
  const mdLink = token.match(/^\[[^\]]+]\(([^)]+)\)$/);
  if (mdLink?.[1]) {
    const core = mdLink[1].trim().replace(/^<|>$/g, "");
    if (!core || !isLikelyLocalAssetRef(core) || isLikelyMarkdownRef(core)) {
      return null;
    }
    return { kind: "file", value: core };
  }
  return null;
}
function isLikelyLocalAssetRef(value) {
  if (!value) {
    return false;
  }
  const normalized = value.trim();
  return !/^https?:\/\//i.test(normalized) && !/^mailto:/i.test(normalized) && !/^data:/i.test(normalized) && !normalized.startsWith("#");
}
function isLikelyMarkdownRef(value) {
  const core = value.split(/[?#]/)[0] ?? value;
  return /\.md$/i.test(core.trim());
}
function isLikelyImageRef(value) {
  const core = value.split(/[?#]/)[0] ?? value;
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif|avif)$/i.test(core.trim());
}
function isLikelyTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|")) {
    return false;
  }
  if (/^\s{4,}/.test(line)) {
    return false;
  }
  return true;
}
function isTableSeparatorLine(line) {
  if (!isLikelyTableLine(line)) {
    return false;
  }
  const cells = splitMarkdownTableLine(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}
function splitMarkdownTableLine(line) {
  const trimmed = line.trim();
  const core = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const core2 = core.endsWith("|") ? core.slice(0, -1) : core;
  return core2.split("|").map((cell) => cell.trim());
}
function columnIndexToName(index) {
  let n = Math.max(1, index);
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
function detectImageDimensions(bytes) {
  const view = new DataView(bytes);
  const u8 = new Uint8Array(bytes);
  if (u8.length < 10) {
    return null;
  }
  if (u8.length >= 24 && u8[0] === 137 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71 && u8[4] === 13 && u8[5] === 10 && u8[6] === 26 && u8[7] === 10) {
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  if (u8.length >= 10 && u8[0] === 71 && u8[1] === 73 && u8[2] === 70 && u8[3] === 56) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  if (u8[0] === 255 && u8[1] === 216) {
    let offset = 2;
    while (offset + 9 < u8.length) {
      if (u8[offset] !== 255) {
        offset += 1;
        continue;
      }
      const marker = u8[offset + 1];
      const length = u8[offset + 2] << 8 | u8[offset + 3];
      if (length < 2 || offset + 2 + length > u8.length) {
        break;
      }
      const isSof = marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207;
      if (isSof) {
        const height = u8[offset + 5] << 8 | u8[offset + 6];
        const width = u8[offset + 7] << 8 | u8[offset + 8];
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
      offset += 2 + length;
    }
  }
  if (u8.length >= 30 && u8[0] === 82 && u8[1] === 73 && u8[2] === 70 && u8[3] === 70 && u8[8] === 87 && u8[9] === 69 && u8[10] === 66 && u8[11] === 80) {
    const chunk = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (chunk === "VP8X" && u8.length >= 30) {
      const width = 1 + (u8[24] | u8[25] << 8 | u8[26] << 16);
      const height = 1 + (u8[27] | u8[28] << 8 | u8[29] << 16);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  }
  return null;
}
async function resolveLocalAssetPath(assetContext, assetRef, fallbackName) {
  const normalizedRef = normalizeAssetRef(assetRef);
  const candidates = buildAssetCandidates(assetContext.baseFilePath, normalizedRef);
  for (const candidate of candidates) {
    if (await assetContext.fileExists(candidate)) {
      const fileName = candidate.split("/").pop() ?? fallbackName;
      return { path: candidate, fileName };
    }
  }
  return null;
}
function normalizeAssetRef(value) {
  const base = value.split("#")[0]?.trim() ?? value.trim();
  return base.replace(/^<|>$/g, "");
}
function buildAssetCandidates(baseFilePath, ref) {
  const normalizedBase = normalizeFsPath(baseFilePath);
  const baseDir = normalizedBase.split("/").slice(0, -1).join("/");
  const out = /* @__PURE__ */ new Set();
  if (ref.startsWith("/")) {
    out.add(normalizeFsPath(ref.slice(1)));
  } else {
    out.add(normalizeFsPath(ref));
    out.add(normalizeFsPath(`${baseDir}/${ref}`));
  }
  return Array.from(out).filter((item) => !!item);
}
function normalizeFsPath(value) {
  const raw = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const isAbs = raw.startsWith("/");
  const parts = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".")
      continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!isAbs) {
        parts.push("..");
      }
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  return isAbs ? `/${joined}` : joined;
}
function coerceSheetCellValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }
  return value;
}
function toCreatableBlock(block, parentBlock) {
  if (!block) {
    return null;
  }
  const normalized = normalizeMisclassifiedListCodeBlock(block, parentBlock);
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (key === "block_id" || key === "parent_id" || key === "children") {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
function normalizeMisclassifiedListCodeBlock(block, parentBlock) {
  const blockType = Number(block.block_type ?? 0);
  if (blockType !== 14) {
    return block;
  }
  const parentType = Number(parentBlock?.block_type ?? 0);
  if (![12, 13, 17, 35].includes(parentType)) {
    return block;
  }
  const code = block.code ?? {};
  const firstText = extractFirstTextRun(code.elements);
  if (!firstText) {
    return block;
  }
  const orderedMatch = firstText.match(/^\s*(\d+)\.\s+(.+)$/);
  if (orderedMatch) {
    return {
      ...block,
      block_type: 13,
      ordered: {
        elements: [{ text_run: { content: orderedMatch[2], text_element_style: {} } }],
        style: { align: 1, folded: false, sequence: normalizeOrderedSequence(orderedMatch[1]) }
      }
    };
  }
  const bulletMatch = firstText.match(/^\s*[-*+]\s+(.+)$/);
  if (bulletMatch) {
    return {
      ...block,
      block_type: 12,
      bullet: {
        elements: [{ text_run: { content: bulletMatch[1], text_element_style: {} } }],
        style: { align: 1, folded: false }
      }
    };
  }
  return block;
}
function extractFirstTextRun(elements) {
  if (!Array.isArray(elements)) {
    return "";
  }
  for (const item of elements) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const run = item.text_run;
    if (run && typeof run.content === "string" && run.content.trim()) {
      return run.content;
    }
  }
  return "";
}
function normalizeOrderedSequence(value) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) {
    return String(num);
  }
  return "1";
}
function normalizeMarkdownForFeishuConvert(markdown) {
  if (!markdown.includes("\n")) {
    return markdown;
  }
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.trimStart();
    if (fence.startsWith("```") || fence.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const tabExpanded = line.replace(/^([ \t]+)/, (m2) => m2.replace(/\t/g, "    "));
    const m = tabExpanded.match(/^(\s+)([-*+]|\d+\.)\s+/);
    if (!m) {
      out.push(tabExpanded);
      continue;
    }
    out.push(tabExpanded);
  }
  return out.join("\n");
}
function extractSheetPlaceholders(markdown) {
  const regex = /\{\{sheet:([^}]+)\}\}/g;
  const tokens = [];
  let match = regex.exec(markdown);
  while (match) {
    tokens.push(match[1]);
    match = regex.exec(markdown);
  }
  return Array.from(new Set(tokens));
}
function extractBitablePlaceholders(markdown) {
  const regex = /\{\{bitable:([^}]+)\}\}/g;
  const tokens = [];
  let match = regex.exec(markdown);
  while (match) {
    tokens.push(match[1]);
    match = regex.exec(markdown);
  }
  return Array.from(new Set(tokens));
}
function extractFilePlaceholders(markdown) {
  const regex = /\{\{file:[^}]+\}\}/g;
  const refs = [];
  let match = regex.exec(markdown);
  while (match) {
    refs.push(match[0]);
    match = regex.exec(markdown);
  }
  return Array.from(new Set(refs));
}
function toMarkdownTable(values) {
  const normalized = normalizeSheetValues(values);
  if (normalized.length === 0) {
    return "";
  }
  const header = normalized[0].map((cell) => escapeMdCell(cell));
  const separator = header.map(() => "---");
  const body = normalized.slice(1).map((row) => row.map((cell) => escapeMdCell(cell)));
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ];
  return lines.join("\n");
}
function escapeMdCell(value) {
  const text = String(value ?? "");
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
function recordsToMarkdownTable(records) {
  const headers = [];
  for (const row of records) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    }
  }
  if (headers.length === 0) {
    return "";
  }
  const values = [headers];
  for (const row of records) {
    values.push(headers.map((key) => stringifyFieldValue(row[key])));
  }
  return toMarkdownTable(values);
}
function parseFilePlaceholder(placeholder) {
  const match = placeholder.match(/^\{\{file:([^:}]+):([^}]*)\}\}$/);
  if (!match) {
    return null;
  }
  return {
    token: match[1],
    name: decodeURIComponentSafe(match[2])
  };
}
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "attachment.bin";
}
function uniqueJoinPath(baseDir, fileName, used) {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let i = 0; i < 1e3; i += 1) {
    const candidateName = i === 0 ? fileName : `${stem}-${String(i).padStart(2, "0")}${ext}`;
    const full = `${baseDir}/${candidateName}`;
    if (!used.has(full)) {
      used.add(full);
      return full;
    }
  }
  return `${baseDir}/${Date.now()}-${fileName}`;
}
function stringifyFieldValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyFieldValue(item)).filter((v) => v.length > 0).join(", ");
  }
  if (typeof value === "object") {
    const obj = value;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.name === "string") {
      return obj.name;
    }
    return JSON.stringify(obj);
  }
  return String(value);
}
function normalizeSheetValues(values) {
  if (values.length === 0) {
    return [];
  }
  const maxCols = values.reduce((max, row) => Math.max(max, row.length), 0);
  const matrix = values.map(
    (row) => Array.from({ length: maxCols }, (_, idx) => String(row[idx] ?? "").trim())
  );
  const nonEmptyRows = matrix.filter((row) => row.some((cell) => cell.length > 0));
  if (nonEmptyRows.length === 0) {
    return [];
  }
  const keepCols = [];
  for (let col = 0; col < maxCols; col += 1) {
    if (nonEmptyRows.some((row) => row[col].length > 0)) {
      keepCols.push(col);
    }
  }
  if (keepCols.length === 0) {
    return [];
  }
  return nonEmptyRows.map((row) => keepCols.map((col) => row[col]));
}

// src/services/feishuDocDownload.ts
var FeishuDocDownloadService = class {
  constructor(deps) {
    this.deps = deps;
    this.sheetExportFileTokenBySpreadsheet = /* @__PURE__ */ new Map();
  }
  async fetchDocument(account, docToken, options = {}) {
    const token = await this.deps.getAccessToken(account);
    const docMeta = await this.deps.request(
      `/docx/v1/documents/${encodeURIComponent(docToken)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const title = docMeta.data?.document?.title ?? "Untitled";
    const fromBlocks = await this.tryParseBlocksMarkdown(account, docToken, title);
    const fromExport = fromBlocks ?? await this.tryExportMarkdown(account, docToken);
    const raw = await this.deps.request(
      `/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const markdown = fromExport ?? (raw.data?.content ?? "");
    const withSheet = options.sheetAsExcel ? await this.resolveSheetPlaceholdersAsExcelFile(account, markdown) : await this.resolveSheetPlaceholders(account, markdown);
    const withBitable = await this.resolveBitablePlaceholders(account, withSheet);
    return {
      docToken,
      title,
      markdown: withBitable,
      imageUrls: extractImageRefs(withBitable),
      fileRefs: extractFilePlaceholders(withBitable),
      updatedAt: Number(raw.data?.updated_at ?? "0")
    };
  }
  async tryParseBlocksMarkdown(account, docToken, title) {
    const token = await this.deps.getAccessToken(account);
    const blocks = [];
    let pageToken = "";
    for (let i = 0; i < 20; i += 1) {
      const query = pageToken ? `?page_size=500&page_token=${encodeURIComponent(pageToken)}` : "?page_size=500";
      try {
        const response = await this.deps.request(
          `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks${query}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          }
        );
        blocks.push(...response.data?.items ?? []);
        if (!response.data?.has_more) {
          break;
        }
        pageToken = response.data.page_token ?? "";
        if (!pageToken) {
          break;
        }
      } catch {
        return null;
      }
    }
    if (blocks.length === 0) {
      return null;
    }
    const markdown = parseDocxBlocksToMarkdown({ document_id: docToken, title }, blocks);
    return markdown.trim().length > 0 ? markdown : null;
  }
  async tryExportMarkdown(account, docToken) {
    const token = await this.deps.getAccessToken(account);
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const payloadCandidates = [
      { token: docToken, type: "docx", file_extension: "md" },
      { file_token: docToken, type: "docx", file_extension: "md" }
    ];
    for (const payload of payloadCandidates) {
      try {
        const created = await this.deps.request(
          "/drive/v1/export_tasks",
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(payload)
          }
        );
        const ticket = created.data?.ticket ?? created.data?.task_id ?? created.data?.job_id ?? "";
        if (!ticket) {
          continue;
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(300 + attempt * 200);
          const status = await this.deps.request(buildExportTaskStatusPath(ticket, docToken), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          });
          const state = (status.data?.status ?? status.data?.result?.status ?? "").toLowerCase();
          const fileToken = status.data?.result?.file_token ?? status.data?.file_token;
          if (state.includes("fail")) {
            break;
          }
          if (fileToken || state.includes("success") || state.includes("finish")) {
            const paths = [
              `/drive/v1/export_tasks/${encodeURIComponent(ticket)}/download`,
              fileToken ? `/drive/v1/files/${encodeURIComponent(fileToken)}/download` : ""
            ].filter((item) => item.length > 0);
            for (const path of paths) {
              try {
                const text = await this.deps.requestText(path, {
                  method: "GET",
                  headers: { Authorization: `Bearer ${token}` }
                });
                if (looksLikeMarkdown(text)) {
                  return text;
                }
              } catch {
                continue;
              }
            }
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }
  async resolveSheetPlaceholders(account, markdown) {
    const tokens = extractSheetPlaceholders(markdown);
    if (tokens.length === 0) {
      return markdown;
    }
    let output = markdown;
    for (const token of tokens) {
      const tableMd = await this.fetchSheetAsMarkdown(account, token);
      output = output.split(`{{sheet:${token}}}`).join(tableMd);
    }
    return output;
  }
  async resolveSheetPlaceholdersAsExcelFile(account, markdown) {
    const tokens = extractSheetPlaceholders(markdown);
    if (tokens.length === 0) {
      return markdown;
    }
    let output = markdown;
    for (const token of tokens) {
      const placeholder = await this.fetchSheetAsExcelFilePlaceholder(account, token);
      output = output.split(`{{sheet:${token}}}`).join(placeholder);
    }
    return output;
  }
  async resolveBitablePlaceholders(account, markdown) {
    const tokens = extractBitablePlaceholders(markdown);
    if (tokens.length === 0) {
      return markdown;
    }
    let output = markdown;
    for (const token of tokens) {
      const tableMd = await this.fetchBitableAsMarkdown(account, token);
      output = output.split(`{{bitable:${token}}}`).join(tableMd);
    }
    return output;
  }
  async fetchSheetAsMarkdown(account, combinedToken) {
    const parsed = splitSheetCombinedToken(combinedToken);
    if (!parsed) {
      return `> [Sheet] ${combinedToken}`;
    }
    const spreadsheetToken = parsed.spreadsheetToken;
    const sheetId = parsed.sheetId;
    const auth = { Authorization: `Bearer ${await this.deps.getAccessToken(account)}` };
    const rangeCandidates = [`${sheetId}!A1:ZZ500`, `${sheetId}!A1:Z500`, `${sheetId}!A1:Z100`];
    let lastError;
    for (const range of rangeCandidates) {
      try {
        const response = await this.deps.request(
          `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
          {
            method: "GET",
            headers: auth
          }
        );
        const values = response.data?.valueRange?.values ?? response.data?.values ?? [];
        return toMarkdownTable(values ?? []);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      return `> [Sheet] ${combinedToken}`;
    }
    return `> [Sheet] ${combinedToken}`;
  }
  async fetchSheetAsExcelFilePlaceholder(account, combinedToken) {
    const parsed = splitSheetCombinedToken(combinedToken);
    if (!parsed) {
      return await this.fetchSheetAsMarkdown(account, combinedToken);
    }
    const { spreadsheetToken, sheetId } = parsed;
    try {
      const fileToken = await this.exportSpreadsheetAsXlsx(account, spreadsheetToken);
      if (!fileToken) {
        return await this.fetchSheetAsMarkdown(account, combinedToken);
      }
      const fileName = encodeURIComponent(`sheet-${sheetId}.xlsx`);
      return `{{file:${fileToken}:${fileName}}}`;
    } catch {
      return await this.fetchSheetAsMarkdown(account, combinedToken);
    }
  }
  async exportSpreadsheetAsXlsx(account, spreadsheetToken) {
    const cached = this.sheetExportFileTokenBySpreadsheet.get(spreadsheetToken);
    if (cached) {
      return cached;
    }
    const bearerToken = await this.deps.getAccessToken(account);
    const authHeaders = {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json"
    };
    const payloadCandidates = [
      { token: spreadsheetToken, type: "sheet", file_extension: "xlsx" },
      { file_token: spreadsheetToken, type: "sheet", file_extension: "xlsx" }
    ];
    for (const payload of payloadCandidates) {
      try {
        const created = await this.deps.request(
          "/drive/v1/export_tasks",
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(payload)
          }
        );
        const ticket = created.data?.ticket ?? created.data?.task_id ?? created.data?.job_id ?? "";
        if (!ticket) {
          continue;
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(300 + attempt * 200);
          const status = await this.deps.request(buildExportTaskStatusPath(ticket, spreadsheetToken), {
            method: "GET",
            headers: { Authorization: `Bearer ${bearerToken}` }
          });
          const state = (status.data?.status ?? status.data?.result?.status ?? "").toLowerCase();
          const fileToken = status.data?.result?.file_token ?? status.data?.file_token ?? "";
          if (fileToken) {
            this.sheetExportFileTokenBySpreadsheet.set(spreadsheetToken, fileToken);
            return fileToken;
          }
          if (state.includes("fail")) {
            break;
          }
          if (!(state.includes("success") || state.includes("finish"))) {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }
  async fetchBitableAsMarkdown(account, combinedToken) {
    const separator = combinedToken.indexOf("_");
    if (separator <= 0 || separator >= combinedToken.length - 1) {
      return `> [Bitable] ${combinedToken}`;
    }
    const appToken = combinedToken.slice(0, separator);
    const tableId = combinedToken.slice(separator + 1);
    const auth = { Authorization: `Bearer ${await this.deps.getAccessToken(account)}` };
    const rows = [];
    let pageToken = "";
    for (let i = 0; i < 10; i += 1) {
      const query = pageToken ? `?page_size=200&page_token=${encodeURIComponent(pageToken)}` : "?page_size=200";
      try {
        const response = await this.deps.request(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records${query}`, {
          method: "GET",
          headers: auth
        });
        for (const item of response.data?.items ?? []) {
          rows.push(item.fields ?? {});
        }
        if (!response.data?.has_more) {
          break;
        }
        pageToken = response.data?.page_token ?? "";
        if (!pageToken) {
          break;
        }
      } catch {
        return `> [Bitable] ${combinedToken}`;
      }
    }
    if (rows.length === 0) {
      return `> [Bitable] ${combinedToken}`;
    }
    return recordsToMarkdownTable(rows);
  }
};
function splitSheetCombinedToken(combinedToken) {
  const separator = combinedToken.lastIndexOf("_");
  if (separator <= 0 || separator >= combinedToken.length - 1) {
    return null;
  }
  return {
    spreadsheetToken: combinedToken.slice(0, separator),
    sheetId: combinedToken.slice(separator + 1)
  };
}
function buildExportTaskStatusPath(ticket, sourceToken) {
  const encodedTicket = encodeURIComponent(ticket);
  const encodedSourceToken = encodeURIComponent(sourceToken);
  return `/drive/v1/export_tasks/${encodedTicket}?token=${encodedSourceToken}`;
}

// src/services/blockMapping.ts
var FEISHU_BLOCK_MARKDOWN_MAP = {
  1: "page",
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  7: "heading5",
  8: "heading6",
  9: "heading7",
  10: "heading8",
  11: "heading9",
  12: "bullet",
  13: "ordered",
  14: "code",
  15: "quote",
  17: "todo",
  18: "bitable",
  19: "callout",
  20: "chat_card",
  21: "diagram",
  22: "divider",
  23: "file",
  24: "grid",
  25: "grid_column",
  26: "iframe",
  27: "image",
  28: "isv",
  29: "mindnote",
  30: "sheet",
  31: "table",
  32: "table_cell",
  33: "view",
  34: "quote_container",
  35: "task",
  36: "okr",
  37: "okr_objective",
  38: "okr_key_result",
  39: "okr_progress",
  40: "mermaid",
  41: "jira_issue",
  42: "wiki_catalog",
  43: "board",
  44: "agenda",
  45: "agenda_item",
  46: "agenda_item_title",
  47: "agenda_item_content",
  48: "link_preview",
  49: "source_synced",
  50: "reference_synced",
  51: "sub_page_list",
  52: "ai_template",
  999: "undefined"
};

// src/services/feishuDocUpload.ts
var _FeishuDocUploadService = class _FeishuDocUploadService {
  constructor(deps) {
    this.deps = deps;
  }
  async createDocument(account, title, markdown, targetFolderToken, assetContext, mermaidMode = "text", onProgress) {
    this.reportProgress(onProgress, 5, "\u51C6\u5907\u4E0A\u4F20", "\u6B63\u5728\u521B\u5EFA\u7EBF\u4E0A\u6587\u6863\u8282\u70B9...");
    const parsed = targetFolderToken ? parseWikiTargetToken(targetFolderToken) : null;
    if (targetFolderToken && !parsed?.spaceId) {
      throw new Error("Invalid wiki target token. Expected wiki_space:<space_id> or wiki_node:<space_id>:<node_token>.");
    }
    if (parsed?.spaceId) {
      const created2 = await this.createWikiDocxNode(account, parsed.spaceId, title, parsed.nodeToken);
      const update2 = await this.writeMarkdownAsBlocks(
        account,
        created2.docToken,
        markdown,
        assetContext,
        mermaidMode,
        onProgress
      );
      return {
        docToken: created2.docToken,
        title: created2.title,
        updatedAt: update2.updatedAt,
        docUrl: created2.docUrl ?? buildDocxUrl(created2.docToken)
      };
    }
    const token = await this.deps.getAccessToken(account);
    const created = await this.requestWithRetry(
      "/docx/v1/documents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ title })
      }
    );
    const docToken = created.data?.document?.document_id;
    if (!docToken) {
      throw new Error("Feishu createDocument missing document_id.");
    }
    const update = await this.writeMarkdownAsBlocks(
      account,
      docToken,
      markdown,
      assetContext,
      mermaidMode,
      onProgress
    );
    return {
      docToken,
      title: created.data?.document?.title ?? title,
      updatedAt: update.updatedAt,
      docUrl: created.data?.document?.url && typeof (created.data?.document).url === "string" ? (created.data?.document).url ?? void 0 : buildDocxUrl(docToken)
    };
  }
  async updateDocument(account, docToken, markdown, assetContext, mermaidMode = "text", onProgress) {
    return await this.writeMarkdownAsBlocks(
      account,
      docToken,
      markdown,
      assetContext,
      mermaidMode,
      onProgress
    );
  }
  async uploadImages(account, images) {
    const token = await this.deps.getAccessToken(account);
    const replacements = /* @__PURE__ */ new Map();
    for (const image of images) {
      const localPath = image.localPath;
      const fileName = localPath.split("/").pop() ?? "image.png";
      const multipart = buildMultipartBody(fileName, image.bytes);
      const response = await this.requestWithRetry(
        "/drive/v1/medias/upload_all",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": multipart.contentType
          },
          body: multipart.body
        }
      );
      const fileToken = response.data?.file_token;
      if (fileToken) {
        replacements.set(localPath, fileToken);
      }
    }
    return replacements;
  }
  async uploadFiles(account, files) {
    const token = await this.deps.getAccessToken(account);
    const replacements = /* @__PURE__ */ new Map();
    for (const file of files) {
      const localPath = file.localPath;
      const fileName = localPath.split("/").pop() ?? "attachment.bin";
      const fileToken = await this.uploadSingleFileWithFallback(token, fileName, file.bytes);
      if (fileToken) {
        replacements.set(localPath, fileToken);
      }
    }
    return replacements;
  }
  async uploadSingleFileWithFallback(token, fileName, bytes) {
    const candidates = [
      { path: "/drive/v1/files/upload_all", parentType: "explorer", parentNode: "root" },
      { path: "/drive/v1/medias/upload_all", parentType: "docx_file", parentNode: "0" }
    ];
    let lastError;
    for (const candidate of candidates) {
      const multipart = buildMultipartBody(fileName, bytes, {
        parentType: candidate.parentType,
        parentNode: candidate.parentNode
      });
      try {
        const response = await this.requestWithRetry(candidate.path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": multipart.contentType
          },
          body: multipart.body
        });
        return response.data?.file_token;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Feishu file upload failed.");
  }
  async createWikiDocxNode(account, spaceId, title, parentNodeToken) {
    const token = await this.deps.getAccessToken(account);
    const body = {
      title,
      obj_type: "docx",
      node_type: "origin"
    };
    if (parentNodeToken) {
      body.parent_node_token = parentNodeToken;
    }
    const response = await this.requestWithRetry(`/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const docToken = response.data?.node?.obj_token ?? response.data?.obj_token ?? "";
    if (!docToken) {
      throw new Error("Wiki create node missing obj_token for docx.");
    }
    return {
      docToken,
      title: response.data?.node?.title ?? response.data?.title ?? title,
      docUrl: response.data?.node?.url && typeof (response.data?.node).url === "string" ? (response.data?.node).url ?? void 0 : typeof response.data?.url === "string" ? response.data.url ?? void 0 : buildDocxUrl(docToken)
    };
  }
  async writeMarkdownAsBlocks(account, docToken, markdown, assetContext, mermaidMode = "text", onProgress) {
    this.reportProgress(onProgress, 12, "\u8BFB\u53D6\u6587\u6863\u7ED3\u6784", "\u6B63\u5728\u83B7\u53D6\u6839\u8282\u70B9\u5E76\u6E05\u7406\u65E7\u5185\u5BB9...");
    const root = await this.getRootBlock(account, docToken);
    await this.deleteExistingChildren(account, docToken, root.firstLevelChildren);
    const trimmed = markdown.trim();
    if (!trimmed) {
      this.reportProgress(onProgress, 100, "\u4E0A\u4F20\u5B8C\u6210", "\u6587\u6863\u5185\u5BB9\u4E3A\u7A7A\uFF0C\u5DF2\u5B8C\u6210\u3002");
      return { updatedAt: Date.now() };
    }
    this.reportProgress(onProgress, 20, "\u89E3\u6790 Markdown", "\u6B63\u5728\u8F6C\u6362\u4E3A\u98DE\u4E66\u5757\u7ED3\u6784...");
    const converted = await this.convertMarkdownToChildren(trimmed, mermaidMode);
    const token = await this.deps.getAccessToken(account);
    if (converted.kind === "children") {
      if (converted.children.length === 0) {
        this.reportProgress(onProgress, 100, "\u4E0A\u4F20\u5B8C\u6210", "\u65E0\u53EF\u5199\u5165\u5757\u3002");
        return { updatedAt: Date.now() };
      }
      await this.appendChildren(
        token,
        docToken,
        root.blockId,
        converted.children,
        (batchIndex, totalBatches) => {
          const p = 25 + Math.floor(batchIndex / Math.max(1, totalBatches) * 70);
          this.reportProgress(
            onProgress,
            p,
            "\u5199\u5165\u6587\u6863\u5757",
            `\u6B63\u5728\u5199\u5165\u6279\u6B21 ${batchIndex}/${totalBatches}...`
          );
        }
      );
      this.reportProgress(onProgress, 100, "\u4E0A\u4F20\u5B8C\u6210", "\u5757\u5199\u5165\u5B8C\u6210\u3002");
      return { updatedAt: Date.now() };
    }
    this.reportProgress(onProgress, 25, "\u5199\u5165\u6587\u6863\u5757", "\u6B63\u5728\u521B\u5EFA\u5757\u5E76\u5904\u7406\u5D4C\u5957\u7ED3\u6784...");
    await this.appendConvertedTree(account, token, docToken, root.blockId, converted, assetContext, onProgress);
    this.reportProgress(onProgress, 100, "\u4E0A\u4F20\u5B8C\u6210", "\u6587\u6863\u4E0A\u4F20\u5DF2\u5B8C\u6210\u3002");
    return { updatedAt: Date.now() };
  }
  async appendChildren(token, docToken, parentBlockId, children, onBatch, onProgress, progressStage = "\u5199\u5165\u6587\u6863\u5757", progressContext) {
    if (children.length === 0) {
      return [];
    }
    const path = `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(parentBlockId)}/children?document_revision_id=-1`;
    const batches = this.splitChildrenForCreate(children);
    console.log("[FeishuSync][upload:append_children_batches]", {
      documentId: docToken,
      parentBlockId,
      totalChildren: children.length,
      totalBatches: batches.length,
      batchSizes: batches.map((batch) => batch.length),
      sheetCounts: batches.map(
        (batch) => batch.reduce((count, item) => count + (Number(item.block_type ?? 0) === 30 ? 1 : 0), 0)
      )
    });
    const allCreated = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      onBatch?.(batchIndex + 1, batches.length);
      const batchSheetCount = batch.reduce(
        (count, item) => count + (Number(item.block_type ?? 0) === 30 ? 1 : 0),
        0
      );
      console.log("[FeishuSync][upload:append_children_batch_start]", {
        documentId: docToken,
        parentBlockId,
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        childrenCount: batch.length,
        sheetCount: batchSheetCount
      });
      const response = await this.requestWithRetry(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          children: batch,
          // Keep insertion order stable across sequential batches.
          index: -1
        })
      }, onProgress, progressStage, progressContext);
      const created = (response.data?.children ?? []).map((item) => ({
        blockId: item.block_id ?? "",
        sheetToken: item.sheet?.token,
        fileBlockId: Number(item.block_type ?? 0) === 33 && Array.isArray(item.children) && item.children[0] ? item.children[0] : void 0
      })).filter((item) => !!item.blockId);
      console.log("[FeishuSync][upload:append_children_batch_done]", {
        documentId: docToken,
        parentBlockId,
        batchIndex: batchIndex + 1,
        createdCount: created.length
      });
      allCreated.push(...created);
    }
    return allCreated;
  }
  splitChildrenForCreate(children) {
    const maxChildrenPerRequest = 50;
    const maxSheetBlocksPerRequest = 5;
    const batches = [];
    let current = [];
    let currentSheetCount = 0;
    const isSheetBlock = (item) => Number(item.block_type ?? 0) === 30;
    const flush = () => {
      if (current.length === 0) {
        return;
      }
      batches.push(current);
      current = [];
      currentSheetCount = 0;
    };
    for (const item of children) {
      const sheetDelta = isSheetBlock(item) ? 1 : 0;
      const exceedsLen = current.length >= maxChildrenPerRequest;
      const exceedsSheet = currentSheetCount + sheetDelta > maxSheetBlocksPerRequest;
      if (exceedsLen || exceedsSheet) {
        flush();
      }
      current.push(item);
      currentSheetCount += sheetDelta;
      if (current.length >= maxChildrenPerRequest || currentSheetCount >= maxSheetBlocksPerRequest) {
        flush();
      }
    }
    flush();
    return batches;
  }
  async appendConvertedTree(account, token, docToken, rootBlockId, converted, assetContext, onProgress) {
    if (converted.kind !== "blocks") {
      return;
    }
    const visited = /* @__PURE__ */ new Set();
    const totalBlocks = Math.max(1, converted.blockMap.size);
    const totalAssets = converted.imageRefByBlockId.size + converted.fileRefByBlockId.size;
    let processedBlocks = 0;
    let uploadedAssetCount = 0;
    const formatAssetProgress = (next) => totalAssets > 0 ? `\u9644\u4EF6\u8FDB\u5EA6\uFF1A${Math.min(next, totalAssets)}/${totalAssets}` : "\u9644\u4EF6\u8FDB\u5EA6\uFF1A0/0";
    const formatAssetStage = (base, next) => totalAssets > 0 ? `${base}\uFF08${Math.min(next, totalAssets)}/${totalAssets}\uFF09` : base;
    const appendRecursive = async (parentBlockId, oldChildIds, oldParentBlock) => {
      const normalizedIds = oldChildIds.filter((id) => converted.blockMap.has(id) && !visited.has(id));
      if (normalizedIds.length === 0) {
        return;
      }
      const payload = normalizedIds.map((oldId) => toCreatableBlock(converted.blockMap.get(oldId), oldParentBlock)).filter((item) => !!item);
      if (payload.length === 0) {
        return;
      }
      const created = await this.appendChildren(
        token,
        docToken,
        parentBlockId,
        payload,
        void 0,
        onProgress,
        "\u5199\u5165\u6587\u6863\u5757",
        `\u6B63\u5728\u5904\u7406\u5757 ${Math.min(processedBlocks + normalizedIds.length, totalBlocks)}/${totalBlocks}`
      );
      for (let i = 0; i < normalizedIds.length; i += 1) {
        const oldId = normalizedIds[i];
        visited.add(oldId);
        processedBlocks += 1;
        const progress = 25 + Math.floor(processedBlocks / totalBlocks * 65);
        this.reportProgress(
          onProgress,
          Math.min(92, progress),
          "\u5199\u5165\u6587\u6863\u5757",
          `\u6B63\u5728\u5904\u7406\u5757 ${processedBlocks}/${totalBlocks}...`
        );
        const oldBlock = converted.blockMap.get(oldId);
        const isFileBlock = Number(oldBlock?.block_type ?? 0) === 23;
        const newId = (isFileBlock ? created[i]?.fileBlockId : void 0) ?? created[i]?.blockId ?? "";
        const sheetToken = created[i]?.sheetToken ?? "";
        const tableRows = converted.tableRowsByBlockId.get(oldId);
        if (tableRows) {
          this.reportProgress(onProgress, Math.min(95, progress + 1), "\u5904\u7406\u8868\u683C", "\u6B63\u5728\u5199\u5165 Sheet \u6570\u636E...");
          if (!sheetToken) {
            throw new Error("Sheet placeholder created without sheet token.");
          }
          const targetRows = Math.max(1, tableRows.length);
          const targetCols = Math.max(1, tableRows.reduce((max, row) => Math.max(max, row.length), 0));
          await this.expandSheetDimensionsIfNeeded(account, sheetToken, targetRows, targetCols);
          await this.prependSheetValuesByCombinedToken(account, sheetToken, tableRows);
          const tableStyles = converted.tableStylesByBlockId.get(oldId);
          const tableAligns = converted.tableColumnAlignByBlockId.get(oldId);
          if (tableStyles) {
            await this.applySheetCellStylesByCombinedToken(account, sheetToken, tableStyles, tableAligns);
          }
          this.reportProgress(onProgress, Math.min(95, progress + 2), "\u5904\u7406\u8868\u683C", "\u6B63\u5728\u8C03\u6574\u8868\u683C\u5217\u5BBD...");
          await this.setSheetColumnWidthsByCombinedToken(account, sheetToken, tableRows);
        }
        const imageRef = converted.imageRefByBlockId.get(oldId) ?? "";
        if (imageRef) {
          const isMermaidImage = decodeMermaidImageRef(imageRef) !== null;
          const imageDetail = isMermaidImage ? "\u6B63\u5728\u4E0A\u4F20 Mermaid \u56FE\u7247..." : `\u6B63\u5728\u4E0A\u4F20\u56FE\u7247: ${imageRef}`;
          this.reportProgress(
            onProgress,
            Math.min(96, progress + 1),
            formatAssetStage("\u5904\u7406\u56FE\u7247", uploadedAssetCount + 1),
            `${imageDetail}\uFF08${formatAssetProgress(uploadedAssetCount + 1)}\uFF09`
          );
          if (uploadedAssetCount > 0) {
            const throttleMs = this.getAssetThrottleDelayMs();
            if (throttleMs > 0) {
              this.reportProgress(
                onProgress,
                Math.min(96, progress + 1),
                formatAssetStage("\u5904\u7406\u56FE\u7247", uploadedAssetCount),
                `\u4E3A\u907F\u514D\u89E6\u53D1\u9650\u901F\u9650\u5236\uFF0C\u5728\u9650\u901F\u4E0A\u4F20\u4E2D...\uFF08${formatAssetProgress(uploadedAssetCount)}\uFF09`
              );
              await this.sleep(throttleMs);
            }
          }
          if (!newId)
            throw new Error("Image placeholder created without block id.");
          await this.uploadImageByBlockReference(account, newId, imageRef, assetContext, docToken, onProgress);
          uploadedAssetCount += 1;
        }
        const fileRef = converted.fileRefByBlockId.get(oldId) ?? "";
        if (fileRef) {
          this.reportProgress(
            onProgress,
            Math.min(97, progress + 1),
            formatAssetStage("\u5904\u7406\u9644\u4EF6", uploadedAssetCount + 1),
            `\u6B63\u5728\u4E0A\u4F20\u9644\u4EF6: ${fileRef}\uFF08${formatAssetProgress(uploadedAssetCount + 1)}\uFF09`
          );
          if (uploadedAssetCount > 0) {
            const throttleMs = this.getAssetThrottleDelayMs();
            if (throttleMs > 0) {
              this.reportProgress(
                onProgress,
                Math.min(97, progress + 1),
                formatAssetStage("\u5904\u7406\u9644\u4EF6", uploadedAssetCount),
                `\u4E3A\u907F\u514D\u89E6\u53D1\u9650\u901F\u9650\u5236\uFF0C\u5728\u9650\u901F\u4E0A\u4F20\u4E2D...\uFF08${formatAssetProgress(uploadedAssetCount)}\uFF09`
              );
              await this.sleep(throttleMs);
            }
          }
          if (!newId)
            throw new Error("File placeholder created without block id.");
          await this.uploadFileByBlockReference(account, newId, fileRef, assetContext, docToken, onProgress);
          uploadedAssetCount += 1;
        }
        if (!newId)
          continue;
        const nested = converted.childIdMap.get(oldId) ?? [];
        if (nested.length > 0) {
          await appendRecursive(newId, nested, oldBlock);
        }
      }
    };
    await appendRecursive(rootBlockId, converted.firstLevelBlockIds, void 0);
  }
  reportProgress(onProgress, percent, stage, detail) {
    if (!onProgress)
      return;
    onProgress({
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      stage,
      detail
    });
  }
  async getRootBlock(account, docToken) {
    const token = await this.deps.getAccessToken(account);
    const response = await this.requestWithRetry(
      `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks?document_revision_id=-1&page_size=500`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const root = (response.data?.items ?? []).find((item) => item.block_type === 1);
    if (!root?.block_id) {
      throw new Error("Unable to locate root block for document.");
    }
    const firstLevelFromResponse = Array.isArray(response.data?.first_level_block_ids) ? response.data?.first_level_block_ids.filter((item) => typeof item === "string" && !!item) : [];
    const firstLevelChildren = firstLevelFromResponse.length > 0 ? firstLevelFromResponse : (root.children ?? []).filter((item) => typeof item === "string" && !!item);
    return { blockId: root.block_id, firstLevelChildren };
  }
  async deleteExistingChildren(account, docToken, children) {
    if (children.length === 0)
      return;
    const token = await this.deps.getAccessToken(account);
    const uniqueChildren = Array.from(new Set(children));
    for (const blockId of uniqueChildren.reverse()) {
      await this.requestWithRetry(
        `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}?document_revision_id=-1`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        }
      );
    }
  }
  async convertMarkdownToChildren(markdown, mermaidMode) {
    return parseMarkdownToBlockGraph(normalizeMarkdownForFeishuConvert(markdown), {
      mermaidUploadMode: mermaidMode
    });
  }
  async prependSheetValuesByCombinedToken(account, combinedToken, rows) {
    const separator = combinedToken.indexOf("_");
    if (separator <= 0 || separator >= combinedToken.length - 1) {
      throw new Error(`Invalid sheet token: ${combinedToken}`);
    }
    const spreadsheetToken = combinedToken.slice(0, separator);
    const sheetId = combinedToken.slice(separator + 1);
    const cols = Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0));
    const rowCount = Math.max(1, rows.length);
    const range = `${sheetId}!A1:${columnIndexToName(cols)}${rowCount}`;
    const typedValues = rows.map((row) => row.map((cell) => coerceSheetCellValue(cell)));
    const token = await this.deps.getAccessToken(account);
    await this.requestWithRetry(`/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ valueRange: { range, values: typedValues } })
    });
  }
  async applySheetCellStylesByCombinedToken(account, combinedToken, styles, columnAligns) {
    const separator = combinedToken.indexOf("_");
    if (separator <= 0 || separator >= combinedToken.length - 1) {
      throw new Error(`Invalid sheet token: ${combinedToken}`);
    }
    const spreadsheetToken = combinedToken.slice(0, separator);
    const sheetId = combinedToken.slice(separator + 1);
    const grouped = /* @__PURE__ */ new Map();
    for (let rowIndex = 0; rowIndex < styles.length; rowIndex += 1) {
      const row = styles[rowIndex] ?? [];
      for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
        const style = row[colIndex];
        const hAlign = columnAligns?.[colIndex] ?? 0;
        if (!style && hAlign === 0) {
          continue;
        }
        const stylePayload = this.buildSheetStylePayload(style);
        stylePayload.hAlign = hAlign;
        const styleKey = JSON.stringify(stylePayload);
        const existing = grouped.get(styleKey);
        if (existing) {
          existing.coords.push({ row: rowIndex + 1, col: colIndex + 1 });
        } else {
          grouped.set(styleKey, {
            coords: [{ row: rowIndex + 1, col: colIndex + 1 }],
            style: stylePayload
          });
        }
      }
    }
    const data = Array.from(grouped.values()).map((entry) => ({
      ranges: this.compressSheetStyleRanges(sheetId, entry.coords),
      style: entry.style
    }));
    if (data.length === 0) {
      return;
    }
    const token = await this.deps.getAccessToken(account);
    await this.requestWithRetry(
      `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/styles_batch_update`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ data })
      }
    );
  }
  buildSheetStylePayload(style) {
    return {
      font: {
        bold: style?.bold ?? false,
        italic: style?.italic ?? false,
        clean: false
      },
      textDecoration: this.resolveTextDecoration(style),
      formatter: "",
      hAlign: 0,
      vAlign: 0,
      clean: false
    };
  }
  compressSheetStyleRanges(sheetId, coords) {
    if (coords.length === 0)
      return [];
    const byRow = /* @__PURE__ */ new Map();
    for (const coord of coords) {
      const rowCols = byRow.get(coord.row) ?? [];
      rowCols.push(coord.col);
      byRow.set(coord.row, rowCols);
    }
    const horizontalRanges = [];
    const sortedRows = Array.from(byRow.keys()).sort((a, b) => a - b);
    for (const row of sortedRows) {
      const cols = Array.from(new Set(byRow.get(row) ?? [])).sort((a, b) => a - b);
      if (cols.length === 0)
        continue;
      let start = cols[0];
      let prev = cols[0];
      for (let i = 1; i < cols.length; i += 1) {
        const current = cols[i];
        if (current === prev + 1) {
          prev = current;
          continue;
        }
        horizontalRanges.push({ rowStart: row, rowEnd: row, colStart: start, colEnd: prev });
        start = current;
        prev = current;
      }
      horizontalRanges.push({ rowStart: row, rowEnd: row, colStart: start, colEnd: prev });
    }
    const mergedByCols = /* @__PURE__ */ new Map();
    for (const item of horizontalRanges) {
      const key = `${item.colStart}:${item.colEnd}`;
      const existing = mergedByCols.get(key) ?? [];
      const last = existing[existing.length - 1];
      if (last && last.rowEnd + 1 === item.rowStart) {
        last.rowEnd = item.rowEnd;
      } else {
        existing.push({ ...item });
      }
      mergedByCols.set(key, existing);
    }
    const mergedRanges = Array.from(mergedByCols.values()).flat();
    mergedRanges.sort((a, b) => {
      if (a.rowStart !== b.rowStart)
        return a.rowStart - b.rowStart;
      if (a.colStart !== b.colStart)
        return a.colStart - b.colStart;
      if (a.rowEnd !== b.rowEnd)
        return a.rowEnd - b.rowEnd;
      return a.colEnd - b.colEnd;
    });
    return mergedRanges.map((item) => {
      const start = `${columnIndexToName(item.colStart)}${item.rowStart}`;
      const end = `${columnIndexToName(item.colEnd)}${item.rowEnd}`;
      return `${sheetId}!${start}:${end}`;
    });
  }
  resolveTextDecoration(style) {
    const underline = style?.underline ? 1 : 0;
    const strike = style?.strikeThrough ? 2 : 0;
    return underline + strike;
  }
  async expandSheetDimensionsIfNeeded(account, combinedToken, targetRows, targetCols) {
    if (targetRows > 5e3)
      throw new Error("Table rows exceed Feishu single-write limit (5000).");
    if (targetCols > 100)
      throw new Error("Table columns exceed Feishu single-write limit (100).");
    const separator = combinedToken.indexOf("_");
    if (separator <= 0 || separator >= combinedToken.length - 1) {
      throw new Error(`Invalid sheet token: ${combinedToken}`);
    }
    const spreadsheetToken = combinedToken.slice(0, separator);
    const sheetId = combinedToken.slice(separator + 1);
    const baseRows = Math.min(9, Math.max(1, targetRows));
    const baseCols = Math.min(9, Math.max(1, targetCols));
    const addRows = Math.max(0, targetRows - baseRows);
    const addCols = Math.max(0, targetCols - baseCols);
    if (addRows === 0 && addCols === 0)
      return;
    const token = await this.deps.getAccessToken(account);
    const postDimension = async (majorDimension, length) => {
      if (length <= 0)
        return;
      await this.requestWithRetry(`/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dimension_range`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dimension: { sheetId, majorDimension, length }
        })
      });
    };
    await postDimension("ROWS", addRows);
    await postDimension("COLUMNS", addCols);
  }
  async setSheetColumnWidthsByCombinedToken(account, combinedToken, rows) {
    const separator = combinedToken.indexOf("_");
    if (separator <= 0 || separator >= combinedToken.length - 1) {
      throw new Error(`Invalid sheet token: ${combinedToken}`);
    }
    const spreadsheetToken = combinedToken.slice(0, separator);
    const sheetId = combinedToken.slice(separator + 1);
    const columnCount = Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0));
    const rawWidths = this.computeSheetColumnWidths(rows, columnCount);
    const token = await this.deps.getAccessToken(account);
    for (let i = 0; i < rawWidths.length; i += 1) {
      await this.requestWithRetry(
        `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dimension_range`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            dimension: {
              sheetId,
              majorDimension: "COLUMNS",
              startIndex: i + 1,
              endIndex: i + 1
            },
            dimensionProperties: {
              fixedSize: rawWidths[i]
            }
          })
        }
      );
    }
  }
  computeSheetColumnWidths(rows, columnCount) {
    const raw = Array.from({ length: columnCount }, () => 0);
    for (const row of rows) {
      for (let col = 0; col < columnCount; col += 1) {
        const value = row[col] ?? "";
        const width = this.measureSheetCellDisplayWidth(String(value));
        if (width > raw[col]) {
          raw[col] = width;
        }
      }
    }
    for (let col = 0; col < raw.length; col += 1) {
      raw[col] = Math.max(_FeishuDocUploadService.MIN_SHEET_COLUMN_WIDTH, raw[col]);
    }
    const total = raw.reduce((sum, item) => sum + item, 0);
    if (total <= 900) {
      return raw.map((item) => Math.max(1, Math.round(item)));
    }
    const over300 = raw.filter(
      (item) => item > _FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_THREE_WIDE
    ).length;
    if (over300 >= 3) {
      return raw.map(
        (item) => Math.max(
          1,
          Math.min(_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_THREE_WIDE, Math.round(item))
        )
      );
    }
    const over400 = raw.filter(
      (item) => item > _FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_MULTI_WIDE
    ).length;
    if (over400 >= 2) {
      return raw.map(
        (item) => Math.max(
          1,
          Math.min(_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_MULTI_WIDE, Math.round(item))
        )
      );
    }
    const over500 = raw.filter((item) => item > _FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH).length;
    if (over500 >= 1) {
      return raw.map(
        (item) => Math.max(1, Math.min(_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH, Math.round(item)))
      );
    }
    return raw.map((item) => Math.max(1, Math.round(item)));
  }
  measureSheetCellDisplayWidth(value) {
    let width = 0;
    for (const char of value) {
      width += this.measureSingleCharWidth(char);
    }
    return width;
  }
  measureSingleCharWidth(char) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "W")
      return 14;
    if (char === "M" || char === "m")
      return 12;
    if (char === "N" || char === "O" || char === "Q" || char === "w")
      return 11;
    if ("UGHCDVXA".includes(char))
      return 10;
    if (char === "r" || char === "f" || char === "t")
      return 6;
    if (char === "I" || char === "i" || char === "j" || char === "l")
      return 5;
    const isLatinLetter = code >= 65 && code <= 90 || // A-Z
    code >= 97 && code <= 122;
    if (isLatinLetter)
      return 9;
    const isDigit = code >= 48 && code <= 57;
    if (isDigit)
      return 9;
    const isSpace = code === 32;
    if (isSpace)
      return 8;
    const isAsciiPunctuation = code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126;
    if (isAsciiPunctuation)
      return 8;
    if (code === 65039 || code === 8205 || code === 8419)
      return 0;
    if (this.isEmojiCodePoint(code))
      return 15;
    if (this.isHanCodePoint(code))
      return 14;
    if (this.isFullwidthPunctuationCodePoint(code))
      return 15;
    return 14;
  }
  isHanCodePoint(code) {
    return code >= 13312 && code <= 19903 || // CJK Unified Ideographs Extension A
    code >= 19968 && code <= 40959 || // CJK Unified Ideographs
    code >= 63744 && code <= 64255 || // CJK Compatibility Ideographs
    code >= 131072 && code <= 173791 || // Extension B
    code >= 173824 && code <= 177983 || // Extension C
    code >= 177984 && code <= 178207 || // Extension D
    code >= 178208 && code <= 183983 || // Extension E/F
    code >= 183984 && code <= 191471 || // Extension F/G
    code >= 196608 && code <= 201551;
  }
  isFullwidthPunctuationCodePoint(code) {
    return code >= 12288 && code <= 12351 || // CJK Symbols and Punctuation
    code >= 65281 && code <= 65376 || // Fullwidth ASCII variants
    code >= 65504 && code <= 65518;
  }
  isEmojiCodePoint(code) {
    return code >= 127744 && code <= 128511 || // Misc Symbols and Pictographs
    code >= 128512 && code <= 128591 || // Emoticons
    code >= 128640 && code <= 128767 || // Transport and Map
    code >= 128768 && code <= 128895 || code >= 128896 && code <= 129023 || code >= 129024 && code <= 129279 || code >= 129280 && code <= 129535 || // Supplemental Symbols and Pictographs
    code >= 129536 && code <= 129791 || code >= 9728 && code <= 9983 || // Misc symbols
    code >= 9984 && code <= 10175;
  }
  async uploadImageByBlockReference(account, imageBlockId, imageRef, assetContext, documentId, onProgress) {
    const mermaidSource = decodeMermaidImageRef(imageRef);
    let bytes;
    let fileName;
    if (mermaidSource !== null) {
      bytes = await this.renderMermaidToPngBytes(mermaidSource);
      fileName = "mermaid.png";
    } else {
      if (!assetContext)
        throw new Error(`Image asset context missing for: ${imageRef}`);
      const resolved = await resolveLocalAssetPath(assetContext, imageRef, "image.png");
      if (!resolved)
        throw new Error(`Image file not found: ${imageRef}`);
      bytes = await assetContext.readBinary(resolved.path);
      fileName = resolved.fileName;
    }
    const dimensions = detectImageDimensions(bytes);
    const token = await this.deps.getAccessToken(account);
    const multipart = buildMultipartBody(fileName, bytes, {
      parentType: "docx_image",
      parentNode: imageBlockId,
      extra: documentId ? { drive_route_token: documentId } : void 0
    });
    const uploadResp = await this.requestWithRetry(
      "/drive/v1/medias/upload_all",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": multipart.contentType
        },
        body: multipart.body
      }
    );
    const fileToken = uploadResp.data?.file_token ?? uploadResp.data?.data?.file_token ?? "";
    if (!fileToken)
      throw new Error("Image upload succeeded but file_token missing.");
    if (!documentId)
      throw new Error("Document id is required for replace_image.");
    await this.requestWithRetry(
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(imageBlockId)}?document_revision_id=-1`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          replace_image: {
            token: fileToken,
            ...dimensions ? { width: dimensions.width, height: dimensions.height } : {},
            align: 2
          }
        })
      },
      onProgress,
      "\u5904\u7406\u56FE\u7247"
    );
  }
  async uploadFileByBlockReference(account, fileBlockId, fileRef, assetContext, documentId, onProgress) {
    if (!assetContext)
      throw new Error(`File asset context missing for: ${fileRef}`);
    const resolved = await resolveLocalAssetPath(assetContext, fileRef, "attachment.bin");
    if (!resolved)
      throw new Error(`File not found: ${fileRef}`);
    const bytes = await assetContext.readBinary(resolved.path);
    const token = await this.deps.getAccessToken(account);
    const multipart = buildMultipartBody(resolved.fileName, bytes, {
      parentType: "docx_file",
      parentNode: fileBlockId,
      extra: documentId ? { drive_route_token: documentId } : void 0
    });
    const uploadResp = await this.requestWithRetry(
      "/drive/v1/medias/upload_all",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": multipart.contentType
        },
        body: multipart.body
      }
    );
    const fileToken = uploadResp.data?.file_token ?? uploadResp.data?.data?.file_token ?? "";
    if (!fileToken || !documentId)
      return;
    try {
      await this.requestWithRetry(
        `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(fileBlockId)}?document_revision_id=-1`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            replace_file: { token: fileToken }
          })
        },
        onProgress,
        "\u5904\u7406\u9644\u4EF6"
      );
    } catch {
    }
  }
  async renderMermaidToPngBytes(source) {
    if (this.deps.renderMermaidToPng) {
      try {
        return await this.deps.renderMermaidToPng(source);
      } catch {
      }
    }
    const base64 = toBase64UrlUtf8(source);
    const candidates = [
      `https://mermaid.ink/img/${base64}?type=png&scale=3`,
      `https://mermaid.ink/img/${base64}?type=png&scale=2`,
      `https://mermaid.ink/img/${base64}?type=png`,
      `https://mermaid.ink/img/${base64}`
    ];
    let lastError;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { method: "GET" });
        if (!response.ok) {
          lastError = new Error(`Mermaid render failed with HTTP ${response.status}`);
          continue;
        }
        return await response.arrayBuffer();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Mermaid render failed: ${String(lastError ?? "unknown error")}`);
  }
  async requestWithRetry(path, init, onProgress, progressStage = "\u4E0A\u4F20\u4E2D", progressContext) {
    const retryLimit = this.getRetryLimit429();
    const retryDelayMs = this.getRetryDelayMs429();
    let retryCount = 0;
    while (true) {
      try {
        return await this.deps.request(path, init);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimited = /\bHTTP\s*429\b/.test(message) || /\b429\b/.test(message);
        if (!isRateLimited || retryCount >= retryLimit) {
          throw error;
        }
        retryCount += 1;
        this.reportProgress(
          onProgress,
          90,
          progressStage,
          `\u89E6\u53D1\u98DE\u4E66\u9650\u901F(429)\uFF0C${Math.round(retryDelayMs / 1e3)}\u79D2\u540E\u91CD\u8BD5\uFF08${retryCount}/${retryLimit}\uFF09...${progressContext ? `\uFF08${progressContext}\uFF09` : ""}`
        );
        await this.sleep(retryDelayMs);
      }
    }
  }
  getAssetThrottleDelayMs() {
    const behavior = this.deps.getUploadBehavior?.();
    if (!behavior) {
      return _FeishuDocUploadService.DEFAULT_ASSET_UPLOAD_DELAY_MS;
    }
    if (!behavior.assetThrottleEnabled) {
      return 0;
    }
    const seconds = Math.max(0, Math.min(60, Math.round(behavior.assetThrottleSeconds)));
    return seconds * 1e3;
  }
  getRetryLimit429() {
    const behavior = this.deps.getUploadBehavior?.();
    if (!behavior) {
      return _FeishuDocUploadService.DEFAULT_RATE_LIMIT_RETRY_LIMIT;
    }
    return Math.max(0, Math.min(20, Math.round(behavior.retryLimit429)));
  }
  getRetryDelayMs429() {
    const behavior = this.deps.getUploadBehavior?.();
    if (!behavior) {
      return _FeishuDocUploadService.DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
    }
    const seconds = Math.max(1, Math.min(120, Math.round(behavior.retryDelaySeconds429)));
    return seconds * 1e3;
  }
  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
};
_FeishuDocUploadService.DEFAULT_RATE_LIMIT_RETRY_LIMIT = 5;
_FeishuDocUploadService.DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1e4;
_FeishuDocUploadService.DEFAULT_ASSET_UPLOAD_DELAY_MS = 3e3;
_FeishuDocUploadService.MIN_SHEET_COLUMN_WIDTH = 100;
_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH = 500;
_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_MULTI_WIDE = 400;
_FeishuDocUploadService.MAX_SHEET_COLUMN_WIDTH_THREE_WIDE = 300;
var FeishuDocUploadService = _FeishuDocUploadService;
function toBase64UrlUtf8(input) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  const utf8 = new TextEncoder().encode(input);
  let binary = "";
  for (const b of utf8) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// src/services/feishuAssetService.ts
var FeishuAssetService = class {
  constructor(deps) {
    this.deps = deps;
    this.bufferCache = /* @__PURE__ */ new Map();
  }
  async downloadImages(account, imageRefs, targetFolder) {
    const token = await this.deps.getAccessToken(account);
    const files = [];
    for (const ref of imageRefs) {
      const mediaToken = extractMediaToken(ref);
      if (!mediaToken) {
        continue;
      }
      const binary = await this.deps.requestBinary(`/drive/v1/medias/${encodeURIComponent(mediaToken)}/download`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      const ext = inferFileExtension(binary.headers);
      const localPath = `${targetFolder}/${mediaToken}${ext}`;
      files.push({ originalUrl: ref, localPath });
      this.bufferCache.set(localPath, binary.arrayBuffer);
    }
    return files;
  }
  async downloadFiles(account, fileRefs, targetFolder) {
    const token = await this.deps.getAccessToken(account);
    const files = [];
    const used = /* @__PURE__ */ new Set();
    for (const placeholder of fileRefs) {
      const parsed = parseFilePlaceholder(placeholder);
      if (!parsed) {
        continue;
      }
      const binary = await this.downloadFileBinary(token, parsed.token);
      const fallbackName = parsed.name || `${parsed.token}${inferFileExtension(binary.headers)}`;
      const safeName = sanitizeFilename(fallbackName);
      const localPath = uniqueJoinPath(targetFolder, safeName, used);
      files.push({ placeholder, localPath });
      this.bufferCache.set(localPath, binary.arrayBuffer);
    }
    return files;
  }
  popDownloadedBuffer(localPath) {
    const value = this.bufferCache.get(localPath) ?? null;
    if (value) {
      this.bufferCache.delete(localPath);
    }
    return value;
  }
  async downloadFileBinary(token, fileToken) {
    const auth = { Authorization: `Bearer ${token}` };
    const paths = [
      `/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      `/drive/v1/medias/${encodeURIComponent(fileToken)}/download`
    ];
    for (const path of paths) {
      try {
        return await this.deps.requestBinary(path, { method: "GET", headers: auth });
      } catch {
        continue;
      }
    }
    throw new Error(`Unable to download file token: ${fileToken}`);
  }
};

// src/services/feishuClient.ts
var HttpFeishuClient = class {
  constructor(fetchImpl, options = {}) {
    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    } else if (typeof window !== "undefined" && typeof window.fetch === "function") {
      this.fetchImpl = window.fetch.bind(window);
    } else if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("Fetch API is not available in current runtime.");
    }
    this.baseUrl = options.baseUrl ?? "https://open.feishu.cn/open-apis";
    this.requester = options.requester;
    this.logger = options.logger;
    this.maskSensitiveLogs = options.maskSensitiveLogs;
    this.auth = new FeishuAuthManager(
      async (path, init) => await this.request(path, init),
      options.onAccountAuthUpdated
    );
    this.docDownload = new FeishuDocDownloadService({
      getAccessToken: async (account) => await this.getAccessToken(account),
      request: async (path, init) => await this.request(path, init),
      requestText: async (path, init) => await this.requestText(path, init)
    });
    this.docUpload = new FeishuDocUploadService({
      getAccessToken: async (account) => await this.getAccessToken(account),
      request: async (path, init) => await this.request(path, init),
      renderMermaidToPng: options.mermaidRenderer,
      getUploadBehavior: options.getUploadBehavior
    });
    this.assets = new FeishuAssetService({
      getAccessToken: async (account) => await this.getAccessToken(account),
      requestBinary: async (path, init) => await this.requestBinary(path, init)
    });
  }
  buildUserAuthorizeUrl(account, redirectUri, state) {
    return this.auth.buildUserAuthorizeUrl(account, redirectUri, state);
  }
  async exchangeUserCode(account, code, redirectUri) {
    return await this.auth.exchangeUserCode(account, code, redirectUri);
  }
  async fetchCurrentUserInfo(account) {
    return await this.auth.fetchCurrentUserInfo(account);
  }
  invalidateAuthCache(account) {
    this.auth.invalidateAccountCache(account);
  }
  async listRootFolders(account) {
    const token = await this.getAccessToken(account);
    const response = await this.request("/wiki/v2/spaces?page_size=50", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    const output = [];
    for (const item of response.data?.items ?? []) {
      const spaceId = item.space_id ?? "";
      if (!spaceId) {
        continue;
      }
      output.push({
        token: encodeWikiSpaceToken(spaceId),
        name: item.name || `\u77E5\u8BC6\u5E93 ${spaceId}`
      });
    }
    return output;
  }
  async listChildFolders(account, parentFolderToken) {
    const parsed = parseWikiTargetToken(parentFolderToken);
    if (!parsed || !parsed.spaceId) {
      return [];
    }
    const token = await this.getAccessToken(account);
    const nodes = await this.listWikiNodesRecursive(token, parsed.spaceId, parsed.nodeToken);
    if (nodes.length === 0) {
      return [];
    }
    const byParent = /* @__PURE__ */ new Map();
    for (const item of nodes) {
      const parent = (item.parent_node_token ?? "").trim();
      const group = byParent.get(parent) ?? [];
      group.push(item);
      byParent.set(parent, group);
    }
    const allNodeTokens = new Set(
      nodes.map((item) => (item.node_token ?? "").trim()).filter((value) => value.length > 0)
    );
    const roots = nodes.filter((item) => {
      const parent = (item.parent_node_token ?? "").trim();
      return !parent || !allNodeTokens.has(parent);
    });
    const output = [];
    const visited = /* @__PURE__ */ new Set();
    const walk = (node, depth) => {
      const nodeToken = (node.node_token ?? "").trim();
      if (!nodeToken) {
        return;
      }
      if (visited.has(nodeToken)) {
        return;
      }
      visited.add(nodeToken);
      const leafTitle = (node.title ?? "").trim() || nodeToken;
      const indent = "\xA0\xA0".repeat(Math.max(0, depth));
      const marker = depth > 0 ? "\u2514 " : "";
      output.push({
        token: encodeWikiNodeToken(parsed.spaceId, nodeToken),
        name: `${indent}${marker}${leafTitle}`
      });
      const children = byParent.get(nodeToken) ?? [];
      for (const child of children) {
        walk(child, depth + 1);
      }
    };
    for (const root of roots) {
      walk(root, 0);
    }
    for (const node of nodes) {
      walk(node, 0);
    }
    return uniqueFolderSummaries(output);
  }
  async listDocumentsByTitle(account, title) {
    const token = await this.getAccessToken(account);
    const query = encodeURIComponent(`name="${title}" and type="docx"`);
    const response = await this.request(
      `/drive/v1/files?query=${query}&page_size=50`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    return (response.data?.files ?? []).map((item) => ({
      docToken: item.token,
      title: item.name,
      updatedAt: Number(item.modified_time ?? "0")
    }));
  }
  async listWikiDocumentsByTitle(account, targetToken, title) {
    const parsed = parseWikiTargetToken(targetToken);
    if (!parsed?.spaceId) {
      return [];
    }
    const tenantToken = await this.getAccessToken(account);
    const rows = [];
    const nodes = await this.listWikiNodesRecursive(tenantToken, parsed.spaceId, parsed.nodeToken);
    for (const item of nodes) {
      if ((item.title ?? "") !== title) {
        continue;
      }
      if (!isWikiDocumentType(item.obj_type)) {
        continue;
      }
      const docToken = item.obj_token ?? item.node_token ?? "";
      if (!docToken) {
        continue;
      }
      rows.push({
        docToken,
        title: item.title ?? title,
        updatedAt: Number(item.obj_edit_time ?? item.obj_create_time ?? "0")
      });
    }
    return uniqueDocsByToken(rows);
  }
  async listWikiDocumentsInSpace(account, spaceToken) {
    const parsed = parseWikiTargetToken(spaceToken);
    if (!parsed?.spaceId) {
      return [];
    }
    const token = await this.getAccessToken(account);
    const items = await this.listWikiNodesRecursive(token, parsed.spaceId);
    const byParent = /* @__PURE__ */ new Map();
    for (const item of items) {
      const parent = (item.parent_node_token ?? "").trim();
      const group = byParent.get(parent) ?? [];
      group.push(item);
      byParent.set(parent, group);
    }
    const allNodeTokens = new Set(
      items.map((item) => (item.node_token ?? "").trim()).filter((value) => value.length > 0)
    );
    const roots = items.filter((item) => {
      const parent = (item.parent_node_token ?? "").trim();
      return !parent || !allNodeTokens.has(parent);
    });
    const options = [];
    const visited = /* @__PURE__ */ new Set();
    const walk = (node, chain) => {
      const nodeTokenRaw = (node.node_token ?? "").trim();
      if (nodeTokenRaw) {
        visited.add(nodeTokenRaw);
      }
      const name = (node.title ?? "").trim() || (node.node_token ?? "Untitled");
      const nextChain = [...chain, name];
      if (isWikiDocumentType(node.obj_type)) {
        const docToken = (node.obj_token ?? node.node_token ?? "").trim();
        const nodeToken = nodeTokenRaw;
        if (docToken && nodeToken) {
          options.push({
            docToken,
            title: nextChain.join(" / "),
            depth: Math.max(0, nextChain.length - 1),
            leafTitle: name,
            updatedAt: Number(node.obj_edit_time ?? node.obj_create_time ?? "0"),
            spaceId: parsed.spaceId,
            nodeToken
          });
        }
      }
      const children = byParent.get((node.node_token ?? "").trim()) ?? [];
      for (const child of children) {
        walk(child, nextChain);
      }
    };
    for (const root of roots) {
      walk(root, []);
    }
    for (const item of items) {
      const tokenValue = (item.node_token ?? "").trim();
      if (!tokenValue || visited.has(tokenValue)) {
        continue;
      }
      walk(item, []);
    }
    const dedup = /* @__PURE__ */ new Map();
    for (const item of options) {
      if (!dedup.has(item.docToken)) {
        dedup.set(item.docToken, item);
      }
    }
    return [...dedup.values()];
  }
  async listWikiNodesRecursive(accessToken, spaceId, startParentNodeToken) {
    const out = [];
    const queue = [startParentNodeToken ?? ""];
    const visitedParents = /* @__PURE__ */ new Set();
    while (queue.length > 0) {
      const parentNodeToken = queue.shift() ?? "";
      const parentKey = parentNodeToken || "__root__";
      if (visitedParents.has(parentKey)) {
        continue;
      }
      visitedParents.add(parentKey);
      let pageToken = "";
      for (let i = 0; i < 20; i += 1) {
        const params = new URLSearchParams();
        params.set("page_size", "50");
        if (pageToken) {
          params.set("page_token", pageToken);
        }
        if (parentNodeToken) {
          params.set("parent_node_token", parentNodeToken);
        }
        const response = await this.request(`/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${params.toString()}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const items = response.data?.items ?? [];
        out.push(...items);
        for (const item of items) {
          const childNodeToken = (item.node_token ?? "").trim();
          if (!childNodeToken) {
            continue;
          }
          if (item.has_child) {
            queue.push(childNodeToken);
          }
        }
        if (!response.data?.has_more) {
          break;
        }
        pageToken = response.data?.page_token ?? "";
        if (!pageToken) {
          break;
        }
      }
    }
    return out;
  }
  async fetchDocument(account, docToken, options) {
    return await this.docDownload.fetchDocument(account, docToken, options);
  }
  async createDocument(account, title, markdown, targetFolderToken, assetContext, mermaidMode, onProgress) {
    return await this.docUpload.createDocument(
      account,
      title,
      markdown,
      targetFolderToken,
      assetContext,
      mermaidMode,
      onProgress
    );
  }
  async updateDocument(account, docToken, markdown) {
    return await this.docUpload.updateDocument(account, docToken, markdown);
  }
  async uploadImages(account, images) {
    return await this.docUpload.uploadImages(account, images);
  }
  async uploadFiles(account, files) {
    return await this.docUpload.uploadFiles(account, files);
  }
  async downloadImages(account, imageRefs, targetFolder) {
    return await this.assets.downloadImages(account, imageRefs, targetFolder);
  }
  async downloadFiles(account, fileRefs, targetFolder) {
    return await this.assets.downloadFiles(account, fileRefs, targetFolder);
  }
  popDownloadedBuffer(localPath) {
    return this.assets.popDownloadedBuffer(localPath);
  }
  async getAccessToken(account) {
    return await this.auth.getAccessToken(account);
  }
  async request(path, init) {
    const maskSensitive = this.shouldMaskSensitiveLogs();
    this.logger?.("request", {
      url: `${this.baseUrl}${path}`,
      method: init.method ?? "GET",
      headers: sanitizeHeaders(init.headers, maskSensitive),
      body: sanitizeBody(init.body, maskSensitive)
    });
    let ok = false;
    let status = 0;
    let payload;
    let responseHeaders = {};
    try {
      if (this.requester) {
        const resp = await this.requester(`${this.baseUrl}${path}`, init);
        ok = resp.ok;
        status = resp.status;
        payload = resp.json;
        responseHeaders = normalizeHeaders(resp.headers);
      } else {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
        ok = response.ok;
        status = response.status;
        payload = await response.json();
        const normalized = {};
        response.headers.forEach((value, key) => {
          normalized[key.toLowerCase()] = value;
        });
        responseHeaders = normalized;
      }
    } catch (error) {
      this.logger?.("error", {
        url: `${this.baseUrl}${path}`,
        method: init.method ?? "GET",
        error: String(error)
      });
      throw error;
    }
    this.logger?.("response", {
      url: `${this.baseUrl}${path}`,
      method: init.method ?? "GET",
      status,
      ok,
      headers: status === 429 ? responseHeaders : void 0,
      payload
    });
    if (!ok) {
      if (status === 429) {
        this.logger?.("error", {
          url: `${this.baseUrl}${path}`,
          method: init.method ?? "GET",
          status,
          headers: responseHeaders,
          payload,
          message: "Feishu API rate limited (HTTP 429)"
        });
      }
      throw new Error(this.buildFeishuErrorMessage(status, payload));
    }
    const parsed = payload;
    if (parsed.code !== 0) {
      throw new Error(this.buildFeishuErrorMessage(status || 200, parsed));
    }
    return parsed;
  }
  shouldMaskSensitiveLogs() {
    if (typeof this.maskSensitiveLogs === "function") {
      return this.maskSensitiveLogs();
    }
    return this.maskSensitiveLogs ?? true;
  }
  async requestText(path, init) {
    if (this.requester) {
      const resp = await this.requester(`${this.baseUrl}${path}`, init);
      if (!resp.ok) {
        throw new Error(`Feishu request failed with HTTP ${resp.status}`);
      }
      if (typeof resp.text === "string") {
        return resp.text;
      }
      return typeof resp.json === "string" ? resp.json : JSON.stringify(resp.json);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Feishu request failed with HTTP ${response.status}`);
    }
    return await response.text();
  }
  async requestBinary(path, init) {
    if (this.requester) {
      const resp = await this.requester(`${this.baseUrl}${path}`, init);
      if (!resp.ok) {
        throw new Error(`Feishu request failed with HTTP ${resp.status}`);
      }
      return {
        status: resp.status,
        headers: normalizeHeaders(resp.headers),
        arrayBuffer: resp.arrayBuffer ?? new ArrayBuffer(0)
      };
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Feishu request failed with HTTP ${response.status}`);
    }
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      arrayBuffer: await response.arrayBuffer()
    };
  }
  buildFeishuErrorMessage(status, payload) {
    const parsed = payload ?? {};
    const apiCode = typeof parsed.code === "number" ? parsed.code : void 0;
    const apiMessage = parsed.msg || parsed.message || parsed.error?.message || "Unknown Feishu API error";
    const logId = parsed.error?.log_id;
    const troubleshooter = parsed.error?.troubleshooter;
    const scopes = (parsed.error?.permission_violations ?? []).map((item) => item?.subject?.trim()).filter((item) => Boolean(item));
    const scopeText = scopes.length > 0 ? `[${scopes.join(", ")}]` : "";
    const parts = [
      `Feishu request failed with HTTP ${status}`,
      apiCode !== void 0 ? `code=${apiCode}` : "",
      `msg=${apiMessage}`,
      logId ? `log_id=${logId}` : "",
      scopeText ? `required_scopes=${scopeText}` : "",
      troubleshooter ? `troubleshooter=${troubleshooter}` : ""
    ].filter((part) => part.length > 0);
    return parts.join(" | ");
  }
};

// src/utils/obfuscation.ts
var OBFUSCATION_PREFIX = "fs1:";
function obfuscateSecret(secret) {
  return `${OBFUSCATION_PREFIX}${Buffer.from(secret, "utf-8").toString("base64")}`;
}
function deobfuscateSecret(value) {
  if (!value.startsWith(OBFUSCATION_PREFIX)) {
    return value;
  }
  const payload = value.slice(OBFUSCATION_PREFIX.length);
  if (!payload) {
    return "";
  }
  return Buffer.from(payload, "base64").toString("utf-8");
}

// src/services/settingsService.ts
var DEFAULT_SETTINGS = {
  accounts: [],
  mappings: [],
  syncLogs: [],
  defaultAssetFolder: "assets/feishu",
  debugNetworkLogs: false,
  maskSensitiveLogs: true,
  uploadAssetThrottleEnabled: true,
  uploadAssetThrottleSeconds: 3,
  upload429RetryLimit: 5,
  upload429RetryDelaySeconds: 10
};
function normalizeSettings(data) {
  if (!data || typeof data !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const incoming = data;
  return {
    accounts: incoming.accounts ?? [],
    mappings: incoming.mappings ?? [],
    syncLogs: incoming.syncLogs ?? [],
    defaultAssetFolder: incoming.defaultAssetFolder ?? DEFAULT_SETTINGS.defaultAssetFolder,
    debugNetworkLogs: incoming.debugNetworkLogs ?? DEFAULT_SETTINGS.debugNetworkLogs,
    maskSensitiveLogs: incoming.maskSensitiveLogs ?? DEFAULT_SETTINGS.maskSensitiveLogs,
    uploadAssetThrottleEnabled: incoming.uploadAssetThrottleEnabled ?? DEFAULT_SETTINGS.uploadAssetThrottleEnabled,
    uploadAssetThrottleSeconds: clampNumber(
      incoming.uploadAssetThrottleSeconds,
      DEFAULT_SETTINGS.uploadAssetThrottleSeconds,
      0,
      60
    ),
    upload429RetryLimit: clampNumber(
      incoming.upload429RetryLimit,
      DEFAULT_SETTINGS.upload429RetryLimit,
      0,
      20
    ),
    upload429RetryDelaySeconds: clampNumber(
      incoming.upload429RetryDelaySeconds,
      DEFAULT_SETTINGS.upload429RetryDelaySeconds,
      1,
      120
    )
  };
}
function buildLegacyAccountId(account, index) {
  const seedRaw = (account.id ?? account.appId ?? account.name ?? `legacy-${index + 1}`).toString().trim();
  const safe = seedRaw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe ? `account-${safe}` : `account-legacy-${index + 1}`;
}
function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
function toRuntimeAccount(account, index) {
  return {
    id: typeof account.id === "string" && account.id.trim() ? account.id : buildLegacyAccountId(account, index),
    name: account.name ?? `Account ${index + 1}`,
    appId: account.appId ?? "",
    appSecret: deobfuscateSecret(account.appSecretObfuscated ?? ""),
    authMode: account.authMode ?? "remote_bridge",
    remoteAuthUrl: account.remoteAuthUrl ?? "",
    remoteAuthApiKey: account.remoteAuthApiKeyObfuscated ? deobfuscateSecret(account.remoteAuthApiKeyObfuscated) : "",
    redirectUri: account.redirectUri ?? "",
    oauthScopes: account.oauthScopes ?? "",
    authType: "user",
    userAccessToken: account.userAccessTokenObfuscated ? deobfuscateSecret(account.userAccessTokenObfuscated) : "",
    userRefreshToken: account.userRefreshTokenObfuscated ? deobfuscateSecret(account.userRefreshTokenObfuscated) : "",
    userTokenExpireAt: account.userTokenExpireAt ?? 0,
    userOpenId: account.userOpenId ?? "",
    userName: account.userName ?? "",
    lastAuthError: account.lastAuthError ?? "",
    lastAuthErrorAt: account.lastAuthErrorAt ?? 0,
    lastAuthCheckAt: account.lastAuthCheckAt ?? 0,
    enabled: typeof account.enabled === "boolean" ? account.enabled : true
  };
}
var SettingsService = class {
  constructor(adapter) {
    this.adapter = adapter;
  }
  async load() {
    const raw = await this.adapter.loadData();
    const normalized = normalizeSettings(raw);
    return {
      accounts: normalized.accounts.map((account, index) => toRuntimeAccount(account, index)),
      mappings: normalized.mappings,
      syncLogs: normalized.syncLogs,
      defaultAssetFolder: normalized.defaultAssetFolder,
      debugNetworkLogs: normalized.debugNetworkLogs,
      maskSensitiveLogs: normalized.maskSensitiveLogs,
      uploadAssetThrottleEnabled: normalized.uploadAssetThrottleEnabled,
      uploadAssetThrottleSeconds: normalized.uploadAssetThrottleSeconds,
      upload429RetryLimit: normalized.upload429RetryLimit,
      upload429RetryDelaySeconds: normalized.upload429RetryDelaySeconds
    };
  }
  async save(settings) {
    const payload = {
      accounts: settings.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        appId: account.appId,
        appSecretObfuscated: obfuscateSecret(account.appSecret),
        authMode: account.authMode ?? "remote_bridge",
        remoteAuthUrl: account.remoteAuthUrl ?? "",
        remoteAuthApiKeyObfuscated: account.remoteAuthApiKey ? obfuscateSecret(account.remoteAuthApiKey) : "",
        redirectUri: account.redirectUri ?? "",
        oauthScopes: account.oauthScopes ?? "",
        authType: "user",
        userAccessTokenObfuscated: account.userAccessToken ? obfuscateSecret(account.userAccessToken) : "",
        userRefreshTokenObfuscated: account.userRefreshToken ? obfuscateSecret(account.userRefreshToken) : "",
        userTokenExpireAt: account.userTokenExpireAt ?? 0,
        userOpenId: account.userOpenId ?? "",
        userName: account.userName ?? "",
        lastAuthError: account.lastAuthError ?? "",
        lastAuthErrorAt: account.lastAuthErrorAt ?? 0,
        lastAuthCheckAt: account.lastAuthCheckAt ?? 0,
        enabled: account.enabled
      })),
      mappings: settings.mappings,
      syncLogs: settings.syncLogs,
      defaultAssetFolder: settings.defaultAssetFolder,
      debugNetworkLogs: settings.debugNetworkLogs,
      maskSensitiveLogs: settings.maskSensitiveLogs,
      uploadAssetThrottleEnabled: settings.uploadAssetThrottleEnabled,
      uploadAssetThrottleSeconds: settings.uploadAssetThrottleSeconds,
      upload429RetryLimit: settings.upload429RetryLimit,
      upload429RetryDelaySeconds: settings.upload429RetryDelaySeconds
    };
    await this.adapter.saveData(payload);
  }
};

// src/services/mappingService.ts
var MappingService = class {
  constructor(mappings) {
    this.mappings = mappings;
  }
  findByLocalPath(localPath) {
    return this.mappings.find((mapping) => mapping.localPath === localPath);
  }
  findByRemote(accountId, docToken) {
    return this.mappings.find(
      (mapping) => mapping.accountId === accountId && mapping.docToken === docToken
    );
  }
  upsert(entry) {
    const index = this.mappings.findIndex((mapping) => mapping.localPath === entry.localPath);
    if (index < 0) {
      return [...this.mappings, entry];
    }
    const next = [...this.mappings];
    next[index] = entry;
    return next;
  }
};

// src/utils/path.ts
function resolveDefaultDownloadDir(activeFilePath, fallbackFolder) {
  if (!activeFilePath) {
    return fallbackFolder;
  }
  const segments = activeFilePath.split("/");
  if (segments.length <= 1) {
    return fallbackFolder;
  }
  segments.pop();
  return segments.join("/") || fallbackFolder;
}
function buildAssetFolder(baseDir, assetFolderName) {
  return `${baseDir.replace(/\/$/, "")}/${assetFolderName.replace(/^\//, "")}`;
}

// src/services/syncOrchestrator.ts
var SyncOrchestrator = class {
  constructor(deps) {
    this.deps = deps;
  }
  async uploadCurrentFile() {
    const progress = this.deps.ui.openUploadProgress?.();
    const updateProgress = (percent, stage, detail) => {
      progress?.update(percent, stage, detail);
    };
    try {
      updateProgress(3, "\u51C6\u5907\u4E0A\u4F20", "\u6B63\u5728\u9009\u62E9\u8D26\u53F7...");
      const settings = this.deps.getSettings();
      const enabledAccounts = settings.accounts.filter((account2) => account2.enabled);
      let account = null;
      let preselectedUpload;
      if (enabledAccounts.length > 1 && this.deps.ui.selectUploadWikiTargetWithAccount) {
        const combined = await this.deps.ui.selectUploadWikiTargetWithAccount(enabledAccounts, {
          loadLibraries: async (accountId) => {
            const target = enabledAccounts.find((item) => item.id === accountId);
            if (!target)
              return [];
            return await this.deps.feishu.listRootFolders(target);
          },
          loadChildren: async (accountId, libraryToken) => {
            const target = enabledAccounts.find((item) => item.id === accountId);
            if (!target)
              return [];
            return await this.deps.feishu.listChildFolders(target, libraryToken);
          }
        });
        if (!combined) {
          progress?.close();
          return { result: "skipped", message: "No account selected." };
        }
        account = enabledAccounts.find((item) => item.id === combined.accountId) ?? null;
        preselectedUpload = {
          folderToken: combined.folderToken || combined.libraryToken,
          mermaidMode: combined.mermaidMode
        };
      } else {
        account = await this.selectAccount(settings.accounts);
      }
      if (!account) {
        progress?.close();
        return { result: "skipped", message: "No account selected." };
      }
      updateProgress(8, "\u8BFB\u53D6\u672C\u5730\u6587\u6863", "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u7F16\u8F91\u6587\u4EF6...");
      const activePath = this.deps.vault.getActiveFilePath();
      if (!activePath) {
        progress?.close();
        return { result: "skipped", message: "No active file." };
      }
      const normalizedPath = normalizePath(activePath);
      const localMtime = await this.deps.vault.getFileMtime(normalizedPath);
      const rawMarkdown = await this.deps.vault.readFile(normalizedPath);
      void this.replaceLocalAssets;
      updateProgress(14, "\u9009\u62E9\u4E0A\u4F20\u4F4D\u7F6E", "\u6B63\u5728\u9009\u62E9 Wiki \u7A7A\u95F4\u548C\u8282\u70B9...");
      const uploadTarget = preselectedUpload ?? await this.selectUploadTarget(account);
      if (!uploadTarget) {
        progress?.close();
        return { result: "skipped", message: "Upload canceled: no wiki target selected." };
      }
      const markdown = rawMarkdown;
      const baseTitle = deriveTitle(normalizedPath);
      updateProgress(20, "\u68C0\u67E5\u6807\u9898", "\u6B63\u5728\u5206\u914D\u552F\u4E00\u6587\u6863\u6807\u9898...");
      const uniqueTitle = await this.allocateUniqueRemoteTitle(account, uploadTarget.folderToken, baseTitle);
      updateProgress(24, "\u521B\u5EFA\u7EBF\u4E0A\u6587\u6863", "\u6B63\u5728\u521B\u5EFA\u5E76\u5199\u5165\u6587\u6863\u5185\u5BB9...");
      const created = await this.deps.feishu.createDocument(
        account,
        uniqueTitle,
        markdown,
        uploadTarget.folderToken,
        {
          baseFilePath: normalizedPath,
          fileExists: async (path) => await this.deps.vault.fileExists(path),
          readBinary: async (path) => await this.deps.vault.readBinary(path)
        },
        uploadTarget.mermaidMode,
        (update) => {
          const mapped = 24 + Math.floor(Math.max(0, Math.min(100, update.percent)) / 100 * 70);
          updateProgress(mapped, update.stage, update.detail);
        }
      );
      const previous = new MappingService(settings.mappings).findByLocalPath(normalizedPath);
      const mapping = {
        localPath: normalizedPath,
        accountId: account.id,
        docToken: created.docToken,
        docTitle: created.title,
        lastSyncAt: previous?.lastSyncAt ?? 0,
        lastLocalMtime: previous?.lastLocalMtime ?? 0,
        lastRemoteMtime: previous?.lastRemoteMtime ?? 0
      };
      const result = await this.complete(
        settings,
        "upload",
        mapping,
        localMtime,
        created.updatedAt,
        "success",
        "Upload completed as new wiki document.",
        false
      );
      updateProgress(98, "\u5199\u5165\u6620\u5C04\u8BB0\u5F55", "\u6B63\u5728\u4FDD\u5B58\u540C\u6B65\u5173\u7CFB...");
      updateProgress(100, "\u4E0A\u4F20\u5B8C\u6210", "\u6587\u6863\u4E0A\u4F20\u6210\u529F\u3002");
      progress?.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.deps.ui.showUploadSuccess) {
        await this.deps.ui.showUploadSuccess(
          created.title,
          created.docUrl ?? `https://feishu.cn/docx/${encodeURIComponent(created.docToken)}`
        );
      } else {
        this.deps.ui.notice("Upload completed as new wiki document.");
      }
      return result;
    } catch (error) {
      progress?.close();
      return { result: "failed", message: `Upload failed: ${String(error)}` };
    }
  }
  async downloadToLocal() {
    try {
      const settings = this.deps.getSettings();
      const enabledAccounts = settings.accounts.filter((account2) => account2.enabled);
      let account = null;
      let selected;
      const activePath = this.deps.vault.getActiveFilePath();
      const defaultDir = resolveDefaultDownloadDir(activePath, "/");
      const mappingService = new MappingService(settings.mappings);
      const existingMapping = activePath ? mappingService.findByLocalPath(normalizePath(activePath)) : void 0;
      if (enabledAccounts.length > 1 && this.deps.ui.promptRemoteDocumentWithAccount) {
        const combined = await this.deps.ui.promptRemoteDocumentWithAccount(enabledAccounts, {
          defaultDirectory: defaultDir,
          defaultDocToken: existingMapping?.docToken,
          loadSpaces: async (accountId) => {
            const target = enabledAccounts.find((item) => item.id === accountId);
            if (!target)
              return [];
            return await this.deps.feishu.listRootFolders(target);
          },
          loadWikiDocuments: async (accountId, spaceToken) => {
            const target = enabledAccounts.find((item) => item.id === accountId);
            if (!target)
              return [];
            return await this.deps.feishu.listWikiDocumentsInSpace(target, spaceToken);
          }
        });
        if (!combined) {
          return { result: "skipped", message: "No account selected." };
        }
        account = enabledAccounts.find((item) => item.id === combined.accountId) ?? null;
        selected = {
          docToken: combined.docToken,
          targetDirectory: combined.targetDirectory,
          sheetAsExcel: combined.sheetAsExcel
        };
      } else {
        account = await this.selectAccount(settings.accounts);
        if (!account) {
          return { result: "skipped", message: "No account selected." };
        }
        const spaces = await this.deps.feishu.listRootFolders(account);
        selected = await this.deps.ui.promptRemoteDocument(account, {
          defaultDirectory: defaultDir,
          defaultDocToken: existingMapping?.docToken,
          spaces,
          loadWikiDocuments: async (spaceToken) => await this.deps.feishu.listWikiDocumentsInSpace(account, spaceToken)
        });
      }
      if (!account) {
        return { result: "skipped", message: "No account selected." };
      }
      if (!selected) {
        return { result: "skipped", message: "Download canceled: no remote document selected." };
      }
      const normalizedTargetDir = normalizePath(selected.targetDirectory);
      await this.deps.vault.ensureFolder(normalizedTargetDir);
      const remote = await this.deps.feishu.fetchDocument(account, selected.docToken, {
        sheetAsExcel: selected.sheetAsExcel
      });
      const basePath = normalizePath(`${normalizedTargetDir}/${sanitizeFilename2(remote.title)}.md`);
      const localPath = await this.findAvailablePath(basePath);
      const assetFolder = buildAssetFolder(normalizedTargetDir, settings.defaultAssetFolder);
      await this.deps.vault.ensureFolder(assetFolder);
      const downloadedImages = await this.deps.feishu.downloadImages(account, remote.imageUrls, assetFolder);
      for (const image of downloadedImages) {
        const buffer = this.deps.feishu.popDownloadedBuffer?.(image.localPath);
        if (buffer) {
          await this.deps.vault.writeBinary(image.localPath, buffer);
        }
      }
      const downloadedFiles = await this.deps.feishu.downloadFiles(account, remote.fileRefs, assetFolder);
      for (const file of downloadedFiles) {
        const buffer = this.deps.feishu.popDownloadedBuffer?.(file.localPath);
        if (buffer) {
          await this.deps.vault.writeBinary(file.localPath, buffer);
        }
      }
      const content = rewriteMarkdownFileLinks(
        rewriteMarkdownImageUrls(remote.markdown, downloadedImages),
        downloadedFiles
      );
      await this.deps.vault.writeFile(localPath, content);
      const localMtime = await this.deps.vault.getFileMtime(localPath);
      const finalMapping = {
        localPath,
        accountId: account.id,
        docToken: remote.docToken,
        docTitle: remote.title,
        lastSyncAt: existingMapping?.lastSyncAt ?? 0,
        lastLocalMtime: existingMapping?.lastLocalMtime ?? 0,
        lastRemoteMtime: existingMapping?.lastRemoteMtime ?? 0
      };
      return await this.complete(
        settings,
        "download",
        finalMapping,
        localMtime,
        remote.updatedAt,
        "success",
        "Download completed."
      );
    } catch (error) {
      return { result: "failed", message: `Download failed: ${String(error)}` };
    }
  }
  async replaceLocalAssets(account, markdown, filePath) {
    const imagePaths = await resolveLocalAssetPaths(
      this.deps.vault.fileExists,
      filePath,
      extractLocalImageLinks(markdown)
    );
    const filePaths = await resolveLocalAssetPaths(
      this.deps.vault.fileExists,
      filePath,
      extractLocalFileLinks(markdown)
    );
    if (imagePaths.length === 0 && filePaths.length === 0) {
      return markdown;
    }
    let output = markdown;
    if (imagePaths.length > 0) {
      const imagePayloads = await Promise.all(
        imagePaths.map(async (path) => ({
          localPath: path,
          bytes: await this.deps.vault.readBinary(path)
        }))
      );
      const imageReplacements = await this.deps.feishu.uploadImages(account, imagePayloads);
      output = rewriteImageLinks(output, filePath, imageReplacements);
    }
    if (filePaths.length > 0) {
      const filePayloads = await Promise.all(
        filePaths.map(async (path) => ({
          localPath: path,
          bytes: await this.deps.vault.readBinary(path)
        }))
      );
      const fileReplacements = await this.deps.feishu.uploadFiles(account, filePayloads);
      output = rewriteFileLinks(output, filePath, fileReplacements);
    }
    return output;
  }
  async allocateUniqueRemoteTitle(account, targetToken, baseTitle) {
    const normalizedBase = baseTitle.trim() || "Untitled";
    const parsedTarget = parseWikiTargetToken(targetToken);
    if (parsedTarget?.spaceId) {
      const inSpace = await this.deps.feishu.listWikiDocumentsInSpace(
        account,
        encodeWikiSpaceToken(parsedTarget.spaceId)
      );
      const existing = new Set(
        inSpace.map((item) => (item.leafTitle ?? item.title ?? "").trim()).filter((title) => title.length > 0)
      );
      if (!existing.has(normalizedBase)) {
        return normalizedBase;
      }
      for (let i = 1; i <= 999; i += 1) {
        const candidate = `${normalizedBase}-${String(i).padStart(2, "0")}`;
        if (!existing.has(candidate)) {
          return candidate;
        }
      }
      throw new Error(`Unable to allocate unique remote title for ${normalizedBase}`);
    }
    const exact = await this.deps.feishu.listWikiDocumentsByTitle(account, targetToken, normalizedBase);
    if (exact.length === 0) {
      return normalizedBase;
    }
    for (let i = 1; i <= 999; i += 1) {
      const candidate = `${normalizedBase}-${String(i).padStart(2, "0")}`;
      const found = await this.deps.feishu.listWikiDocumentsByTitle(account, targetToken, candidate);
      if (found.length === 0) {
        return candidate;
      }
    }
    throw new Error(`Unable to allocate unique remote title for ${normalizedBase}`);
  }
  async complete(settings, direction, mapping, localMtime, remoteMtime, result, message, notify = true) {
    const now = this.deps.now();
    const updatedMapping = {
      ...mapping,
      lastSyncAt: now,
      lastLocalMtime: localMtime,
      lastRemoteMtime: remoteMtime
    };
    settings.mappings = new MappingService(settings.mappings).upsert(updatedMapping);
    settings.syncLogs = [
      {
        time: now,
        direction,
        accountId: mapping.accountId,
        localPath: mapping.localPath,
        docToken: mapping.docToken,
        result,
        message
      },
      ...settings.syncLogs
    ].slice(0, 100);
    await this.deps.saveSettings(settings);
    if (notify) {
      this.deps.ui.notice(message);
    }
    return { result, message };
  }
  async selectAccount(accounts) {
    const enabled = accounts.filter((account) => account.enabled);
    console.log("[FeishuSync][account:select:start]", {
      totalAccounts: accounts.length,
      enabledCount: enabled.length,
      enabledAccounts: enabled.map((account) => ({
        id: account.id,
        name: account.name,
        appId: account.appId
      }))
    });
    if (enabled.length === 0) {
      console.log("[FeishuSync][account:select:skipped_no_enabled]");
      return null;
    }
    if (enabled.length === 1) {
      console.log("[FeishuSync][account:select:auto_single]", {
        id: enabled[0].id,
        name: enabled[0].name,
        appId: enabled[0].appId
      });
      return enabled[0];
    }
    const selectedId = await this.deps.ui.selectAccount(enabled);
    console.log("[FeishuSync][account:select:modal_return]", {
      selectedId,
      selectedType: typeof selectedId
    });
    if (!selectedId) {
      console.log("[FeishuSync][account:select:cancelled_or_empty]");
      return null;
    }
    const matched = enabled.find(
      (account) => account.id === selectedId || !!account.appId && account.appId === selectedId || account.name === selectedId
    ) ?? null;
    console.log("[FeishuSync][account:select:matched]", {
      selectedId,
      matched: matched ? { id: matched.id, name: matched.name, appId: matched.appId } : null
    });
    return matched;
  }
  async selectUploadTarget(account) {
    const libraries = await this.deps.feishu.listRootFolders(account);
    if (libraries.length === 0) {
      this.deps.ui.notice("\u672A\u8BFB\u53D6\u5230\u53EF\u7528 Wiki \u6587\u6863\u5E93\uFF0C\u8BF7\u624B\u5DE5\u8F93\u5165 Wiki \u76EE\u6807\u3002");
      const manualToken = await this.deps.ui.promptUploadFolderToken();
      const normalized = (manualToken ?? "").trim();
      if (!normalized) {
        return null;
      }
      return { folderToken: normalized, mermaidMode: "text" };
    }
    const selected = await this.deps.ui.selectUploadWikiTarget(
      libraries,
      async (libraryToken) => await this.deps.feishu.listChildFolders(account, libraryToken)
    );
    if (!selected) {
      return null;
    }
    return {
      folderToken: selected.folderToken || selected.libraryToken,
      mermaidMode: selected.mermaidMode
    };
  }
  async findAvailablePath(basePath) {
    const dotIndex = basePath.lastIndexOf(".");
    const stemRaw = dotIndex > 0 ? basePath.slice(0, dotIndex) : basePath;
    const ext = dotIndex > 0 ? basePath.slice(dotIndex) : "";
    const stem = stemRaw.replace(/-\d{2,}$/u, "");
    const cleanBase = `${stem}${ext}`;
    if (!await this.deps.vault.fileExists(cleanBase)) {
      return cleanBase;
    }
    for (let index = 1; index < 1e3; index += 1) {
      const candidate = `${stem}-${String(index).padStart(2, "0")}${ext}`;
      if (!await this.deps.vault.fileExists(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Unable to allocate unique local filename for ${basePath}`);
  }
};
function deriveTitle(localPath) {
  const normalized = normalizePath(localPath);
  const filename = normalized.split("/").pop() ?? normalized;
  return filename.replace(/\.md$/i, "") || "Untitled";
}
function normalizePath(value) {
  const raw = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const isAbsolute = raw.startsWith("/");
  const parts = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push("..");
      }
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  return isAbsolute ? joined ? `/${joined}` : "/" : joined;
}
function sanitizeFilename2(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "downloaded";
}
function extractLocalImageLinks(markdown) {
  const links = [];
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match = regex.exec(markdown);
  while (match) {
    const link = normalizeLinkTarget(match[1]);
    if (isUploadableLocalLink(link)) {
      links.push(link);
    }
    match = regex.exec(markdown);
  }
  return links;
}
function extractLocalFileLinks(markdown) {
  const links = [];
  const regex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match = regex.exec(markdown);
  while (match) {
    const raw = match[1].trim();
    const link = normalizeLinkTarget(raw);
    if (!link || !isUploadableLocalLink(link) || isMarkdownLink(link)) {
      match = regex.exec(markdown);
      continue;
    }
    links.push(link);
    match = regex.exec(markdown);
  }
  return links;
}
function resolveRelativePath(baseFilePath, assetPath) {
  if (assetPath.startsWith("/")) {
    return stripLeadingSlash(assetPath);
  }
  const baseDir = baseFilePath.split("/").slice(0, -1).join("/");
  return `${baseDir}/${assetPath}`;
}
async function resolveLocalAssetPaths(fileExists, baseFilePath, links) {
  const output = [];
  const seen = /* @__PURE__ */ new Set();
  for (const link of links) {
    const direct = normalizePath(stripLeadingSlash(link));
    const relative = normalizePath(resolveRelativePath(baseFilePath, link));
    const chosen = direct && await fileExists(direct) ? direct : relative;
    if (!seen.has(chosen)) {
      seen.add(chosen);
      output.push(chosen);
    }
  }
  return output;
}
function rewriteImageLinks(markdown, filePath, replacements) {
  if (replacements.size === 0) {
    return markdown;
  }
  return markdown.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (full, path) => {
    const target = normalizeLinkTarget(path);
    if (!target) {
      return full;
    }
    const replacement = findReplacementByCandidates(replacements, filePath, target);
    if (!replacement) {
      return full;
    }
    return full.replace(path, replacement);
  });
}
function rewriteFileLinks(markdown, filePath, replacements) {
  if (replacements.size === 0) {
    return markdown;
  }
  return markdown.replace(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g, (full, path) => {
    const target = normalizeLinkTarget(path);
    if (!target || !isUploadableLocalLink(target) || isMarkdownLink(target)) {
      return full;
    }
    const replacement = findReplacementByCandidates(replacements, filePath, target);
    if (!replacement) {
      return full;
    }
    return full.replace(path, replacement);
  });
}
function rewriteMarkdownImageUrls(markdown, replacements) {
  if (replacements.length === 0) {
    return markdown;
  }
  let output = markdown;
  for (const replacement of replacements) {
    output = output.split(replacement.originalUrl).join(replacement.localPath);
  }
  return output;
}
function rewriteMarkdownFileLinks(markdown, replacements) {
  if (replacements.length === 0) {
    return markdown;
  }
  let output = markdown;
  for (const replacement of replacements) {
    const filename = replacement.localPath.split("/").pop() ?? "file";
    output = output.split(replacement.placeholder).join(`[${filename}](${replacement.localPath})`);
  }
  return output;
}
function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value);
}
function normalizeLinkTarget(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  return unwrapped.split(/\s+/)[0] ?? "";
}
function isUploadableLocalLink(value) {
  if (!value) {
    return false;
  }
  return !isRemoteUrl(value) && !value.startsWith("#") && !/^mailto:/i.test(value) && !/^data:/i.test(value);
}
function isMarkdownLink(value) {
  const core = value.split(/[?#]/)[0] ?? value;
  return /\.md$/i.test(core);
}
function stripLeadingSlash(value) {
  return value.startsWith("/") ? value.slice(1) : value;
}
function findReplacementByCandidates(replacements, filePath, target) {
  const direct = normalizePath(stripLeadingSlash(target));
  const relative = normalizePath(resolveRelativePath(filePath, target));
  return replacements.get(direct) ?? replacements.get(relative);
}

// src/ui/modals.ts
var import_obsidian = require("obsidian");

// src/utils/folders.ts
function normalizeFolderPaths(paths) {
  const filtered = paths.filter((path) => path.length > 0).filter((path) => !containsAssetsSegment(path)).filter((path) => path !== "/").sort((a, b) => a.localeCompare(b));
  return ["/", ...Array.from(new Set(filtered))];
}
function containsAssetsSegment(path) {
  return path.split("/").includes("assets");
}

// src/ui/modals.ts
var AccountSelectModal = class extends import_obsidian.SuggestModal {
  constructor(app, accounts) {
    super(app);
    this.accounts = accounts;
    this.resolver = null;
    this.selectedAccountId = null;
    this.setPlaceholder("\u9009\u62E9\u98DE\u4E66\u8D26\u53F7");
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.selectedAccountId = null;
      this.open();
    });
  }
  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    return this.accounts.filter((account) => account.name.toLowerCase().includes(normalized));
  }
  renderSuggestion(value, el) {
    el.createEl("div", { text: value.name });
    el.createEl("small", { text: value.appId });
  }
  onChooseSuggestion(item) {
    console.log("[FeishuSync][account:modal:choose]", {
      id: item.id,
      name: item.name,
      appId: item.appId
    });
    this.selectedAccountId = item.id;
    this.close();
  }
  onClose() {
    console.log("[FeishuSync][account:modal:close]", {
      resolved: !this.resolver,
      selectedAccountId: this.selectedAccountId
    });
    if (this.resolver) {
      this.resolver(this.selectedAccountId);
      this.resolver = null;
    }
    this.selectedAccountId = null;
  }
};
var UnmappedNameDecisionModal = class extends import_obsidian.SuggestModal {
  constructor(app, candidates) {
    super(app);
    this.candidates = candidates;
    this.resolver = null;
    this.setPlaceholder("\u9009\u62E9\u7ED1\u5B9A\u5DF2\u6709\u6587\u6863\u6216\u521B\u5EFA\u65B0\u6587\u6863");
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    const filtered = this.candidates.filter((doc) => doc.title.toLowerCase().includes(normalized));
    return [...filtered, null];
  }
  renderSuggestion(value, el) {
    if (!value) {
      el.createEl("div", { text: "\u521B\u5EFA\u65B0\u6587\u6863" });
      return;
    }
    el.createEl("div", { text: value.title });
    el.createEl("small", { text: `DocToken: ${value.docToken}` });
  }
  onChooseSuggestion(item) {
    if (!item) {
      this.resolver?.({ action: "create" });
    } else {
      this.resolver?.({ action: "bind", docToken: item.docToken, docTitle: item.title });
    }
    this.resolver = null;
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
var OptionModal = class extends import_obsidian.Modal {
  constructor(app, titleText, description, options) {
    super(app);
    this.titleText = titleText;
    this.description = description;
    this.options = options;
    this.resolver = null;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.description });
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; flex-wrap: wrap;");
    for (const option of this.options) {
      const button = new import_obsidian.ButtonComponent(actions);
      button.setButtonText(option.label).onClick(() => {
        this.resolver?.(option.value);
        this.resolver = null;
        this.close();
      });
      if (option.cta) {
        button.setCta();
      }
    }
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
var TextPromptModal = class extends import_obsidian.Modal {
  constructor(app, titleText, placeholder, initialValue) {
    super(app);
    this.titleText = titleText;
    this.placeholder = placeholder;
    this.initialValue = initialValue;
    this.resolver = null;
    this.input = null;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    this.contentEl.empty();
    const row = this.contentEl.createDiv();
    row.setAttr("style", "margin: 8px 0 16px;");
    this.input = new import_obsidian.TextComponent(row);
    this.input.setPlaceholder(this.placeholder);
    this.input.setValue(this.initialValue);
    this.input.inputEl.setAttr("style", "width: 100%;");
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      const value = this.input?.getValue().trim() ?? "";
      this.resolver?.(value || null);
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
function isAssetsFolder(path) {
  const segments = path.split("/").map((segment) => segment.trim().toLowerCase()).filter((segment) => segment.length > 0);
  return segments.includes("assets");
}
function listVaultFolders(app) {
  const rawFolders = app.vault.getAllLoadedFiles().filter((item) => item instanceof import_obsidian.TFolder).map((folder) => folder.path).filter((path) => path.length > 0).filter((path) => !isAssetsFolder(path));
  return normalizeFolderPaths(rawFolders);
}
async function askConflictDecision(app) {
  const modal = new OptionModal(app, "\u68C0\u6D4B\u5230\u51B2\u7A81", "\u672C\u5730\u4E0E\u98DE\u4E66\u6587\u6863\u90FD\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u9009\u62E9\u5904\u7406\u65B9\u5F0F", [
    { value: "localWins", label: "\u4EE5\u672C\u5730\u4E3A\u51C6", cta: true },
    { value: "remoteWins", label: "\u4EE5\u98DE\u4E66\u4E3A\u51C6" },
    { value: "saveCopy", label: "\u53E6\u5B58\u526F\u672C" },
    { value: "cancel", label: "\u53D6\u6D88" }
  ]);
  const value = await modal.ask();
  return value ?? "cancel";
}
var UploadWikiTargetModal = class extends import_obsidian.Modal {
  constructor(app, libraries, loadChildren) {
    super(app);
    this.libraries = libraries;
    this.loadChildren = loadChildren;
    this.resolver = null;
    this.selectedMermaidMode = "text";
    this.folderSelectEl = null;
    this.selectedLibraryToken = libraries[0]?.token ?? "";
    this.selectedFolderToken = this.selectedLibraryToken;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u9009\u62E9 Wiki \u4E0A\u4F20\u4F4D\u7F6E");
    this.contentEl.empty();
    const form = this.contentEl.createDiv();
    form.setAttr("style", "display:flex; flex-direction:column; gap: 12px; margin: 8px 0 16px;");
    const libraryLabel = form.createEl("label", { text: "\u6587\u6863\u5E93" });
    libraryLabel.setAttr("style", "font-weight: 600;");
    const librarySelect = form.createEl("select");
    librarySelect.setAttr("style", "width: 100%; padding: 8px;");
    for (const library of this.libraries) {
      const option = librarySelect.createEl("option", { text: library.name });
      option.value = library.token;
    }
    librarySelect.value = this.selectedLibraryToken;
    librarySelect.onchange = async () => {
      this.selectedLibraryToken = librarySelect.value;
      await this.reloadChildren();
    };
    const folderLabel = form.createEl("label", { text: "\u5B50\u8282\u70B9\uFF08\u53EF\u9009\uFF09" });
    folderLabel.setAttr("style", "font-weight: 600;");
    this.folderSelectEl = form.createEl("select");
    this.folderSelectEl.setAttr("size", "10");
    this.folderSelectEl.setAttr(
      "style",
      "width: 100%; padding: 8px; min-height: 220px; overflow-y: auto;"
    );
    const mermaidLabel = form.createEl("label", { text: "Mermaid \u4E0A\u4F20\u6A21\u5F0F" });
    mermaidLabel.setAttr("style", "font-weight: 600;");
    const mermaidGroup = form.createDiv();
    mermaidGroup.setAttr("style", "display:flex; gap: 12px; flex-wrap: wrap;");
    const modes = [
      { value: "text", label: "\u6587\u672C\u5757" },
      { value: "image", label: "\u56FE\u7247" },
      { value: "both", label: "\u6587\u672C\u5757\u548C\u56FE\u7247" }
    ];
    for (const mode of modes) {
      const item = mermaidGroup.createEl("label");
      item.setAttr("style", "display:flex; align-items:center; gap:6px;");
      const input = item.createEl("input");
      input.type = "radio";
      input.name = "feishu-mermaid-mode";
      input.value = mode.value;
      input.checked = mode.value === this.selectedMermaidMode;
      input.onchange = () => {
        if (input.checked) {
          this.selectedMermaidMode = mode.value;
        }
      };
      item.createSpan({ text: mode.label });
    }
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      if (!this.selectedLibraryToken) {
        this.resolver?.(null);
      } else {
        this.resolver?.({
          libraryToken: this.selectedLibraryToken,
          folderToken: this.selectedFolderToken || this.selectedLibraryToken,
          mermaidMode: this.selectedMermaidMode
        });
      }
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
    void this.reloadChildren();
  }
  async reloadChildren() {
    if (!this.folderSelectEl) {
      return;
    }
    this.folderSelectEl.empty();
    const rootOption = this.folderSelectEl.createEl("option", { text: "\u6839\u8282\u70B9\uFF08\u9ED8\u8BA4\uFF09" });
    rootOption.value = this.selectedLibraryToken;
    rootOption.selected = true;
    this.selectedFolderToken = this.selectedLibraryToken;
    const children = await this.loadChildren(this.selectedLibraryToken);
    for (const child of children) {
      const option = this.folderSelectEl.createEl("option", { text: child.name });
      option.value = child.token;
    }
    this.folderSelectEl.onchange = () => {
      this.selectedFolderToken = this.folderSelectEl?.value || this.selectedLibraryToken;
    };
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
var UploadSuccessModal = class extends import_obsidian.Modal {
  constructor(app, docTitle, docUrl) {
    super(app);
    this.docTitle = docTitle;
    this.docUrl = docUrl;
    this.resolver = null;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u4E0A\u4F20\u6210\u529F");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `\u6587\u6863\u201C${this.docTitle}\u201D\u5DF2\u6210\u529F\u4E0A\u4F20\u5230\u98DE\u4E66\u4E91\u6587\u6863\u3002`
    });
    const linkInput = this.contentEl.createEl("input");
    linkInput.type = "text";
    linkInput.readOnly = true;
    linkInput.value = this.docUrl;
    linkInput.setAttr("style", "width: 100%; padding: 8px; margin: 8px 0 16px;");
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:center;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u590D\u5236\u94FE\u63A5").setCta().onClick(async () => {
      await navigator.clipboard.writeText(this.docUrl);
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u6253\u5F00\u6587\u6863").onClick(() => {
      window.open(this.docUrl, "_blank");
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u5173\u95ED").onClick(() => {
      this.resolver?.();
      this.resolver = null;
      this.close();
    });
  }
  onClose() {
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }
};
var DownloadTargetModal = class extends import_obsidian.Modal {
  constructor(app, folders, defaultDirectory, spaces, loadWikiDocuments) {
    super(app);
    this.folders = folders;
    this.spaces = spaces;
    this.loadWikiDocuments = loadWikiDocuments;
    this.resolver = null;
    this.selectedDocToken = "";
    this.allDocuments = [];
    this.searchKeyword = "";
    this.docInput = null;
    this.docsSearchInput = null;
    this.docsSelect = null;
    this.statusEl = null;
    this.downloadSheetAsExcel = false;
    this.selectedDirectory = folders.includes(defaultDirectory) ? defaultDirectory : folders[0] ?? "/";
    this.selectedSpaceToken = spaces[0]?.token ?? "";
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u4E0B\u8F7D\u98DE\u4E66\u6587\u6863");
    this.contentEl.empty();
    const form = this.contentEl.createDiv();
    form.setAttr("style", "display:flex; flex-direction:column; gap: 12px;");
    form.createEl("label", { text: "\u672C\u5730\u76EE\u5F55" });
    const directorySelect = form.createEl("select");
    directorySelect.setAttr("style", "width: 100%; padding: 8px;");
    for (const folder of this.folders) {
      const option = directorySelect.createEl("option", { text: folder || "/" });
      option.value = folder;
      if (folder === this.selectedDirectory) {
        option.selected = true;
      }
    }
    directorySelect.onchange = () => {
      this.selectedDirectory = directorySelect.value;
    };
    form.createEl("label", { text: "\u6587\u6863 ID\uFF08\u4F18\u5148\uFF09" });
    this.docInput = new import_obsidian.TextComponent(form.createDiv());
    this.docInput.setPlaceholder("\u4F8B\u5982: doccnxxxxxxxx");
    this.docInput.setValue("");
    this.docInput.inputEl.setAttr("style", "width: 100%;");
    form.createEl("label", { text: "Wiki Space" });
    const spaceSelect = form.createEl("select");
    spaceSelect.setAttr("style", "width: 100%; padding: 8px;");
    const emptySpaceOption = spaceSelect.createEl("option", { text: "\u672A\u9009\u62E9\uFF08\u4EC5\u4F7F\u7528\u6587\u6863ID\uFF09" });
    emptySpaceOption.value = "";
    if (!this.selectedSpaceToken) {
      emptySpaceOption.selected = true;
    }
    for (const space of this.spaces) {
      const option = spaceSelect.createEl("option", { text: space.name });
      option.value = space.token;
      if (space.token === this.selectedSpaceToken) {
        option.selected = true;
      }
    }
    spaceSelect.onchange = async () => {
      this.selectedSpaceToken = spaceSelect.value;
      await this.reloadDocuments();
    };
    form.createEl("label", { text: "Space \u6587\u6863\uFF08\u542B\u5B50\u6587\u6863\uFF09" });
    this.docsSearchInput = new import_obsidian.TextComponent(form.createDiv());
    this.docsSearchInput.setPlaceholder("\u672C\u5730\u641C\u7D22\u6587\u6863\u6807\u9898");
    this.docsSearchInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    this.docsSearchInput.onChange((value) => {
      this.searchKeyword = value.trim().toLowerCase();
      this.renderDocumentOptions();
    });
    this.docsSelect = form.createEl("select");
    this.docsSelect.setAttr("size", "10");
    this.docsSelect.setAttr("style", "width: 100%; padding: 8px; min-height: 220px; overflow-y: auto;");
    this.docsSelect.onchange = () => {
      this.selectedDocToken = this.docsSelect?.value ?? "";
    };
    this.statusEl = form.createEl("small", { text: "\u6587\u6863ID\u4F18\u5148\uFF1B\u82E5\u4E3A\u7A7A\u5219\u4F7F\u7528\u4E0B\u62C9\u9009\u4E2D\u7684\u6587\u6863\u3002" });
    this.statusEl.setAttr("style", "color: var(--text-muted);");
    const sheetOptionWrap = form.createDiv();
    sheetOptionWrap.setAttr("style", "display:flex; align-items:center; gap:8px; margin-top: 2px;");
    const sheetOption = sheetOptionWrap.createEl("input");
    sheetOption.type = "checkbox";
    sheetOption.checked = this.downloadSheetAsExcel;
    sheetOption.onchange = () => {
      this.downloadSheetAsExcel = sheetOption.checked;
    };
    sheetOptionWrap.createSpan({ text: "\u8868\u683C\u4E0B\u8F7D\u4E3A Excel \u9644\u4EF6\uFF08sheet block \u8F6C .xlsx\uFF09" });
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end; margin-top: 16px;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      const manual = this.docInput?.getValue().trim() ?? "";
      const docToken = manual || this.selectedDocToken;
      if (!this.selectedDirectory) {
        this.setStatus("\u8BF7\u9009\u62E9\u672C\u5730\u76EE\u5F55\u3002");
        return;
      }
      if (!docToken) {
        this.setStatus("\u8BF7\u586B\u5199\u6587\u6863ID\uFF0C\u6216\u4ECE Wiki \u6587\u6863\u5217\u8868\u9009\u62E9\u4E00\u4E2A\u3002");
        return;
      }
      this.resolver?.({
        targetDirectory: this.selectedDirectory,
        docToken,
        sheetAsExcel: this.downloadSheetAsExcel
      });
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
    void this.reloadDocuments();
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
  async reloadDocuments() {
    if (!this.docsSelect) {
      return;
    }
    this.docsSelect.empty();
    this.allDocuments = [];
    this.selectedDocToken = "";
    if (!this.selectedSpaceToken) {
      const option = this.docsSelect.createEl("option", { text: "\u672A\u9009\u62E9 Space" });
      option.value = "";
      option.selected = true;
      return;
    }
    const loading = this.docsSelect.createEl("option", { text: "\u52A0\u8F7D\u4E2D..." });
    loading.value = "";
    loading.selected = true;
    try {
      this.allDocuments = await this.loadWikiDocuments(this.selectedSpaceToken);
      this.renderDocumentOptions();
    } catch (error) {
      this.docsSelect.empty();
      const failed = this.docsSelect.createEl("option", { text: "\u6587\u6863\u5217\u8868\u52A0\u8F7D\u5931\u8D25" });
      failed.value = "";
      failed.selected = true;
      this.setStatus(`\u6587\u6863\u5217\u8868\u52A0\u8F7D\u5931\u8D25: ${String(error)}`);
    }
  }
  renderDocumentOptions() {
    if (!this.docsSelect) {
      return;
    }
    this.docsSelect.empty();
    const filtered = this.searchKeyword ? this.allDocuments.filter((doc) => doc.title.toLowerCase().includes(this.searchKeyword)) : this.allDocuments;
    const hint = this.docsSelect.createEl("option", {
      text: filtered.length > 0 ? "\u8BF7\u9009\u62E9\u6587\u6863" : "\u65E0\u5339\u914D\u6587\u6863"
    });
    hint.value = "";
    hint.selected = true;
    for (const doc of filtered) {
      const indent = "\xA0\xA0".repeat(Math.max(0, doc.depth));
      const marker = doc.depth > 0 ? "\u2514 " : "";
      const option = this.docsSelect.createEl("option", { text: `${indent}${marker}${doc.leafTitle}` });
      option.value = doc.docToken;
      option.title = doc.title;
      if (doc.docToken === this.selectedDocToken) {
        option.selected = true;
      }
    }
  }
  setStatus(message) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
};
var UploadProgressModal = class extends import_obsidian.Modal {
  constructor() {
    super(...arguments);
    this.stageEl = null;
    this.percentEl = null;
    this.detailEl = null;
    this.barEl = null;
  }
  onOpen() {
    this.titleEl.setText("\u6B63\u5728\u4E0A\u4F20\u6587\u6863");
    this.contentEl.empty();
    this.stageEl = this.contentEl.createEl("div", { text: "\u51C6\u5907\u4E0A\u4F20..." });
    this.stageEl.setAttr("style", "font-size: 18px; font-weight: 600; text-align: center; margin-top: 20px;");
    this.percentEl = this.contentEl.createEl("div", { text: "0%" });
    this.percentEl.setAttr("style", "font-size: 18px; font-weight: 700; text-align: center; margin-top: 12px;");
    const barWrap = this.contentEl.createDiv();
    barWrap.setAttr(
      "style",
      "width: 100%; height: 14px; background: var(--background-modifier-border); border-radius: 999px; margin: 20px 0 16px; overflow: hidden;"
    );
    this.barEl = barWrap.createDiv();
    this.barEl.setAttr(
      "style",
      "height: 100%; width: 0%; background: linear-gradient(90deg, #7a66ff, #7f5af0); border-radius: 999px;"
    );
    this.detailEl = this.contentEl.createEl("div", { text: "\u4EFB\u52A1\u521B\u5EFA\u4E2D..." });
    this.detailEl.setAttr("style", "font-size: 15px; text-align: center; margin-top: 8px;");
    const tipEl = this.contentEl.createEl("div", { text: "\u8BF7\u4FDD\u6301\u7F51\u7EDC\u8FDE\u63A5\uFF0C\u4E0D\u8981\u5173\u95ED\u6B64\u7A97\u53E3" });
    tipEl.setAttr("style", "font-size: 13px; color: var(--text-muted); text-align: center; margin-top: 12px;");
  }
  updateProgress(percent, stage, detail) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    if (this.stageEl) {
      this.stageEl.setText(stage || "\u5904\u7406\u4E2D...");
    }
    if (this.percentEl) {
      this.percentEl.setText(`${safePercent}%`);
    }
    if (this.detailEl) {
      this.detailEl.setText(detail || "");
    }
    if (this.barEl) {
      this.barEl.setAttr(
        "style",
        `height: 100%; width: ${safePercent}%; background: linear-gradient(90deg, #7a66ff, #7f5af0); border-radius: 999px;`
      );
    }
  }
};
var OAuthAuthorizeModal = class extends import_obsidian.Modal {
  constructor(app, authUrl, beginWaitForCode, openAuthUrl, cancelWaitForCode) {
    super(app);
    this.authUrl = authUrl;
    this.beginWaitForCode = beginWaitForCode;
    this.openAuthUrl = openAuthUrl;
    this.cancelWaitForCode = cancelWaitForCode;
    this.resolver = null;
    this.waiting = false;
    this.statusEl = null;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u98DE\u4E66\u7528\u6237\u8BA4\u8BC1");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "\u8BF7\u5148\u590D\u5236\u6216\u6253\u5F00\u4E0B\u9762\u7684\u6388\u6743\u5730\u5740\u3002\u4F60\u53EF\u4EE5\u7528\u4EFB\u610F\u6D4F\u89C8\u5668\u5B8C\u6210\u767B\u5F55\u6388\u6743\u3002"
    });
    const urlWrap = this.contentEl.createDiv();
    urlWrap.setAttr(
      "style",
      "padding: 8px 10px; border: 1px solid var(--background-modifier-border); border-radius: 6px; word-break: break-all; user-select: text;"
    );
    urlWrap.setText(this.authUrl);
    this.statusEl = this.contentEl.createEl("p", {
      text: "\u7B49\u5F85\u64CD\u4F5C\uFF1A\u53EF\u590D\u5236\u5730\u5740\u6216\u81EA\u52A8\u8DF3\u8F6C\u3002"
    });
    this.statusEl.setAttr("style", "color: var(--text-muted); margin-top: 8px;");
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end; margin-top: 16px;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u590D\u5236\u5730\u5740").onClick(async () => {
      if (this.waiting)
        return;
      await copyText(this.authUrl);
      this.setStatus("\u5DF2\u590D\u5236\u5730\u5740\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u6388\u6743\u3002\u6B63\u5728\u7B49\u5F85\u672C\u5730\u56DE\u8C03...");
      await this.waitForCode();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u81EA\u52A8\u8DF3\u8F6C").setCta().onClick(async () => {
      if (this.waiting)
        return;
      this.openAuthUrl();
      this.setStatus("\u5DF2\u53D1\u8D77\u8DF3\u8F6C\uFF0C\u6B63\u5728\u7B49\u5F85\u672C\u5730\u56DE\u8C03...");
      await this.waitForCode();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u624B\u5DE5\u586BToken").onClick(() => {
      if (this.waiting)
        return;
      this.resolver?.({ mode: "manual" });
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.cancelWaitForCode();
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
  }
  onClose() {
    this.cancelWaitForCode();
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
  async waitForCode() {
    if (this.waiting)
      return;
    this.waiting = true;
    try {
      const code = await this.beginWaitForCode();
      this.resolver?.({ mode: "code", code });
      this.resolver = null;
      this.close();
    } catch (error) {
      this.waiting = false;
      this.setStatus(`\u7B49\u5F85\u56DE\u8C03\u5931\u8D25: ${String(error)}`);
    }
  }
  setStatus(message) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
};
var UploadWikiTargetWithAccountModal = class extends import_obsidian.Modal {
  constructor(app, accounts, loadLibraries, loadChildren) {
    super(app);
    this.accounts = accounts;
    this.loadLibraries = loadLibraries;
    this.loadChildren = loadChildren;
    this.resolver = null;
    this.selectedLibraryToken = "";
    this.selectedFolderToken = "";
    this.selectedMermaidMode = "text";
    this.librarySelectEl = null;
    this.folderSelectEl = null;
    this.statusEl = null;
    this.selectedAccountId = accounts[0]?.id ?? "";
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u9009\u62E9\u8D26\u53F7\u4E0E Wiki \u4E0A\u4F20\u4F4D\u7F6E");
    this.contentEl.empty();
    const form = this.contentEl.createDiv();
    form.setAttr("style", "display:flex; flex-direction:column; gap: 12px; margin: 8px 0 16px;");
    form.createEl("label", { text: "\u8D26\u53F7" }).setAttr("style", "font-weight: 600;");
    const accountSelect = form.createEl("select");
    accountSelect.setAttr("style", "width: 100%; padding: 8px;");
    for (const account of this.accounts) {
      const option = accountSelect.createEl("option", { text: account.name });
      option.value = account.id;
    }
    accountSelect.value = this.selectedAccountId;
    accountSelect.onchange = async () => {
      this.selectedAccountId = accountSelect.value;
      await this.reloadLibraries();
    };
    form.createEl("label", { text: "\u6587\u6863\u5E93" }).setAttr("style", "font-weight: 600;");
    this.librarySelectEl = form.createEl("select");
    this.librarySelectEl.setAttr("style", "width: 100%; padding: 8px;");
    this.librarySelectEl.onchange = async () => {
      this.selectedLibraryToken = this.librarySelectEl?.value ?? "";
      await this.reloadChildren();
    };
    form.createEl("label", { text: "\u5B50\u8282\u70B9\uFF08\u53EF\u9009\uFF09" }).setAttr("style", "font-weight: 600;");
    this.folderSelectEl = form.createEl("select");
    this.folderSelectEl.setAttr("size", "10");
    this.folderSelectEl.setAttr("style", "width: 100%; padding: 8px; min-height: 220px; overflow-y: auto;");
    this.folderSelectEl.onchange = () => {
      this.selectedFolderToken = this.folderSelectEl?.value || this.selectedLibraryToken;
    };
    const mermaidLabel = form.createEl("label", { text: "Mermaid \u4E0A\u4F20\u6A21\u5F0F" });
    mermaidLabel.setAttr("style", "font-weight: 600;");
    const mermaidGroup = form.createDiv();
    mermaidGroup.setAttr("style", "display:flex; gap: 12px; flex-wrap: wrap;");
    for (const mode of [
      { value: "text", label: "\u6587\u672C\u5757" },
      { value: "image", label: "\u56FE\u7247" },
      { value: "both", label: "\u6587\u672C\u5757\u548C\u56FE\u7247" }
    ]) {
      const item = mermaidGroup.createEl("label");
      item.setAttr("style", "display:flex; align-items:center; gap:6px;");
      const input = item.createEl("input");
      input.type = "radio";
      input.name = "feishu-mermaid-mode-with-account";
      input.value = mode.value;
      input.checked = mode.value === this.selectedMermaidMode;
      input.onchange = () => {
        if (input.checked)
          this.selectedMermaidMode = mode.value;
      };
      item.createSpan({ text: mode.label });
    }
    this.statusEl = form.createEl("small", { text: "\u8BF7\u9009\u62E9\u8D26\u53F7\u548C\u6587\u6863\u5E93\u540E\u7EE7\u7EED\u3002" });
    this.statusEl.setAttr("style", "color: var(--text-muted);");
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      if (!this.selectedAccountId || !this.selectedLibraryToken)
        return;
      this.resolver?.({
        accountId: this.selectedAccountId,
        libraryToken: this.selectedLibraryToken,
        folderToken: this.selectedFolderToken || this.selectedLibraryToken,
        mermaidMode: this.selectedMermaidMode
      });
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
    void this.reloadLibraries();
  }
  async reloadLibraries() {
    if (!this.librarySelectEl)
      return;
    this.librarySelectEl.empty();
    try {
      const libraries = await this.loadLibraries(this.selectedAccountId);
      for (const library of libraries) {
        const option = this.librarySelectEl.createEl("option", { text: library.name });
        option.value = library.token;
      }
      this.selectedLibraryToken = libraries[0]?.token ?? "";
      this.librarySelectEl.value = this.selectedLibraryToken;
      await this.reloadChildren();
      if (!this.selectedLibraryToken) {
        this.setStatus("\u672A\u8BFB\u53D6\u5230\u53EF\u7528\u6587\u6863\u5E93\uFF0C\u53EF\u6539\u7528\u624B\u5DE5\u8F93\u5165 token\u3002");
      } else {
        this.setStatus("\u5DF2\u52A0\u8F7D\u6587\u6863\u5E93\u3002");
      }
    } catch (error) {
      const message = toHumanLoadError(error, "\u52A0\u8F7D\u6587\u6863\u5E93\u5931\u8D25");
      this.setStatus(message);
      new import_obsidian.Notice(message, 6e3);
      this.selectedLibraryToken = "";
      this.selectedFolderToken = "";
    }
  }
  async reloadChildren() {
    if (!this.folderSelectEl)
      return;
    this.folderSelectEl.empty();
    if (!this.selectedLibraryToken)
      return;
    const rootOption = this.folderSelectEl.createEl("option", { text: "\u6839\u8282\u70B9\uFF08\u9ED8\u8BA4\uFF09" });
    rootOption.value = this.selectedLibraryToken;
    rootOption.selected = true;
    this.selectedFolderToken = this.selectedLibraryToken;
    try {
      const children = await this.loadChildren(this.selectedAccountId, this.selectedLibraryToken);
      for (const child of children) {
        const option = this.folderSelectEl.createEl("option", { text: child.name });
        option.value = child.token;
      }
    } catch (error) {
      const message = toHumanLoadError(error, "\u52A0\u8F7D\u5B50\u8282\u70B9\u5931\u8D25");
      this.setStatus(message);
      new import_obsidian.Notice(message, 6e3);
    }
  }
  setStatus(message) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
var DownloadTargetWithAccountModal = class extends import_obsidian.Modal {
  constructor(app, accounts, folders, defaultDirectory, loadSpaces, loadWikiDocuments) {
    super(app);
    this.accounts = accounts;
    this.folders = folders;
    this.loadSpaces = loadSpaces;
    this.loadWikiDocuments = loadWikiDocuments;
    this.resolver = null;
    this.selectedSpaceToken = "";
    this.selectedDocToken = "";
    this.allDocuments = [];
    this.searchKeyword = "";
    this.docInput = null;
    this.docsSelect = null;
    this.docsSearchInput = null;
    this.spaceSelect = null;
    this.downloadSheetAsExcel = false;
    this.statusEl = null;
    this.selectedAccountId = accounts[0]?.id ?? "";
    this.selectedDirectory = folders.includes(defaultDirectory) ? defaultDirectory : folders[0] ?? "/";
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u4E0B\u8F7D\u98DE\u4E66\u6587\u6863");
    this.contentEl.empty();
    const form = this.contentEl.createDiv();
    form.setAttr("style", "display:flex; flex-direction:column; gap: 12px;");
    form.createEl("label", { text: "\u8D26\u53F7" });
    const accountSelect = form.createEl("select");
    accountSelect.setAttr("style", "width: 100%; padding: 8px;");
    for (const account of this.accounts) {
      const option = accountSelect.createEl("option", { text: account.name });
      option.value = account.id;
    }
    accountSelect.value = this.selectedAccountId;
    accountSelect.onchange = async () => {
      this.selectedAccountId = accountSelect.value;
      await this.reloadSpaces();
    };
    form.createEl("label", { text: "\u672C\u5730\u76EE\u5F55" });
    const dirSelect = form.createEl("select");
    dirSelect.setAttr("style", "width: 100%; padding: 8px;");
    for (const folder of this.folders) {
      const option = dirSelect.createEl("option", { text: folder || "/" });
      option.value = folder;
      if (folder === this.selectedDirectory)
        option.selected = true;
    }
    dirSelect.onchange = () => {
      this.selectedDirectory = dirSelect.value;
    };
    form.createEl("label", { text: "\u6587\u6863 ID\uFF08\u4F18\u5148\uFF09" });
    this.docInput = new import_obsidian.TextComponent(form.createDiv());
    this.docInput.setPlaceholder("\u4F8B\u5982: doccnxxxxxxxx");
    this.docInput.setValue("");
    this.docInput.inputEl.setAttr("style", "width: 100%;");
    form.createEl("label", { text: "Wiki Space" });
    this.spaceSelect = form.createEl("select");
    this.spaceSelect.setAttr("style", "width: 100%; padding: 8px;");
    this.spaceSelect.onchange = async () => {
      this.selectedSpaceToken = this.spaceSelect?.value ?? "";
      await this.reloadDocuments();
    };
    form.createEl("label", { text: "Space \u6587\u6863\uFF08\u542B\u5B50\u6587\u6863\uFF09" });
    this.docsSearchInput = new import_obsidian.TextComponent(form.createDiv());
    this.docsSearchInput.setPlaceholder("\u672C\u5730\u641C\u7D22\u6587\u6863\u6807\u9898");
    this.docsSearchInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    this.docsSearchInput.onChange((value) => {
      this.searchKeyword = value.trim().toLowerCase();
      this.renderDocumentOptions();
    });
    this.docsSelect = form.createEl("select");
    this.docsSelect.setAttr("size", "10");
    this.docsSelect.setAttr("style", "width: 100%; padding: 8px; min-height: 220px; overflow-y: auto;");
    this.docsSelect.onchange = () => {
      this.selectedDocToken = this.docsSelect?.value ?? "";
    };
    this.statusEl = form.createEl("small", { text: "\u6587\u6863ID\u4F18\u5148\uFF1B\u82E5\u4E3A\u7A7A\u5219\u4F7F\u7528\u4E0B\u62C9\u9009\u4E2D\u7684\u6587\u6863\u3002" });
    this.statusEl.setAttr("style", "color: var(--text-muted);");
    const sheetOptionWrap = form.createDiv();
    sheetOptionWrap.setAttr("style", "display:flex; align-items:center; gap:8px; margin-top: 2px;");
    const sheetOption = sheetOptionWrap.createEl("input");
    sheetOption.type = "checkbox";
    sheetOption.checked = this.downloadSheetAsExcel;
    sheetOption.onchange = () => {
      this.downloadSheetAsExcel = sheetOption.checked;
    };
    sheetOptionWrap.createSpan({ text: "\u8868\u683C\u4E0B\u8F7D\u4E3A Excel \u9644\u4EF6\uFF08sheet block \u8F6C .xlsx\uFF09" });
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end; margin-top: 16px;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      const manual = this.docInput?.getValue().trim() ?? "";
      const docToken = manual || this.selectedDocToken;
      if (!this.selectedAccountId || !docToken)
        return;
      this.resolver?.({
        accountId: this.selectedAccountId,
        targetDirectory: this.selectedDirectory,
        docToken,
        sheetAsExcel: this.downloadSheetAsExcel
      });
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
    void this.reloadSpaces();
  }
  async reloadSpaces() {
    if (!this.spaceSelect)
      return;
    this.spaceSelect.empty();
    const empty = this.spaceSelect.createEl("option", { text: "\u672A\u9009\u62E9\uFF08\u4EC5\u4F7F\u7528\u6587\u6863ID\uFF09" });
    empty.value = "";
    empty.selected = true;
    this.selectedSpaceToken = "";
    try {
      const spaces = await this.loadSpaces(this.selectedAccountId);
      for (const space of spaces) {
        const option = this.spaceSelect.createEl("option", { text: space.name });
        option.value = space.token;
      }
      this.setStatus("\u5DF2\u52A0\u8F7D Wiki Space\u3002");
    } catch (error) {
      const message = toHumanLoadError(error, "\u52A0\u8F7D Wiki Space \u5931\u8D25");
      this.setStatus(message);
      new import_obsidian.Notice(message, 6e3);
    }
    await this.reloadDocuments();
  }
  async reloadDocuments() {
    if (!this.docsSelect)
      return;
    this.docsSelect.empty();
    this.allDocuments = [];
    this.selectedDocToken = "";
    if (!this.selectedSpaceToken) {
      const option = this.docsSelect.createEl("option", { text: "\u672A\u9009\u62E9 Space" });
      option.value = "";
      option.selected = true;
      return;
    }
    const loading = this.docsSelect.createEl("option", { text: "\u52A0\u8F7D\u4E2D..." });
    loading.value = "";
    loading.selected = true;
    try {
      this.allDocuments = await this.loadWikiDocuments(this.selectedAccountId, this.selectedSpaceToken);
      this.renderDocumentOptions();
    } catch (error) {
      this.docsSelect.empty();
      const failed = this.docsSelect.createEl("option", { text: "\u6587\u6863\u5217\u8868\u52A0\u8F7D\u5931\u8D25" });
      failed.value = "";
      failed.selected = true;
      const message = toHumanLoadError(error, "\u6587\u6863\u5217\u8868\u52A0\u8F7D\u5931\u8D25");
      this.setStatus(message);
      new import_obsidian.Notice(message, 6e3);
    }
  }
  renderDocumentOptions() {
    if (!this.docsSelect)
      return;
    this.docsSelect.empty();
    const filtered = this.searchKeyword ? this.allDocuments.filter((doc) => doc.title.toLowerCase().includes(this.searchKeyword)) : this.allDocuments;
    const hint = this.docsSelect.createEl("option", { text: filtered.length > 0 ? "\u8BF7\u9009\u62E9\u6587\u6863" : "\u65E0\u5339\u914D\u6587\u6863" });
    hint.value = "";
    hint.selected = true;
    for (const doc of filtered) {
      const indent = "\xA0\xA0".repeat(Math.max(0, doc.depth));
      const marker = doc.depth > 0 ? "\u2514 " : "";
      const option = this.docsSelect.createEl("option", { text: `${indent}${marker}${doc.leafTitle}` });
      option.value = doc.docToken;
      option.title = doc.title;
    }
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
  setStatus(message) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
};
async function askUploadWikiTarget(app, libraries, loadChildren) {
  return await new UploadWikiTargetModal(app, libraries, loadChildren).ask();
}
async function askUploadWikiTargetWithAccount(app, accounts, loadLibraries, loadChildren) {
  return await new UploadWikiTargetWithAccountModal(
    app,
    accounts,
    loadLibraries,
    loadChildren
  ).ask();
}
async function askManualUploadFolderToken(app) {
  return await new TextPromptModal(
    app,
    "\u8F93\u5165 Wiki \u4E0A\u4F20\u76EE\u6807",
    "\u4F8B\u5982: wiki_space:735... \u6216 wiki_node:735...:wikcn...",
    ""
  ).ask();
}
async function askOAuthAuthorize(app, authUrl, beginWaitForCode, openAuthUrl, cancelWaitForCode) {
  return await new OAuthAuthorizeModal(
    app,
    authUrl,
    beginWaitForCode,
    openAuthUrl,
    cancelWaitForCode
  ).ask();
}
var UserTokenInputModal = class extends import_obsidian.Modal {
  constructor() {
    super(...arguments);
    this.resolver = null;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("\u624B\u5DE5\u5F55\u5165\u7528\u6237 Token");
    this.contentEl.empty();
    const accessInput = new import_obsidian.TextComponent(this.contentEl.createDiv());
    accessInput.setPlaceholder("access_token");
    accessInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    const refreshInput = new import_obsidian.TextComponent(this.contentEl.createDiv());
    refreshInput.setPlaceholder("refresh_token");
    refreshInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    const expiresInput = new import_obsidian.TextComponent(this.contentEl.createDiv());
    expiresInput.setPlaceholder("expires_in (\u79D2\uFF0C\u9ED8\u8BA4 7200)");
    expiresInput.setValue("7200");
    expiresInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    const userNameInput = new import_obsidian.TextComponent(this.contentEl.createDiv());
    userNameInput.setPlaceholder("\u7528\u6237\u59D3\u540D\uFF08\u53EF\u9009\uFF09");
    userNameInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 8px;");
    const openIdInput = new import_obsidian.TextComponent(this.contentEl.createDiv());
    openIdInput.setPlaceholder("open_id\uFF08\u53EF\u9009\uFF09");
    openIdInput.inputEl.setAttr("style", "width: 100%; margin-bottom: 12px;");
    const actions = this.contentEl.createDiv();
    actions.setAttr("style", "display:flex; gap: 12px; justify-content:flex-end;");
    new import_obsidian.ButtonComponent(actions).setButtonText("\u786E\u8BA4").setCta().onClick(() => {
      const accessToken = accessInput.getValue().trim();
      const refreshToken = refreshInput.getValue().trim();
      const expiresInSec = Number(expiresInput.getValue().trim() || "7200");
      if (!accessToken || !refreshToken) {
        return;
      }
      this.resolver?.({
        accessToken,
        refreshToken,
        expiresInSec: Number.isFinite(expiresInSec) && expiresInSec > 60 ? expiresInSec : 7200,
        userName: userNameInput.getValue().trim(),
        openId: openIdInput.getValue().trim()
      });
      this.resolver = null;
      this.close();
    });
    new import_obsidian.ButtonComponent(actions).setButtonText("\u53D6\u6D88").onClick(() => {
      this.resolver?.(null);
      this.resolver = null;
      this.close();
    });
  }
  onClose() {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
};
async function askManualUserTokens(app) {
  return await new UserTokenInputModal(app).ask();
}
async function askConfirmUploadOverwrite(app, docTitle) {
  const modal = new OptionModal(
    app,
    "\u786E\u8BA4\u8986\u76D6\u7EBF\u4E0A\u6587\u6863",
    `\u5DF2\u5EFA\u7ACB\u540C\u6B65\u5173\u7CFB\uFF0C\u7EE7\u7EED\u4E0A\u4F20\u4F1A\u8986\u76D6\u98DE\u4E66\u6587\u6863\uFF1A${docTitle}`,
    [
      { value: "yes", label: "\u7EE7\u7EED\u4E0A\u4F20", cta: true },
      { value: "no", label: "\u53D6\u6D88" }
    ]
  );
  return await modal.ask() === "yes";
}
async function askDownloadTarget(app, options) {
  const folders = listVaultFolders(app);
  return await new DownloadTargetModal(
    app,
    folders,
    options.defaultDirectory,
    options.spaces,
    options.loadWikiDocuments
  ).ask();
}
async function askDownloadTargetWithAccount(app, accounts, options) {
  return await new DownloadTargetWithAccountModal(
    app,
    accounts,
    options.folders,
    options.defaultDirectory,
    options.loadSpaces,
    options.loadWikiDocuments
  ).ask();
}
async function showUploadSuccessModal(app, docTitle, docUrl) {
  await new UploadSuccessModal(app, docTitle, docUrl).ask();
}
function openUploadProgressModal(app) {
  const modal = new UploadProgressModal(app);
  modal.open();
  return {
    update: (percent, stage, detail) => {
      modal.updateProgress(percent, stage, detail);
    },
    close: () => {
      modal.close();
    }
  };
}
async function copyText(value) {
  const nav = globalThis.navigator;
  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}
function toHumanLoadError(error, fallbackPrefix) {
  const text = String(error ?? "").replace(/^Error:\s*/i, "").trim();
  const lower = text.toLowerCase();
  const unauthorizedHint = lower.includes("unauthorized") || lower.includes("access denied") || lower.includes("scope") || lower.includes("99991672") || lower.includes("99991679");
  if (unauthorizedHint) {
    return `${fallbackPrefix}\uFF1A\u8D26\u53F7\u672A\u6388\u6743\u6216\u6743\u9650\u4E0D\u8DB3\u3002${text}`;
  }
  return `${fallbackPrefix}\uFF1A${text}`;
}

// src/main.ts
var DEFAULT_LOCAL_OAUTH_REDIRECT = "http://127.0.0.1:27123/feishu-sync/callback";
var DEFAULT_OAUTH_SCOPES2 = [
  "offline_access",
  "auth:user.id:read",
  "bitable:app",
  "bitable:app:readonly",
  "docs:doc",
  "docs:doc:readonly",
  "docs:document.comment:create",
  "docs:document.comment:read",
  "docs:document.comment:update",
  "docs:document.comment:write_only",
  "docs:document.content:read",
  "docs:document.media:download",
  "docs:document.media:upload",
  "docs:document.subscription",
  "docs:document.subscription:read",
  "docs:document:copy",
  "docs:document:export",
  "docs:document:import",
  "docx:document",
  "docx:document.block:convert",
  "docx:document:create",
  "docx:document:readonly",
  "docx:document:write_only",
  "drive:drive",
  "drive:file",
  "sheets:spreadsheet",
  "space:document.event:read",
  "space:document:delete",
  "space:document:move",
  "space:document:retrieve",
  "space:document:shortcut",
  "wiki:node:copy",
  "wiki:node:create",
  "wiki:node:move",
  "wiki:node:read",
  "wiki:node:retrieve",
  "wiki:node:update",
  "wiki:setting:read",
  "wiki:setting:write_only",
  "wiki:space:read",
  "wiki:space:retrieve",
  "wiki:space:write_only",
  "wiki:wiki",
  "wiki:wiki:readonly"
].join(" ");
var FeishuSyncPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.activeAuthListener = null;
    this.cancelActiveAuthWait = null;
  }
  async onload() {
    this.settingsService = new SettingsService({
      loadData: async () => await this.loadData(),
      saveData: async (data) => await this.saveData(data)
    });
    this.settings = await this.settingsService.load();
    this.orchestrator = this.createOrchestrator();
    this.addRibbonIcon("upload", "\u4E0A\u4F20\u5230\u98DE\u4E66", async () => {
      const result = await this.orchestrator.uploadCurrentFile();
      if (result.result !== "success") {
        new import_obsidian2.Notice(result.message, 8e3);
      }
    });
    this.addRibbonIcon("download", "\u4ECE\u98DE\u4E66\u4E0B\u8F7D", async () => {
      const result = await this.orchestrator.downloadToLocal();
      if (result.result !== "success") {
        new import_obsidian2.Notice(result.message, 8e3);
      }
    });
    this.addSettingTab(new FeishuSyncSettingTab(this.app, this));
  }
  createOrchestrator() {
    this.feishuClient = new HttpFeishuClient(void 0, {
      logger: (event, payload) => {
        if (!this.settings.debugNetworkLogs) {
          return;
        }
        console.log(`[FeishuSync][${event}]`, payload);
      },
      requester: async (url, init) => {
        const response = await (0, import_obsidian2.requestUrl)({
          url,
          method: init.method ?? "GET",
          headers: toHeaderRecord(init.headers),
          body: toRequestBody(init.body),
          throw: false
        });
        const contentType = Object.entries(response.headers).find(
          ([key]) => key.toLowerCase() === "content-type"
        )?.[1] ?? "";
        const isJson = contentType.toLowerCase().includes("application/json");
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          headers: response.headers,
          arrayBuffer: response.arrayBuffer,
          json: isJson ? response.json ?? {} : {},
          text: response.text ?? ""
        };
      },
      onAccountAuthUpdated: async () => {
        await this.persistSettings();
      },
      maskSensitiveLogs: () => this.settings.maskSensitiveLogs,
      mermaidRenderer: async (source) => await this.renderMermaidToPngLocal(source),
      getUploadBehavior: () => ({
        assetThrottleEnabled: this.settings.uploadAssetThrottleEnabled,
        assetThrottleSeconds: this.settings.uploadAssetThrottleSeconds,
        retryLimit429: this.settings.upload429RetryLimit,
        retryDelaySeconds429: this.settings.upload429RetryDelaySeconds
      })
    });
    return new SyncOrchestrator({
      getSettings: () => this.settings,
      saveSettings: async (settings) => {
        this.settings = settings;
        await this.settingsService.save(settings);
      },
      ui: {
        selectAccount: async (accounts) => await new AccountSelectModal(this.app, accounts).ask(),
        decideForUnmappedName: async (documents) => await new UnmappedNameDecisionModal(this.app, documents).ask(),
        decideConflict: async () => await askConflictDecision(this.app),
        promptRemoteDocument: async (_account, options) => await askDownloadTarget(this.app, options),
        promptRemoteDocumentWithAccount: async (accounts, options) => await askDownloadTargetWithAccount(this.app, accounts, {
          folders: normalizeFolderPaths(
            this.app.vault.getAllLoadedFiles().filter((item) => item instanceof import_obsidian2.TFolder).map((folder) => folder.path).filter((path) => path.length > 0).filter((path) => !path.toLowerCase().split("/").includes("assets"))
          ),
          defaultDirectory: options.defaultDirectory,
          loadSpaces: options.loadSpaces,
          loadWikiDocuments: options.loadWikiDocuments
        }),
        selectUploadWikiTarget: async (libraries, loadChildren) => await askUploadWikiTarget(this.app, libraries, loadChildren),
        selectUploadWikiTargetWithAccount: async (accounts, options) => await askUploadWikiTargetWithAccount(
          this.app,
          accounts,
          options.loadLibraries,
          options.loadChildren
        ),
        promptUploadFolderToken: async () => await askManualUploadFolderToken(this.app),
        confirmUploadOverwrite: async (docTitle) => await askConfirmUploadOverwrite(this.app, docTitle),
        openUploadProgress: () => openUploadProgressModal(this.app),
        showUploadSuccess: async (docTitle, docUrl) => await showUploadSuccessModal(this.app, docTitle, docUrl),
        notice: (message) => new import_obsidian2.Notice(message)
      },
      vault: {
        getActiveFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
        getFileMtime: async (path) => {
          const file = this.getMarkdownFile(path);
          return file.stat.mtime;
        },
        readFile: async (path) => {
          const file = this.getMarkdownFile(path);
          return await this.app.vault.cachedRead(file);
        },
        readBinary: async (path) => {
          const normalized = (0, import_obsidian2.normalizePath)(path);
          return await this.app.vault.adapter.readBinary(normalized);
        },
        writeFile: async (path, content) => {
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing instanceof import_obsidian2.TFile) {
            await this.app.vault.modify(existing, content);
            return;
          }
          await this.ensureParentFolder(path);
          await this.app.vault.create(path, content);
        },
        writeBinary: async (path, content) => {
          await this.ensureParentFolder(path);
          await this.app.vault.adapter.writeBinary((0, import_obsidian2.normalizePath)(path), content);
        },
        fileExists: async (path) => this.app.vault.getAbstractFileByPath(path) instanceof import_obsidian2.TFile,
        ensureFolder: async (path) => {
          const normalized = (0, import_obsidian2.normalizePath)(path);
          if (normalized === "/") {
            return;
          }
          const existing = this.app.vault.getAbstractFileByPath(normalized);
          if (!existing) {
            await this.app.vault.createFolder(normalized);
          }
        }
      },
      feishu: this.feishuClient,
      now: () => Date.now()
    });
  }
  async renderMermaidToPngLocal(source) {
    const tempContainer = document.createElement("div");
    tempContainer.style.position = "fixed";
    tempContainer.style.left = "-100000px";
    tempContainer.style.top = "0";
    tempContainer.style.opacity = "0";
    tempContainer.style.pointerEvents = "none";
    document.body.appendChild(tempContainer);
    const renderComponent = new import_obsidian2.Component();
    try {
      const markdownContent = `\`\`\`mermaid
${source}
\`\`\``;
      await import_obsidian2.MarkdownRenderer.render(this.app, markdownContent, tempContainer, "", renderComponent);
      const svgElement = await this.waitForMermaidSvg(tempContainer, 6e3);
      const box = this.getSvgRenderBox(svgElement);
      const clonedSvg = svgElement.cloneNode(true);
      clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clonedSvg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
      clonedSvg.setAttribute("width", String(box.width));
      clonedSvg.setAttribute("height", String(box.height));
      clonedSvg.setAttribute("viewBox", `${box.minX} ${box.minY} ${box.width} ${box.height}`);
      this.inlineSvgStyles(clonedSvg);
      const svgText = new XMLSerializer().serializeToString(clonedSvg);
      const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Mermaid local render failed: svg image load error."));
        image.src = svgDataUrl;
      });
      const scale = 3;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(box.width * scale);
      canvas.height = Math.round(box.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Mermaid local render failed: canvas context unavailable.");
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, box.width, box.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => {
          if (!value) {
            reject(new Error("Mermaid local render failed: canvas export failed."));
            return;
          }
          resolve(value);
        }, "image/png", 1);
      });
      return await blob.arrayBuffer();
    } catch (error) {
      console.warn("[FeishuSync][mermaid] local render failed, fallback to remote renderer.", error);
      throw error;
    } finally {
      renderComponent.unload();
      tempContainer.remove();
    }
  }
  async waitForMermaidSvg(container, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const svg = container.querySelector("svg");
      if (svg instanceof SVGSVGElement) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return svg;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Mermaid local render failed: svg not found before timeout.");
  }
  getSvgRenderBox(svgElement) {
    const normalizeBox = (minX, minY, width, height) => ({
      minX: Number.isFinite(minX) ? minX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      width: Math.max(100, Math.round(width)),
      height: Math.max(100, Math.round(height))
    });
    const rawViewBox = svgElement.getAttribute("viewBox");
    if (rawViewBox) {
      const parts = rawViewBox.trim().split(/[,\s]+/).map((part) => Number.parseFloat(part));
      if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
        const [minX, minY, width, height] = parts;
        if (width > 0 && height > 0) {
          return normalizeBox(minX, minY, width, height);
        }
      }
    }
    const rawWidth = svgElement.getAttribute("width");
    const rawHeight = svgElement.getAttribute("height");
    if (rawWidth && rawHeight && !rawWidth.includes("%") && !rawHeight.includes("%")) {
      const parsedWidth = Number.parseFloat(rawWidth);
      const parsedHeight = Number.parseFloat(rawHeight);
      if (Number.isFinite(parsedWidth) && Number.isFinite(parsedHeight) && parsedWidth > 0 && parsedHeight > 0) {
        return normalizeBox(0, 0, parsedWidth, parsedHeight);
      }
    }
    const rect = svgElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return normalizeBox(0, 0, rect.width, rect.height);
    }
    try {
      const bbox = svgElement.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        return normalizeBox(bbox.x, bbox.y, bbox.width, bbox.height);
      }
    } catch {
    }
    return normalizeBox(0, 0, 800, 600);
  }
  inlineSvgStyles(root) {
    const nodes = root.querySelectorAll("*");
    nodes.forEach((node) => {
      if (!(node instanceof Element)) {
        return;
      }
      const computed = window.getComputedStyle(node);
      const inlineStyles = [
        "font-family",
        "font-size",
        "font-weight",
        "fill",
        "stroke",
        "stroke-width",
        "opacity"
      ].map((name) => `${name}:${computed.getPropertyValue(name)};`).join("");
      const existing = node.getAttribute("style") ?? "";
      node.setAttribute("style", `${existing}${existing && !existing.endsWith(";") ? ";" : ""}${inlineStyles}`);
    });
  }
  async persistSettings() {
    await this.settingsService.save(this.settings);
  }
  async startUserAuth(accountId) {
    try {
      const account = this.settings.accounts.find((item) => item.id === accountId);
      if (!account) {
        new import_obsidian2.Notice("\u8D26\u53F7\u4E0D\u5B58\u5728\u3002");
        return;
      }
      if (!account.appId) {
        new import_obsidian2.Notice("\u8BF7\u5148\u586B\u5199 App ID\u3002");
        return;
      }
      const authMode = resolveAccountAuthMode(account);
      if (authMode === "local_secret" && !account.appSecret) {
        new import_obsidian2.Notice("\u5F53\u524D\u4E3A\u672C\u5730\u8BA4\u8BC1\u6A21\u5F0F\uFF0C\u8BF7\u5148\u586B\u5199 App Secret\u3002");
        return;
      }
      if (authMode === "remote_bridge" && !(account.remoteAuthUrl ?? "").trim()) {
        new import_obsidian2.Notice("\u5F53\u524D\u4E3A\u8FDC\u7A0B\u4EE3\u7406\u6A21\u5F0F\uFF0C\u8BF7\u5148\u586B\u5199\u8FDC\u7A0B\u8BA4\u8BC1 URL\u3002");
        return;
      }
      const redirectUri = (account.redirectUri || DEFAULT_LOCAL_OAUTH_REDIRECT).trim();
      account.redirectUri = redirectUri;
      this.feishuClient.invalidateAuthCache(account);
      const state = `feishu-sync-${account.id}-${Date.now()}`;
      const authUrl = this.feishuClient.buildUserAuthorizeUrl(account, redirectUri, state);
      this.authLog("start", {
        accountId: account.id,
        accountName: account.name,
        authType: "user",
        authMode,
        redirectUri
      });
      const authResult = await askOAuthAuthorize(
        this.app,
        authUrl,
        async () => await this.waitForOAuthCodeByLocalHttp(redirectUri, state, 3 * 60 * 1e3),
        () => window.open(authUrl, "_blank"),
        () => this.stopActiveOAuthWaitByUser()
      );
      if (!authResult) {
        this.authLog("cancelled", { accountId: account.id });
        return;
      }
      if (authResult.mode === "manual") {
        this.authLog("manual_token_input", { accountId: account.id });
        const manual = await askManualUserTokens(this.app);
        if (!manual) {
          this.authLog("manual_token_cancelled", { accountId: account.id });
          return;
        }
        account.authType = "user";
        account.userAccessToken = manual.accessToken;
        account.userRefreshToken = manual.refreshToken;
        account.userTokenExpireAt = Date.now() + Math.max(60, manual.expiresInSec - 120) * 1e3;
        account.userOpenId = manual.openId || "";
        account.userName = manual.userName || "";
        account.lastAuthCheckAt = Date.now();
        account.lastAuthError = "";
        account.lastAuthErrorAt = 0;
        this.feishuClient.invalidateAuthCache(account);
        await this.persistSettings();
        this.authLog("manual_token_saved", {
          accountId: account.id,
          expireAt: account.userTokenExpireAt,
          hasRefreshToken: !!account.userRefreshToken
        });
        new import_obsidian2.Notice(`\u7528\u6237Token\u5DF2\u4FDD\u5B58\uFF1A${account.userName || account.userOpenId || account.name}`);
      } else {
        this.authLog("oauth_code_received", { accountId: account.id, codeLength: authResult.code.length });
        const exchanged = await this.feishuClient.exchangeUserCode(account, authResult.code, redirectUri);
        account.authType = "user";
        account.userAccessToken = exchanged.accessToken;
        account.userRefreshToken = exchanged.refreshToken;
        account.userTokenExpireAt = exchanged.expireAt;
        account.userOpenId = exchanged.openId ?? "";
        account.userName = exchanged.userName ?? "";
        account.lastAuthCheckAt = Date.now();
        account.lastAuthError = "";
        account.lastAuthErrorAt = 0;
        this.feishuClient.invalidateAuthCache(account);
        await this.persistSettings();
        this.authLog("oauth_exchange_success", {
          accountId: account.id,
          userName: account.userName,
          openId: account.userOpenId,
          expireAt: account.userTokenExpireAt
        });
        new import_obsidian2.Notice(`\u7528\u6237\u767B\u5F55\u6210\u529F\uFF1A${account.userName || account.userOpenId || account.name}`);
      }
    } catch (error) {
      const account = this.settings.accounts.find((item) => item.id === accountId);
      if (account) {
        account.lastAuthCheckAt = Date.now();
        account.lastAuthError = String(error);
        account.lastAuthErrorAt = Date.now();
        await this.persistSettings();
      }
      this.authLog("oauth_failed", { accountId, error: String(error) });
      new import_obsidian2.Notice(`\u7528\u6237\u767B\u5F55\u5931\u8D25: ${String(error)}`, 8e3);
    }
  }
  async clearUserAuth(accountId) {
    const account = this.settings.accounts.find((item) => item.id === accountId);
    if (!account) {
      return;
    }
    account.authType = "user";
    account.userAccessToken = "";
    account.userRefreshToken = "";
    account.userTokenExpireAt = 0;
    account.userOpenId = "";
    account.userName = "";
    account.lastAuthError = "";
    account.lastAuthErrorAt = 0;
    account.lastAuthCheckAt = Date.now();
    this.feishuClient.invalidateAuthCache(account);
    await this.persistSettings();
    new import_obsidian2.Notice("\u5DF2\u6E05\u9664\u7528\u6237\u767B\u5F55\u4FE1\u606F\u3002");
  }
  async waitForOAuthCodeByLocalHttp(redirectUri, expectedState, timeoutMs) {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) {
      throw new Error(`\u672C\u5730\u56DE\u8C03\u5730\u5740\u5FC5\u987B\u662F http \u4E14\u5305\u542B\u7AEF\u53E3\uFF0C\u4F8B\u5982 ${DEFAULT_LOCAL_OAUTH_REDIRECT}`);
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("\u5F53\u524D\u4EC5\u652F\u6301 localhost/127.0.0.1 \u4F5C\u4E3A\u672C\u5730\u56DE\u8C03\u5730\u5740\u3002");
    }
    const port = Number(parsed.port);
    const pathName = parsed.pathname || "/";
    return await new Promise((resolve, reject) => {
      let settled = false;
      let serverClosed = false;
      const finish = (fn) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        this.cancelActiveAuthWait = null;
        this.activeAuthListener = null;
        try {
          fn();
        } finally {
          if (!serverClosed) {
            serverClosed = true;
            server.close();
          }
        }
      };
      this.cancelActiveAuthWait = () => {
        this.authLog("callback_cancelled_by_user", { host: parsed.hostname, port, path: pathName });
        finish(() => reject(new Error("\u7528\u6237\u53D6\u6D88\u6388\u6743\uFF0C\u5DF2\u505C\u6B62\u672C\u5730\u76D1\u542C\u3002")));
      };
      this.authLog("callback_server_start", {
        host: parsed.hostname,
        port,
        path: pathName,
        timeoutMs
      });
      const respond = (res, status, message) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Connection", "close");
        res.end(`<!doctype html><html><body><h3>${message}</h3><p>\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\u5E76\u56DE\u5230 Obsidian\u3002</p></body></html>`);
      };
      const server = (0, import_node_http.createServer)((req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", `http://${parsed.host}`);
          if (reqUrl.pathname !== pathName) {
            respond(res, 404, "Not Found");
            return;
          }
          const err = reqUrl.searchParams.get("error");
          if (err) {
            respond(res, 400, `\u6388\u6743\u5931\u8D25: ${err}`);
            finish(() => reject(new Error(`OAuth error: ${err}`)));
            return;
          }
          const state = reqUrl.searchParams.get("state") || "";
          const code = reqUrl.searchParams.get("code") || "";
          const stateMatched = state === expectedState;
          const stateCompatible = isCompatibleAuthState(expectedState, state);
          this.authLog("callback_received", {
            path: reqUrl.pathname,
            hasCode: !!code,
            codeLength: code.length,
            stateMatched,
            stateCompatible
          });
          if (!code) {
            respond(res, 400, "\u7F3A\u5C11 code \u53C2\u6570");
            return;
          }
          if (!stateMatched && !stateCompatible) {
            respond(res, 400, "state \u6821\u9A8C\u5931\u8D25");
            finish(() => reject(new Error("OAuth state mismatch.")));
            return;
          }
          if (!stateMatched && stateCompatible) {
            this.authLog("callback_state_accepted_by_compat", {
              expectedState,
              receivedState: state
            });
          }
          respond(res, 200, "\u6388\u6743\u6210\u529F");
          finish(() => resolve(code));
        } catch (error) {
          respond(res, 500, "\u56DE\u8C03\u5904\u7406\u5931\u8D25");
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
      server.on("error", (error) => {
        this.authLog("callback_server_error", { error: String(error) });
        if (String(error).includes("EADDRINUSE")) {
          this.authLog("callback_server_error_hint", {
            message: "\u7AEF\u53E3\u5360\u7528\u3002\u82E5\u5F53\u524D\u6B63\u5728\u7B49\u5F85\u56DE\u8C03\uFF0C\u53EF\u7EE7\u7EED\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u6388\u6743\uFF1B\u5426\u5219\u66F4\u6362\u56DE\u8C03\u7AEF\u53E3\u5E76\u540C\u6B65\u98DE\u4E66\u540E\u53F0\u91CD\u5B9A\u5411\u5730\u5740\u3002"
          });
        }
        finish(
          () => reject(new Error(`\u672C\u5730\u56DE\u8C03\u670D\u52A1\u542F\u52A8\u5931\u8D25(${parsed.host})\uFF1A${String(error)}\u3002\u8BF7\u68C0\u67E5\u7AEF\u53E3\u662F\u5426\u88AB\u5360\u7528\u3002`))
        );
      });
      server.listen(port, parsed.hostname, () => {
        this.activeAuthListener = {
          host: parsed.hostname,
          port,
          path: pathName,
          startedAt: Date.now()
        };
      });
      const timer = setTimeout(() => {
        this.authLog("callback_timeout", { host: parsed.hostname, port, path: pathName });
        finish(() => reject(new Error("\u7B49\u5F85\u98DE\u4E66\u56DE\u8C03\u8D85\u65F6\uFF0C\u5DF2\u505C\u6B62\u672C\u5730\u76D1\u542C\uFF0C\u8BF7\u91CD\u8BD5\u6388\u6743\u3002")));
      }, timeoutMs);
    });
  }
  stopActiveOAuthWaitByUser() {
    if (!this.cancelActiveAuthWait) {
      return;
    }
    this.cancelActiveAuthWait();
  }
  async refreshAccountAuthStatus(accountId) {
    const account = this.settings.accounts.find((item) => item.id === accountId);
    if (!account) {
      new import_obsidian2.Notice("\u8D26\u53F7\u4E0D\u5B58\u5728\u3002");
      return;
    }
    try {
      const info = await this.feishuClient.fetchCurrentUserInfo(account);
      await this.persistSettings();
      const tokenValid = (account.userTokenExpireAt ?? 0) > Date.now();
      const expireAtText = account.userTokenExpireAt ? new Date(account.userTokenExpireAt).toLocaleString() : "\u672A\u77E5";
      new import_obsidian2.Notice(
        `\u7528\u6237\u8EAB\u4EFD\u6709\u6548: ${tokenValid ? "\u662F" : "\u5426"} | \u5230\u671F: ${expireAtText} | \u7528\u6237: ${info.name || account.userName || "-"}`
      );
    } catch (error) {
      account.lastAuthCheckAt = Date.now();
      account.lastAuthError = String(error);
      account.lastAuthErrorAt = Date.now();
      await this.persistSettings();
      new import_obsidian2.Notice(`\u5237\u65B0\u8EAB\u4EFD\u72B6\u6001\u5931\u8D25: ${String(error)}`, 8e3);
    }
  }
  async checkOAuthCallbackAvailability(accountId) {
    const account = this.settings.accounts.find((item) => item.id === accountId);
    if (!account) {
      new import_obsidian2.Notice("\u8D26\u53F7\u4E0D\u5B58\u5728\u3002");
      return;
    }
    const redirectUri = (account.redirectUri || DEFAULT_LOCAL_OAUTH_REDIRECT).trim();
    try {
      const parsed = new URL(redirectUri);
      const listener = this.activeAuthListener;
      if (listener && listener.host === parsed.hostname && listener.port === Number(parsed.port) && listener.path === (parsed.pathname || "/")) {
        new import_obsidian2.Notice(`\u56DE\u8C03\u7AEF\u53E3\u6B63\u5728\u7531\u63D2\u4EF6\u76D1\u542C\uFF1A${redirectUri}\uFF08\u53EF\u76F4\u63A5\u7EE7\u7EED\u6388\u6743\uFF09`);
        return;
      }
      await this.probeLocalCallbackEndpoint(redirectUri);
      new import_obsidian2.Notice(`\u56DE\u8C03\u5730\u5740\u53EF\u7528\uFF1A${redirectUri}`);
    } catch (error) {
      new import_obsidian2.Notice(`\u56DE\u8C03\u5730\u5740\u4E0D\u53EF\u7528\uFF1A${String(error)}`, 8e3);
    }
  }
  getMarkdownFile(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian2.TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }
  async ensureParentFolder(path) {
    const segments = (0, import_obsidian2.normalizePath)(path).split("/");
    segments.pop();
    if (segments.length === 0) {
      return;
    }
    const folderPath = segments.join("/");
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    }
  }
  async probeLocalCallbackEndpoint(redirectUri) {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) {
      throw new Error(`\u56DE\u8C03\u5730\u5740\u5FC5\u987B\u662F http \u4E14\u5305\u542B\u7AEF\u53E3\uFF0C\u4F8B\u5982 ${DEFAULT_LOCAL_OAUTH_REDIRECT}`);
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("\u4EC5\u652F\u6301 localhost/127.0.0.1 \u4F5C\u4E3A\u672C\u5730\u56DE\u8C03\u5730\u5740\u3002");
    }
    const port = Number(parsed.port);
    await new Promise((resolve, reject) => {
      const server = (0, import_node_http.createServer)((_req, res) => {
        res.statusCode = 204;
        res.end();
      });
      server.on("error", (error) => {
        reject(new Error(`\u7AEF\u53E3 ${port} \u4E0D\u53EF\u7528: ${String(error)}`));
      });
      server.listen(port, parsed.hostname, () => {
        server.close((closeErr) => {
          if (closeErr) {
            reject(new Error(String(closeErr)));
            return;
          }
          resolve();
        });
      });
    });
  }
  authLog(event, payload) {
    console.log(`[FeishuSync][auth:${event}]`, payload);
  }
};
var FeishuSyncSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Feishu Sync \u8BBE\u7F6E" });
    this.renderAccountsSection();
    this.renderDefaultsSection();
    this.renderDiagnosticsSection();
  }
  renderAccountsSection() {
    this.containerEl.createEl("h3", { text: "\u8D26\u53F7\u914D\u7F6E" });
    this.plugin.settings.accounts.forEach((account, index) => {
      if (index > 0) {
        const divider = this.containerEl.createEl("hr");
        divider.setAttr(
          "style",
          "margin: 12px 0 14px; border: none; border-top: 1px solid var(--background-modifier-border);"
        );
      }
      new import_obsidian2.Setting(this.containerEl).setName(account.name || "\u672A\u547D\u540D\u8D26\u53F7").setDesc(account.appId).addText((text) => {
        text.setPlaceholder("\u663E\u793A\u540D\u79F0");
        text.setValue(account.name);
        text.onChange(async (value) => {
          account.name = value.trim();
          await this.plugin.persistSettings();
        });
      }).addToggle((toggle) => {
        toggle.setValue(account.enabled);
        toggle.onChange(async (value) => {
          account.enabled = value;
          await this.plugin.persistSettings();
        });
      }).addButton((button) => {
        button.setButtonText("\u5220\u9664").onClick(async () => {
          this.plugin.settings.accounts = this.plugin.settings.accounts.filter(
            (item) => item.id !== account.id
          );
          await this.plugin.persistSettings();
          this.display();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("App ID").addText((text) => {
        text.setValue(account.appId);
        text.onChange(async (value) => {
          account.appId = value.trim();
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("\u8BA4\u8BC1\u4EE4\u724C\u4EA4\u6362\u65B9\u5F0F").setDesc("\u672C\u5730\u8BA4\u8BC1\uFF1A\u4F7F\u7528 App Secret\uFF1B\u8FDC\u7A0B\u4EE3\u7406\uFF1A\u901A\u8FC7\u8BA4\u8BC1 URL \u4EE3\u6362 token").addDropdown((dropdown) => {
        const mode = resolveAccountAuthMode(account);
        dropdown.addOption("local_secret", "\u672C\u5730\u8BA4\u8BC1\uFF08App Secret\uFF09").addOption("remote_bridge", "\u8FDC\u7A0B\u4EE3\u7406\uFF08Auth URL\uFF09").setValue(mode).onChange(async (value) => {
          account.authMode = value === "remote_bridge" ? "remote_bridge" : "local_secret";
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("App Secret").setDesc("\u672C\u5730\u8BA4\u8BC1\u6A21\u5F0F\u5FC5\u586B\uFF0C\u8FDC\u7A0B\u4EE3\u7406\u6A21\u5F0F\u53EF\u7559\u7A7A\u3002\u4EE5\u7B80\u5316\u6DF7\u6DC6\u65B9\u5F0F\u672C\u5730\u4FDD\u5B58\uFF08MVP\uFF09").addText((text) => {
        text.inputEl.type = "password";
        text.setValue(account.appSecret);
        text.onChange(async (value) => {
          account.appSecret = value.trim();
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("\u8FDC\u7A0B\u8BA4\u8BC1 URL").setDesc("\u8FDC\u7A0B\u4EE3\u7406\u6A21\u5F0F\u5FC5\u586B\uFF0C\u4F8B\u5982 https://auth.example.com").addText((text) => {
        text.setValue(account.remoteAuthUrl ?? "");
        text.onChange(async (value) => {
          account.remoteAuthUrl = value.trim();
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("\u8FDC\u7A0B\u8BA4\u8BC1 API Key").setDesc("\u53EF\u9009\u3002\u82E5\u4F60\u7684\u8BA4\u8BC1\u4EE3\u7406\u5F00\u542F\u9274\u6743\uFF0C\u8BF7\u586B\u5199\u3002").addText((text) => {
        text.inputEl.type = "password";
        text.setValue(account.remoteAuthApiKey ?? "");
        text.onChange(async (value) => {
          account.remoteAuthApiKey = value.trim();
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("OAuth \u56DE\u8C03\u5730\u5740").setDesc("\u9700\u5728\u98DE\u4E66\u5E94\u7528\u540E\u53F0\u914D\u7F6E\u4E3A\u91CD\u5B9A\u5411 URL\uFF08\u5EFA\u8BAE\u672C\u5730\u56DE\u8C03\uFF09").addText((text) => {
        text.setValue(account.redirectUri || DEFAULT_LOCAL_OAUTH_REDIRECT);
        text.onChange(async (value) => {
          account.redirectUri = value.trim() || DEFAULT_LOCAL_OAUTH_REDIRECT;
          await this.plugin.persistSettings();
        });
      }).addButton((button) => {
        button.setButtonText("\u68C0\u6D4B\u56DE\u8C03\u7AEF\u53E3").onClick(async () => {
          await this.plugin.checkOAuthCallbackAvailability(account.id);
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("OAuth \u6388\u6743 Scope").setDesc("\u7A7A\u683C\u6216\u9017\u53F7\u5206\u9694\u3002\u7559\u7A7A\u5C06\u4F7F\u7528\u9ED8\u8BA4 Scope\uFF08\u542B wiki \u4E0E bitable\uFF09\u3002").addTextArea((text) => {
        text.setValue(account.oauthScopes || DEFAULT_OAUTH_SCOPES2);
        text.inputEl.setAttr("style", "width: 100%; min-height: 72px;");
        text.onChange(async (value) => {
          account.oauthScopes = value.trim();
          await this.plugin.persistSettings();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("\u8BA4\u8BC1\u65B9\u5F0F").setDesc(`\u5F53\u524D\uFF1A\u7528\u6237\u8EAB\u4EFD ${account.userName || account.userOpenId || ""}`).addButton((button) => {
        button.setButtonText("\u7528\u6237\u767B\u5F55").setCta().onClick(async () => {
          await this.plugin.startUserAuth(account.id);
          this.display();
        });
      }).addButton((button) => {
        button.setButtonText("\u6E05\u9664\u7528\u6237\u4EE4\u724C").onClick(async () => {
          await this.plugin.clearUserAuth(account.id);
          this.display();
        });
      });
      new import_obsidian2.Setting(this.containerEl).setName("\u8EAB\u4EFD\u72B6\u6001").setDesc(formatAuthStatus(account)).addButton((button) => {
        button.setButtonText("\u5237\u65B0\u72B6\u6001").onClick(async () => {
          await this.plugin.refreshAccountAuthStatus(account.id);
          this.display();
        });
      });
    });
    new import_obsidian2.Setting(this.containerEl).addButton((button) => {
      button.setButtonText("\u65B0\u589E\u8D26\u53F7").setCta().onClick(async () => {
        this.plugin.settings.accounts.push(createNewAccount());
        await this.plugin.persistSettings();
        this.display();
      });
    });
  }
  renderDefaultsSection() {
    this.containerEl.createEl("h3", { text: "\u9ED8\u8BA4\u914D\u7F6E" });
    new import_obsidian2.Setting(this.containerEl).setName("\u56FE\u7247\u4E0B\u8F7D\u5B50\u76EE\u5F55").setDesc("\u4E0B\u8F7D\u98DE\u4E66\u6587\u6863\u56FE\u7247\u65F6\u4F7F\u7528").addText((text) => {
      text.setValue(this.plugin.settings.defaultAssetFolder);
      text.onChange(async (value) => {
        this.plugin.settings.defaultAssetFolder = value.trim() || "assets/feishu";
        await this.plugin.persistSettings();
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("\u63A7\u5236\u53F0\u7F51\u7EDC\u8C03\u8BD5\u65E5\u5FD7").setDesc("\u5F00\u542F\u540E\u8F93\u51FA\u98DE\u4E66\u8BF7\u6C42\u5730\u5740\u3001\u53C2\u6570\u548C\u54CD\u5E94\u6570\u636E\uFF08\u654F\u611F\u5B57\u6BB5\u6253\u7801\uFF09").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.debugNetworkLogs);
      toggle.onChange(async (value) => {
        this.plugin.settings.debugNetworkLogs = value;
        await this.plugin.persistSettings();
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("\u65E5\u5FD7\u654F\u611F\u4FE1\u606F\u8131\u654F").setDesc("\u5F00\u542F\u540E\u9690\u85CF Authorization\u3001app_secret\u3001token \u7B49\u654F\u611F\u5B57\u6BB5").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.maskSensitiveLogs);
      toggle.onChange(async (value) => {
        this.plugin.settings.maskSensitiveLogs = value;
        await this.plugin.persistSettings();
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("\u4E0A\u4F20\u8D44\u4EA7\u8282\u6D41").setDesc("\u4E0A\u4F20\u56FE\u7247/\u9644\u4EF6\u65F6\uFF0C\u7B2C\u4E00\u4E2A\u7ACB\u5373\u4E0A\u4F20\uFF0C\u540E\u7EED\u6309\u7B49\u5F85\u79D2\u6570\u8282\u6D41").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.uploadAssetThrottleEnabled);
      toggle.onChange(async (value) => {
        this.plugin.settings.uploadAssetThrottleEnabled = value;
        await this.plugin.persistSettings();
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("\u4E0A\u4F20\u8282\u6D41\u7B49\u5F85\u79D2\u6570").setDesc("\u4EC5\u5728\u201C\u4E0A\u4F20\u8D44\u4EA7\u8282\u6D41\u201D\u5F00\u542F\u65F6\u751F\u6548\uFF0C\u5EFA\u8BAE 1-5 \u79D2").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(this.plugin.settings.uploadAssetThrottleSeconds));
      text.onChange(async (value) => {
        this.plugin.settings.uploadAssetThrottleSeconds = parseBoundedInt(
          value,
          this.plugin.settings.uploadAssetThrottleSeconds,
          0,
          60
        );
        await this.plugin.persistSettings();
        text.setValue(String(this.plugin.settings.uploadAssetThrottleSeconds));
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("429 \u91CD\u8BD5\u6B21\u6570").setDesc("\u9047\u5230 HTTP 429 \u65F6\u81EA\u52A8\u91CD\u8BD5\u7684\u6700\u5927\u6B21\u6570").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(this.plugin.settings.upload429RetryLimit));
      text.onChange(async (value) => {
        this.plugin.settings.upload429RetryLimit = parseBoundedInt(
          value,
          this.plugin.settings.upload429RetryLimit,
          0,
          20
        );
        await this.plugin.persistSettings();
        text.setValue(String(this.plugin.settings.upload429RetryLimit));
      });
    });
    new import_obsidian2.Setting(this.containerEl).setName("429 \u91CD\u8BD5\u7B49\u5F85\u79D2\u6570").setDesc("\u6BCF\u6B21 429 \u91CD\u8BD5\u524D\u7684\u7B49\u5F85\u65F6\u95F4").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(this.plugin.settings.upload429RetryDelaySeconds));
      text.onChange(async (value) => {
        this.plugin.settings.upload429RetryDelaySeconds = parseBoundedInt(
          value,
          this.plugin.settings.upload429RetryDelaySeconds,
          1,
          120
        );
        await this.plugin.persistSettings();
        text.setValue(String(this.plugin.settings.upload429RetryDelaySeconds));
      });
    });
  }
  renderDiagnosticsSection() {
    this.containerEl.createEl("h3", { text: "\u6700\u8FD1\u540C\u6B65\u8BB0\u5F55" });
    const logs = this.plugin.settings.syncLogs.slice(0, 100);
    if (logs.length === 0) {
      this.containerEl.createEl("p", { text: "\u6682\u65E0\u540C\u6B65\u8BB0\u5F55\u3002" });
      return;
    }
    const grouped = /* @__PURE__ */ new Map();
    for (const record of logs) {
      const group = grouped.get(record.localPath) ?? [];
      group.push(record);
      grouped.set(record.localPath, group);
    }
    for (const [localPath, records] of grouped.entries()) {
      const uploadCount = records.filter((item) => item.direction === "upload").length;
      const downloadCount = records.filter((item) => item.direction === "download").length;
      const card = this.containerEl.createDiv();
      card.setAttr(
        "style",
        "border:1px solid var(--background-modifier-border); border-radius:12px; margin: 0 0 10px; overflow:hidden;"
      );
      const header = card.createDiv();
      header.setAttr(
        "style",
        "display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--background-secondary);"
      );
      header.createEl("div", {
        text: localPath
      });
      const summaryEl = header.createEl("div", {
        text: `${uploadCount}\u6B21\u4E0A\u4F20 / ${downloadCount}\u6B21\u4E0B\u8F7D`
      });
      summaryEl.setAttr("style", "font-size: 12px; color: var(--text-muted);");
      for (const record of records) {
        const row = card.createDiv();
        row.setAttr(
          "style",
          "padding:8px 12px; border-top:1px solid var(--background-modifier-border);"
        );
        const meta = row.createDiv();
        meta.setAttr("style", "display:flex; justify-content:space-between; gap:10px; margin-bottom:6px;");
        const timeEl = meta.createEl("span", {
          text: formatSyncLogTime(record.time)
        });
        timeEl.setAttr("style", "font-size: 12px; color: var(--text-muted);");
        const statusEl = meta.createEl("span", {
          text: `${record.direction === "upload" ? "\u4E0A\u4F20" : "\u4E0B\u8F7D"} | ${record.result === "success" ? "\u6210\u529F" : record.result === "failed" ? "\u5931\u8D25" : "\u8DF3\u8FC7"}`
        });
        statusEl.setAttr("style", "font-size: 12px; color: var(--text-muted);");
        const url = buildDocxUrlByToken(record.docToken);
        const linkRow = row.createDiv();
        linkRow.setAttr("style", "display:flex; align-items:center; gap:6px; margin-bottom:6px;");
        const urlInput = linkRow.createEl("input");
        urlInput.type = "text";
        urlInput.value = url;
        urlInput.readOnly = true;
        urlInput.setAttr("style", "flex:1; min-width:0; padding:5px 8px; font-size:13px;");
        const copyBtn = linkRow.createEl("button", { text: "\u{1F4CB}" });
        copyBtn.title = "\u590D\u5236\u94FE\u63A5";
        copyBtn.setAttr(
          "style",
          "padding:0 4px; min-width:auto; line-height:1; border:none; background:transparent; box-shadow:none;"
        );
        copyBtn.onclick = async () => {
          await copyToClipboard(url);
          new import_obsidian2.Notice("\u5DF2\u590D\u5236\u98DE\u4E66\u94FE\u63A5");
        };
        const openBtn = linkRow.createEl("button", { text: "\u{1F517}" });
        openBtn.title = "\u6253\u5F00\u94FE\u63A5";
        openBtn.setAttr(
          "style",
          "padding:0 4px; min-width:auto; line-height:1; border:none; background:transparent; box-shadow:none;"
        );
        openBtn.onclick = () => {
          window.open(url, "_blank");
        };
        const msgEl = row.createEl("small", {
          text: record.message
        });
        msgEl.setAttr("style", "font-size: 12px; color: var(--text-muted);");
      }
    }
  }
};
function createNewAccount() {
  return {
    id: `account-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: "\u65B0\u8D26\u53F7",
    appId: "",
    appSecret: "",
    authMode: "remote_bridge",
    remoteAuthUrl: "",
    remoteAuthApiKey: "",
    redirectUri: DEFAULT_LOCAL_OAUTH_REDIRECT,
    oauthScopes: DEFAULT_OAUTH_SCOPES2,
    authType: "user",
    userAccessToken: "",
    userRefreshToken: "",
    userTokenExpireAt: 0,
    userOpenId: "",
    userName: "",
    lastAuthError: "",
    lastAuthErrorAt: 0,
    lastAuthCheckAt: 0,
    enabled: true
  };
}
function toHeaderRecord(headers) {
  if (!headers) {
    return void 0;
  }
  if (headers instanceof Headers) {
    const record = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}
function toRequestBody(body) {
  if (!body) {
    return void 0;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer;
  }
  return void 0;
}
function formatAuthStatus(account) {
  const authMode = resolveAccountAuthMode(account);
  const authModeText = authMode === "remote_bridge" ? "\u8FDC\u7A0B\u4EE3\u7406" : "\u672C\u5730\u8BA4\u8BC1";
  const lastCheck = account.lastAuthCheckAt ? new Date(account.lastAuthCheckAt).toLocaleString() : "\u672A\u6821\u9A8C";
  const lastErrorAt = account.lastAuthErrorAt ? new Date(account.lastAuthErrorAt).toLocaleString() : "\u65E0";
  const lastError = account.lastAuthError || "\u65E0";
  const expireAt = account.userTokenExpireAt ?? 0;
  const valid = !!account.userAccessToken && expireAt > Date.now();
  const expireText = expireAt ? new Date(expireAt).toLocaleString() : "\u672A\u8BBE\u7F6E";
  const user = account.userName || account.userOpenId || "\u672A\u77E5\u7528\u6237";
  return `\u6A21\u5F0F: \u7528\u6237\u8EAB\u4EFD | \u4EE4\u724C\u4EA4\u6362: ${authModeText} | token\u6709\u6548: ${valid ? "\u662F" : "\u5426"} | \u5230\u671F: ${expireText} | \u7528\u6237: ${user} | \u6700\u8FD1\u6821\u9A8C: ${lastCheck} | \u6700\u8FD1\u9519\u8BEF: ${lastErrorAt} ${lastError}`;
}
function resolveAccountAuthMode(account) {
  if (account.authMode === "local_secret" || account.authMode === "remote_bridge") {
    return account.authMode;
  }
  return "remote_bridge";
}
function formatSyncLogTime(time) {
  const dt = new Date(time);
  const yyyy = dt.getFullYear();
  const MM = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}`;
}
function buildDocxUrlByToken(docToken) {
  return `https://feishu.cn/docx/${encodeURIComponent(docToken)}`;
}
async function copyToClipboard(value) {
  const nav = globalThis.navigator;
  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}
function isCompatibleAuthState(expectedState, receivedState) {
  if (!expectedState || !receivedState) {
    return false;
  }
  const expectedPrefix = expectedState.replace(/-\d+$/, "");
  const receivedPrefix = receivedState.replace(/-\d+$/, "");
  return expectedPrefix.length > 0 && expectedPrefix === receivedPrefix;
}
function parseBoundedInt(input, fallback, min, max) {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
