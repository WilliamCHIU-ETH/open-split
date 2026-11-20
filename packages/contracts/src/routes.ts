/**
 * HTTP surface.
 * Slice labels follow docs/04. Expense routes started in slice 1 and now accept every split & FX rate.
 * Virtual members, claim, and joining by invite are slice 2. Settlements, payment profiles, and summaries are slice 3.
 * FX conversion is slice 4. R2 receipt attachments and OAuth 2.1 + MCP server are slice 5.
 */
export const plannedHttpRoutes = [
  { method: "GET", path: "/health", slice: "0", summary: "存活檢查" },
  { method: "GET", path: "/api/dev/session", slice: "1", summary: "本機假登入是否可用" },
  { method: "POST", path: "/api/dev/session", slice: "1", summary: "本機假身份建立工作階段" },
  { method: "GET", path: "/api/dev/users", slice: "1", summary: "本機已建立的使用者" },
  { method: "GET", path: "/api/session", slice: "1", summary: "目前的登入者" },
  { method: "DELETE", path: "/api/session", slice: "1", summary: "登出" },
  { method: "GET", path: "/api/groups", slice: "1", summary: "列出我的群組" },
  { method: "POST", path: "/api/groups", slice: "1", summary: "建立群組" },
  { method: "GET", path: "/api/groups/:groupId", slice: "1", summary: "看群組、成員與支出" },
  { method: "POST", path: "/api/groups/:groupId/expenses", slice: "1", summary: "記一筆支出" },
  { method: "PATCH", path: "/api/groups/:groupId/expenses/:expenseId", slice: "1", summary: "改一筆支出" },
  { method: "POST", path: "/api/groups/:groupId/expenses/:expenseId/void", slice: "1", summary: "作廢一筆支出" },
  { method: "GET", path: "/api/groups/:groupId/balances", slice: "1", summary: "看即時餘額" },
  { method: "GET", path: "/api/groups/:groupId/activity", slice: "1", summary: "看活動紀錄" },
  { method: "POST", path: "/api/groups/:groupId/members", slice: "2", summary: "加入成員或虛擬成員" },
  { method: "POST", path: "/api/groups/:groupId/members/:memberId/claim-link", slice: "2", summary: "重新產生認領連結" },
  { method: "GET", path: "/api/claims/:token", slice: "2", summary: "看要認領的成員" },
  { method: "POST", path: "/api/claims/:token", slice: "2", summary: "認領虛擬成員" },
  { method: "POST", path: "/api/groups/:groupId/invites", slice: "2", summary: "建立邀請連結" },
  { method: "GET", path: "/api/invites/:token", slice: "2", summary: "看邀請連結" },
  { method: "POST", path: "/api/invites/:token/accept", slice: "2", summary: "用邀請連結加入群組" },
  { method: "GET", path: "/api/groups/:groupId/settlement-plan", slice: "3", summary: "看建議轉帳" },
  { method: "POST", path: "/api/groups/:groupId/settlements", slice: "3", summary: "記錄結清" },
  { method: "POST", path: "/api/groups/:groupId/settlements/:settlementId/void", slice: "3", summary: "作廢一筆結清" },
  { method: "PUT", path: "/api/groups/:groupId/members/:memberId/payment-profile", slice: "3", summary: "設定收款方式" },
  { method: "DELETE", path: "/api/groups/:groupId/members/:memberId/payment-profile", slice: "3", summary: "清除收款方式" },
  { method: "GET", path: "/api/groups/:groupId/summary", slice: "3", summary: "看成員與分類摘要" },
  { method: "GET", path: "/api/groups/:groupId/attachments", slice: "5", summary: "列出群組收據附檔" },
  { method: "POST", path: "/api/groups/:groupId/attachments/upload-intent", slice: "5", summary: "建立 R2 收據上傳意圖" },
  { method: "PUT", path: "/api/groups/:groupId/attachments/:attachmentId/content", slice: "5", summary: "上傳收據檔案二進位內容" },
  { method: "GET", path: "/api/groups/:groupId/attachments/:attachmentId", slice: "5", summary: "私有下載收據附檔" },
  { method: "DELETE", path: "/api/groups/:groupId/attachments/:attachmentId", slice: "5", summary: "刪除收據附檔" },
] as const;

export type PlannedHttpRoute = (typeof plannedHttpRoutes)[number];
