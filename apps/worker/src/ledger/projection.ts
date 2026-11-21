import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { splitSchema, type SettlementView, type SplitWire } from "@open-split/contracts";
import { computeBalances, formatMinor, minorFromSafeInteger, type NetBalance } from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import { attachments, expenseShares, expenses, settlements } from "../db/schema.ts";
import { toAttachmentSummary } from "./attachments.ts";
import type { AttachmentRow, ExpenseRow, ShareRow } from "./context.ts";
import { ServiceError } from "./errors.ts";

export async function loadLedger(db: LedgerDb, groupId: string) {
  const [expenseRows, shareRows, settlementRows, attachmentRows] = await db.batch([
    db.select().from(expenses).where(eq(expenses.groupId, groupId)).orderBy(asc(expenses.createdAt), asc(expenses.id)),
    db
      .select({
        expenseId: expenseShares.expenseId,
        memberId: expenseShares.memberId,
        amountMinor: expenseShares.amountMinor,
        originalAmountMinor: expenseShares.originalAmountMinor,
      })
      .from(expenseShares)
      .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
      .where(eq(expenses.groupId, groupId))
      .orderBy(asc(expenseShares.memberId)),
    db
      .select()
      .from(settlements)
      .where(eq(settlements.groupId, groupId))
      .orderBy(desc(settlements.createdAt), desc(settlements.id)),
    db
      .select()
      .from(attachments)
      .where(and(eq(attachments.groupId, groupId), eq(attachments.status, "ready"), isNull(attachments.deletedAt)))
      .orderBy(asc(attachments.createdAt), asc(attachments.id)),
  ]);
  const shares = new Map<string, ShareRow[]>();
  for (const row of shareRows) {
    const list = shares.get(row.expenseId) ?? [];
    list.push(row);
    shares.set(row.expenseId, list);
  }
  const attachmentsByExpense = new Map<string, AttachmentRow[]>();
  for (const row of attachmentRows) {
    if (!row.expenseId) continue;
    const list = attachmentsByExpense.get(row.expenseId) ?? [];
    list.push(row);
    attachmentsByExpense.set(row.expenseId, list);
  }
  return { expenseRows, shares, settlementRows, attachmentsByExpense };
}

export function activeLedger({ expenseRows, shares, settlementRows }: Awaited<ReturnType<typeof loadLedger>>) {
  const activeExpenses = expenseRows
    .filter((row) => row.voidedAt === null)
    .map((row) => {
      const parts = shares.get(row.id) ?? [];
      if (parts.length === 0) throw new ServiceError(500, "missing_shares", "這筆支出沒有份額。");
      return {
        payerId: row.payerMemberId,
        amount: minorFromSafeInteger(row.convertedAmountMinor ?? row.amountMinor),
        participantIds: parts.map((part) => part.memberId),
        split: {
          type: "exact" as const,
          amounts: Object.fromEntries(
            parts.map(({ memberId, amountMinor }) => [memberId, minorFromSafeInteger(amountMinor)]),
          ),
        },
        category: row.category,
      };
    });
  const transfers = settlementRows
    .filter((row) => row.voidedAt === null)
    .map((row) => ({
      fromId: row.fromMemberId,
      toId: row.toMemberId,
      amount: minorFromSafeInteger(row.amountMinor),
    }));
  return { expenses: activeExpenses, transfers };
}

export async function projectBalances(db: LedgerDb, groupId: string) {
  const { expenses: activeExpenses, transfers } = activeLedger(await loadLedger(db, groupId));
  return computeBalances(activeExpenses, transfers);
}

export function wireBalances(nets: readonly NetBalance[]) {
  return nets.map(({ participantId, net }) => ({ participantId, net: formatMinor(net) }));
}

export function toSettlementView(row: typeof settlements.$inferSelect): SettlementView {
  return {
    id: row.id,
    fromMemberId: row.fromMemberId,
    toMemberId: row.toMemberId,
    amount: formatMinor(minorFromSafeInteger(row.amountMinor)),
    currency: row.currency,
    note: row.note,
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
  };
}

export function toExpenseView(
  row: ExpenseRow,
  defaultCurrency: string,
  shares: readonly ShareRow[],
  attachmentRows: readonly AttachmentRow[],
) {
  const convertedMinor = minorFromSafeInteger(row.convertedAmountMinor ?? row.amountMinor);
  return {
    id: row.id,
    payerId: row.payerMemberId,
    amount: formatMinor(minorFromSafeInteger(row.amountMinor)),
    currency: row.currency,
    convertedAmount: formatMinor(convertedMinor),
    convertedCurrency: defaultCurrency,
    fxRate:
      row.fxNumerator !== null && row.fxDenominator !== null
        ? { numerator: row.fxNumerator, denominator: row.fxDenominator }
        : null,
    participantIds: shares.map((share) => share.memberId),
    split: readSplit(row.splitJson),
    category: row.category,
    note: row.note,
    voided: row.voidedAt !== null,
    shares: shares.map((share) => ({
      participantId: share.memberId,
      amount: formatMinor(minorFromSafeInteger(share.amountMinor)),
    })),
    originalShares: shares.map((share) => ({
      participantId: share.memberId,
      amount: formatMinor(minorFromSafeInteger(share.originalAmountMinor ?? share.amountMinor)),
    })),
    attachments: attachmentRows.map(toAttachmentSummary),
  };
}

export function readSplit(raw: string | null): SplitWire {
  if (raw === null || raw.length === 0) return { type: "equal" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ServiceError(500, "bad_split", "這筆支出的分法讀不出來。");
  }
  const result = splitSchema.safeParse(parsed);
  if (!result.success) throw new ServiceError(500, "bad_split", "這筆支出的分法讀不出來。");
  return result.data;
}
