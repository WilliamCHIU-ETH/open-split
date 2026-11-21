## 切片

- 對應 `docs/04-vertical-slices.md` 的哪一片：
- `docs/feature-map.md` 的項目（使用者語言）：

## 檢查

- [ ] `pnpm check` 通過（型別、lint、架構、legacy-scan、JS 預算、測試）
- [ ] 若改了 `apps/web` 的介面，已用 `pnpm exec modern-web-guidance search` / `retrieve` 查過對應指引

## 跑過的證據

CI 的 `accept` 會跑完整的 `pnpm driver accept`。這一片新增的驗收步驟寫在這裡，必要時貼本機輸出。

```
```

## 合併

開好之後執行 `gh pr merge <n> --auto --squash --delete-branch`。`check`、`accept`、`merge-gate` 都成功就會自己合併，見 `docs/05-agent-workflow.md`。

- 沒修的 P2／P3 開的 `deferred-review` issue：
- 改到登入、權限、MCP、遷移或金額時，ADR 守門員審查：
