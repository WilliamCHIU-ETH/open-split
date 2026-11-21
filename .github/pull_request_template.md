## 切片

- 對應 `docs/04-vertical-slices.md` 的哪一片：
- `docs/feature-map.md` 的項目（使用者語言）：

## 檢查

- [ ] `pnpm check` 通過（型別、lint、架構、legacy-scan、JS 預算、測試）
- [ ] 若改了 `apps/web` 的介面，已用 `pnpm exec modern-web-guidance search` / `retrieve` 查過對應指引

## 跑過的證據

貼上 `pnpm driver ...` 的輸出。沒有跑過 driver 的功能 PR 不算完成。

```
```

## 合併條件（見 docs/05-agent-workflow.md）

- [ ] 一份 PR 最多一片；非測試變更約 1,000 行以內
- [ ] Codex 審查涵蓋 head SHA，沒有未處理的 P0／P1
- [ ] 改到登入、權限、MCP、遷移或金額：有 ADR 守門員審查
- [ ] 沒修的 P2／P3 已開 `deferred-review` issue：
- [ ] 沒有真實 Email、LINE user id、token 或個資
- [ ] 需要擁有者先同意的事（改意圖、推翻 ADR、正式部署、改正式資料、對真實群組發訊息）：無／已取得
