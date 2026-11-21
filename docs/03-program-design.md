# 03 程式設計

這一層把表、型別、函式與 MCP 工具定成契約。標成「已實作」的是這次 harness 裡真的會跑的數學與守衛。其餘是後續切片要接上的形狀，現在不要在路由裡假裝已經完成。

欄位以 `apps/worker/src/db/schema.ts` 為準。下面是索引。

## D1 資料表

金額欄都是整數最小貨幣單位（`*_minor`），不是 REAL。

| 表 | 用途 |
| --- | --- |
| `users` | 使用者。`mcp_allowed` 預設 false，並可搭配 `primary_email` 與 `MCP_ALLOWED_EMAILS` |
| `auth_identities` | `line` 或 `google` 的 subject，唯一 |
| `sessions` | 網頁工作階段，只存 token 雜湊 |
| `groups` | 群組與預設幣別 |
| `group_members` | 成員。`user_id` 空著就是虛擬成員 |
| `invite_links` | 邀請，只存權杖雜湊 |
| `expenses` | 支出。含 `fx_numerator`／`fx_denominator` 與 `converted_amount_minor` |
| `expense_shares` | 每人份額，主鍵是支出 + 成員，含換算後與原幣份額 |
| `settlements` | 記錄下來的結清，強制群組預設幣別 |
| `payment_profiles` | 收款方式的文字說明，不移動金錢 |
| `attachments` | R2 收據中繼資料、`sha256`、`mime_type`、`upload_token_hash` 與軟刪除時間 |
| `idempotency_keys` | HTTP／MCP 寫入冪等紀錄（payload hash 與快取回應） |
| `activity_log` | 活動紀錄，payload 是 JSON 文字（含操作者與 `via`／`clientId`） |
| `line_push_targets` | 可選的官方帳號推播對象。不是聊天 webhook |
| `oauth_clients` / `oauth_authorization_codes` / `oauth_access_tokens` | schema 預留表（切片 5 的 OAuth 狀態實際由 `OAUTH_KV` 與 `@cloudflare/workers-oauth-provider` 管理） |

遷移從切片 1 開始按切片加入：`0001_slice1.sql`、`0002_slice2.sql`、`0003_slice3.sql`、`0004_slice4_5.sql`（加入 `expenses.converted_amount_minor`、`expense_shares.original_amount_minor`、`attachments`、`idempotency_keys` 與索引）。

## 帳本核心

已實作，見 `packages/core`。

```ts
type Minor = bigint & { readonly [brand]: "Minor" };

function minor(units: bigint): Minor;
function minorFromSafeInteger(value: number): Minor;
function formatMinor(value: Minor): string;

function allocate(input: {
  amount: Minor;
  participantIds: readonly string[];
  split:
    | { type: "equal" }
    | { type: "exact"; amounts: Readonly<Record<string, Minor>> }
    | { type: "percentage"; basisPoints: Readonly<Record<string, number>> }
    | { type: "shares"; weights: Readonly<Record<string, number>> };
}): readonly { participantId: string; amount: Minor }[];

// 多幣別整數比值換算與 ISO 4217 小數格式化（見 ADR-0006）
function convertMinor(input: ConvertMinorInput): Minor;
function allocateConvertedExpense(input: {
  amount: Minor;
  fromCurrency: string;
  toCurrency: string;
  fxNumerator: number | null;
  fxDenominator: number | null;
  participantIds: readonly string[];
  split: SplitSpec;
}): ConvertedExpenseAllocation;
function parseRateRatio(raw: string): { numerator: number; denominator: number };
function parseMajorToMinor(raw: string, currency: string): Minor;
function formatMinorDecimal(value: Minor, currency: string): string;
function formatMinorByCurrency(value: Minor, currency: string): string;

interface Expense {
  payerId: string;
  amount: Minor;
  participantIds: readonly string[];
  split: SplitSpec;
}
function computeBalances(expenses: readonly Expense[], settlements?: readonly Transfer[]): readonly NetBalance[];

function summarizeMembers(expenses: readonly Expense[]): readonly {
  participantId: string;
  paid: Minor;
  share: Minor;
}[];
function summarizeCategories(expenses: readonly (Expense & { category?: string | null })[]): readonly {
  category: string | null;
  total: Minor;
  count: number;
}[];

function simplifyDebts(balances: readonly NetBalance[]): readonly {
  fromId: string;
  toId: string;
  amount: Minor;
}[];

function applyTransfers(balances, transfers): readonly NetBalance[];
function transferBound(participantCount: number): number;
```

`net` 為正代表群組欠他，為負代表他欠群組。沒有出現在向量裡的人視為 0。

結清金額必須為正，付款人與收款人必須是不同的非空 id，且幣別必須是群組預設幣別。付款人的淨額增加，收款人的淨額減少。成員與分類摘要只讀取有效支出（以換算後主幣別計算）。未填分類合併為 `null`，同額時排在具名分類之後。

百分比的基點必須合計 10000，而且每個被列入的人都是正整數。要排除某人，是不要把他放進 `participantIds`，不是給 0。

