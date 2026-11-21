# ADR-0009：MCP 用 LINE 登入授權，取代 Google 白名單

- 狀態：已接受（實作在切片 6）
- 日期：2026-11-21
- 取代：[ADR-0007](0007-mcp-oauth-google-whitelist.md) 第 2 點「上游身份驗證與白名單」。ADR-0007 的其他部分（OAuth Provider、scope、token 隔離、冪等與稽核）仍然有效。
- 修訂：[ADR-0003](0003-auth-separation.md) 的 MCP 開關條件。

## 背景

ADR-0007 用 Google OAuth 加 Gmail 白名單決定誰的 Agent 能連 MCP。擁有者在 2026-11-21 說明，那是當時還沒想清楚 MCP 要怎麼管理時的暫時做法。實際的身份是 LINE：網頁與 LIFF 都用 LINE 登入（[00 意圖](../00-intent.md)）。

保留 Google 會造成帳號分裂：同一個人用 LINE 登入網頁、用 Google 授權 Agent，在資料庫裡是兩個 `users`，Agent 看不到他的群組（審查 P2-9）。Lightsplit 的 MCP 也是讓 Agent 用同一個 LINE 帳號登入、再按同意。

## 決策

1. **MCP 的上游登入就是網頁的 LINE Login。** `/authorize` 導到 LINE Login；登入後得到的是網頁同一位 `users` 列。沒有第二套身份。
2. **能不能連 MCP，看 `users.mcp_allowed`。** 預設關閉。上線前只開擁有者自己：擁有者的 LINE user id 放在 Worker 變數 `OWNER_LINE_USER_IDS`，比對成功就視為允許。之後要讓朋友的 Agent 連，由擁有者在網頁替那個人打開 `mcp_allowed`，不是登入就有。
3. **同意頁照舊。** 顯示是哪個客戶端、要 `mcp:read` 還是 `mcp:write`；預設只給讀，記住授權預設不勾。
4. **權限不超過本人。** 每次工具呼叫照舊即時複查 `mcp_allowed` 與群組成員身份。
5. **正式環境不能直接用 `userId` 拉人進群。** `add_member(virtual: false, userId)` 只在 dev／test 可用。正式環境加真人只走虛擬成員認領或邀請連結，讓對方自己同意。

## 後果

- `MCP_ALLOWED_EMAILS`、Google 上游 OIDC 與相關 secret 在切片 6 移除。driver 與測試改用 dev LINE 身份走 MCP 授權。
- P2-9 的帳號連結問題消失，不做 LINE 與 Google 的合併流程。
- Google 不再是上線範圍內的登入方式。是否保留為網頁次要登入，等上線後有實際需要再決定。
- MCP 依然是獨立的 OAuth 授權：LINE 登入本身不會發出 MCP 權杖，ADR-0003 的「登入與 MCP 分開」精神不變，變的只是上游身份來源。

## 不採用

- 維持 Google 白名單：多一套身份，造成帳號分裂，還要另外維護 Email 名單。
- 登入 LINE 就自動能連 MCP：任何受邀朋友都會變成 MCP 客戶端，違反 ADR-0003。
