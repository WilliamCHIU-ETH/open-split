# open-split 給代理的說明

規則的理由在檢查的錯誤訊息裡，不在這份文件。

開始改程式之前：

1. 讀對應的 `docs/04-vertical-slices.md` 與 `docs/feature-map.md`。架構與契約在 `docs/02-system-architecture.md`、`docs/03-program-design.md`。登入邊界在 `docs/adr/0003-auth-separation.md` 與 `docs/adr/0005-line-liff.md`。
2. 帳本數學只改 `packages/core`，並補上 fast-check。`apps/*` 呼叫 `@open-split/core`，不要自己算。
3. Zod schema 只加在 `packages/contracts`。
4. 做 `apps/web` 之前讀 `docs/frontend-quality.md`，並用專案鎖定的 Modern Web Guidance 查指引。見 `.cursor/rules/web-frontend.mdc`。
5. 完成後跑 `pnpm check`。用 `pnpm driver` 跑該切片的流程，把輸出貼進 PR。PR 範本要求這些證據。

不要合併 PR。擁有者會自己讀、自己合併。

本機假登入只存在 driver 與 `wrangler dev` 的 `.dev.vars`。不要把它放進 `wrangler.jsonc`，也不要放進 `apps/web`。
