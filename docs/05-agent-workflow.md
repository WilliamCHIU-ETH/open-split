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
| 驗收 | 在乾淨的本機 D1 上跑 `pnpm driver accept` | CI 的 `accept` job |
| 合併 | 三個必要狀態都成功時合併 | GitHub auto-merge |

沒有 Agent 親手按合併；實作者只負責打開 auto-merge。

## 一份 PR 的流程

1. 從最新的 `main` 開分支，命名為 `<agent>/slice-<n>-<短描述>`。
2. 一份 PR 最多一片。非測試、非文件、非 lockfile 的變更超過 1,000 行，就拆成幾份依序合併的 PR。
3. 本機跑 `pnpm check`；要確認功能時再跑 `pnpm driver accept`。CI 會在乾淨的本機 D1 上再跑一次 `accept`。
4. 開 PR 之後馬上 `gh pr merge <n> --auto --squash --delete-branch`。之後不用再管合併，條件成立時 GitHub 會自己合。
5. 等 Codex 審查。每一則意見不是修掉，就是回覆為什麼不成立，然後把那則對話標成 resolved。推了新 commit 之後，用 `pnpm merge-gate <n> --request-review` 請 Codex 審新的 head。
6. 改了登入、權限、MCP 工具、遷移或金額計算的 PR，要有 ADR 守門員的審查留言。
7. 沒修的 P2／P3 開成 GitHub issue（標籤 `deferred-review`），並在 PR 裡連過去。

`pnpm merge-gate <n>` 隨時可以在本機看目前卡在哪裡。

## 合併條件

`main` 的分支保護要求三個狀態都成功，auto-merge 才會合併：

| 狀態 | 檢查什麼 | 由誰產生 |
| --- | --- | --- |
| `check` | 型別、lint、依賴邊界、legacy-scan、個資掃描、JS 預算、測試 | `.github/workflows/ci.yml` |
| `accept` | 乾淨本機 D1 上的 `pnpm driver accept` | `.github/workflows/ci.yml` |
| `merge-gate` | Codex 審過目前的 head 且沒有未處理意見；PR 不是草稿、沒有 `hold`；大小在上限內；改到要擁有者同意的檔案時有 `owner-approved` | `.github/workflows/merge-gate.yml` 執行 `tools/repo-guard/merge-gate.mjs` |

推了新 commit，三個狀態都會對新的 SHA 重來；舊 SHA 的結果不算數。

機器還檢查不到、要靠 Agent 自律的兩件事：ADR 守門員的審查，以及延後項目有沒有開 issue。

### 需要擁有者同意的檔案

`merge-gate` 遇到下面的檔案會擋下，直到 PR 有 `owner-approved` 標籤：

- `docs/00-intent.md`、`docs/01-product-review.md`、`docs/05-agent-workflow.md`、`AGENTS.md`
- 修改或刪除既有的 ADR 與遷移（新增檔案不用）
- 閘門本身：`.github/workflows/`、`tools/repo-guard/`

`owner-approved` 只能由擁有者加。Agent 用的是擁有者的 GitHub 帳號，機器分辨不出是誰加的，所以這條靠 Agent 遵守：**Agent 不可以自己加 `owner-approved`，也不可以拿掉 `hold`。** 要同意時，在對話裡請擁有者加。

想先停住某份 PR，加上 `hold` 標籤即可。

## 一定要先問擁有者

- 修改 [00 意圖](00-intent.md) 或 [01 產品檢視](01-product-review.md)。
- 新的 ADR 推翻或取代一個已接受的決策。
- 部署到正式環境（在上線之前每一次都問；上線之後再訂規則）。
- 會刪除或改寫正式資料的遷移。
- 任何會傳訊息給真實 LINE 群組或真實朋友的動作。

其他都不用問，照這份流程做完。

## 退回

- 停掉全部自動合併：在 GitHub 的 repo 設定關掉 auto-merge，或對 PR 加 `hold`。
- 拿掉分支保護：`gh api -X DELETE repos/<owner>/open-split/branches/main/protection`。
- 已經合併的錯誤 PR：開一份 revert PR，走同一套流程。

## 還沒自動化的部分

- ADR 守門員審查還是由 Agent 手動留言，沒有變成狀態。
- 延後項目有沒有開 issue，機器不檢查。
- 機器分辨不出 `owner-approved` 是擁有者還是 Agent 加的。
- 部署正式環境還沒有流程；上線前每次都要先問擁有者。
