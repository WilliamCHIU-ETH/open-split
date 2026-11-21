# ADR-0010：長期框架架構——單一 Worker 同網域、內部分層邊界、契約統一與輕量前端

- 狀態：已接受
- 日期：2026-11-21
- 脈絡：在進入切片 6（LINE Login、LIFF、MCP 改用 LINE 授權）與切片 7（LINE 通知）前，以長期可維護架構重新檢視整體 repo 結構。

## 決策

### 1. 前後端程式分離，部署同網域合一（Workers Static Assets）
- `apps/web` 與 `apps/worker` 在程式碼層由 `dependency-cruiser` 嚴格分離，但部署時由**同一個 Cloudflare Worker** 透過 Workers Static Assets 提供靜態網頁與 API／MCP。
- `wrangler.jsonc` 的 `assets.run_worker_first` 明確列出所有後端前綴（`/api/*`、`/auth/*`、`/mcp`、`/authorize`、`/callback`、`/oauth/*`、`/.well-known/*`、`/health`），其餘路徑才走 SPA fallback。
- 理由：LIFF、LINE Login callback、MCP OAuth callback 與 `SameSite=Lax` session cookie 共享同一網域，無須 CORS 或 `SameSite=None`，避免 iOS LINE 內建瀏覽器（WKWebView／ITP）擋第三方 cookie，並保留單一原子部署與退回點。

### 2. Worker 內部分層與機器強制邊界
- `apps/worker/src/entry/` 為唯一組裝入口，負責環境守衛與分發，不再由 `mcp/oauth.ts` 反過來包住 `http/app.ts`。
- 透過 `.dependency-cruiser.cjs` 強制內部有向無環分層：
  - `http/` 與 `mcp/` 互不匯入，共用工具下沉至 `shared/`。
  - `ledger/`（用例與領域服務）不匯入 `http/`、`mcp/`、`entry/`。
  - `db/` 與 `shared/` 為底層葉節點，不反向依賴上層傳輸或入口。
- 帳本通知（切片 7）採 **Transactional Outbox** 模式：領域事件在服務層產生（`ledger/events.ts`），寫入同一筆 D1 `db.batch`，確保網頁與 MCP 寫入觸發完全一致的群組通知且不因 Worker 請求中斷而遺失。

### 3. 契約單一事實來源（零前端 Zod 負擔）
- HTTP 與 MCP 共用 `packages/contracts/src/ledger.ts` 的同一組 Zod schema，移除 `mcp.ts` 內的寬鬆 `*Stub` 避免兩邊漂移。
- 提供給 `apps/web` 的路徑定義（`apiPaths`）與型別（`type` import）不把 Zod 拉進瀏覽器執行期，守住 150 KB gzip 預算。
- 未知 `/api/*` 回傳乾淨 `404 not_found`，不在線上回應暴露路由清單。

### 4. 前端維持輕量自寫路由，LIFF SDK 採 npm 白名單
- 150 KB gzip 預算下不引入 React Router／TanStack Router 或重型快取套件；改以集中且有型別的小路由模組管理，明確排除後端前綴（`/api/`、`/auth/`、`/authorize`、`[download]`）並保留 `window.location.search`（供 LIFF `liff.state` 與 OAuth 參數使用）。
- 切片 6 接入 `@line/liff` 時，走 npm 鎖定版本並納入 `tools/constraint-check` 白名單，同時受 150 KB 預算控管；不改由外部 CDN `<script>` 載入，以維持嚴格 CSP 與離線型別檢查。

### 5. `packages/auth` 界線與巢狀 `AGENTS.md`
- `packages/auth` 專責零 I/O 的純授權政策與假身份環境守衛；所有涉及網路與金鑰的 LINE／OAuth 流程留在 `apps/worker`。
- `docs/` 維持扁平編號不搬移目錄，避免破壞既有連結與引用；只在規則專屬該層時增設 `apps/worker/AGENTS.md` 與 `apps/web/AGENTS.md`（吸納 `.cursor/rules/web-frontend.mdc`，讓所有 Agent 工具讀到同一份規則）。

## 後果
- `apps/worker/src/ledger/service.ts` 依領域拆成模組化檔案，每次重構拆成不超過 1,000 行的小型 PR，走自動化 `merge-gate` 驗證。
- `ci.yml` 的 `accept` job 在啟動 `wrangler dev` 前先建置 `@open-split/web`，確保靜態資產與 API 在 CI 同時驗證。
