# 04 垂直切片

每次只做一片，做完要能從使用者的動作看到結果。數學不變量從第一片就在，不能等最後才補。

切片 0 是這份 harness，不含產品功能。

## 1. 平均分帳與餘額

使用者能建立群組、加入已登入的自己、記一筆平均分的支出、看到餘額合計為 0。

包含：群組、支出、份額、餘額查詢、活動紀錄的第一筆。HTTP 不再對這些路徑回 501。

不包含：不平均分法、虛擬成員、結清寫入、多幣別、MCP、LINE。

Driver：`pnpm driver accept` 已經用假身份走平均分。這一片要改成打到 Worker，而不是只寫 JSON。證據仍貼 driver 輸出。

完成：`packages/core` 的性質測試仍過；一筆平均分支出的份額合計等於原金額。

## 2. 不平均分法與虛擬成員

使用者能用指定金額、百分比基點、份數來分，也能排除某些人。能先加一個還沒登入的朋友，稍後由他認領，歷史份額不改掛到別的成員。

Driver：`add-expense --split exact|percentage|shares`，以及 `add-member --virtual`。認領流程在這一片接上真的資料庫。

## 3. 結清與債務簡化

使用者看到建議轉帳（人數減 1 以內），並能把一筆結清寫進帳，餘額隨之歸零。可以留下收款方式文字。作廢一筆結清會回到活動紀錄。同時看得到每個人累計付了多少、分到多少，以及每個分類花了多少。那是讀取，不是新的分法。

Driver：`settle --record` 把方案逐筆寫入，再向伺服器讀餘額確認每人為 0；`record-settlement`、`void-settlement`、`set-payment-profile`、`show-summary` 各自打 Worker。結清只是記帳，不經手付款。幣別必須是群組預設幣別，多幣別仍在切片 4。

## 4. 多幣別（已完成）

一筆支出可以不是群組預設幣別。匯率是兩個正整數比值（`numerator/denominator`）。換算在 `packages/core`（依 ISO 4217 小數位與 Hamilton 最大餘額法守恆），禁止浮點匯率。換完之後，餘額與結清皆以群組預設幣別計算並合計為 0。見 [ADR-0006](adr/0006-fx-conversion-and-rounding.md)。

## 5. OAuth 2.1 與 MCP（已完成）

外部代理人透過 `@cloudflare/workers-oauth-provider` 走 OAuth 2.1 PKCE（`mcp:read` / `mcp:write`）+ Google OIDC 與 `MCP_ALLOWED_EMAILS` Gmail 白名單驗證。不是群組成員也不能對該群呼叫工具。工具實作呼叫與網頁相同的服務層與 `packages/contracts`，支援 `idempotencyKey`。代理人與網頁都可以透過兩階段上傳把收據存進 R2（僅保存、不辨識，強制 magic bytes 與 SHA-256 驗證）。見 [ADR-0007](adr/0007-mcp-oauth-google-whitelist.md) 與 [ADR-0008](adr/0008-r2-receipt-attachments.md)。

本機驗收繼續用假身份與 dev OAuth 同意頁，不把假身份開到部署設定。

## 6. LINE Login、LIFF、分享卡片、MCP 改用 LINE 授權

LINE Login 成為主要登入。LIFF 打開的是同一套帳本，在裡面記帳必須可用。`liff.shareTargetPicker()` 能把 Flex 卡片分享到聊天。

MCP 的上游登入改成同一個 LINE Login，`OWNER_LINE_USER_IDS` 與 `users.mcp_allowed` 決定誰的 Agent 能連；移除 Google 上游與 `MCP_ALLOWED_EMAILS`；正式環境停用 `add_member(virtual: false, userId)`。見 [ADR-0009](adr/0009-mcp-identity-via-line.md)。

這一片會比較大，依 [05 Agent 工作流程](05-agent-workflow.md) 拆成幾份 PR：LINE Login 與 session、LIFF、分享卡片、MCP 上游切換。

不做聊天機器人。見 [ADR-0005](adr/0005-line-liff.md)。

## 上線

不是新功能，是第一次真的給朋友用。定義在 [00 意圖](00-intent.md#上線的定義)：正式網域部署、真實 LINE 群組用 LIFF 記帳與分享、Agent 經 MCP 記一筆、結清歸零、備份與退回演練過。部署正式環境要先問擁有者。

切片 7 與 8 排在上線之後。

## 7. 可選的官方帳號推播

群組可以綁一個 LINE `groupId`。官方帳號只 push 帳單或提醒，不接收、不回覆聊天。沒綁定的群組完全不碰 Messaging API。每個人可以選擇要不要收到推播。

## 8. 找帳、匯出與明細

切片 1 到 7 沒有涵蓋、但成熟分帳產品有的使用者功能放在這裡。仍然不做內建自然語言、不做 OCR、不經手付款。

包含：支出的發生日期、搜尋與篩選、CSV 匯出、重複支出、帳單逐項分（稅和小費跟著項目）、一筆帳多個付款人、在平均分上對某人加減、封存群組、離開群組且歷史份額保留。

在平均分上加減不是切片 2。切片 2 只做指定金額、百分比、份數，以及把人排除在外。

## 每一片都要

- 對應 `docs/feature-map.md` 的項目。
- `pnpm check` 通過。
- PR 裡貼上 driver 證據。
- 照 [05 Agent 工作流程](05-agent-workflow.md) 的合併條件，由實作者以外的 Agent 合併。
