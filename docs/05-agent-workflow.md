# 05 Agent 工作流程

open-split 由 Agent 寫、Agent 審、Agent 合併。擁有者只管意圖、上線，以及會碰到真實朋友的動作。

- 狀態：已接受
- 日期：2026-11-21
- 來源：擁有者 2026-11-21 決定 PR「希望可以全自動」。這取代先前「每份 PR 由擁有者讀過再合併」的規則；那條規則後來沒有被執行，PR #5 因此長到 57 個檔案、六千多行。

## 角色

| 角色 | 做什麼 | 現在由誰做 |
| --- | --- | --- |
| 實作者 | 一片一個分支，寫程式、測試、文件，開 PR | Cursor、Codex、OpenBot 上的 Agent |
| 自動審查 | 每次 push 後審 diff，標 P0–P3 | GitHub 上的 Codex connector（`chatgpt-codex-connector[bot]`） |
| ADR 守門員 | 對照 `docs/00`–`05` 與 ADR，找出違反決策的地方 | 審查 Agent |
| 驗收跑者 | 在乾淨的本機 D1 上跑 `pnpm driver accept`，把輸出與 SHA 貼進 PR | 審查 Agent；之後改由 CI |
| 合併者 | 確認合併條件全部成立後合併 | 實作者以外的 Agent |

同一個 Agent 不能既寫又合併同一份 PR。

## 一份 PR 的流程

1. 從最新的 `main` 開分支，命名為 `<agent>/slice-<n>-<短描述>`。
2. 一份 PR 最多一片。非測試、非 lockfile 的變更超過約 1,000 行，就拆成幾份依序合併的 PR。
3. 本機跑 `pnpm check` 與 `pnpm driver accept`，把 driver 輸出貼進 PR。
4. 等 Codex 審查。對每一則 P0／P1 不是修掉，就是回覆為什麼不成立。
5. 改了登入、權限、MCP 工具、遷移或金額計算的 PR，要有 ADR 守門員的審查留言。
6. 合併者確認下面的條件，用 squash 合併，刪掉分支。

## 合併條件

全部都要指向 PR 的同一個 head SHA：

- [ ] CI `check` 通過。
- [ ] 驗收跑者貼出這個 SHA 的 `pnpm driver accept` 輸出，結果通過。
- [ ] Codex 審查涵蓋這個 SHA，沒有未處理的 P0／P1。
- [ ] 觸及上一節第 5 步範圍的 PR，有 ADR 守門員的審查，沒有未處理的違規。
- [ ] P2／P3 沒修的，每一項都開成 GitHub issue（標籤 `deferred-review`），並在 PR 裡連過去。不要只留在 PR 留言裡。
- [ ] diff 裡沒有真實 Email、LINE user id、token 或其他個資（repo 是公開的）。

任何一項不成立就不合併。修完之後重跑對應的檢查，舊 SHA 的結果不算數。

## 一定要先問擁有者

- 修改 [00 意圖](00-intent.md) 或 [01 產品檢視](01-product-review.md)。
- 新的 ADR 推翻或取代一個已接受的決策。
- 部署到正式環境（在上線之前每一次都問；上線之後再訂規則）。
- 會刪除或改寫正式資料的遷移。
- 任何會傳訊息給真實 LINE 群組或真實朋友的動作。

其他都不用問，照這份流程做完。

## 還沒自動化的部分

下面這些目前靠 Agent 照規則手動做，之後逐一改成機器強制：

1. `main` 的分支保護：必須通過 `check` 才能合併。
2. CI 加一個 job：起 `wrangler dev` 與乾淨的本機 D1，跑 `pnpm driver accept`。之後驗收跑者就不用再手動貼輸出。
3. CI 掃描密鑰與個資。
4. 一支合併檢查腳本：讀 Codex 審查留言裡的 `codex-review-state`，確認 SHA 一致、沒有未處理的 P0／P1。
5. 打開 repo 的 auto-merge，讓合併者只負責按下去。
