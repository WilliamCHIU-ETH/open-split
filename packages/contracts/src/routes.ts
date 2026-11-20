/**
 * Planned HTTP surface.
 * Slice labels follow docs/04. Slice 1 serves the ledger routes below (they no longer return 501).
 * Member, invite, and settlement-preview handlers also respond, because the acceptance flow needs them;
 * their slice labels stay on the original plan. Recording a settlement stays 501.
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
  { method: "GET", path: "/api/groups/:groupId/settlement-preview", slice: "1", summary: "看建議結清方案" },
  { method: "GET", path: "/api/groups/:groupId/activity", slice: "1", summary: "看活動紀錄" },
  { method: "POST", path: "/api/groups/:groupId/members", slice: "2", summary: "加入成員或虛擬成員" },
  { method: "POST", path: "/api/groups/:groupId/settlements", slice: "3", summary: "記錄結清" },
  { method: "POST", path: "/api/groups/:groupId/invites", slice: "6", summary: "建立邀請連結" },
] as const;

export type PlannedHttpRoute = (typeof plannedHttpRoutes)[number];
