import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  type ExpenseInput,
  type GroupDetail,
  type GroupSummary,
  type PaymentProfileWrite,
  type SettlementPreview,
  type SettlementWrite,
  type SplitWire,
  parseUnsignedMinor,
} from "@open-split/contracts";
import {
  allocateConvertedExpense,
  balancesSum,
  computeBalances,
  currencyExponent,
  formatMinor,
  minorFromSafeInteger,
  minorToSafeInteger,
  simplifyDebts,
  sumMinor,
  summarizeLedger,
  toMinorUnits,
  transferBound,
  ZERO_MINOR,
  type Minor,
  type Share,
  type SplitSpec,
} from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import {
  activityLog,
  attachments,
  expenseShares,
  expenses,
  groupMembers,
  groups,
  paymentProfiles,
  settlements,
  users,
} from "../db/schema.ts";
import { clearUnusedAttachmentLink, validateAttachmentsForExpense } from "./attachments.ts";
import {
  activityInsert,
  blankToNull,
  DEFAULT_AUDIT,
  readActivityMeta,
  requireMembership,
  toMember,
  type AuditContext,
  type ExpenseRow,
  type MemberRow,
  type SessionUser,
} from "./context.ts";
import { ServiceError } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  activeLedger,
  loadLedger,
  projectBalances,
  toExpenseView,
  toSettlementView,
  wireBalances,
} from "./projection.ts";

export type { AuditContext, SessionUser } from "./context.ts";
export {
  acceptInvite,
  addMember,
  claimMember,
  createInvite,
  previewClaim,
  previewInvite,
  rotateClaimLink,
} from "./members.ts";
export {
  deleteSession,
  devSignIn,
  isUserMcpAuthorized,
  listDevUsers,
  parseAllowedEmails,
  readSession,
  resolveGoogleUser,
} from "./sessions.ts";

export async function createGroup(
  db: LedgerDb,
  actor: SessionUser,
  input: { readonly name: string; readonly defaultCurrency: string },
  audit: AuditContext = DEFAULT_AUDIT,
) {
  currencyExponent(input.defaultCurrency);
  const now = new Date();
  const groupId = newId("grp");
  const memberId = newId("mem");
  await db.batch([
    db.insert(groups).values({
      id: groupId,
      name: input.name,
      defaultCurrency: input.defaultCurrency,
      createdByUserId: actor.userId,
      createdAt: now,
    }),
    db.insert(groupMembers).values({
      id: memberId,
      groupId,
      displayName: actor.displayName,
      userId: actor.userId,
      role: "owner",
      claimTokenHash: null,
      claimedAt: null,
      createdAt: now,
    }),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "group.created",
      entityType: "group",
      entityId: groupId,
      summary: `建立群組「${input.name}」`,
      audit,
      createdAt: now,
    }),
  ]);
  return { id: groupId, name: input.name, defaultCurrency: input.defaultCurrency, ownerMemberId: memberId };
}

export async function listGroups(db: LedgerDb, actor: SessionUser) {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      defaultCurrency: groups.defaultCurrency,
    })
    .from(groups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, actor.userId))
    .orderBy(desc(groups.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    defaultCurrency: row.defaultCurrency,
  }));
}

export async function getGroupDetail(db: LedgerDb, actor: SessionUser, groupId: string): Promise<GroupDetail> {
  const { group, members } = await requireMembership(db, groupId, actor.userId);
  const ledger = await loadLedger(db, groupId);
  const profiles = await db
    .select({ memberId: paymentProfiles.memberId, label: paymentProfiles.label, details: paymentProfiles.details })
    .from(paymentProfiles)
    .innerJoin(groupMembers, eq(paymentProfiles.memberId, groupMembers.id))
    .where(eq(groupMembers.groupId, groupId));
  const profilesByMember = new Map(profiles.map(({ memberId, label, details }) => [memberId, { label, details }]));
  const active = activeLedger(ledger);
  return {
    group: { id: group.id, name: group.name, defaultCurrency: group.defaultCurrency },
    members: members.map((row) => ({ ...toMember(row), paymentProfile: profilesByMember.get(row.id) ?? null })),
    expenses: ledger.expenseRows.map((row) =>
      toExpenseView(row, group.defaultCurrency, ledger.shares.get(row.id) ?? [], ledger.attachmentsByExpense.get(row.id) ?? []),
    ),
    settlements: ledger.settlementRows.map(toSettlementView),
    balances: wireBalances(computeBalances(active.expenses, active.transfers)),
  };
}

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

