import { and, asc, desc, eq } from "drizzle-orm";
import {
  createDevGoogleProvider,
  createDevLineProvider,
  type AuthProviderId,
} from "@open-split/auth";
import {
  type ExpenseInput,
  parseUnsignedMinor,
} from "@open-split/contracts";
import {
  allocate,
  balancesSum,
  computeBalances,
  formatMinor,
  minorFromSafeInteger,
  minorToSafeInteger,
  sumMinor,
  toMinorUnits,
  type Minor,
} from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import {
  activityLog,
  authIdentities,
  expenseShares,
  expenses,
  groupMembers,
  groups,
  inviteLinks,
  sessions,
  users,
} from "../db/schema.ts";
import { ServiceError } from "./errors.ts";
import { newId, newSecret, sha256Hex } from "./ids.ts";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  readonly userId: string;
  readonly displayName: string;
  readonly provider: AuthProviderId;
  readonly subject: string;
}

type MemberRow = typeof groupMembers.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;
type ShareRow = typeof expenseShares.$inferSelect;

export async function devSignIn(
  db: LedgerDb,
  input: { readonly name: string; readonly provider: AuthProviderId },
): Promise<SessionUser & { readonly token: string }> {
  const provider = input.provider === "line" ? createDevLineProvider() : createDevGoogleProvider();
  let identity: ReturnType<typeof provider.signInAs>;
  try {
    identity = provider.signInAs(input.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法建立假身份。";
    throw new ServiceError(400, "invalid_identity", message);
  }

  const existing = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, identity.provider), eq(authIdentities.subject, identity.subject)))
    .limit(1);
  const found = existing[0];
  const now = new Date();
  let userId: string;
  let displayName: string;
  if (found) {
    userId = found.userId;
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user) throw new ServiceError(500, "missing_user", "身份沒有對應的使用者。");
    displayName = user.displayName;
  } else {
    userId = newId("usr");
    displayName = identity.displayName;
    await db.batch([
      db.insert(users).values({
        id: userId,
        displayName,
        primaryEmail: null,
        mcpAllowed: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(authIdentities).values({
        id: newId("idn"),
        userId,
        provider: identity.provider,
        subject: identity.subject,
        createdAt: now,
      }),
    ]);
  }

  const token = newSecret();
  await db.insert(sessions).values({
    id: newId("ses"),
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + SESSION_MS),
    createdAt: now,
  });

  return { token, userId, displayName, provider: identity.provider, subject: identity.subject };
}

export async function listDevUsers(db: LedgerDb): Promise<SessionUser[]> {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      provider: authIdentities.provider,
      subject: authIdentities.subject,
    })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .orderBy(asc(users.displayName), asc(authIdentities.subject));
  return rows;
}

export async function readSession(db: LedgerDb, token: string): Promise<SessionUser | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, await sha256Hex(token)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userRows[0];
  if (!user) return null;
  const identityRows = await db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.userId, user.id))
    .limit(1);
  const identity = identityRows[0];
  if (!identity) return null;
  return {
    userId: user.id,
    displayName: user.displayName,
    provider: identity.provider,
    subject: identity.subject,
  };
}

export async function deleteSession(db: LedgerDb, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}

