# 03 程式設計

這一層把表、型別、函式與 MCP 工具定成契約。標成「已實作」的是這次 harness 裡真的會跑的數學與守衛。其餘是後續切片要接上的形狀，現在不要在路由裡假裝已經完成。

欄位以 `apps/worker/src/db/schema.ts` 為準。下面是索引。

## D1 資料表

金額欄都是整數最小貨幣單位（`*_minor`），不是 REAL。

| 表 | 用途 |
| --- | --- |
| `users` | 使用者。`mcp_allowed` 預設 false |
| `auth_identities` | `line` 或 `google` 的 subject，唯一 |
| `sessions` | 網頁工作階段，只存 token 雜湊 |
| `groups` | 群組與預設幣別 |
| `group_members` | 成員。`user_id` 空著就是虛擬成員 |
| `invite_links` | 邀請，只存權杖雜湊 |
| `expenses` | 支出。`fx_numerator`／`fx_denominator` 都空表示不換匯 |
| `expense_shares` | 每人份額，主鍵是支出 + 成員 |
| `settlements` | 記錄下來的結清，不是只算給人看 |
| `payment_profiles` | 收款方式的文字說明，不移動金錢 |
| `activity_log` | 活動紀錄，payload 是 JSON 文字 |
| `line_push_targets` | 可選的官方帳號推播對象。不是聊天 webhook |
| `oauth_clients` | MCP 的 OAuth 客戶端 |
| `oauth_authorization_codes` | 授權碼與 PKCE，只存雜湊 |
| `oauth_access_tokens` | 存取權杖雜湊 |

遷移從切片 1 開始，按那一片需要的表加。切片 1 的遷移含使用者、工作階段、群組、成員、支出、份額、活動紀錄與邀請。切片 2 給支出加上 `split_json`（空著代表切片 1 的平均分），並用認領權杖的雜湊找虛擬成員。餘額仍用存下來的份額，不在查詢時重算另一套分法。切片 3 的 `0003_slice3.sql` 建立結清與收款方式資料表，按群組查詢結清，每個成員最多有一筆收款方式。OAuth 的表仍只在 schema。

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

結清金額必須為正，付款人與收款人必須是不同的非空 id。付款人的淨額增加，收款人的淨額減少。成員與分類摘要只讀取支出。未填分類合併為 `null`，同額時排在具名分類之後。

百分比的基點必須合計 10000，而且每個被列入的人都是正整數。要排除某人，是不要把他放進 `participantIds`，不是給 0。

`simplifyDebts` 是貪心法，不是 NP-hard 的最少轉帳最佳解。它保證：淨額合計為 0 時，套用後每人為 0，且轉帳數 ≤ 參與者 − 1。

還沒做、仍會放在 core 的：自訂匯率 `convertMinor(amount, numerator, denominator)`。切片 4 再加，並且繼續用整數。

## 共用契約

HTTP 與 MCP 共用 schema。見 `packages/contracts`。

金額在 JSON 裡是十進位整數字串，例如 `"3000"`。`"3000.0"`、`"01"` 與 JSON number 都拒絕。

### MCP 工具

每個工具的 input／output 就是 `mcpToolContracts` 裡的 Zod schema。名稱：

| 工具 | 切片 | 輸入要點 | 輸出要點 |
| --- | --- | --- | --- |
| `list_groups` | 5 | 空物件 | `{ groups }` |
| `create_group` | 1 | `name`, `defaultCurrency` | 群組 |
| `add_member` | 2 | `groupId`, `displayName`, `virtual` | 成員 |
| `create_invite` | 6 | `groupId` | `invitePath`, `token` |
| `add_expense` | 1 | 支出契約（見下） | `id`, `shares` |
| `update_expense` | 1 | 支出契約 + `expenseId` | 同 `add_expense` |
| `void_expense` | 1 | `expenseId` | `{ id, voided: true }` |
| `get_balances` | 1 | `groupId` | `balances`, `sum` |
| `preview_settlement` | 3 | `groupId` | `currency`, `transfers`, `participantCount`, `transferBound` |
| `record_settlement` | 3 | 成員、金額字串、幣別、選填 `note` | `id` |
| `list_activity` | 1 | `groupId` | `entries` |
| `set_payment_profile` | 3 | `memberId`, `label`, `details` | `id` |

`add_expense` 的輸入：

```ts
{
  groupId: string;
  payerId: string;
  amount: string;          // 最小貨幣單位
  currency: string;        // ISO 4217
  participantIds: string[];
  split:
    | { type: "equal" }
    | { type: "exact"; amounts: Record<string, string> }
    | { type: "percentage"; basisPoints: Record<string, number> }
    | { type: "shares"; weights: Record<string, number> };
  category?: string;
  note?: string;
}
```

HTTP 路徑的預定清單在 `plannedHttpRoutes`。切片 1 的群組、支出、餘額與活動紀錄不再回 501。切片 2 起，同一批支出路徑接受指定金額、百分比與份數；虛擬成員、認領與用邀請連結加入也走 HTTP。MCP 的 `create_invite` 仍標切片 6，因為工具傳輸那時才有。切片 3 新增結清方案、記錄與作廢結清、設定與清除收款方式，以及唯讀摘要。

結清方案沿用 driver 的上限算法，以餘額清單的長度作為 `participantCount`。在有效支出或結清中出現過的成員，即使目前淨額為零也計入。作廢結清保留在群組明細與活動紀錄，餘額與摘要只採計有效結清。

## 登入介面

已實作介面與守衛，沒有 OAuth。見 `packages/auth`。

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

`createDevLineProvider()` 與 `createDevGoogleProvider()` 是僅有的假身份。正式提供者以後補上授權碼交換，不補 `signInAs`。

## 還沒做

OAuth、MCP 傳輸、LIFF SDK、Flex Message、官方帳號 push、多幣別。切片順序見 [04](04-vertical-slices.md)。