export async function getBalances(db: LedgerDb, actor: SessionUser, groupId: string) {
  const { group } = await requireMembership(db, groupId, actor.userId);
  const nets = await projectBalances(db, groupId);
  return {
    groupId,
    currency: group.defaultCurrency,
    balances: wireBalances(nets),
    sum: formatMinor(balancesSum(nets)),
  };
}

export async function getSettlementPlan(db: LedgerDb, actor: SessionUser, groupId: string): Promise<SettlementPreview> {
  const { group } = await requireMembership(db, groupId, actor.userId);
  const nets = await projectBalances(db, groupId);
  return {
    currency: group.defaultCurrency,
    transfers: simplifyDebts(nets).map(({ fromId, toId, amount }) => ({ fromId, toId, amount: formatMinor(amount) })),
    participantCount: nets.length,
    transferBound: transferBound(nets.length),
  };
}

export async function recordSettlement(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  input: SettlementWrite,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { group, members, actor: actorMember } = await requireMembership(db, groupId, actor.userId);
  if (input.currency !== group.defaultCurrency) {
    throw new ServiceError(422, "currency_mismatch", "結清幣別必須和群組預設幣別相同。");
  }
  const byId = new Map(members.map((member) => [member.id, member]));
  const fromMember = byId.get(input.fromMemberId);
  const toMember = byId.get(input.toMemberId);
  if (!fromMember || !toMember) {
    throw new ServiceError(422, "unknown_member", "付款人與收款人都必須是這個群組的成員。");
  }

  const id = newId("stl");
  const now = new Date();
  const note = blankToNull(input.note);
  await db.batch([
    db.insert(settlements).values({
      id,
      groupId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amountMinor: minorToSafeInteger(parseUnsignedMinor(input.amount)),
      currency: input.currency,
      note,
      createdByUserId: actor.userId,
      createdAt: now,
    }),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "settlement.recorded",
      entityType: "settlement",
      entityId: id,
      summary: `${actorMember.displayName} 記錄一筆結清：${fromMember.displayName} 付給 ${toMember.displayName} ${input.amount} ${input.currency}`,
      audit,
      payload: { ...input, note, actorMemberId: actorMember.id, actorDisplayName: actorMember.displayName },
      createdAt: now,
    }),
  ]);
  return { id };
}

export async function voidSettlement(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  settlementId: string,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { actor: actorMember } = await requireMembership(db, groupId, actor.userId);
  const target = and(eq(settlements.id, settlementId), eq(settlements.groupId, groupId));
  const [current] = await db.select().from(settlements).where(target).limit(1);
  if (!current) throw new ServiceError(404, "not_found", "找不到這筆結清。");

  const now = new Date();
  const active = and(target, isNull(settlements.voidedAt));
  const amount = formatMinor(minorFromSafeInteger(current.amountMinor));
  const summary = `${actorMember.displayName} 作廢一筆 ${amount} ${current.currency} 的結清`;
  // Both statements use the same active-row condition so retries cannot duplicate the audit entry.
  const [, result] = await db.batch([
    activityInsert(
      db,
      {
        groupId,
        actorUserId: actor.userId,
        action: "settlement.voided",
        entityType: "settlement",
        entityId: settlementId,
        summary,
        audit,
        createdAt: now,
      },
      exists(db.select({ id: settlements.id }).from(settlements).where(active)),
    ),
    db.update(settlements).set({ voidedAt: now }).where(active),
  ]);
  if (result.meta.changes === 0) throw new ServiceError(409, "already_voided", "這筆結清已經作廢。");
  return { id: settlementId, voided: true as const };
}

export async function updatePaymentProfile(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  memberId: string,
  profile: PaymentProfileWrite,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const allowed = await paymentProfilePermission(db, actor, groupId, memberId);
  const id = newId("pay");
  const now = new Date();
  const [rows] = await db.batch([
    db.insert(paymentProfiles)
      .select(sql`select ${id}, ${memberId}, ${profile.label}, ${profile.details}, ${now.getTime()} where ${allowed}`)
      .onConflictDoUpdate({ target: paymentProfiles.memberId, set: profile })
      .returning({ id: paymentProfiles.id }),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "payment_profile.updated",
      entityType: "member",
      entityId: memberId,
      summary: "更新收款方式",
      audit,
      payload: { label: profile.label },
      createdAt: now,
    }, allowed),
  ]);
  const row = rows[0];
  if (!row) throw paymentProfileForbidden();
  return row;
}

