import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { parseUnsignedMinor, type ExpenseInput, type SplitWire } from "@open-split/contracts";
import {
  allocateConvertedExpense,
  currencyExponent,
  formatMinor,
  minorFromSafeInteger,
  minorToSafeInteger,
  sumMinor,
  toMinorUnits,
  type Minor,
  type Share,
  type SplitSpec,
} from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import { attachments, expenseShares, expenses } from "../db/schema.ts";
import { clearUnusedAttachmentLink, validateAttachmentsForExpense } from "./attachments.ts";
import {
  activityInsert,
  blankToNull,
  DEFAULT_AUDIT,
  requireMembership,
  type AuditContext,
  type ExpenseRow,
  type MemberRow,
  type SessionUser,
} from "./context.ts";
import { ServiceError } from "./errors.ts";
import { newId } from "./ids.ts";

export async function addExpense(
  db: LedgerDb,
  actor: SessionUser,
  input: ExpenseInput,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { group, members, actor: actorMember } = await requireMembership(db, input.groupId, actor.userId);
  const draft = prepareExpense(group.defaultCurrency, members, input);
  const attachmentIds = input.attachmentIds ? [...new Set(input.attachmentIds)] : [];
  if (attachmentIds.length > 0) {
    await validateAttachmentsForExpense(db, input.groupId, null, attachmentIds);
  }
  const now = new Date();
  const expenseId = newId("exp");
  const category = blankToNull(input.category?.trim());
  const note = blankToNull(input.note);
  const splitJson = JSON.stringify(input.split);
  const shares = shareValues(expenseId, draft.convertedShares, draft.originalShares);
  const activity = {
    groupId: input.groupId,
    actorUserId: actor.userId,
    action: "expense.created",
    entityType: "expense",
    entityId: expenseId,
    summary: expenseSummary(`${actorMember.displayName} 記了一筆`, input, group.defaultCurrency, draft.convertedAmount),
    audit,
    createdAt: now,
    shares: wireShares(draft.convertedShares),
    payload: {
      originalAmount: formatMinor(draft.originalAmount),
      originalCurrency: input.currency,
      convertedAmount: formatMinor(draft.convertedAmount),
      convertedCurrency: group.defaultCurrency,
      ...(input.fxRate ? { fxRate: input.fxRate } : {}),
    },
  };

  if (attachmentIds.length === 0) {
    await db.batch([
      db.insert(expenses).values({
        id: expenseId,
        groupId: input.groupId,
        payerMemberId: input.payerId,
        amountMinor: minorToSafeInteger(draft.originalAmount),
        currency: input.currency,
        fxNumerator: input.fxRate?.numerator ?? null,
        fxDenominator: input.fxRate?.denominator ?? null,
        convertedAmountMinor: minorToSafeInteger(draft.convertedAmount),
        category,
        note,
        splitJson,
        voidedAt: null,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(expenseShares).values(shares),
      activityInsert(db, activity),
    ]);
  } else {
    const claimableCount = db
      .select({ count: sql<number>`count(*)` })
      .from(attachments)
      .where(
        and(
          eq(attachments.groupId, input.groupId),
          inArray(attachments.id, attachmentIds),
          isNull(attachments.expenseId),
          eq(attachments.status, "ready"),
          isNull(attachments.deletedAt),
        ),
      );
    const expenseExists = exists(db.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, expenseId)));
    const [inserted] = await db.batch([
      db
        .insert(expenses)
        .select(
          sql`select ${expenseId}, ${input.groupId}, ${input.payerId}, ${minorToSafeInteger(draft.originalAmount)}, ${input.currency}, ${input.fxRate?.numerator ?? null}, ${input.fxRate?.denominator ?? null}, ${minorToSafeInteger(draft.convertedAmount)}, ${category}, ${note}, ${splitJson}, ${null}, ${actor.userId}, ${now.getTime()}, ${now.getTime()} where (${claimableCount}) = ${attachmentIds.length}`,
        )
        .returning({ id: expenses.id }),
      insertSharesGuarded(db, shares, expenseExists),
      db
        .update(attachments)
        .set({ expenseId })
        .where(
          and(
            eq(attachments.groupId, input.groupId),
            inArray(attachments.id, attachmentIds),
            isNull(attachments.expenseId),
            eq(attachments.status, "ready"),
            isNull(attachments.deletedAt),
            expenseExists,
          ),
        ),
      activityInsert(db, activity, expenseExists),
    ]);
    if (inserted.length === 0) {
      throw new ServiceError(409, "attachment_in_use", "其中一份收據附檔已綁定或已刪除，請重新確認。");
    }
  }

  return {
    id: expenseId,
    shares: wireShares(draft.convertedShares),
    convertedAmount: formatMinor(draft.convertedAmount),
    convertedCurrency: group.defaultCurrency,
    originalShares: wireShares(draft.originalShares),
  };
}

