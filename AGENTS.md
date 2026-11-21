# open-split 給 Agent 的說明

這是 Agent 進到這個 repo 唯一需要先讀的檔案。`CLAUDE.md` 與 `.cursor/rules/harness.mdc` 都指回這裡，不要在那兩處另寫規則。

## 這是什麼

擁有者自己和朋友用的分帳服務：在 LINE 上的體驗對標 Lightsplit，而且 Agent 是一等公民，可以經 MCP 記帳。是 homelab，不是公開服務。為什麼要做、做到哪算上線，寫在 [docs/00-intent.md](docs/00-intent.md)。跟其他文件衝突時，以那份為準。

## 先讀哪些

| 要做的事 | 先讀 |
| --- | --- |
| 任何工作 | `docs/00-intent.md`、`docs/05-agent-workflow.md` |
| 一個切片 | `docs/04-vertical-slices.md` 對應的那片、`docs/feature-map.md` |
| 架構、表、契約 | `docs/02-system-architecture.md`、`docs/03-program-design.md` |
| 登入、MCP、權限 | ADR-0003、ADR-0005、ADR-0007、ADR-0009（0009 取代 0007 的 Google 白名單） |
| 金額、多幣別 | ADR-0002、ADR-0006 |
| `apps/web` | `docs/frontend-quality.md`、`.cursor/rules/web-frontend.mdc` |

## 程式碼規則

檢查會擋的規則，理由寫在錯誤訊息裡。下面是檢查擋不住、但一樣必須遵守的規則。

- 帳本數學只放 `packages/core`，並補 fast-check 性質測試。`apps/*` 呼叫 `@open-split/core`，不要自己算。
- 金額是整數最小貨幣單位，匯率是兩個正整數的比值。不用浮點數。
- Zod schema 只加在 `packages/contracts`。網頁 API 與 MCP 共用同一套服務層。
- MCP 寫入工具都要支援冪等鍵、檢查群組成員身份、寫入活動紀錄並標示 `via`。回傳一次性權杖的動作不快取回應本體。
- 遷移只能新增檔案，不改已合併的遷移。改表要附「從有資料的舊庫升級」的測試。
- 假登入只存在 driver 與 `wrangler dev` 的 `.dev.vars`。不要放進 `wrangler.jsonc`，也不要放進 `apps/web`。

## 公開 repo 規則

- 不要提交真實 Email、LINE user id、群組名稱、token 或任何個資。範例與測試用 `[redacted-email]`、`dev-line:alice` 這類假值，真實值從環境變數注入。
- `pnpm check` 裡的 `pii-scan` 會擋真實 Email、LINE user id 與常見權杖格式。

## 完成與合併

- 一份 PR 最多一片；非測試變更超過約 1,000 行就拆。
- 完成前跑 `pnpm check`。CI 會再跑 `check`、`accept`（driver 驗收）與 `merge-gate`。
- 開 PR 後直接打開 auto-merge（`gh pr merge <n> --auto --squash --delete-branch`）；三個狀態都成功時 GitHub 會自己合。卡在哪裡用 `pnpm merge-gate <n>` 看。流程見 [docs/05-agent-workflow.md](docs/05-agent-workflow.md)。
- 不要自己加 `owner-approved` 標籤，也不要拿掉 `hold`。
- 沒修的審查意見開成 `deferred-review` issue，不要只留在 PR 留言。

## 一定要先問擁有者

改意圖或產品檢視、推翻已接受的 ADR、部署正式環境、改寫正式資料、傳訊息給真實 LINE 群組或朋友。完整清單在 `docs/05-agent-workflow.md`。
