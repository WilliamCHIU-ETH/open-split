# 驗收驅動

`tools/driver` 是代理人必須真的跑過的程式，不是說明書。切片 1 起，帳本指令打本機 Worker 與 D1。`demo` 仍只算數學、不寫檔。輸出的鍵名與切片 0 相同，另外會多印修改、作廢與份額合計。

## 怎麼跑

```sh
pnpm driver demo
pnpm driver accept
pnpm driver login --as alice
pnpm driver login --as bob --provider google
pnpm driver create-group --name 京都週末 --currency JPY
pnpm driver add-member --group <id> --name Bob --virtual
pnpm driver add-member --group <id> --name Bob --user <userId>
pnpm driver add-expense --group <id> --payer <memberId> --amount 3000 --currency JPY --participants <id>,<id> --split equal
pnpm driver add-expense --group <id> --payer <memberId> --amount 600 --currency JPY --participants <id>,<id> --split exact --amounts <id>=100,<id>=500
pnpm driver add-expense --group <id> --payer <memberId> --amount 1000 --currency JPY --participants <id>,<id> --split percentage --basis-points <id>=6000,<id>=4000
pnpm driver add-expense --group <id> --payer <memberId> --amount 1001 --currency JPY --participants <id>,<id> --split shares --weights <id>=1,<id>=2
pnpm driver add-expense --group <id> --payer <memberId> --amount 1001 --currency JPY --fx-rate 0.21 --participants <id>,<id> --split equal
pnpm driver claim --token <token>
pnpm driver join --token <token>
pnpm driver show-balances --group <id>
pnpm driver settle --group <id>
pnpm driver settle --group <id> --record
pnpm driver record-settlement --group <id> --from <memberId> --to <memberId> --amount <minor> --currency <ccy> [--note <text>]
pnpm driver void-settlement --group <id> --settlement <id>
pnpm driver set-payment-profile --group <id> --member <memberId> --label <text> --details <text>
pnpm driver clear-payment-profile --group <id> --member <memberId>
pnpm driver show-summary --group <id>
pnpm driver share-link --group <id>
```

`pnpm` 會在參數前多放一個 `--`。CLI 會把它拿掉。

金額是 ISO 4217 整數最小貨幣單位：日圓 `3000` JPY 是 `3000`，新台幣 `120.50` TWD 是 `12050`，美元 `12.50` USD 是 `1250`。不要傳 `3000.00`。外幣支出可傳 `--fx-rate <decimal|num/den>`（1 外幣主要單位 = ratio 群組主幣別主要單位）。

狀態檔預設是 `./.open-split-driver/state.json`（已忽略）。`--state` 可換路徑。`accept` 若沒給 `--state`，會寫到暫存檔並印出路徑。

## 假身份

`login --as alice` 走 LINE，subject 是 `dev-line:alice`。`bob` 的 Google subject 是 `dev-google:bob`。這是 [ADR-0003](adr/0003-auth-separation.md) 的 dev 提供者。

```sh
pnpm driver login --as alice --environment production
```

必須失敗。正式環境不接受假登入。

`accept` 會做完：
1. 切片 1–2：bob 與 alice 以假身份登入、alice 建立群組、加入已登入的 bob、平均分、修改、作廢、建立虛擬成員、指定金額、百分比、份數、排除某人、kenji 認領同一個成員、chao 用邀請連結加入。
2. 切片 3：設定收款方式與權限檢查（403）、部分結清與作廢、活動紀錄驗證、非成員 403 與幣別不符 422、全額結清歸零、核對群組摘要。
3. 切片 4：建立 `TWD` 多幣別群組、以 `--fx-rate` 記 `JPY` 與 `USD` 支出、驗證折算總額與餘額不變量、確認同幣別附匯率被 422 拒絕與外幣結清被 422 拒絕、以 `TWD` 結清並核對活動紀錄操作者姓名歸屬。
4. 切片 5：檢查 RFC 9728 / 8414 metadata、動態客戶端註冊（含拒絕危險 redirect URI）、驗證非白名單 Email 被 `access_denied` 拒絕、以白名單 Gmail 走本機 PKCE 取得 MCP token、確認與網頁 API 隔離（401）、呼叫 MCP `create_attachment_upload` 驗證偽造 SVG 檔頭（415）與合法 PNG 上傳進 R2、冪等呼叫兩次 `add_expense`、驗證私有下載安全標頭與非成員 403、刪除收據、並確認 `mcp:read` 權杖無法呼叫寫入工具（403）。

`settle` 預設預覽方案。加上 `--record` 後會逐筆寫入方案中的轉帳，再向伺服器查詢餘額以驗證結清。`show-summary` 會印出成員的累計支出、份額、結清付出和收款、淨額，以及各分類與支出總額。它會比對餘額端點與摘要淨額，並核對分類合計。

邀請連結不是 `liff.shareTargetPicker()`。那個屬於切片 6。

`claim` 先讀伺服器上的成員 id，寫入後再讀一次。兩次必須是同一個 id。認領者可以用自己的狀態檔，不必先有群組紀錄。

先啟動本機 Worker（`.dev.vars` 要打開假身份並設定 `MCP_ALLOWED_EMAILS`，並套用遷移）：

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @open-split/worker exec wrangler d1 migrations apply open-split --local
pnpm --filter @open-split/worker dev
```

`OPEN_SPLIT_API_URL` 可換掉預設的 `http://127.0.0.1:8787`。

## PR 要貼什麼

把指令與標準輸出整段貼進 PR。至少要看得到：

- `login.subject`
- `invariant.balances_sum_to_zero: pass`
- `invariant.transfer_bound: pass`
- `invariant.settled_to_zero: pass`
- `check.fx_conversion: pass`、`invariant.fx_balances_sum_to_zero: pass`
- `check.mcp_oauth_token: pass`、`check.r2_receipt_uploaded: pass`、`check.mcp_read_only_scope_enforced: pass`
- 若這一片含分享，`invite_path`

只有「測試通過」而沒有這段輸出，不算跑過功能。

`demo` 是不寫檔的數學例子（10 人裡 5 人吃、付 3000 日圓）。它不能代替 `accept`。
