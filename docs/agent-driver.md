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

`accept` 會做完：bob 與 alice 以假身份登入、alice 建立群組、加入已登入的 bob、平均分 3000、把金額改成 3600、作廢另一筆、印餘額，再用核心印結清方案、建立邀請連結。虛擬成員與結清寫入不在這一片。邀請連結不是 `liff.shareTargetPicker()`。那個屬於切片 6。認領邀請也還沒做。

先啟動本機 Worker（`.dev.vars` 要打開假身份，並套用遷移）：

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @open-split/worker dev
```

`OPEN_SPLIT_API_URL` 可換掉預設的 `http://127.0.0.1:8787`。

## PR 要貼什麼

把指令與標準輸出整段貼進 PR。至少要看得到：

- `login.subject`
- `invariant.balances_sum_to_zero: pass`
- `invariant.transfer_bound: pass`
- `invariant.settled_to_zero: pass`
- 若這一片含分享，`invite_path`

只有「測試通過」而沒有這段輸出，不算跑過功能。

`demo` 是不寫檔的數學例子（10 人裡 5 人吃、付 3000 日圓）。它不能代替 `accept`。
