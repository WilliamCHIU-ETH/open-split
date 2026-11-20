# open-split

擁有者自己掌控的分帳服務。帳本網頁是主產品，外部代理人經 OAuth 2.1 的 MCP 寫入同一本帳，LINE 用來登入、在 LIFF 裡打開同一套網頁，以及分享或安靜推播。不做聊天機器人，不經手付款。

目前已完成 **切片 1 至 5**：平均／指定金額／百分比／份數分帳、虛擬成員認領與邀請連結、簡化結清與收款方式／群組摘要、多幣別（ISO 4217 小數與整數比值匯率換算）、MCP OAuth 2.1（`@cloudflare/workers-oauth-provider` + Google OIDC + Gmail 白名單），以及 Cloudflare R2 收據附檔上傳下載（僅保存，不做 OCR）。本機與測試環境可用假身份或本機 OAuth 同意頁驗收，帳在 D1、OAuth 狀態在 KV、收據在 R2。

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `packages/core` | 純帳本數學、多幣別整數匯率換算與性質測試 |
| `packages/contracts` | 網頁、Worker 與 MCP 共用的 Zod 契約 |
| `packages/auth` | 登入介面，以及只允許在本機／測試打開的假身份 |
| `apps/worker` | Hono + Drizzle (D1) + R2 收據 + MCP OAuth 2.1 Gateway (KV) |
| `apps/web` | 手機優先的帳本網頁 |
| `tools/driver` | 驗收用 CLI（含切片 1–5 完整 `accept`） |
| `docs/` | 產品、架構、契約、切片、ADR `0001`–`0008` |

## 常用指令

```sh
pnpm install
pnpm check
pnpm driver demo
pnpm driver accept
```

`pnpm check` 會做型別檢查、lint（含無障礙與金額規則）、依賴邊界、`legacy-scan`、前端 JS gzip 預算，以及測試。

本機帳本（首次執行請先套用本機 D1 遷移）：

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @open-split/worker exec wrangler d1 migrations apply open-split --local
pnpm --filter @open-split/worker dev
pnpm --filter @open-split/web dev
```

網頁在 `http://127.0.0.1:5173`，API 與 MCP/OAuth 端點由 Vite 轉到 Worker。`pnpm driver accept` 直接打 Worker。

`.dev.vars` 不會上傳。假登入旗標 `AUTH_DEV_IDENTITIES=true`、本機 `MCP_ALLOWED_EMAILS`、測試 `COOKIE_ENCRYPTION_KEY` 與 OAuth secrets 只能放在那裡；`wrangler.jsonc` 裡必須維持關閉，檢查會擋下打開假身份的部署設定。

前端指引使用鎖定的 Modern Web Guidance，見 [docs/frontend-quality.md](docs/frontend-quality.md)。不要改用 `npx …@latest`。

正式部署前，請在 `apps/worker/wrangler.jsonc` 與 Worker secrets 補齊實際 D1／KV／R2 ID、`PUBLIC_BASE_URL`（必須與線上對外網域一致）、Google/LINE secrets、`MCP_ALLOWED_EMAILS`，以及 Cloudflare WAF／Rate Limiting（保護 `/oauth/register` DCR 端點）。

## 還沒做的東西

切片 6 至 8：正式 LINE Login OAuth 授權碼交換、LIFF SDK 與 `liff.shareTargetPicker()` Flex 卡片分享、可選的 LINE 官方帳號安靜推播，以及日期、搜尋／篩選、CSV 匯出、逐項拆帳、多人先付與封存／離開群組。
