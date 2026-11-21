import { desc, eq } from "drizzle-orm";
import type { GroupDetail } from "@open-split/contracts";
import { computeBalances, currencyExponent } from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import { activityLog, groupMembers, groups, paymentProfiles, users } from "../db/schema.ts";
import {
  activityInsert,
  DEFAULT_AUDIT,
  readActivityMeta,
  requireMembership,
  toMember,
  type AuditContext,
  type SessionUser,
} from "./context.ts";
import { newId } from "./ids.ts";
import { activeLedger, loadLedger, toExpenseView, toSettlementView, wireBalances } from "./projection.ts";

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
      toExpenseView(
        row,
        group.defaultCurrency,
        ledger.shares.get(row.id) ?? [],
        ledger.attachmentsByExpense.get(row.id) ?? [],
      ),
    ),
    settlements: ledger.settlementRows.map(toSettlementView),
    balances: wireBalances(computeBalances(active.expenses, active.transfers)),
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
