import {
  PERCENT_BASIS_POINTS,
  allocate,
  formatMinor,
  minor,
  subMinor,
  sumMinor,
  toMinorUnits,
  type Minor,
  type SplitSpec,
} from "@open-split/core";

const MINOR_TEXT = /^(0|[1-9][0-9]*)$/;

export type SplitMode = "equal" | "exact" | "percentage" | "shares";

export function readMinor(raw: string): Minor | null {
  const text = raw.trim();
  if (!MINOR_TEXT.test(text)) return null;
  return minor(BigInt(text));
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
  const shares = allocate({
    amount: minor(BigInt(PERCENT_BASIS_POINTS)),
    participantIds,
    split: { type: "equal" },
  });
  const record: Record<string, string> = {};
  for (const share of shares) {
    record[share.participantId] = formatPercentInput(Number(toMinorUnits(share.amount)));
  }
  return record;
}

/** What `targetId` must be so the exact amounts equal `totalText`. Null when the others are not integers yet. */
export function exactShareFor(
  totalText: string,
  participantIds: readonly string[],
  exact: Readonly<Record<string, string>>,
  targetId: string,
): string | null {
  const total = readMinor(totalText);
  if (!total || !participantIds.includes(targetId)) return null;
  const others: Minor[] = [];
  for (const id of participantIds) {
    if (id === targetId) continue;
    const raw = (exact[id] ?? "").trim();
    const units = raw.length === 0 ? minor(0n) : readMinor(raw);
    if (!units) return null;
    others.push(units);
  }
  const gap = subMinor(total, others.length === 0 ? minor(0n) : sumMinor(others));
  if (toMinorUnits(gap) < 0n) return null;
  return formatMinor(gap);
}

export interface PreviewLine {
  readonly participantId: string;
  readonly amount: string;
}

export interface SplitPreview {
  readonly ready: boolean;
  readonly message: string;
  readonly lines: readonly PreviewLine[];
}

export function previewSplit(input: {
  readonly amountText: string;
  readonly mode: SplitMode;
  readonly participantIds: readonly string[];
  readonly exact: Readonly<Record<string, string>>;
  readonly percent: Readonly<Record<string, string>>;
  readonly weights: Readonly<Record<string, string>>;
}): SplitPreview {
  if (input.participantIds.length === 0) {
    return { ready: false, message: "至少要有一個人分攤。", lines: [] };
  }
  const total = readMinor(input.amountText);
  if (!total) return { ready: false, message: "先填這筆帳的金額。金額是整數。", lines: [] };
  if (input.mode === "equal") return finish(total, input.participantIds, { type: "equal" }, "平均分，零頭會分完。");
  if (input.mode === "exact") return previewExact(total, input.participantIds, input.exact);
  if (input.mode === "percentage") return previewPercentage(total, input.participantIds, input.percent);
  return previewShares(total, input.participantIds, input.weights);
}

function previewExact(total: Minor, ids: readonly string[], exact: Readonly<Record<string, string>>): SplitPreview {
  const amounts: Record<string, Minor> = {};
  const parsed: Minor[] = [];
  for (const id of ids) {
    const raw = (exact[id] ?? "").trim();
    if (raw.length === 0) {
      return { ready: false, message: "每個人都要填指定金額。不想分的人請取消勾選。", lines: [] };
    }
    const units = readMinor(raw);
    if (!units) return { ready: false, message: "指定金額要是整數，不能有小數點。", lines: [] };
    amounts[id] = units;
    parsed.push(units);
  }
  const gap = subMinor(total, sumMinor(parsed));
  const gapUnits = toMinorUnits(gap);
  if (gapUnits !== 0n) {
    const text = gapUnits > 0n ? `還差 ${formatMinor(gap)}` : `多了 ${formatMinor(minor(-gapUnits))}`;
    return { ready: false, message: `指定金額的合計要剛好。${text}。`, lines: [] };
  }
  return finish(total, ids, { type: "exact", amounts }, "指定金額剛好。");
}

function previewPercentage(
  total: Minor,
  ids: readonly string[],
  percent: Readonly<Record<string, string>>,
): SplitPreview {
  const basisPoints: Record<string, number> = {};
  let pointsTotal = 0;
  for (const id of ids) {
    const raw = (percent[id] ?? "").trim();
    if (raw.length === 0) return { ready: false, message: "每個人都要填百分比。", lines: [] };
    const points = parsePercent(raw);
    if (points === null) return { ready: false, message: "百分比要大於 0，最多到小數兩位。不想分的人請取消勾選。", lines: [] };
    basisPoints[id] = points;
    pointsTotal += points;
  }
  if (pointsTotal !== PERCENT_BASIS_POINTS) {
    const shown = formatPercentInput(pointsTotal);
    const gap = PERCENT_BASIS_POINTS - pointsTotal;
    const hint = gap > 0 ? `還差 ${formatPercentInput(gap)}` : `多了 ${formatPercentInput(Math.abs(gap))}`;
    return { ready: false, message: `百分比現在是 ${shown}%。${hint} 個百分點才會到 100%。`, lines: [] };
  }
  return finish(total, ids, { type: "percentage", basisPoints }, "依百分比分，零頭會分完。");
}

function previewShares(total: Minor, ids: readonly string[], weights: Readonly<Record<string, string>>): SplitPreview {
  const parsed: Record<string, number> = {};
  for (const id of ids) {
    const raw = (weights[id] ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) {
      return { ready: false, message: "份數要是正整數。不想分的人請取消勾選。", lines: [] };
    }
    parsed[id] = Number(raw);
  }
  return finish(total, ids, { type: "shares", weights: parsed }, "依份數分，零頭會分完。");
}

function finish(total: Minor, ids: readonly string[], split: SplitSpec, message: string): SplitPreview {
  try {
    const shares = allocate({ amount: total, participantIds: ids, split });
    const got = sumMinor(shares.map((share) => share.amount));
    if (toMinorUnits(got) !== toMinorUnits(total)) {
      return { ready: false, message: "預覽的合計對不上。", lines: [] };
    }
    return {
      ready: true,
      message,
      lines: shares.map((share) => ({ participantId: share.participantId, amount: formatMinor(share.amount) })),
    };
  } catch {
    return { ready: false, message: "這組分法還不能預覽。", lines: [] };
  }
}