export async function createGroup(
  db: LedgerDb,
  actor: SessionUser,
  input: { readonly name: string; readonly defaultCurrency: string },
) {
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

export async function getGroupDetail(db: LedgerDb, actor: SessionUser, groupId: string) {
  const { group, members } = await requireMembership(db, groupId, actor.userId);
  const expenseRows = await loadExpenses(db, groupId);
  const shares = await loadShares(db, groupId);
  return {
    group: { id: group.id, name: group.name, defaultCurrency: group.defaultCurrency },
    members: members.map(toMember),
    expenses: expenseRows.map((row) => toExpenseView(row, shares.get(row.id) ?? [])),
  };
}

export async function addMember(
  db: LedgerDb,
  actor: SessionUser,
  input: { readonly groupId: string; readonly displayName: string; readonly virtual: boolean; readonly userId?: string },
) {
  if (input.virtual || input.userId === undefined) {
    throw new ServiceError(422, "virtual_not_in_slice", "虛擬成員是切片 2。這次只能加入已經登入的人。");
  }
  const { members } = await requireMembership(db, input.groupId, actor.userId);
  const linked = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!linked[0]) throw new ServiceError(404, "not_found", "找不到要加入的使用者。請先讓對方在這台機器登入一次。");
  if (members.some((member) => member.userId === input.userId)) {
    throw new ServiceError(409, "already_member", "這個人已經在群組裡。");
  }
  const now = new Date();
  const memberId = newId("mem");
  const userId = input.userId;
  await db.batch([
    db.insert(groupMembers).values({
      id: memberId,
      groupId: input.groupId,
      displayName: input.displayName,
      userId,
      role: "member",
      claimTokenHash: null,
      claimedAt: null,
      createdAt: now,
    }),
    activityInsert(db, {
      groupId: input.groupId,
      actorUserId: actor.userId,
      action: "member.added",
      entityType: "member",
      entityId: memberId,
      summary: `加入成員「${input.displayName}」`,
      createdAt: now,
    }),
  ]);
  return toMember({
    id: memberId,
    groupId: input.groupId,
    displayName: input.displayName,
    userId,
    role: "member",
  });
}

export async function addExpense(db: LedgerDb, actor: SessionUser, input: ExpenseInput) {
  const { group, members } = await requireMembership(db, input.groupId, actor.userId);
  const draft = prepareExpense(group.defaultCurrency, members, input);
  const now = new Date();
  const expenseId = newId("exp");
  await db.batch([
    db.insert(expenses).values({
      id: expenseId,
      groupId: input.groupId,
      payerMemberId: input.payerId,
      amountMinor: minorToSafeInteger(draft.amount),
      currency: input.currency,
      fxNumerator: null,
      fxDenominator: null,
      category: blankToNull(input.category),
      note: blankToNull(input.note),
      voidedAt: null,
      createdByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(expenseShares).values(shareValues(expenseId, draft.shares)),
    activityInsert(db, {
      groupId: input.groupId,
      actorUserId: actor.userId,
      action: "expense.created",
      entityType: "expense",
      entityId: expenseId,
      summary: expenseSummary("記了一筆", input),
      createdAt: now,
      shares: wireShares(draft.shares),
    }),
  ]);
  return { id: expenseId, shares: wireShares(draft.shares) };
}

export async function updateExpense(
  db: LedgerDb,
  actor: SessionUser,
  expenseId: string,
  input: ExpenseInput,
) {
  const { group, members } = await requireMembership(db, input.groupId, actor.userId);
  const current = await loadExpense(db, input.groupId, expenseId);
  if (current.voidedAt) throw new ServiceError(409, "voided", "作廢的支出不能再改。");
  const draft = prepareExpense(group.defaultCurrency, members, input);
  const now = new Date();
  await db.batch([
    db.delete(expenseShares).where(eq(expenseShares.expenseId, expenseId)),
    db
      .update(expenses)
      .set({
        payerMemberId: input.payerId,
        amountMinor: minorToSafeInteger(draft.amount),
        currency: input.currency,
        category: blankToNull(input.category),
        note: blankToNull(input.note),
        updatedAt: now,
      })
      .where(eq(expenses.id, expenseId)),
    db.insert(expenseShares).values(shareValues(expenseId, draft.shares)),
    activityInsert(db, {
      groupId: input.groupId,
      actorUserId: actor.userId,
      action: "expense.updated",
      entityType: "expense",
      entityId: expenseId,
      summary: expenseSummary("修改支出為", input),
      createdAt: now,
      shares: wireShares(draft.shares),
    }),
  ]);
  return { id: expenseId, shares: wireShares(draft.shares) };
}

export async function voidExpense(db: LedgerDb, actor: SessionUser, groupId: string, expenseId: string) {
  await requireMembership(db, groupId, actor.userId);
  const current = await loadExpense(db, groupId, expenseId);
  if (current.voidedAt) throw new ServiceError(409, "already_voided", "這筆支出已經作廢。");
  const now = new Date();
  const amount = formatMinor(minorFromSafeInteger(current.amountMinor));
  await db.batch([
    db.update(expenses).set({ voidedAt: now, updatedAt: now }).where(eq(expenses.id, expenseId)),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "expense.voided",
      entityType: "expense",
      entityId: expenseId,
      summary: `作廢一筆 ${amount} ${current.currency} 的支出`,
      createdAt: now,
    }),
  ]);
  return { id: expenseId, voided: true as const };
}

