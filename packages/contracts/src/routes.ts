/**
 * HTTP API route catalog and zero-runtime-Zod path builders shared by Worker and Web.
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

const seg = (value: string): string => encodeURIComponent(value);

/** Zero-runtime-Zod URL builders shared with apps/web so endpoints stay in one place. */
export const apiPaths = {
  health: () => "/health",
  devSession: () => "/api/dev/session",
  devUsers: () => "/api/dev/users",
  session: () => "/api/session",
  groups: () => "/api/groups",
  group: (groupId: string) => `/api/groups/${seg(groupId)}`,
  groupMembers: (groupId: string) => `/api/groups/${seg(groupId)}/members`,
  memberClaimLink: (groupId: string, memberId: string) => `/api/groups/${seg(groupId)}/members/${seg(memberId)}/claim-link`,
  memberPaymentProfile: (groupId: string, memberId: string) =>
    `/api/groups/${seg(groupId)}/members/${seg(memberId)}/payment-profile`,
  claim: (token: string) => `/api/claims/${seg(token)}`,
  groupInvites: (groupId: string) => `/api/groups/${seg(groupId)}/invites`,
  invite: (token: string) => `/api/invites/${seg(token)}`,
  inviteAccept: (token: string) => `/api/invites/${seg(token)}/accept`,
  groupExpenses: (groupId: string) => `/api/groups/${seg(groupId)}/expenses`,
  groupExpense: (groupId: string, expenseId: string) => `/api/groups/${seg(groupId)}/expenses/${seg(expenseId)}`,
  groupExpenseVoid: (groupId: string, expenseId: string) => `/api/groups/${seg(groupId)}/expenses/${seg(expenseId)}/void`,
  groupBalances: (groupId: string) => `/api/groups/${seg(groupId)}/balances`,
  groupSettlementPlan: (groupId: string) => `/api/groups/${seg(groupId)}/settlement-plan`,
  groupSettlements: (groupId: string) => `/api/groups/${seg(groupId)}/settlements`,
  groupSettlementVoid: (groupId: string, settlementId: string) =>
    `/api/groups/${seg(groupId)}/settlements/${seg(settlementId)}/void`,
  groupSummary: (groupId: string) => `/api/groups/${seg(groupId)}/summary`,
  groupActivity: (groupId: string) => `/api/groups/${seg(groupId)}/activity`,
  groupAttachments: (groupId: string) => `/api/groups/${seg(groupId)}/attachments`,
  groupAttachmentUploadIntent: (groupId: string) => `/api/groups/${seg(groupId)}/attachments/upload-intent`,
  groupAttachment: (groupId: string, attachmentId: string) => `/api/groups/${seg(groupId)}/attachments/${seg(attachmentId)}`,
} as const;
