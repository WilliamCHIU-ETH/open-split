/** Planned HTTP surface. Slice 0 serves /health and answers the rest with 501. */
export const plannedHttpRoutes = [
  { method: "GET", path: "/health", slice: "0", summary: "存活檢查" },
  { method: "POST", path: "/api/groups", slice: "1", summary: "建立群組" },
  { method: "POST", path: "/api/groups/:groupId/expenses", slice: "1", summary: "記一筆支出" },
  { method: "PATCH", path: "/api/groups/:groupId/expenses/:expenseId", slice: "1", summary: "改一筆支出" },
  { method: "POST", path: "/api/groups/:groupId/expenses/:expenseId/void", slice: "1", summary: "作廢一筆支出" },
  { method: "GET", path: "/api/groups/:groupId/balances", slice: "1", summary: "看即時餘額" },
  { method: "GET", path: "/api/groups/:groupId/activity", slice: "1", summary: "看活動紀錄" },
  { method: "POST", path: "/api/groups/:groupId/members", slice: "2", summary: "加入虛擬成員" },
  { method: "POST", path: "/api/groups/:groupId/settlements", slice: "3", summary: "記錄結清" },
  { method: "POST", path: "/api/groups/:groupId/invites", slice: "6", summary: "建立邀請連結" },
] as const;

export type PlannedHttpRoute = (typeof plannedHttpRoutes)[number];
