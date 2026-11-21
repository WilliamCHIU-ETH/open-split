import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import {
  parseUnsignedMinor,
  type GroupSummary,
  type PaymentProfileWrite,
  type SettlementPreview,
  type SettlementWrite,
} from "@open-split/contracts";
import {
  balancesSum,
  formatMinor,
  minorFromSafeInteger,
  minorToSafeInteger,
  simplifyDebts,
  summarizeLedger,
  transferBound,
  ZERO_MINOR,
} from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import { groupMembers, paymentProfiles, settlements } from "../db/schema.ts";
import {
  activityInsert,
  blankToNull,
  DEFAULT_AUDIT,
  requireMembership,
  type AuditContext,
  type SessionUser,
} from "./context.ts";
import { ServiceError } from "./errors.ts";
import { newId } from "./ids.ts";
import { activeLedger, loadLedger, projectBalances, wireBalances } from "./projection.ts";

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
    db
      .insert(paymentProfiles)
      .select(sql`select ${id}, ${memberId}, ${profile.label}, ${profile.details}, ${now.getTime()} where ${allowed}`)
      .onConflictDoUpdate({ target: paymentProfiles.memberId, set: profile })
      .returning({ id: paymentProfiles.id }),
    activityInsert(
      db,
      {
        groupId,
        actorUserId: actor.userId,
        action: "payment_profile.updated",
        entityType: "member",
        entityId: memberId,
        summary: "更新收款方式",
        audit,
        payload: { label: profile.label },
        createdAt: now,
      },
      allowed,
    ),
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

async function paymentProfilePermission(db: LedgerDb, actor: SessionUser, groupId: string, memberId: string) {
  const { members } = await requireMembership(db, groupId, actor.userId);
  const member = members.find((row) => row.id === memberId);
  if (!member) throw new ServiceError(404, "not_found", "找不到這個成員。");
  // Check the seat again in the write batch in case it was claimed after the membership lookup.
  return exists(
    db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(and(eq(groupMembers.id, member.id), or(eq(groupMembers.userId, actor.userId), isNull(groupMembers.userId)))),
  );
}

function paymentProfileForbidden() {
  return new ServiceError(403, "forbidden", "只能編輯自己或虛擬成員的收款方式。");
}