export async function clearPaymentProfile(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  memberId: string,
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const allowed = await paymentProfilePermission(db, actor, groupId, memberId);
  const target = eq(paymentProfiles.memberId, memberId);
  const label = db.select({ label: paymentProfiles.label }).from(paymentProfiles).where(target);
  const summary = "清除收款方式";
  const now = new Date();
  const clientExpr = audit.clientId ? audit.clientId : null;
  const [permission] = await db.batch([
    db.select({ id: groupMembers.id }).from(groupMembers).where(and(eq(groupMembers.id, memberId), allowed)),
    activityInsert(
      db,
      {
        groupId,
        actorUserId: actor.userId,
        action: "payment_profile.cleared",
        entityType: "member",
        entityId: memberId,
        summary,
        audit,
        createdAt: now,
      },
      and(allowed, exists(db.select({ id: paymentProfiles.id }).from(paymentProfiles).where(target))),
      sql`json_object('summary', ${summary}, 'label', (${label}), 'via', ${audit.via}, 'clientId', ${clientExpr})`,
    ),
    db.delete(paymentProfiles).where(and(target, allowed)),
  ]);
  if (permission.length === 0) throw paymentProfileForbidden();
  return { ok: true as const };
}

async function paymentProfilePermission(db: LedgerDb, actor: SessionUser, groupId: string, memberId: string) {
  const { members } = await requireMembership(db, groupId, actor.userId);
  const member = members.find((row) => row.id === memberId);
  if (!member) throw new ServiceError(404, "not_found", "找不到這個成員。");
  // Check the seat again in the write batch in case it was claimed after the membership lookup.
  return exists(db.select({ id: groupMembers.id }).from(groupMembers).where(and(
    eq(groupMembers.id, member.id),
    or(eq(groupMembers.userId, actor.userId), isNull(groupMembers.userId)),
  )));
}

function paymentProfileForbidden() {
  return new ServiceError(403, "forbidden", "只能編輯自己或虛擬成員的收款方式。");
}

export async function getGroupSummary(db: LedgerDb, actor: SessionUser, groupId: string): Promise<GroupSummary> {
  const { group, members } = await requireMembership(db, groupId, actor.userId);
  const ledger = await loadLedger(db, groupId);
  const { expenses, transfers } = activeLedger(ledger);
  const summary = summarizeLedger({ expenses, settlements: transfers });
  const memberTotals = new Map(summary.members.map((row) => [row.participantId, row]));
  return {
    currency: group.defaultCurrency,
    members: members.map(({ id }) => {
      const totals = memberTotals.get(id);
      return {
        memberId: id,
        paid: formatMinor(totals?.paid ?? ZERO_MINOR),
        share: formatMinor(totals?.share ?? ZERO_MINOR),
        settledPaid: formatMinor(totals?.settledPaid ?? ZERO_MINOR),
        settledReceived: formatMinor(totals?.settledReceived ?? ZERO_MINOR),
        net: formatMinor(totals?.net ?? ZERO_MINOR),
      };
    }),
    categories: summary.categories.map((row) => ({ ...row, total: formatMinor(row.total) })),
    totalSpent: formatMinor(summary.totalSpent),
  };
}

export async function listActivity(db: LedgerDb, actor: SessionUser, groupId: string) {
  await requireMembership(db, groupId, actor.userId);
  const rows = await db
    .select({
      id: activityLog.id,
      action: activityLog.action,
      entityId: activityLog.entityId,
      payloadJson: activityLog.payloadJson,
      createdAt: activityLog.createdAt,
      actorDisplayName: users.displayName,
    })
    .from(activityLog)
    .leftJoin(users, eq(activityLog.actorUserId, users.id))
    .where(eq(activityLog.groupId, groupId))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  return {
    entries: rows.map((row) => {
      const meta = readActivityMeta(row.payloadJson, row.action);
      return {
        id: row.id,
        action: row.action,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        summary: meta.summary,
        actorDisplayName: row.actorDisplayName ?? null,
        via: meta.via,
        clientId: meta.clientId,
      };
    }),
  };
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
