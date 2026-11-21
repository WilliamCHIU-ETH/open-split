/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      severity: "error",
      comment:
        "packages/core 必須是純確定性帳本，不能依賴 I/O、Workers、資料庫、網路或任何執行期套件。WHY: 同一組輸入必須得到同一組餘額，性質測試才成立。請把讀寫留在 apps/worker，數學留在 @open-split/core。",
      from: { path: "(^|/)packages/core/src/" },
      to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-peer", "npm-optional", "unknown"] },
    },
    {
      name: "auth-is-pure",
      severity: "error",
      comment:
        "packages/auth 只放登入邊界與假身份守衛，不能碰 I/O 或帳本。WHY: 正式環境能不能打開假 LINE／Google 身份必須是純判斷，測試不用啟動 Worker 也能證明它會拒絕。",
      from: { path: "(^|/)packages/auth/src/" },
      to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-peer", "npm-optional", "unknown"] },
    },
    {
      name: "core-does-not-import-other-packages",
      severity: "error",
      comment:
        "packages/core 不能依賴 apps、auth、contracts 或 tools。WHY: 帳本數學若回頭依賴資料庫 schema、登入或 HTTP 契約，就不再是 MCP 與網頁共用的純函式。",
      from: { path: "(^|/)packages/core/" },
      to: { path: "(^|/)(apps|packages/(auth|contracts)|tools)/" },
    },
    {
      name: "auth-does-not-import-product-packages",
      severity: "error",
      comment:
        "packages/auth 不能依賴 core、contracts、apps 或 tools。WHY: 假身份守衛若綁住帳本或 D1，就沒辦法在部署設定檢查裡單獨失敗。",
      from: { path: "(^|/)packages/auth/" },
      to: { path: "(^|/)(apps|packages/(core|contracts)|tools)/" },
    },
    {
      name: "schemas-defined-once",
      severity: "error",
      comment:
        "Zod schema 只能定義在 packages/contracts。WHY: 網頁 API 與 MCP 必須接受同一套輸入，否則代理人與網頁會寫入不同的帳。請從 @open-split/contracts 匯入。",
      from: { path: "(^|/)(apps|packages/core|packages/auth|tools)/" },
      to: { path: "(^zod$|/node_modules/zod/)" },
    },
    {
      name: "call-core-through-entry",
      severity: "error",
      comment:
        "分帳與餘額只能經由 @open-split/core 的公開入口。WHY: 深層檔案不是契約。應用層直接拿內部函式，之後重構數學時呼叫端會默默分叉。",
      from: { path: "(^|/)(apps|tools/driver)/" },
      to: { path: "(^|/)packages/core/src/(?!index\\.ts$)" },
    },
    {
      name: "web-does-not-import-worker",
      severity: "error",
      comment:
        "apps/web 不引用 apps/worker。WHY: 瀏覽器不能綁定 D1，也不該複製 Worker 的路由實作。網頁只打 HTTP，契約放在 @open-split/contracts。",
      from: { path: "(^|/)apps/web/" },
      to: { path: "(^|/)apps/worker/" },
    },
    {
      name: "worker-does-not-import-web",
      severity: "error",
      comment: "apps/worker 不引用 apps/web。WHY: Worker 是 API 與服務層，不是去 import 一套前端元件。",
      from: { path: "(^|/)apps/worker/" },
      to: { path: "(^|/)apps/web/" },
    },
    {
      name: "web-no-db",
      severity: "error",
      comment:
        "apps/web 不能碰 D1、Drizzle 或 Hono。WHY: 帳本資料只活在 Worker。瀏覽器若要即時預覽，只能呼叫 @open-split/core 的純函式。",
      from: { path: "(^|/)apps/web/" },
      to: { path: "/node_modules/(drizzle-orm|hono)/" },
    },
    {
      name: "web-no-dev-auth",
      severity: "error",
      comment:
        "apps/web 不能匯入 @open-split/auth。WHY: 假的 LINE／Google 身份只能活在本機 Worker 與 driver。進到前端 bundle 就等於把測試登入送到每位使用者的瀏覽器，包含 LIFF。",
      from: { path: "(^|/)apps/web/" },
      to: { path: "(^|/)packages/auth/" },
    },
    {
      name: "worker-http-no-mcp",
      severity: "error",
      comment:
        "apps/worker/src/http 不能匯入 apps/worker/src/mcp。WHY: HTTP 與 MCP 是平行傳輸層，共用工具請下沉到 src/shared 或 src/ledger，避免跨傳輸耦合（ADR-0010）。",
      from: { path: "(^|/)apps/worker/src/http/" },
      to: { path: "(^|/)apps/worker/src/mcp/" },
    },
    {
      name: "worker-mcp-no-http",
      severity: "error",
      comment:
        "apps/worker/src/mcp 不能匯入 apps/worker/src/http。WHY: Worker 入口由 src/entry/worker.ts 組裝，不由 OAuth/MCP 反向包住 HTTP（ADR-0010）。",
      from: { path: "(^|/)apps/worker/src/mcp/" },
      to: { path: "(^|/)apps/worker/src/http/" },
    },
    {
      name: "worker-ledger-no-transport",
      severity: "error",
      comment:
        "apps/worker/src/ledger 不能依賴 http、mcp 或 entry。WHY: 服務層必須與傳輸層無關，HTTP 與 MCP 才能共用同一套用例與事件（ADR-0010）。",
      from: { path: "(^|/)apps/worker/src/ledger/" },
      to: { path: "(^|/)apps/worker/src/(http|mcp|entry)/" },
    },
    {
      name: "worker-shared-is-leaf",
      severity: "error",
      comment:
        "apps/worker/src/shared 不能依賴 http、mcp、entry 或 db。WHY: 共用工具屬於底層葉節點，不可形成循環依賴（ADR-0010）。",
      from: { path: "(^|/)apps/worker/src/shared/" },
      to: { path: "(^|/)apps/worker/src/(http|mcp|entry|db)/" },
    },
    {
      name: "worker-db-is-leaf",
      severity: "error",
      comment:
        "apps/worker/src/db 不能依賴 http、mcp、ledger 或 entry。WHY: 資料層 schema 與 client 屬於基礎設施葉節點（ADR-0010）。",
      from: { path: "(^|/)apps/worker/src/db/" },
      to: { path: "(^|/)apps/worker/src/(http|mcp|ledger|entry)/" },
    },
    {
      name: "contracts-client-no-zod",
      severity: "error",
      comment:
        "@open-split/contracts/client 及其底層檔不得匯入 zod。WHY: 瀏覽器端透過此子入口取得常數與 API 路徑，保持零 Zod 執行期體積（ADR-0010）。",
      from: { path: "(^|/)packages/contracts/src/(client|attachment-limits|routes)\\.ts$" },
      to: { path: "(^zod$|/node_modules/zod/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};
