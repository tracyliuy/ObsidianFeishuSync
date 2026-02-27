<?php
declare(strict_types=1);

/**
 * Feishu OAuth bridge (single PHP file, no framework)
 *
 * Environment:
 * - FEISHU_APP_ID
 * - FEISHU_APP_SECRET
 * - FEISHU_REDIRECT_URI
 * - BRIDGE_API_KEY (optional but strongly recommended)
 * - ALLOWED_ORIGINS (comma separated, default: *)
 * - REQUEST_TIMEOUT_MS (default: 15000)
 */

$FEISHU_APP_ID = getenv("FEISHU_APP_ID") ?: "";
$FEISHU_APP_SECRET = getenv("FEISHU_APP_SECRET") ?: "";
$FEISHU_REDIRECT_URI = getenv("FEISHU_REDIRECT_URI") ?: "";
$FEISHU_APP_CREDENTIALS_RAW = getenv("FEISHU_APP_CREDENTIALS") ?: "";
$BRIDGE_API_KEY = getenv("BRIDGE_API_KEY") ?: "";
$REQUEST_TIMEOUT_MS = (int)(getenv("REQUEST_TIMEOUT_MS") ?: "15000");
$ALLOWED_ORIGINS = array_values(array_filter(array_map("trim", explode(",", getenv("ALLOWED_ORIGINS") ?: "*"))));

$FEISHU_OAUTH_AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
$FEISHU_OAUTH_TOKEN = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

$FEISHU_APP_CREDENTIALS = [];
if ($FEISHU_APP_CREDENTIALS_RAW !== "") {
  $decoded = json_decode($FEISHU_APP_CREDENTIALS_RAW, true);
  if (is_array($decoded)) {
    $FEISHU_APP_CREDENTIALS = $decoded;
  }
}

function get_request_headers_safe(): array {
  if (function_exists("getallheaders")) {
    $headers = getallheaders();
    if (is_array($headers)) return $headers;
  }
  $headers = [];
  foreach ($_SERVER as $name => $value) {
    if (strpos($name, "HTTP_") === 0) {
      $key = str_replace(" ", "-", ucwords(strtolower(str_replace("_", " ", substr($name, 5)))));
      $headers[$key] = (string)$value;
    }
  }
  return $headers;
}

