# ADR-0003：登入與 MCP 分開

- 狀態：已接受
- 日期：2026-11-20

## 背景

朋友要能輕鬆加入群組。外部代理人要能替擁有者記帳。這兩件事如果共用一把鑰匙，每個用 LINE 登入的人都會變成 MCP 客戶端。

## 決策

**LINE Login 是主要登入，開放給所有人。Google 是次要登入。** 兩者只建立使用者與 `auth_identities`（provider + subject）。它們不設定 `mcp_allowed`。

**MCP 是另一條授權。** 外部代理人走 OAuth 2.1（授權碼與 PKCE）。除此之外還要：

1. 該使用者的 `mcp_allowed` 為真（允許清單，預設關閉）。
2. 資料層確認他是目標群組的成員。工具不能只靠「猜對 group id」。

用 LINE 或 Google 登入，不會打開 MCP。MCP 授權也不代替群組角色。

LIFF 使用的是 LINE Login 的身份。它是登入，不是 MCP。在 LIFF 裡能做的事見 [ADR-0005](0005-line-liff.md)。

### 本機假身份

自動驗收需要在沒有真 LINE 帳號時跑「登入 → 建群 → 記帳 → 分享連結」。

`packages/auth` 定義：

- `AuthProvider`：`provider` 是 `line` 或 `google`，`mode` 是 `production` 或 `dev`。
- `ProductionAuthProvider` 沒有 `signInAs`。OAuth 完成留到後續切片。
- `DevIdentityProvider.signInAs(name)` 只存在於 dev。`alice` 與 `bob` 的 subject 固定為 `dev-line:alice`、`dev-google:bob` 這類值。

`assertDevAuthAllowed` 只在 `ENVIRONMENT` 為 `development` 或 `test` 時允許 `AUTH_DEV_IDENTITIES`。正式、預覽與空字串都會拒絕。

部署設定裡的這個旗標必須是 `"false"`。檢查讀取 `apps/worker/wrangler.jsonc`，任一處把旗標打開就失敗，包含 `env.test`：因為 `wrangler deploy --env test` 也會把假登入送出去。本機與測試 D1 只從 `.dev.vars`（Wrangler 不會上傳）或測試程式自己傳入的綁定打開。

`apps/web` 不得匯入 `@open-split/auth`。假身份一旦進到前端 bundle，LIFF 裡的使用者也能假裝成 alice。

## 後果

- 服務層在寫入群組資料前要查成員身份。MCP 工具再多一道 `mcp_allowed`。
- driver 的 `login --as alice` 是驗收用具，不是產品登入。`--environment production` 會被拒絕。
- `.dev.vars.example` 預留測試用 LINE Login channel id、channel secret 與 LIFF id。真的 secret 只放在沒有進版控的 `.dev.vars`。

## 不採用

把 LINE 的 channel access token 直接當成 MCP 的憑證。那會把人與人之間的登入，和代理人的權限焊在一起。
