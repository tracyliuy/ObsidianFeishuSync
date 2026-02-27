#!/usr/bin/env node
"use strict";

/**
 * Feishu OAuth bridge (single-file, zero dependency)
 *
 * Purpose:
 * - Keep app_secret on server side
 * - Exchange OAuth code -> user_access_token for desktop plugin
 *
 * Run:
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   FEISHU_REDIRECT_URI=https://your-domain/feishu/callback \
 *   BRIDGE_API_KEY=your_api_key \
 *   node server/feishu-oauth-bridge.js
 */

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || "8787");
const HOST = process.env.HOST || "0.0.0.0";
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const FEISHU_REDIRECT_URI = process.env.FEISHU_REDIRECT_URI || "";
const FEISHU_APP_CREDENTIALS = parseAppCredentials(process.env.FEISHU_APP_CREDENTIALS || "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || "15000"));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FEISHU_OAUTH_AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_OAUTH_TOKEN = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

function parseAppCredentials(raw) {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function json(res, status, payload, origin = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  setCorsHeaders(res, origin);
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res, origin) {
  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-API-Key");
}

function requireApiKey(req) {
  if (!BRIDGE_API_KEY) return null;
  const provided = String(req.headers["x-api-key"] || "");
  if (provided !== BRIDGE_API_KEY) {
    return "Unauthorized: invalid API key";
  }
  return null;
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function postFeishuToken(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(FEISHU_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await resp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    return { status: resp.status, ok: resp.ok, payload };
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthorizeUrl(appId, state, scopes, redirectUri) {
  const url = new URL(FEISHU_OAUTH_AUTHORIZE);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri || FEISHU_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  if (state) url.searchParams.set("state", state);
  if (scopes) url.searchParams.set("scope", scopes);
  return String(url);
}

function validateBaseConfig() {
  if (!FEISHU_APP_ID && Object.keys(FEISHU_APP_CREDENTIALS).length === 0) {
    return "Server misconfigured: FEISHU_APP_ID / FEISHU_APP_SECRET is required";
  }
  return null;
}

function resolveAppConfig(appId = "") {
  const byMap = appId ? FEISHU_APP_CREDENTIALS[appId] : undefined;
  if (byMap && typeof byMap === "object") {
    const app_secret = typeof byMap.app_secret === "string" ? byMap.app_secret : "";
    const redirect_uri = typeof byMap.redirect_uri === "string" ? byMap.redirect_uri : FEISHU_REDIRECT_URI;
    return { app_id: appId, app_secret, redirect_uri };
  }
  if (appId && typeof byMap === "string") {
    return { app_id: appId, app_secret: byMap, redirect_uri: FEISHU_REDIRECT_URI };
  }
  return { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET, redirect_uri: FEISHU_REDIRECT_URI };
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  setCorsHeaders(res, origin);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        service: "feishu-oauth-bridge",
        hasAppId: Boolean(FEISHU_APP_ID),
        hasAppSecret: Boolean(FEISHU_APP_SECRET),
        hasRedirectUri: Boolean(FEISHU_REDIRECT_URI),
        now: Date.now()
      }, origin);
      return;
    }

    if (url.pathname === "/oauth/authorize-url" && req.method === "GET") {
      const configErr = validateBaseConfig();
      if (configErr) {
        json(res, 500, { ok: false, error: configErr }, origin);
        return;
      }
      const state = url.searchParams.get("state") || "";
      const scope = url.searchParams.get("scope") || "";
      const appId = url.searchParams.get("app_id") || "";
      const appConfig = resolveAppConfig(appId);
      const redirectUri = url.searchParams.get("redirect_uri") || appConfig.redirect_uri;
      if (!redirectUri) {
        json(res, 400, { ok: false, error: "redirect_uri is required" }, origin);
        return;
      }
      if (!appConfig.app_id) {
        json(res, 400, { ok: false, error: "app_id is required" }, origin);
        return;
      }
      json(
        res,
        200,
        {
          ok: true,
          authorize_url: buildAuthorizeUrl(appConfig.app_id, state, scope, redirectUri),
          redirect_uri: redirectUri
        },
        origin
      );
      return;
    }

    if (url.pathname === "/oauth/exchange" && req.method === "POST") {
      const keyErr = requireApiKey(req);
      if (keyErr) {
        json(res, 401, { ok: false, error: keyErr }, origin);
        return;
      }
      const configErr = validateBaseConfig();
      if (configErr) {
        json(res, 500, { ok: false, error: configErr }, origin);
        return;
      }

      const body = await readJson(req);
      const code = String(body.code || "");
      const appId = String(body.app_id || "");
      const appConfig = resolveAppConfig(appId);
      const redirectUri = String(body.redirect_uri || FEISHU_REDIRECT_URI || "");
      if (!code) {
        json(res, 400, { ok: false, error: "code is required" }, origin);
        return;
      }
      if (!redirectUri) {
        json(res, 400, { ok: false, error: "redirect_uri is required" }, origin);
        return;
      }

      if (!appConfig.app_id || !appConfig.app_secret) {
        json(res, 400, { ok: false, error: "app_id/app_secret is not configured on bridge" }, origin);
        return;
      }
      const result = await postFeishuToken({
        grant_type: "authorization_code",
        client_id: appConfig.app_id,
        client_secret: appConfig.app_secret,
        code,
        redirect_uri: redirectUri
      });
      json(res, result.status, { ok: result.ok, ...result.payload }, origin);
      return;
    }

    if (url.pathname === "/oauth/refresh" && req.method === "POST") {
      const keyErr = requireApiKey(req);
      if (keyErr) {
        json(res, 401, { ok: false, error: keyErr }, origin);
        return;
      }
      const configErr = validateBaseConfig();
      if (configErr) {
        json(res, 500, { ok: false, error: configErr }, origin);
        return;
      }

      const body = await readJson(req);
      const refreshToken = String(body.refresh_token || "");
      const appId = String(body.app_id || "");
      const appConfig = resolveAppConfig(appId);
      if (!refreshToken) {
        json(res, 400, { ok: false, error: "refresh_token is required" }, origin);
        return;
      }
      if (!appConfig.app_id || !appConfig.app_secret) {
        json(res, 400, { ok: false, error: "app_id/app_secret is not configured on bridge" }, origin);
        return;
      }

      const result = await postFeishuToken({
        grant_type: "refresh_token",
        client_id: appConfig.app_id,
        client_secret: appConfig.app_secret,
        refresh_token: refreshToken
      });
      json(res, result.status, { ok: result.ok, ...result.payload }, origin);
      return;
    }

    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const err = url.searchParams.get("error") || "";
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><body><h3>${
          err ? "授权失败" : "授权成功"
        }</h3><p>code: ${code ? "received" : "missing"} | state: ${state || "-"}</p><p>可关闭此页面。</p></body></html>`
      );
      return;
    }

    json(res, 404, { ok: false, error: "Not Found" }, origin);
  } catch (error) {
    json(res, 500, { ok: false, error: String(error) }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[feishu-oauth-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[feishu-oauth-bridge] health: http://${HOST}:${PORT}/health`);
});
