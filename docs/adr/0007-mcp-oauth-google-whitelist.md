# ADR-0007：MCP OAuth 2.1 採用 Cloudflare OAuth Provider 與 Google 白名單

- 狀態：已接受
- 日期：2026-11-20

## 背景

[ADR-0003](0003-auth-separation.md) 要求登入與 MCP 分開：一般朋友可以用 LINE Login 進群組看帳與記帳，但不應因此拿到 MCP 代理人權杖。另一方面，擁有者希望沿用先前的實戰模式（`@cloudflare/workers-oauth-provider` + Google OAuth + Gmail 白名單），讓 Claude 等支援 MCP OAuth 的用戶端安全取得讀寫帳本權限。

## 決策

1. **OAuth 2.1 伺服器**：在 `apps/worker` 使用 Cloudflare 官方 `@cloudflare/workers-oauth-provider`（搭配 `OAUTH_KV` 綁定），提供標準端點：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/register`（含 DCR 檢查）、`/authorize`、`/callback`、`/oauth/token`。
2. **上游身份驗證與白名單**：
   - 正式環境在 `/authorize` 引導至 **Google OAuth**（`openid email`，PKCE S256 + `nonce` + JWKS `RS256` 驗簽），要求 `email_verified === true`。
   - 授權條件採預設拒絕：**電子郵件須在 `MCP_ALLOWED_EMAILS` 白名單內，或對應的 D1 `users.mcp_allowed` 為真**。通過後自動對應／建立 `users` 與 `auth_identities(provider='google')` 列。
   - 本機測試／驗收（限 `ENVIRONMENT` 為 `development` 或 `test` 且 `AUTH_DEV_IDENTITIES=true`，受 `assertDevAuthAllowed` 守衛）提供開發用身份授權表單與可注入的 OIDC 端點，不把假身份帶進正式設定。
3. **細粒度 Scope 與 Token 隔離**：
   - 支援 `mcp:read`（讀群組、餘額、活動、結清建議、摘要、附檔列表）與 `mcp:write`（建群、加成員、記／改／作廢支出、記錄／作廢結清、設定收款方式、建立附檔上傳／刪除附檔）。
   - **Token 嚴格隔離**：`/mcp` 只接受 `OAuthProvider` 簽發的 MCP access token，拒絕網頁 `sessions` token；`/api/*` 只接受網頁 `sessions` token／Cookie，拒絕 MCP OAuth token。
   - 每次 `/mcp` 請求與工具呼叫皆即時複查白名單／`users.mcp_allowed` 與目標 `groupId` 的 `requireMembership`，離線撤權立即生效。
4. **稽核與防重複**：寫入型工具支援 `idempotencyKey`（同使用者同 key 重試回傳快取結果、不同內容回 422），並在 `activity_log` 標記來源 `via: "mcp"` 與 `clientId`。

## 後果

- 擁有者只要將自己的 Gmail 設在 `MCP_ALLOWED_EMAILS`，即可用 Claude 等外部代理人經 OAuth 2.1 記帳與編輯，不需要幫每個 MCP 客戶端手動開資料庫旗標。
- 一般 LINE 朋友不進白名單就拿不到 MCP 權杖，無法把私人聊天工具直接連進帳本。
- `wrangler.jsonc` 新增 `OAUTH_KV`（Free Tier 即可，正式部署前建立命名空間並填入 `id`；本機 `wrangler dev` 自動模擬）。

## 不採用

- 自己從頭手寫 RFC 7591／8707／9728 與 refresh token 輪替。改用 Cloudflare 官方 `@cloudflare/workers-oauth-provider` 降低安全錯漏風險。
- 把 LINE Login 權杖或網頁 session token 直接當 MCP Bearer token。
