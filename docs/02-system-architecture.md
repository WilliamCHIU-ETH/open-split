# 02 系統架構

## 元件

```mermaid
flowchart LR
  web["apps/web<br/>React 帳本"]
  worker["apps/worker<br/>Hono + D1"]
  mcp["同一 Worker 上的 MCP"]
  core["packages/core<br/>純帳本數學"]
  contracts["packages/contracts<br/>Zod 契約"]
  auth["packages/auth<br/>登入邊界與假身份守衛"]
  driver["tools/driver<br/>驗收驅動"]
  web -->|HTTP| worker
  mcp --> worker
  worker --> core
  worker --> contracts
  worker --> auth
  driver --> core
  driver --> contracts
  driver --> auth
  web --> contracts
```

- `packages/core`：純函式。沒有 Workers、D1、檔案或網路。網頁預覽與 MCP 寫入都呼叫它，避免兩套分帳。
- `packages/contracts`：唯一可以定義 Zod schema 的地方。HTTP 與 MCP 共用。
- `packages/auth`：登入提供者介面，以及「假身份不得出現在正式設定」的純判斷。它不讀檔、不連 LINE。
- `apps/worker`：Hono 路由、Drizzle、D1、服務層。切片 1 會把平均分帳寫進 D1。還沒做的路徑仍回 501。
- `apps/web`：帳本介面。不匯入 Worker、不碰 D1、不匯入 `@open-split/auth`（假登入不能進前端 bundle，也不能進 LIFF）。
- `tools/driver`：代理人與 CI 用來跑「登入 → 建群 → 記帳 → 分享連結」的本機驅動。切片 1 起打本機 Worker。狀態檔只記工作階段，帳在 D1。

依賴方向由 dependency-cruiser 檢查。違反時的說明在 `.dependency-cruiser.cjs` 的 `comment`。

## 請求怎麼走

網頁與 MCP 都進 Worker 的服務層。服務層做三件事：用契約解析輸入、問資料層這個人是不是群組成員、呼叫 `packages/core` 得到份額與餘額，再把結果寫進 D1。活動紀錄記的是服務層認可的結果，不是客戶端自己算的數字。

瀏覽器若要做即時預覽，只能呼叫 `@open-split/core`。送出時仍以伺服器算出的結果為準。這一層預覽還沒做。

## 登入與 MCP 是兩條線

LINE Login 是主要登入，開放給所有人。Google 是次要登入。兩者只建立 `users` 與 `auth_identities`，**不**打開 MCP。

MCP 要另外過 OAuth 2.1，而且帳號的 `mcp_allowed` 必須為真，資料層還要確認群組成員。見 [ADR-0003](adr/0003-auth-separation.md)。

LIFF 使用打開它的那個人的 LINE 身份。在 LIFF 裡記帳就是在用帳本網頁。見 [ADR-0005](adr/0005-line-liff.md)。

## 本機假身份

驗收不能依賴真的 LINE 帳號。`@open-split/auth` 定義 `DevIdentityProvider.signInAs(name)`。`alice` 與 `bob` 的 subject 是固定的。

這個能力只在 `ENVIRONMENT` 為 `development` 或 `test`，且 `AUTH_DEV_IDENTITIES` 為真時成立。正式、預覽、空字串都會拒絕。

- `wrangler.jsonc` 的頂層 `vars` 是 `wrangler deploy` 會送出去的值，必須是 `ENVIRONMENT=production`、`AUTH_DEV_IDENTITIES=false`。任何環境把旗標打開，`pnpm test` 裡的設定檢查會失敗。
- 本機 `wrangler dev` 只從 `apps/worker/.dev.vars` 覆蓋。這個檔不進版控、不會上傳。範例在 `apps/worker/.dev.vars.example`，含測試用 LINE Login channel id、channel secret、LIFF id。
- driver 的 `login --as alice` 先在本機呼叫假身份提供者，所以 `--environment production` 在送出 HTTP 之前就會被同一個守衛拒絕。通過之後才向 Worker 換工作階段，帳本資料才進得了 D1。

OAuth 程式碼交換、LINE token、LIFF SDK 都不在這一次。介面與守衛先在。

## 資料

D1 是唯一的帳本資料庫。目標表在 `apps/worker/src/db/schema.ts`，說明在[程式設計](03-program-design.md)。金額欄位是整數最小貨幣單位，不是 REAL。

遷移按切片加。schema 檔可以走在遷移前面。切片 1 只查它自己遷移過的表。

## 可觀察性

Worker 打開 logs 與 traces。正式流量變大之後，再把 `traces.head_sampling_rate` 調低。日誌用 `JSON.stringify` 的單行物件。
