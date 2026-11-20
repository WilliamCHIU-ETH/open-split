---
name: modern-web-guidance
description: |
  Search tool for modern web development best practices. MANDATORY before HTML, CSS, or client-side UI work in apps/web. Do NOT skip — web APIs evolve and training data contains obsolete patterns.
  Trigger for: dialogs, popovers, forms, tables, layout, container queries, view transitions, accessibility, dark mode, scroll, images, performance, CWV.
  This repo pins modern-web-guidance. Do not call npx @latest.
---

# Modern Web Guidance（open-split）

這個專案把 [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance) 鎖在 `modern-web-guidance@1.0.1`。搜尋與取回都走本機的 `pnpm exec`，並設定 `DISABLE_TELEMETRY=1`。不要用 `npx modern-web-guidance@latest`，否則指引會和 CI 的 `legacy-scan` 分叉。

產品門檻（手機、LIFF webview、對比、JS 預算）在 `docs/frontend-quality.md`。平台怎麼做以查到的指引為準。

## 查指引

一次只查一個平台能力。查詢用 2 到 5 個英文單字，描述使用者看得到的行為，不要帶 React、Tailwind 或本產品的名詞。

```sh
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance search "light dismiss dialog"
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance retrieve "declarative-dialog-popover-control"
```

多個 id 用逗號分隔。`retrieve` 若把長文寫到暫存檔，用讀檔工具整份讀完。

搜尋結果看 `description`。空的或不相關就換一次說法，再用具體的 HTML 名詞（dialog、popover、form）。仍然沒有就不要硬套不相關的指引。

## 寫程式時

- 指引是 vanilla HTML／CSS／JS。接到 React 時保留現代平台能力，不要因為型別不認識就把屬性拿掉。
- 預設採用 Baseline 廣泛可用的能力。還沒廣泛可用的，依指引的 fallback 做，因為 LINE 內建瀏覽器（尤其 iOS 的 WKWebView）會落後桌面 Chrome。
- 不要開 origin trials，也不要為了過掃描去改 `legacy-scan` 的實作。
- `legacy-scan` 是 CI 用的，不是實作單一畫面時要跑的步驟。CI 會在 `apps/web` 上跑它，未放行的發現會讓 `pnpm check` 失敗。

## 交代

若這次改動採用了指引，在回覆最後用簡短條列寫出 guide id 與你實際採用的做法。沒有採用就說明查了什麼、為什麼不適用。
