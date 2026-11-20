# open-split

擁有者自己掌控的分帳服務。帳本網頁是主產品，外部代理人經 OAuth 2.1 的 MCP 寫入同一本帳，LINE 用來登入、在 LIFF 裡打開同一套網頁，以及分享或安靜推播。不做聊天機器人，不經手付款。

這一版是工程 harness：結構、規劃、可執行的約束、性質測試與 CI。產品功能從[切片 1](docs/04-vertical-slices.md) 才開始。

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `packages/core` | 純帳本數學與性質測試 |
| `packages/contracts` | 網頁與 MCP 共用的 Zod schema |
| `packages/auth` | 登入介面，以及只允許在本機／測試打開的假身份 |
| `apps/worker` | Hono + D1 的佔位 Worker |
| `apps/web` | React 空殼 |
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

本機 Worker：

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @open-split/worker dev
```

`.dev.vars` 不會上傳。假登入旗標 `AUTH_DEV_IDENTITIES=true` 只能放在那裡。`wrangler.jsonc` 裡必須維持關閉，檢查會擋下打開它的部署設定。

前端指引使用鎖定的 Modern Web Guidance，見 [docs/frontend-quality.md](docs/frontend-quality.md)。不要改用 `npx …@latest`。

## 切片 1 之前故意沒有的東西

沒有真的群組 API，沒有畫面上記帳，沒有 OAuth，沒有 LIFF SDK，沒有 D1 查詢。Drizzle schema 是目標形狀，遷移還沒跑。driver 的結清只印方案，不寫入帳本。