export async function getBalances(db: LedgerDb, actor: SessionUser, groupId: string) {
  const { group } = await requireMembership(db, groupId, actor.userId);
  const nets = await projectBalances(db, groupId);
  return {
    groupId,
    currency: group.defaultCurrency,
    balances: nets.map((row) => ({ participantId: row.participantId, net: formatMinor(row.net) })),
    sum: formatMinor(balancesSum(nets)),
  };
}

export async function listActivity(db: LedgerDb, actor: SessionUser, groupId: string) {
  await requireMembership(db, groupId, actor.userId);
  const rows = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.groupId, groupId))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  return {
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
      summary: readSummary(row.payloadJson, row.action),
    })),
  };
}

export async function createInvite(db: LedgerDb, actor: SessionUser, groupId: string) {
  await requireMembership(db, groupId, actor.userId);
  const token = crypto.randomUUID();
  const now = new Date();
  const inviteId = newId("inv");
  await db.batch([
    db.insert(inviteLinks).values({
      id: inviteId,
      groupId,
      tokenHash: await sha256Hex(token),
      expiresAt: null,
      revokedAt: null,
      createdByUserId: actor.userId,
      createdAt: now,
    }),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "invite.created",
      entityType: "invite",
      entityId: inviteId,
      summary: "建立邀請連結",
      createdAt: now,
    }),
  ]);
  return { invitePath: `/invite/${token}`, token };
}

async function requireMembership(db: LedgerDb, groupId: string, userId: string) {
  const groupRows = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  const group = groupRows[0];
  if (!group) throw new ServiceError(404, "not_found", "找不到這個群組。");
  const members = await db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.createdAt), asc(groupMembers.id));
  const actor = members.find((member) => member.userId === userId);
  if (!actor) throw new ServiceError(403, "not_a_member", "你不是這個群組的成員。");
  return { group, members, actor };
}

async function loadExpense(db: LedgerDb, groupId: string, expenseId: string): Promise<ExpenseRow> {
  const rows = await db.select().from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  const row = rows[0];
  if (!row || row.groupId !== groupId) throw new ServiceError(404, "not_found", "找不到這筆支出。");
  return row;
}

async function loadExpenses(db: LedgerDb, groupId: string): Promise<ExpenseRow[]> {
  return db.select().from(expenses).where(eq(expenses.groupId, groupId)).orderBy(asc(expenses.createdAt), asc(expenses.id));
}

async function loadShares(db: LedgerDb, groupId: string): Promise<Map<string, ShareRow[]>> {
  const grouped = new Map<string, ShareRow[]>();
  const rows = await db
    .select({
      expenseId: expenseShares.expenseId,
      memberId: expenseShares.memberId,
      amountMinor: expenseShares.amountMinor,
    })
    .from(expenseShares)
    .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
    .where(eq(expenses.groupId, groupId));
  for (const row of rows) {
    const list = grouped.get(row.expenseId) ?? [];
    list.push(row);
    grouped.set(row.expenseId, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0));
  }
  return grouped;
}

