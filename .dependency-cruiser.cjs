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