function set_cors_headers(array $allowedOrigins): void {
  $origin = $_SERVER["HTTP_ORIGIN"] ?? "";
  if (in_array("*", $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: *");
  } elseif ($origin !== "" && in_array($origin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: " . $origin);
  }
  header("Access-Control-Allow-Methods: GET,POST,OPTIONS");
  header("Access-Control-Allow-Headers: Content-Type,X-API-Key");
}

function json_response(int $status, array $payload): void {
  http_response_code($status);
  header("Content-Type: application/json; charset=utf-8");
  echo json_encode($payload, JSON_UNESCAPED_UNICODE);
  exit;
}

function read_json_body(): array {
  $raw = file_get_contents("php://input");
  if ($raw === false || trim($raw) === "") {
    return [];
  }
  $decoded = json_decode($raw, true);
  if (!is_array($decoded)) {
    json_response(400, ["ok" => false, "error" => "Invalid JSON body"]);
  }
  return $decoded;
}

function require_api_key(string $requiredKey): void {
  if ($requiredKey === "") return;
  $headers = get_request_headers_safe();
  $provided = "";
  foreach ($headers as $k => $v) {
    if (strtolower($k) === "x-api-key") {
      $provided = (string)$v;
      break;
    }
  }
  if ($provided !== $requiredKey) {
    json_response(401, ["ok" => false, "error" => "Unauthorized: invalid API key"]);
  }
}

function validate_base_config(string $appId, string $appSecret, array $appCredentials): void {
  if (($appId === "" || $appSecret === "") && count($appCredentials) === 0) {
    json_response(500, ["ok" => false, "error" => "Server misconfigured: FEISHU_APP_ID / FEISHU_APP_SECRET is required"]);
  }
}

function feishu_token_request(string $url, array $body, int $timeoutMs): array {
  $ch = curl_init($url);
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_POST, true);
  curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
  curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
  curl_setopt($ch, CURLOPT_TIMEOUT_MS, max(1000, $timeoutMs));
  $respBody = curl_exec($ch);
  if ($respBody === false) {
    $err = curl_error($ch);
    curl_close($ch);
    return [
      "status" => 500,
      "ok" => false,
      "payload" => ["ok" => false, "error" => "curl failed: " . $err]
    ];
  }
  $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  $decoded = json_decode((string)$respBody, true);
  if (!is_array($decoded)) {
    $decoded = ["raw" => (string)$respBody];
  }
  return ["status" => $status, "ok" => ($status >= 200 && $status < 300), "payload" => $decoded];
}

function build_authorize_url(string $baseUrl, string $appId, string $redirectUri, string $state, string $scope): string {
  $params = [
    "app_id" => $appId,
    "redirect_uri" => $redirectUri,
    "response_type" => "code"
  ];
  if ($state !== "") $params["state"] = $state;
  if ($scope !== "") $params["scope"] = $scope;
  return $baseUrl . "?" . http_build_query($params);
}

function resolve_app_config(
  array $appCredentials,
  string $requestedAppId,
  string $defaultAppId,
  string $defaultAppSecret,
  string $defaultRedirectUri
): array {
  if ($requestedAppId !== "" && array_key_exists($requestedAppId, $appCredentials)) {
    $entry = $appCredentials[$requestedAppId];
    if (is_string($entry)) {
      return [
        "app_id" => $requestedAppId,
        "app_secret" => $entry,
        "redirect_uri" => $defaultRedirectUri
      ];
    }
    if (is_array($entry)) {
      return [
        "app_id" => $requestedAppId,
        "app_secret" => (string)($entry["app_secret"] ?? ""),
        "redirect_uri" => (string)($entry["redirect_uri"] ?? $defaultRedirectUri)
      ];
    }
  }
  return [
    "app_id" => $defaultAppId,
    "app_secret" => $defaultAppSecret,
    "redirect_uri" => $defaultRedirectUri
  ];
}

set_cors_headers($ALLOWED_ORIGINS);
if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
  http_response_code(204);
  exit;
}

$path = parse_url($_SERVER["REQUEST_URI"] ?? "/", PHP_URL_PATH) ?: "/";
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

// Support reverse proxy/nginx path prefix "/api" while keeping backward compatible routes.
if ($path === "/api") {
  $path = "/";
} elseif (strpos($path, "/api/") === 0) {
  $normalized = substr($path, 4);
  $path = $normalized !== "" ? $normalized : "/";
}

if ($path === "/health" && $method === "GET") {
  json_response(200, [
    "ok" => true,
    "service" => "feishu-oauth-bridge-php",
    "hasAppId" => $FEISHU_APP_ID !== "",
    "hasAppSecret" => $FEISHU_APP_SECRET !== "",
    "hasRedirectUri" => $FEISHU_REDIRECT_URI !== "",
    "now" => round(microtime(true) * 1000)
  ]);
}

if ($path === "/oauth/authorize-url" && $method === "GET") {
  validate_base_config($FEISHU_APP_ID, $FEISHU_APP_SECRET, $FEISHU_APP_CREDENTIALS);
  $requestedAppId = isset($_GET["app_id"]) ? trim((string)$_GET["app_id"]) : "";
  $appConfig = resolve_app_config(
    $FEISHU_APP_CREDENTIALS,
    $requestedAppId,
    $FEISHU_APP_ID,
    $FEISHU_APP_SECRET,
    $FEISHU_REDIRECT_URI
  );
  $state = isset($_GET["state"]) ? trim((string)$_GET["state"]) : "";
  $scope = isset($_GET["scope"]) ? trim((string)$_GET["scope"]) : "";
  $redirectUri = isset($_GET["redirect_uri"]) ? trim((string)$_GET["redirect_uri"]) : (string)$appConfig["redirect_uri"];
  if ((string)$appConfig["app_id"] === "") {
    json_response(400, ["ok" => false, "error" => "app_id is required"]);
  }
  if ($redirectUri === "") {
    json_response(400, ["ok" => false, "error" => "redirect_uri is required"]);
  }
  json_response(200, [
    "ok" => true,
    "authorize_url" => build_authorize_url($FEISHU_OAUTH_AUTHORIZE, (string)$appConfig["app_id"], $redirectUri, $state, $scope),
    "redirect_uri" => $redirectUri
  ]);
}

