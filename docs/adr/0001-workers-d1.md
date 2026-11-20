# ADR-0001：帳本跑在 Cloudflare Workers + D1

- 狀態：已接受
- 日期：2026-11-20

## 背景

帳本要由擁有者自己掌控，讀寫模型簡單，並能同時服務網頁與 MCP。流量是個人與小群組，不是多租戶的大規模分析。

## 決策

API、MCP 與稍後的 LIFF 靜態資源都放在 Cloudflare Workers。帳本資料放在 D1，經由 Drizzle 存取。設定用 `wrangler.jsonc`。相容日期用建立當日（2026-11-20）。這個日期已預設開啟 Node.js 相容，因此不再寫 `nodejs_compat`。

`database_id` 目前是佔位符。第一次部署前才用 `wrangler d1 create` 換成真的 id。密鑰不進設定檔，本機用 `.dev.vars`。

## 後果

- 沒有長駐的伺服器行程。請求期間要完成的工作必須在該次請求裡結束。
- D1 是 SQLite。金額用 INTEGER。跨表的不變量由服務層與 `packages/core` 維持，不靠資料庫觸發器偷偷改帳。
- 綁定型別用 `wrangler types` 產生，不手寫 `Env`。`pnpm --filter @open-split/worker typecheck` 會先產生型別。產生的 `worker-configuration.d.ts` 不進版控。

## 不採用

另外架一台帶 Postgres 的應用伺服器。那會多一套要維護的主機，而這個產品的讀寫規模用不上。
