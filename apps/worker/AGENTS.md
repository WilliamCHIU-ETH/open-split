# apps/worker 給 Agent 的規則

通用 repo 規則與流程見根目錄 [AGENTS.md](../../AGENTS.md)。本檔只補充 Worker 層的專屬邊界與資料一致性規則（見 [ADR-0010](../../docs/adr/0010-long-term-architecture.md)）。

## 內部分層（由 `.dependency-cruiser.cjs` 強制）

- `src/entry/`：唯一組裝入口，負責執行期假身份環境守衛與分發至 `http/` 或 `mcp/`。`src/index.ts` 只轉發 `src/entry/worker.ts`。
- `src/http/` 與 `src/mcp/`：薄傳輸層，**互不匯入**。共用輔助（例如串流位元組上限）放 `src/shared/`。
- `src/ledger/`：領域與用例服務，**不可匯入** `http/`、`mcp/`、`entry/`。新領域模組沿用小檔切分，經由 `ledger/service.ts` 穩定對外匯出。
- `src/db/` 與 `src/shared/`：葉節點模組，不可反向匯入傳輸層、服務層或入口層。
- `packages/auth` 只放零 I/O 的授權政策與假身份守衛；涉及金鑰與外部網路呼叫的 LINE／Google OAuth 流程留在 `apps/worker`。

## 資料一致性與通知

- 所有寫入操作與 `activity_log` 必須在同一個 D1 `db.batch([...])` 中原子完成，並標示 `audit.via`（`web` 或 `mcp`）。
- 切片 7 起的群組通知採 **Transactional Outbox**：領域事件在 `ledger/` 產生（型別見 `src/ledger/events.ts`），隨同一筆 `db.batch` 寫入 outbox 表，再由非同步派送器送出，不直接在 HTTP／MCP handler 裡同步呼叫外部 LINE Messaging API。
- D1 遷移只新增檔案，不修改已合併的遷移；每次改表都須附「從有資料的舊庫升級」測試。

## 同網域靜態資產與環境變數

- `wrangler.jsonc` 以 Workers Static Assets 同網域提供 `apps/web/dist`；新增後端前綴時，必須同步更新 `wrangler.jsonc` 的 `assets.run_worker_first`、`apps/web/src/router.ts` 的 `BACKEND_PATH_PREFIXES` 與 `apps/web/vite.config.ts` 的 `proxy`。
- 改完 `wrangler.jsonc` binding 或 secret 宣告後，跑 `pnpm types` 確認型別同步；不要手寫 `Env`。
