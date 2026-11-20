# open-split

擁有者自己掌控的分帳服務。帳本網頁是主產品，外部代理人經 OAuth 2.1 的 MCP 寫入同一本帳，LINE 用來登入、在 LIFF 裡打開同一套網頁，以及分享或安靜推播。不做聊天機器人，不經手付款。

切片 1 與 2 已接上帳本：平均、指定金額、百分比、份數，以及還沒註冊的朋友。本機用假身份經網頁或 driver 記帳、改帳、作廢、認領，並看餘額。帳在 D1。建議轉帳由 driver 用核心印出，不寫入。OAuth、MCP、LIFF 還沒做。

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `packages/core` | 純帳本數學與性質測試 |
| `packages/contracts` | 網頁與 MCP 共用的 Zod schema |
| `packages/auth` | 登入介面，以及只允許在本機／測試打開的假身份 |
| `apps/worker` | Hono + D1。切片 1 的帳本 API |
| `apps/web` | 手機優先的帳本網頁 |
| `tools/driver` | 驗收用 CLI |
| `docs/` | 產品、架構、契約、切片、ADR |

## 常用指令

```sh
pnpm install
pnpm check
pnpm driver demo
pnpm driver accept
```

`pnpm check` 會做型別檢查、lint（含無障礙與金額規則）、依賴邊界、`legacy-scan`、前端 JS gzip 預算，以及測試。

本機帳本：

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @open-split/worker dev
pnpm --filter @open-split/web dev
```

網頁在 `http://127.0.0.1:5173`，API 由 Vite 轉到 Worker。`pnpm driver accept` 直接打 Worker。

`.dev.vars` 不會上傳。假登入旗標 `AUTH_DEV_IDENTITIES=true` 只能放在那裡。`wrangler.jsonc` 裡必須維持關閉，檢查會擋下打開它的部署設定。

前端指引使用鎖定的 Modern Web Guidance，見 [docs/frontend-quality.md](docs/frontend-quality.md)。不要改用 `npx …@latest`。

## 還沒做的東西

沒有 OAuth，沒有 MCP 傳輸，沒有 LIFF SDK，沒有多幣別。結清只印方案，不寫入帳本。
