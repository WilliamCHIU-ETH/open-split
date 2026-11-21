# ADR-0008：R2 憑證與收據附檔（僅保存、不做 OCR）

- 狀態：已接受
- 日期：2026-11-20

## 背景

切片 5 允許代理人（與網頁使用者）替支出附上收據或檔案，但帳本只負責安全保存，不做 OCR 辨識或文字抽取（OCR 由擁有者外部代理人自行處理，再以結構化支出＋附檔送入帳本）。

## 決策

1. **儲存空間**：使用 Cloudflare R2（`RECEIPTS_BUCKET` 綁定，10 GiB 免費額度）；不對外公開 bucket。
2. **兩步上傳契約**：
   - 不把 base64 二進位塞進 JSON-RPC 或 JSON body。
   - 第一步：經 MCP 工具 `create_attachment_upload` 或 `POST /api/groups/:groupId/attachments/upload-intent` 檢查成員身份與配額，在 D1 寫入 `status = 'pending'` 並回傳一次性 Worker 上傳路徑與 `attachmentId`。
   - 第二步：`PUT /api/groups/:groupId/attachments/:attachmentId/content`（或公開授權的一次性簽章／HMAC 上傳 token，使外部代理人在無網頁 session 時也能完成 PUT）以串流檢查實際位元組大小（上限 10 MiB）、以檔案魔數驗證 MIME 型別（僅允許 `image/jpeg`、`image/png`、`image/webp`、`application/pdf`；禁止 SVG／HTML）、比對 SHA-256，寫入伺服器產生的 R2 key（`groups/{groupId}/receipts/{attachmentId}`）後將 D1 標記為 `ready`。
3. **配額與關聯**：每筆支出最多 5 份附檔，每群組總配額 100 MiB；上傳時可選擇直接掛在既有的 `expenseId`，或先上傳後於 `add_expense`／`update_expense` 附上 `attachmentIds` 綁定。
4. **私有下載與防 XSS**：僅經 `/api/groups/:groupId/attachments/:attachmentId`（或對應 MCP 唯讀摘要）存取；下載前即時確認 `requireMembership`，回應加上 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、`Cache-Control: private, no-store`。
5. **不啟用 Cron 的孤兒回收**：沿用無背景排程原則，於每次建立上傳或讀取群組附檔列表時順手掃描少量超過 24 小時仍為 `pending` 的殘留列，先刪 R2 再標記／清理 D1。
6. **作廢支出保留附檔**：支出作廢時保留收據作為稽核紀錄；手動刪除則寫入 `activity_log` 並刪除 R2 物件與軟刪 D1 列。

## 後果

- `apps/worker/wrangler.jsonc` 新增 `r2_buckets`（`RECEIPTS_BUCKET`）；本機 `wrangler dev` 自動以 Miniflare 模擬 R2，正式環境於部署前建立 bucket。
- 帳本與 MCP 的通訊保持純 JSON 契約，不受大型檔案膨脹影響。

## 不採用

- 公開 R2 bucket URL 或預簽公開網址（難以即時撤銷已離群成員的下載權）。
- 內建 OCR 或在 Worker 端解析圖片／PDF 內容（違反產品邊界且增加攻擊面）。
