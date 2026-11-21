# 前端品質

帳本網頁是主產品。LIFF 是同一套網頁在 LINE 裡打開，所以這裡的門檻同時約束一般瀏覽器與 LINE 內建瀏覽器。平台細節不要寫死在這份文件；做介面之前用 Modern Web Guidance 查。

## 代理人怎麼查

專案鎖定 `modern-web-guidance@1.0.1`，技能在 `.agents/skills/modern-web-guidance/SKILL.md`。

```sh
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance search "confirmation modal dialog"
DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance retrieve "<id>"
```

不要用 `npx …@latest`。CI 的掃描與代理人查到的指引必須是同一版。

查詢用 2 到 5 個英文單字，一次一個能力（dialog、popover、form、view transition、container query）。接到 React 時保留指引裡的平台能力。

預設只使用 Baseline 廣泛可用的功能。尚未廣泛可用的，必須做指引裡的 fallback。LINE 的 iOS 是 WKWebView，Android 是 WebView，都會落後桌面 Chrome。不要開 origin trials，也不要為了省事加一套 polyfill 套件。fallback 要短，或改成較單純的介面。

## 這個產品的門檻

- **手機優先。** 320px 寬要能讀、能點。主要動作不能只靠 hover。
- **LINE 內建瀏覽器與一般瀏覽器都要能記帳。** 不偵測 user agent 來做兩套 UI。
- **語意 HTML。** 標題、主內容、清單、按鈕與連結各用各的元素。表單控制項要有標籤。鍵盤能到達並看得到焦點。
- **對比。** 文字與背景要能分開。不要只用顏色傳達狀態。
- **少依賴。** `apps/web` 的執行期依賴只允許 `react`、`react-dom`、`@open-split/contracts`（值匯入走 `@open-split/contracts/client`，不把 Zod 打包進瀏覽器），以及預覽分帳用的 `@open-split/core`。對話框用 `<dialog>`，popover 用平台的 popover，不要先加元件庫。
- **效能。** 建置後的 JS gzip 合計不得超過 150 KiB。移除前端 Zod 打包後目前約 88 KiB，剩下的空間留給切片 6 的 `@line/liff` 與後續帳本能力，不是拿來裝 UI 框架的。

## 已經會失敗的檢查

| 檢查 | 門檻 | 指令 |
| --- | --- | --- |
| `eslint-plugin-jsx-a11y` recommended | 任一規則錯誤即失敗 | `pnpm lint` |
| `legacy-scan` | `apps/web` 上未放行的發現數必須是 0。上游 CLI 即使有發現也回傳 0，所以本專案的包裝程式會自己失敗 | `pnpm legacy-scan` |
| JS gzip | ≤ 150 KiB | `pnpm budget` |

`legacy-scan` 只覆蓋指引目錄的一部分。它沒叫的東西，仍要靠 `search`／`retrieve`。若某筆發現是指引要求留下的 fallback，才能寫進 `apps/web/legacy-scan.allowlist.json`，而且 `reason` 不能是空的。不要為了讓掃描變 0 去改掃描器。

這三項都在 `pnpm check` 裡。它們不需要 Chrome。

Lighthouse 沒有放進 `pnpm check`，內圈要在沒有瀏覽器的環境也能跑。帳本主畫面另行對這三個分數負責：效能 ≥ 0.9、無障礙 ≥ 0.95、最佳實踐 ≥ 0.9，於本機 Chrome 定期驗證。