export async function updateExpense(
  db: LedgerDb,
  actor: SessionUser,
  expenseId: string,
  input: ExpenseInput,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { group, members, actor: actorMember } = await requireMembership(db, input.groupId, actor.userId);
  const current = await loadExpense(db, input.groupId, expenseId);
  if (current.voidedAt) throw new ServiceError(409, "voided", "作廢的支出不能再改。");
  const draft = prepareExpense(group.defaultCurrency, members, input);
  const attachmentIds = input.attachmentIds !== undefined ? [...new Set(input.attachmentIds)] : undefined;
  if (attachmentIds && attachmentIds.length > 0) {
    await validateAttachmentsForExpense(db, input.groupId, expenseId, attachmentIds);
  }
  const now = new Date();
  const category = blankToNull(input.category?.trim());
  const shares = shareValues(expenseId, draft.convertedShares, draft.originalShares);
  const activeExpense = and(eq(expenses.id, expenseId), eq(expenses.groupId, input.groupId), isNull(expenses.voidedAt));
  const activeExists = exists(db.select({ id: expenses.id }).from(expenses).where(activeExpense));
  const attachmentsGuard =
    attachmentIds && attachmentIds.length > 0
      ? sql`(${db
          .select({ count: sql<number>`count(*)` })
          .from(attachments)
          .where(
            and(
              eq(attachments.groupId, input.groupId),
              inArray(attachments.id, attachmentIds),
              or(isNull(attachments.expenseId), eq(attachments.expenseId, expenseId)),
              eq(attachments.status, "ready"),
              isNull(attachments.deletedAt),
            ),
          )}) = ${attachmentIds.length}`
      : undefined;
  const batchGuard = attachmentsGuard ? sql`(${activeExists} and ${attachmentsGuard})` : activeExists;
  type BatchStatement = Parameters<LedgerDb["batch"]>[0][number];
  const restStatements: BatchStatement[] = [
    db.delete(expenseShares).where(and(eq(expenseShares.expenseId, expenseId), batchGuard)),
    insertSharesGuarded(db, shares, batchGuard),
    ...(attachmentIds !== undefined
      ? [
          clearUnusedAttachmentLink(db, input.groupId, expenseId, attachmentIds, batchGuard),
          ...(attachmentIds.length > 0
            ? [
                db
                  .update(attachments)
                  .set({ expenseId })
                  .where(
                    and(
                      eq(attachments.groupId, input.groupId),
                      inArray(attachments.id, attachmentIds),
                      or(isNull(attachments.expenseId), eq(attachments.expenseId, expenseId)),
                      eq(attachments.status, "ready"),
                      isNull(attachments.deletedAt),
                      batchGuard,
                    ),
                  ),
              ]
            : []),
        ]
      : []),
    activityInsert(
      db,
      {
        groupId: input.groupId,
        actorUserId: actor.userId,
        action: "expense.updated",
        entityType: "expense",
        entityId: expenseId,
        summary: expenseSummary(`${actorMember.displayName} 修改支出為`, input, group.defaultCurrency, draft.convertedAmount),
        audit,
        createdAt: now,
        shares: wireShares(draft.convertedShares),
        payload: {
          originalAmount: formatMinor(draft.originalAmount),
          originalCurrency: input.currency,
          convertedAmount: formatMinor(draft.convertedAmount),
          convertedCurrency: group.defaultCurrency,
          ...(input.fxRate ? { fxRate: input.fxRate } : {}),
        },
      },
      batchGuard,
    ),
  ];

  const [updated] = await db.batch([
    db
      .update(expenses)
      .set({
        payerMemberId: input.payerId,
        amountMinor: minorToSafeInteger(draft.originalAmount),
        currency: input.currency,
        fxNumerator: input.fxRate?.numerator ?? null,
        fxDenominator: input.fxRate?.denominator ?? null,
        convertedAmountMinor: minorToSafeInteger(draft.convertedAmount),
        category,
        note: blankToNull(input.note),
        splitJson: JSON.stringify(input.split),
        updatedAt: now,
      })
      .where(and(activeExpense, ...(attachmentsGuard ? [attachmentsGuard] : [])))
      .returning({ id: expenses.id }),
    ...restStatements,
  ]);
  if (updated.length === 0) {
    const [fresh] = await db
      .select({ voidedAt: expenses.voidedAt })
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.groupId, input.groupId)))
      .limit(1);
    if (!fresh) throw new ServiceError(404, "not_found", "找不到這筆支出。");
    if (fresh.voidedAt) throw new ServiceError(409, "voided", "作廢的支出不能再改。");
    throw new ServiceError(409, "attachment_in_use", "其中一份收據附檔已綁定或已刪除，請重新確認。");
  }
  return {
    id: expenseId,
    shares: wireShares(draft.convertedShares),
    convertedAmount: formatMinor(draft.convertedAmount),
    convertedCurrency: group.defaultCurrency,
    originalShares: wireShares(draft.originalShares),
  };
}

