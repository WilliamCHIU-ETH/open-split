# apps/web 給 Agent 的規則

通用 repo 規則與流程見根目錄 [AGENTS.md](../../AGENTS.md)。本檔集中維護前端專屬規範（原 `.cursor/rules/web-frontend.mdc` 已併入這裡，讓所有 Agent 工具讀到同一份規則）。

## 動手前必查 Modern Web Guidance

修改 `apps/web` 的版面、對話框、popover、表單、轉場、無障礙或效能之前：

1. 先讀 [docs/frontend-quality.md](../../docs/frontend-quality.md)（包含 LINE 內建瀏覽器門檻與效能預算）。
2. 用專案鎖定的 CLI 查平台指引（**不要**用 `npx ...@latest`）：

```sh
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance search "<2 到 5 個英文單字>"
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance retrieve "<id>"
```

3. 平台能力（`<dialog>`、popover、表單驗證、轉場）以查到的指引為準，不在規則檔內自造做法。

## 契約、打包預算與依賴

- **零前端 Zod 負擔**：值匯入（路徑 `apiPaths`、附檔常數等）一律從 `@open-split/contracts/client` 匯入；型別一律用 `import type`（可從 `@open-split/contracts` 或 `@open-split/contracts/client`）。`.dependency-cruiser.cjs` 會阻擋 `contracts/client` 引入 Zod。
- **JS gzip 預算 ≤ 150 KiB**：不引入前端路由套件、全域狀態庫或重型元件庫。
- **執行期依賴白名單**由 `tools/constraint-check` 鎖定；切片 6 接入 `@line/liff` 時走 npm 鎖定版本並同步更新白名單，不從外部 CDN `<script>` 載入（見 [ADR-0010](../../docs/adr/0010-long-term-architecture.md)）。

## 路由與同網域後端路徑

- 路由解析與連結攔截集中在 `src/router.ts`。
- 不可攔截 Worker 擁有的前綴（`BACKEND_PATH_PREFIXES`：`/api`、`/auth`、`/authorize`、`/callback`、`/mcp`、`/oauth`、`/.well-known`、`/health`）、`[download]` 連結、外部網域或非 `_self` target。
- 路由狀態必須保留 `window.location.search`（供 LIFF `liff.state` 與 OAuth callback 參數使用）。
- 改完必須通過 `pnpm check`（含 `typecheck`、`lint`、`arch`、`legacy-scan`、`budget` 與 `test`）。