if ($path === "/oauth/exchange" && $method === "POST") {
  require_api_key($BRIDGE_API_KEY);
  validate_base_config($FEISHU_APP_ID, $FEISHU_APP_SECRET, $FEISHU_APP_CREDENTIALS);
  $body = read_json_body();
  $requestedAppId = trim((string)($body["app_id"] ?? ""));
  $appConfig = resolve_app_config(
    $FEISHU_APP_CREDENTIALS,
    $requestedAppId,
    $FEISHU_APP_ID,
    $FEISHU_APP_SECRET,
    $FEISHU_REDIRECT_URI
  );
  $code = trim((string)($body["code"] ?? ""));
  $redirectUri = trim((string)($body["redirect_uri"] ?? (string)$appConfig["redirect_uri"]));
  if ($code === "") {
    json_response(400, ["ok" => false, "error" => "code is required"]);
  }
  if ($redirectUri === "") {
    json_response(400, ["ok" => false, "error" => "redirect_uri is required"]);
  }
  if ((string)$appConfig["app_id"] === "" || (string)$appConfig["app_secret"] === "") {
    json_response(400, ["ok" => false, "error" => "app_id/app_secret is not configured on bridge"]);
  }
  $resp = feishu_token_request($FEISHU_OAUTH_TOKEN, [
    "grant_type" => "authorization_code",
    "client_id" => (string)$appConfig["app_id"],
    "client_secret" => (string)$appConfig["app_secret"],
    "code" => $code,
    "redirect_uri" => $redirectUri
  ], $REQUEST_TIMEOUT_MS);
  json_response((int)$resp["status"], array_merge(["ok" => (bool)$resp["ok"]], (array)$resp["payload"]));
}

if ($path === "/oauth/refresh" && $method === "POST") {
  require_api_key($BRIDGE_API_KEY);
  validate_base_config($FEISHU_APP_ID, $FEISHU_APP_SECRET, $FEISHU_APP_CREDENTIALS);
  $body = read_json_body();
  $requestedAppId = trim((string)($body["app_id"] ?? ""));
  $appConfig = resolve_app_config(
    $FEISHU_APP_CREDENTIALS,
    $requestedAppId,
    $FEISHU_APP_ID,
    $FEISHU_APP_SECRET,
    $FEISHU_REDIRECT_URI
  );
  $refreshToken = trim((string)($body["refresh_token"] ?? ""));
  if ($refreshToken === "") {
    json_response(400, ["ok" => false, "error" => "refresh_token is required"]);
  }
  if ((string)$appConfig["app_id"] === "" || (string)$appConfig["app_secret"] === "") {
    json_response(400, ["ok" => false, "error" => "app_id/app_secret is not configured on bridge"]);
  }
  $resp = feishu_token_request($FEISHU_OAUTH_TOKEN, [
    "grant_type" => "refresh_token",
    "client_id" => (string)$appConfig["app_id"],
    "client_secret" => (string)$appConfig["app_secret"],
    "refresh_token" => $refreshToken
  ], $REQUEST_TIMEOUT_MS);
  json_response((int)$resp["status"], array_merge(["ok" => (bool)$resp["ok"]], (array)$resp["payload"]));
}

if ($path === "/oauth/callback" && $method === "GET") {
  $code = isset($_GET["code"]) ? trim((string)$_GET["code"]) : "";
  $state = isset($_GET["state"]) ? trim((string)$_GET["state"]) : "";
  $err = isset($_GET["error"]) ? trim((string)$_GET["error"]) : "";
  header("Content-Type: text/html; charset=utf-8");
  echo "<!doctype html><html><body>";
  echo "<h3>" . ($err !== "" ? "授权失败" : "授权成功") . "</h3>";
  echo "<p>code: " . ($code !== "" ? "received" : "missing") . " | state: " . ($state !== "" ? htmlspecialchars($state, ENT_QUOTES, "UTF-8") : "-") . "</p>";
  echo "<p>可关闭此页面。</p>";
  echo "</body></html>";
  exit;
}

json_response(404, ["ok" => false, "error" => "Not Found"]);