export async function voidExpense(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  expenseId: string,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { actor: actorMember } = await requireMembership(db, groupId, actor.userId);
  const current = await loadExpense(db, groupId, expenseId);
  if (current.voidedAt) throw new ServiceError(409, "already_voided", "這筆支出已經作廢。");
  const now = new Date();
  const amount = formatMinor(minorFromSafeInteger(current.amountMinor));
  const active = and(eq(expenses.id, expenseId), eq(expenses.groupId, groupId), isNull(expenses.voidedAt));
  const [, result] = await db.batch([
    activityInsert(
      db,
      {
        groupId,
        actorUserId: actor.userId,
        action: "expense.voided",
        entityType: "expense",
        entityId: expenseId,
        summary: `${actorMember.displayName} 作廢一筆 ${amount} ${current.currency} 的支出`,
        audit,
        createdAt: now,
      },
      exists(db.select({ id: expenses.id }).from(expenses).where(active)),
    ),
    db.update(expenses).set({ voidedAt: now, updatedAt: now }).where(active),
  ]);
  if (result.meta.changes === 0) throw new ServiceError(409, "already_voided", "這筆支出已經作廢。");
  return { id: expenseId, voided: true as const };
}

async function loadExpense(db: LedgerDb, groupId: string, expenseId: string): Promise<ExpenseRow> {
  const rows = await db.select().from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  const row = rows[0];
  if (!row || row.groupId !== groupId) throw new ServiceError(404, "not_found", "找不到這筆支出。");
  return row;
}

