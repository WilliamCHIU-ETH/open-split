import {
  PERCENT_BASIS_POINTS,
  allocateConvertedExpense,
  currencyExponent,
  formatMinor,
  formatMinorDecimal,
  minor,
  parseMajorToMinor,
  parseRateRatio,
  subMinor,
  sumMinor,
  toMinorUnits,
  type FxRateRatio,
  type Minor,
  type SplitSpec,
} from "@open-split/core";

export type SplitMode = "equal" | "exact" | "percentage" | "shares";

export function readMajorAsMinor(raw: string, currency: string): Minor | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = parseMajorToMinor(text, currency);
    if (toMinorUnits(parsed) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function decimalHintForCurrency(currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return `${currency} 不使用小數，請填整數。`;
  return `${currency} 最多可填小數點後 ${String(exp)} 位（例如 120.${"0".repeat(exp)}）。`;
}

export function decimalPatternForCurrency(currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return "^(0|[1-9][0-9]*)$";
  return `^(0|[1-9][0-9]*)(\\.[0-9]{1,${String(exp)}})?$`;
}

export function readRateRatio(raw: string): FxRateRatio | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return parseRateRatio(text);
  } catch {
    return null;
  }
}

/** Percent text such as "33.34" becomes basis points. 100% is 10000. Zero is refused. */
export function parsePercent(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  const wholeText = match?.[1];
  if (!wholeText) return null;
  const points = Number(wholeText) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(points) || points <= 0 || points > PERCENT_BASIS_POINTS) return null;
  return points;
}

export function formatPercentInput(points: number): string {
  const whole = Math.trunc(points / 100);
  const frac = points % 100;
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return `${String(whole)}.${String(frac / 10)}`;
  return `${String(whole)}.${String(frac).padStart(2, "0")}`;
}

export function equalPercents(participantIds: readonly string[]): Record<string, string> {
  if (participantIds.length === 0) return {};
  const allocation = allocateConvertedExpense({
    amount: minor(BigInt(PERCENT_BASIS_POINTS)),
    fromCurrency: "JPY",
    toCurrency: "JPY",
    fxNumerator: null,
    fxDenominator: null,
    participantIds,
    split: { type: "equal" },
  });
  const record: Record<string, string> = {};
  for (const share of allocation.convertedShares) {
    record[share.participantId] = formatPercentInput(Number(toMinorUnits(share.amount)));
  }
  return record;
}

/** What `targetId` must be (in `currency` major units) so exact amounts equal `totalText`. */
export function exactShareFor(
  totalText: string,
  currency: string,
  participantIds: readonly string[],
  exact: Readonly<Record<string, string>>,
  targetId: string,
): string | null {
  const total = readMajorAsMinor(totalText, currency);
  if (total === null || toMinorUnits(total) <= 0n || !participantIds.includes(targetId)) return null;
  const others: Minor[] = [];
  for (const id of participantIds) {
    if (id === targetId) continue;
    const raw = (exact[id] ?? "").trim();
    const units = raw.length === 0 ? minor(0n) : readMajorAsMinor(raw, currency);
    if (units === null) return null;
    others.push(units);
  }
  const gap = subMinor(total, others.length === 0 ? minor(0n) : sumMinor(others));
  if (toMinorUnits(gap) < 0n) return null;
  return formatMinorDecimal(gap, currency);
}

export interface PreviewLine {
  readonly participantId: string;
  readonly amount: string;
  readonly originalAmount: string;
}

export interface SplitPreview {
  readonly ready: boolean;
  readonly message: string;
  readonly convertedTotal: string | null;
  readonly lines: readonly PreviewLine[];
}

export function previewSplit(input: {
  readonly amountText: string;
  readonly currency: string;
  readonly defaultCurrency: string;
  readonly fxRateText: string;
  readonly mode: SplitMode;
  readonly participantIds: readonly string[];
  readonly exact: Readonly<Record<string, string>>;
  readonly percent: Readonly<Record<string, string>>;
  readonly weights: Readonly<Record<string, string>>;
}): SplitPreview {
  if (input.participantIds.length === 0) {
    return { ready: false, message: "至少要有一個人分攤。", convertedTotal: null, lines: [] };
  }
  const total = readMajorAsMinor(input.amountText, input.currency);
  if (total === null || toMinorUnits(total) <= 0n) {
    return { ready: false, message: `先填這筆帳的金額。${decimalHintForCurrency(input.currency)}`, convertedTotal: null, lines: [] };
  }
  let fxRate: FxRateRatio | null = null;
  if (input.currency !== input.defaultCurrency) {
    fxRate = readRateRatio(input.fxRateText);
    if (!fxRate) {
      return { ready: false, message: `外幣支出請填匯率（1 ${input.currency} = 幾 ${input.defaultCurrency}）。`, convertedTotal: null, lines: [] };
    }
  }
  if (input.mode === "equal") {
    return finish(total, input.currency, input.defaultCurrency, fxRate, input.participantIds, { type: "equal" }, "平均分，零頭會分完。");
  }
  if (input.mode === "exact") {
    return previewExact(total, input.currency, input.defaultCurrency, fxRate, input.participantIds, input.exact);
  }
  if (input.mode === "percentage") {
    return previewPercentage(total, input.currency, input.defaultCurrency, fxRate, input.participantIds, input.percent);
  }
  return previewShares(total, input.currency, input.defaultCurrency, fxRate, input.participantIds, input.weights);
}

