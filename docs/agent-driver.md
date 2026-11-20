# 驗收驅動

`tools/driver` 是代理人必須真的跑過的程式，不是說明書。它現在寫本機 JSON，呼叫 `@open-split/core` 與 `@open-split/auth`。它不是產品 API。切片 1 之後，同一組指令要改打 Worker，輸出的鍵名保持不變，PR 才比得出來。

## 怎麼跑

```sh
pnpm driver demo
pnpm driver accept
pnpm driver login --as alice
pnpm driver login --as bob --provider google
pnpm driver create-group --name 京都週末 --currency JPY
pnpm driver add-member --group <id> --name Bob --virtual
pnpm driver add-expense --group <id> --payer <memberId> --amount 3000 --currency JPY --participants <id>,<id> --split equal
pnpm driver show-balances --group <id>
pnpm driver settle --group <id>
pnpm driver share-link --group <id>
```

`pnpm` 會在參數前多放一個 `--`。CLI 會把它拿掉。

金額是整數最小貨幣單位。日圓 3000 就是 `3000`。不要傳 `3000.00`。

狀態檔預設是 `./.open-split-driver/state.json`（已忽略）。`--state` 可換路徑。`accept` 若沒給 `--state`，會寫到暫存檔並印出路徑。

## 假身份

`login --as alice` 走 LINE，subject 是 `dev-line:alice`。`bob` 的 Google subject 是 `dev-google:bob`。這是 [ADR-0003](adr/0003-auth-separation.md) 的 dev 提供者。

```sh
pnpm driver login --as alice --environment production
```

必須失敗。正式環境不接受假登入。

`accept` 會做完：以 alice 登入、建立群組、加入虛擬成員 Bob、平均分 3000、印餘額與結清方案、建立邀請連結。邀請連結不是 `liff.shareTargetPicker()`。那個屬於切片 6。

## PR 要貼什麼

把指令與標準輸出整段貼進 PR。至少要看得到：

- `login.subject`
- `invariant.balances_sum_to_zero: pass`
- `invariant.transfer_bound: pass`
- `invariant.settled_to_zero: pass`
- 若這一片含分享，`invite_path`

只有「測試通過」而沒有這段輸出，不算跑過功能。

`demo` 是不寫檔的數學例子（10 人裡 5 人吃、付 3000 日圓）。它不能代替 `accept`。