`simplifyDebts` 是貪心法，不是 NP-hard 的最少轉帳最佳解。它保證：淨額合計為 0 時，套用後每人為 0，且轉帳數 ≤ 參與者 − 1。

## 共用契約

HTTP 與 MCP 共用 schema。見 `packages/contracts`。

金額在 JSON 裡是十進位整數字串（依 ISO 4217 最小貨幣單位，如 `"3000"` JPY、`"1250"` USD = `$12.50`）。`"3000.0"`、`"01"` 與 JSON number 都拒絕。

### MCP 工具

每個工具的 input／output 就是 `mcpToolContracts` 裡的 Zod schema（含選填 `idempotencyKey` 與 `mcp:read`／`mcp:write` scope）：

| 工具 | Scope | 輸入要點 | 輸出要點 |
| --- | --- | --- | --- |
| `list_groups` | `mcp:read` | 空物件 | `{ groups }` |
| `get_group` | `mcp:read` | `groupId` | 群組明細、成員、支出與餘額 |
| `get_balances` | `mcp:read` | `groupId` | `balances`, `sum` |
| `preview_settlement` | `mcp:read` | `groupId` | `currency`, `transfers`, `participantCount`, `transferBound` |
| `get_summary` | `mcp:read` | `groupId` | 成員收支與分類統計 |
| `list_activity` | `mcp:read` | `groupId` | `entries` |
| `list_attachments` | `mcp:read` | `groupId`, 選填 `expenseId` | `{ attachments }` |
| `create_group` | `mcp:write` | `name`, `defaultCurrency` | 群組 + `ownerMemberId` |
| `add_member` | `mcp:write` | `groupId`, `displayName`, `virtual`, `userId?` | 成員 + `claim?` |
| `create_invite` | `mcp:write` | `groupId` | `invitePath`, `token` |
| `add_expense` | `mcp:write` | 支出契約（見下） | `id`, `shares`, `convertedAmount`, `originalShares` |
| `update_expense` | `mcp:write` | 支出契約 + `expenseId` | 同 `add_expense` |
| `void_expense` | `mcp:write` | `groupId`, `expenseId` | `{ id, voided: true }` |
| `record_settlement` | `mcp:write` | `groupId`, 成員、金額、主幣別、`note?` | `id` |
| `void_settlement` | `mcp:write` | `groupId`, `settlementId` | `{ id, voided: true }` |
| `set_payment_profile` | `mcp:write` | `groupId`, `memberId`, `label`, `details` | `id` |
| `clear_payment_profile` | `mcp:write` | `groupId`, `memberId` | `{ ok: true }` |
| `create_attachment_upload` | `mcp:write` | `groupId`, `filename`, `mimeType`, `byteSize`, `sha256`, `expenseId?` | `attachment`, `uploadPath`, `expiresAt` |
| `delete_attachment` | `mcp:write` | `groupId`, `attachmentId` | `{ id, deleted: true }` |

`add_expense` 的輸入：

```ts
{
  groupId: string;
  payerId: string;
  amount: string;          // 最小貨幣單位
  currency: string;        // ISO 4217
  fxRate?: { numerator: number; denominator: number }; // currency !== group.defaultCurrency 時必填
  participantIds: string[];
  split:
    | { type: "equal" }
    | { type: "exact"; amounts: Record<string, string> }
    | { type: "percentage"; basisPoints: Record<string, number> }
    | { type: "shares"; weights: Record<string, number> };
  category?: string;
  note?: string;
  attachmentIds?: string[]; // 最多 5 份已上傳就緒的收據
}
```

HTTP 路徑的預定清單在 `plannedHttpRoutes`。切片 1 至 5 的群組、成員、支出（含 FX）、餘額、結清、收款方式、摘要、活動紀錄、邀請、認領與收據附檔皆已實作並上線本機測試。

結清方案沿用 driver 的上限算法，以餘額清單的長度作為 `participantCount`。在有效支出或結清中出現過的成員，即使目前淨額為零也計入。作廢結清保留在群組明細與活動紀錄，餘額與摘要只採計有效結清。

## 登入介面

已實作介面、假身份守衛與 `wrangler.jsonc` 安全檢查，見 `packages/auth`。MCP OAuth 2.1 Gateway 與 Google OIDC JWKS 驗證實作於 `apps/worker/src/mcp/oauth.ts`。

```ts
interface AuthProvider {
  readonly provider: "line" | "google";
  readonly mode: "production" | "dev";
}

interface DevIdentityProvider extends AuthProvider {
  readonly mode: "dev";
  signInAs(name: string): {
    provider: "line" | "google";
    subject: string;
    displayName: string;
  };
}

function assertDevAuthAllowed(env: {
  environment: string;
  authDevIdentities: boolean;
}): void;

function auditWranglerConfig(config: unknown): readonly {
  path: string;
  message: string;
}[];
```

`createDevLineProvider()` 與 `createDevGoogleProvider()` 是僅有的假身份。

## 還沒做

切片 6 至 8：正式 LINE Login OAuth 授權碼交換、LIFF SDK 與 `shareTargetPicker()`、官方帳號推播、發生日期／搜尋篩選／CSV 匯出與逐項拆帳。切片順序見 [04](04-vertical-slices.md)。