function prepareExpense(defaultCurrency: string, members: readonly MemberRow[], input: ExpenseInput) {
  currencyExponent(input.currency);
  currencyExponent(defaultCurrency);
  if (input.currency === defaultCurrency && input.fxRate !== undefined) {
    throw new ServiceError(422, "invalid_rate", "同幣別支出不能填寫匯率。");
  }
  if (input.currency !== defaultCurrency && input.fxRate === undefined) {
    throw new ServiceError(422, "invalid_rate", "外幣支出必須提供整數比值匯率 fxRate。");
  }

  const known = new Set(members.map((member) => member.id));
  if (!known.has(input.payerId)) throw new ServiceError(422, "unknown_member", "付款的人不是這個群組的成員。");
  for (const participantId of input.participantIds) {
    if (!known.has(participantId)) throw new ServiceError(422, "unknown_member", "參與者不是這個群組的成員。");
  }

  const originalAmount = parseUnsignedMinor(input.amount);
  const allocation = allocateConvertedExpense({
    amount: originalAmount,
    fromCurrency: input.currency,
    toCurrency: defaultCurrency,
    fxNumerator: input.fxRate?.numerator ?? null,
    fxDenominator: input.fxRate?.denominator ?? null,
    participantIds: input.participantIds,
    split: toCoreSplit(input.split),
  });
  const convertedTotal = sumMinor(allocation.convertedShares.map((share) => share.amount));
  if (toMinorUnits(convertedTotal) !== toMinorUnits(allocation.convertedAmount)) {
    throw new ServiceError(500, "shares_not_conserved", "換算後份額合計與支出金額不一致。");
  }
  if (input.currency !== defaultCurrency && toMinorUnits(allocation.convertedAmount) <= 0n) {
    throw new ServiceError(422, "fx_converted_zero", "外幣換算後的金額不得為 0，請調高金額或確認匯率。");
  }
  return allocation;
}

function shareValues(
  expenseId: string,
  convertedShares: readonly Share[],
  originalShares: readonly Share[],
) {
  const originalByMember = new Map(originalShares.map((s) => [s.participantId, s.amount]));
  return convertedShares.map((share) => {
    const orig = originalByMember.get(share.participantId) ?? share.amount;
    return {
      expenseId,
      memberId: share.participantId,
      amountMinor: minorToSafeInteger(share.amount),
      originalAmountMinor: minorToSafeInteger(orig),
    };
  });
}

function insertSharesGuarded(
  db: LedgerDb,
  rows: ReturnType<typeof shareValues>,
  condition: SQL,
) {
  const selects = sql.join(
    rows.map(
      (row) =>
        sql`select ${row.expenseId} as expense_id, ${row.memberId} as member_id, ${row.amountMinor} as amount_minor, ${row.originalAmountMinor} as original_amount_minor`,
    ),
    sql` union all `,
  );
  return db
    .insert(expenseShares)
    .select(sql`select expense_id, member_id, amount_minor, original_amount_minor from (${selects}) where ${condition}`);
}

function wireShares(shares: readonly Share[]) {
  return shares.map((share) => ({
    participantId: share.participantId,
    amount: formatMinor(share.amount),
  }));
}

function expenseSummary(verb: string, input: ExpenseInput, defaultCurrency: string, convertedAmount: Minor): string {
  const trimmedCategory = input.category?.trim();
  const category = trimmedCategory ? `，${trimmedCategory}` : "";
  const fxNote =
    input.currency !== defaultCurrency
      ? `（折合 ${formatMinor(convertedAmount)} ${defaultCurrency}）`
      : "";
  return `${verb} ${input.amount} ${input.currency}${fxNote}（${splitLabel(input.split.type)}）${category}`;
}

function splitLabel(type: SplitWire["type"]): string {
  if (type === "exact") return "指定金額";
  if (type === "percentage") return "百分比";
  if (type === "shares") return "份數";
  return "平均分";
}

function toCoreSplit(split: SplitWire): SplitSpec {
  if (split.type === "equal") return { type: "equal" };
  if (split.type === "percentage") return { type: "percentage", basisPoints: split.basisPoints };
  if (split.type === "shares") return { type: "shares", weights: split.weights };
  const amounts: Record<string, Minor> = {};
  for (const [id, value] of Object.entries(split.amounts)) amounts[id] = parseUnsignedMinor(value);
  return { type: "exact", amounts };
}