async function projectBalances(db: LedgerDb, groupId: string) {
  const expenseRows = await loadExpenses(db, groupId);
  const active = expenseRows.filter((row) => row.voidedAt === null);
  const shares = await loadShares(db, groupId);
  return computeBalances(
    active.map((row) => ({
      payerId: row.payerMemberId,
      amount: minorFromSafeInteger(row.amountMinor),
      participantIds: (shares.get(row.id) ?? []).map((share) => share.memberId),
      split: { type: "equal" as const },
    })),
  );
}

function prepareExpense(defaultCurrency: string, members: readonly MemberRow[], input: ExpenseInput) {
  if (input.currency !== defaultCurrency) {
    throw new ServiceError(422, "currency_mismatch", "支出幣別必須和群組預設幣別相同。換匯是切片 4。");
  }
  if (input.split.type !== "equal") {
    throw new ServiceError(422, "split_not_in_slice", "指定金額、百分比與份數是切片 2。這次只接受平均分。");
  }
  const known = new Set(members.map((member) => member.id));
  if (!known.has(input.payerId)) throw new ServiceError(422, "unknown_member", "付款的人不是這個群組的成員。");
  for (const participantId of input.participantIds) {
    if (!known.has(participantId)) throw new ServiceError(422, "unknown_member", "參與者不是這個群組的成員。");
  }
  const amount = parseUnsignedMinor(input.amount);
  const shares = allocate({
    amount,
    participantIds: input.participantIds,
    split: { type: "equal" },
  });
  const total = sumMinor(shares.map((share) => share.amount));
  if (toMinorUnits(total) !== toMinorUnits(amount)) {
    throw new ServiceError(500, "shares_not_conserved", "份額合計與支出金額不一致。");
  }
  return { amount, shares };
}

function shareValues(expenseId: string, shares: readonly { readonly participantId: string; readonly amount: Minor }[]) {
  return shares.map((share) => ({
    expenseId,
    memberId: share.participantId,
    amountMinor: minorToSafeInteger(share.amount),
  }));
}

function wireShares(shares: readonly { readonly participantId: string; readonly amount: Minor }[]) {
  return shares.map((share) => ({
    participantId: share.participantId,
    amount: formatMinor(share.amount),
  }));
}

function toMember(row: {
  readonly id: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly userId: string | null;
  readonly role: "owner" | "member";
}) {
  return {
    id: row.id,
    groupId: row.groupId,
    displayName: row.displayName,
    userId: row.userId,
    role: row.role,
    virtual: row.userId === null,
  };
}

function toExpenseView(row: ExpenseRow, shares: readonly ShareRow[]) {
  return {
    id: row.id,
    payerId: row.payerMemberId,
    amount: formatMinor(minorFromSafeInteger(row.amountMinor)),
    currency: row.currency,
    participantIds: shares.map((share) => share.memberId),
    split: { type: "equal" as const },
    category: row.category,
    note: row.note,
    voided: row.voidedAt !== null,
    shares: shares.map((share) => ({
      participantId: share.memberId,
      amount: formatMinor(minorFromSafeInteger(share.amountMinor)),
    })),
  };
}

function expenseSummary(verb: string, input: ExpenseInput): string {
  const category = input.category ? `（${input.category}）` : "";
  return `${verb} ${input.amount} ${input.currency}${category}`;
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value;
}

function activityInsert(
  db: LedgerDb,
  input: {
    readonly groupId: string;
    readonly actorUserId: string;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly summary: string;
    readonly createdAt: Date;
    readonly shares?: readonly { readonly participantId: string; readonly amount: string }[];
  },
) {
  return db.insert(activityLog).values({
    id: newId("act"),
    groupId: input.groupId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    payloadJson: JSON.stringify({
      summary: input.summary,
      shares: input.shares ?? null,
    }),
    createdAt: input.createdAt,
  });
}

function readSummary(payloadJson: string, action: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (isRecord(parsed) && typeof parsed.summary === "string" && parsed.summary.length > 0) return parsed.summary;
  } catch {
    return action;
  }
  return action;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
