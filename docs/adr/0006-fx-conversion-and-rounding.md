# ADR-0006：多幣別換算與捨入契約

- 狀態：已接受
- 日期：2026-11-20

## 背景

旅途中常以非群組預設幣別付款（例如 TWD 群組裡記一筆 JPY 或 USD 支出）。若直接把不同幣別的整數相加，餘額毫無意義；若在資料庫外或用浮點匯率換算，網頁預覽與 MCP 寫入會差 1 個最小單位。

## 決策

### 整數比值匯率

匯率不用浮點數，一律以正整數比值 `(fxNumerator, fxDenominator)` 表示「**1 單位支出主貨幣 = `(fxNumerator / fxDenominator)` 單位群組預設主貨幣**」。例如 `1 USD = 31.5 TWD` 記為 `315 / 10`；`1 JPY = 0.21 TWD` 記為 `21 / 100`。

### ISO 4217 指數表與四捨五入（半入位）

`packages/core` 內建 ISO 4217 小數位指數表（例如 `JPY`/`KRW`/`VND` 為 `0`、`TWD`/`USD`/`EUR` 為 `2`、`KWD`/`BHD` 為 `3`）。未知幣別一律拒絕（`LedgerError`）。

換算整筆支出金額為群組預設幣別最小貨幣單位：

```
numeratorScaled   = amountMinor × fxNumerator × 10^(exp_to)
denominatorScaled = fxDenominator × 10^(exp_from)
convertedTotal    = floor((numeratorScaled + floor(denominatorScaled / 2)) / denominatorScaled)
```

- 支出幣別等於群組預設幣別時，不得附帶 `fxRate`（兩欄皆為 `null`）。
- 支出幣別不同於群組預設幣別時，必須附帶合法正整數比值 `fxRate`。

### 份額與餘額守恆

1. `equal`、`percentage`、`shares` 屬於比例分攤：以 `convertedTotal` 直接呼叫 `allocate()`，確保 `sum(convertedShares) === convertedTotal` 且誤差小於 1 個最小單位；同時保留原幣別份額供明細顯示。
2. `exact`（指定原幣別金額）先驗證原幣別份額合計等於原金額，再以 `originalShares` 為權重用漢彌爾頓最大餘數法將 `convertedTotal` 分回各參與者（0 份額維持 0，同餘數依參與者 `id` 字典序分配），沿用 [ADR-0002](0002-deterministic-ledger-core.md) 的決定性順序。
3. 群組淨額、債務簡化、結清記錄一律使用「群組預設幣別」。`expenses` 寫入 `converted_amount_minor`、`fx_numerator`、`fx_denominator`，`expense_shares.amount_minor` 存換算後份額，歷史帳目不因日後修改規則而重算。
4. 群組一旦有支出或結清紀錄，不可更改預設幣別。

## 後果

- 所有外幣換算與份額分配留在 `packages/core`，性質測試驗證 `sum(convertedShares) === convertedTotal` 與淨額合計為 0。
- `apps/web` 與 `tools/driver` 的十進位金額顯示與輸入解析（major ↔ minor）同樣使用 `packages/core` 提供的純字串整數函式，不出現浮點貨幣計算。

## 不採用

- 用浮點 `rate` 欄位或在查詢時才即時乘匯率。浮點無法重現，且結清後若匯率表變動會讓歷史餘額飄移。
- 多幣別混合結清。結清維持只用群組預設幣別，簡化簡化債務演算法與實際轉帳對帳。