function previewExact(
  total: Minor,
  currency: string,
  defaultCurrency: string,
  fxRate: FxRateRatio | null,
  ids: readonly string[],
  exact: Readonly<Record<string, string>>,
): SplitPreview {
  const amounts: Record<string, Minor> = {};
  const parsed: Minor[] = [];
  for (const id of ids) {
    const raw = (exact[id] ?? "").trim();
    if (raw.length === 0) {
      return { ready: false, message: "每個人都要填指定金額。不想分的人請取消勾選。", convertedTotal: null, lines: [] };
    }
    const units = readMajorAsMinor(raw, currency);
    if (units === null) return { ready: false, message: `指定金額格式不正確。${decimalHintForCurrency(currency)}`, convertedTotal: null, lines: [] };
    amounts[id] = units;
    parsed.push(units);
  }
  const gap = subMinor(total, sumMinor(parsed));
  const gapUnits = toMinorUnits(gap);
  if (gapUnits !== 0n) {
    const absGap = gapUnits > 0n ? gap : minor(-gapUnits);
    const text = gapUnits > 0n ? `還差 ${formatMinorDecimal(absGap, currency)}` : `多了 ${formatMinorDecimal(absGap, currency)}`;
    return { ready: false, message: `指定金額的合計要剛好。${text}。`, convertedTotal: null, lines: [] };
  }
  return finish(total, currency, defaultCurrency, fxRate, ids, { type: "exact", amounts }, "指定金額剛好。");
}

function previewPercentage(
  total: Minor,
  currency: string,
  defaultCurrency: string,
  fxRate: FxRateRatio | null,
  ids: readonly string[],
  percent: Readonly<Record<string, string>>,
): SplitPreview {
  const basisPoints: Record<string, number> = {};
  let pointsTotal = 0;
  for (const id of ids) {
    const raw = (percent[id] ?? "").trim();
    if (raw.length === 0) return { ready: false, message: "每個人都要填百分比。", convertedTotal: null, lines: [] };
    const points = parsePercent(raw);
    if (points === null) return { ready: false, message: "百分比要大於 0，最多到小數兩位。不想分的人請取消勾選。", convertedTotal: null, lines: [] };
    basisPoints[id] = points;
    pointsTotal += points;
  }
  if (pointsTotal !== PERCENT_BASIS_POINTS) {
    const shown = formatPercentInput(pointsTotal);
    const gap = PERCENT_BASIS_POINTS - pointsTotal;
    const hint = gap > 0 ? `還差 ${formatPercentInput(gap)}` : `多了 ${formatPercentInput(Math.abs(gap))}`;
    return { ready: false, message: `百分比現在是 ${shown}%。${hint} 個百分點才會到 100%。`, convertedTotal: null, lines: [] };
  }
  return finish(total, currency, defaultCurrency, fxRate, ids, { type: "percentage", basisPoints }, "依百分比分，零頭會分完。");
}

function previewShares(
  total: Minor,
  currency: string,
  defaultCurrency: string,
  fxRate: FxRateRatio | null,
  ids: readonly string[],
  weights: Readonly<Record<string, string>>,
): SplitPreview {
  const parsed: Record<string, number> = {};
  for (const id of ids) {
    const raw = (weights[id] ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) {
      return { ready: false, message: "份數要是正整數。不想分的人請取消勾選。", convertedTotal: null, lines: [] };
    }
    parsed[id] = Number(raw);
  }
  return finish(total, currency, defaultCurrency, fxRate, ids, { type: "shares", weights: parsed }, "依份數分，零頭會分完。");
}

function finish(
  total: Minor,
  currency: string,
  defaultCurrency: string,
  fxRate: FxRateRatio | null,
  ids: readonly string[],
  split: SplitSpec,
  message: string,
): SplitPreview {
  try {
    const result = allocateConvertedExpense({
      amount: total,
      fromCurrency: currency,
      toCurrency: defaultCurrency,
      fxNumerator: fxRate?.numerator ?? null,
      fxDenominator: fxRate?.denominator ?? null,
      participantIds: ids,
      split,
    });
    const got = sumMinor(result.convertedShares.map((share) => share.amount));
    if (toMinorUnits(got) !== toMinorUnits(result.convertedAmount)) {
      return { ready: false, message: "預覽的合計對不上。", convertedTotal: null, lines: [] };
    }
    const origMap = new Map(result.originalShares.map((share) => [share.participantId, formatMinor(share.amount)]));
    return {
      ready: true,
      message,
      convertedTotal: formatMinor(result.convertedAmount),
      lines: result.convertedShares.map((share) => ({
        participantId: share.participantId,
        amount: formatMinor(share.amount),
        originalAmount: origMap.get(share.participantId) ?? formatMinor(share.amount),
      })),
    };
  } catch {
    return { ready: false, message: "這組分法還不能預覽。", convertedTotal: null, lines: [] };
  }
}
