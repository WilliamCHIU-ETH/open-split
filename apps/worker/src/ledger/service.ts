import { and, asc, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  createDevGoogleProvider,
  createDevLineProvider,
  type AuthProviderId,
} from "@open-split/auth";
import {
  splitSchema,
  type ExpenseInput,
  type GroupDetail,
  type GroupSummary,
  type PaymentProfileWrite,
  type SettlementPreview,
  type SettlementView,
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
  type NetBalance,
  type Share,
  type SplitSpec,
} from "@open-split/core";
import type { LedgerDb } from "../db/client.ts";
import {
  activityLog,
  attachments,
  authIdentities,
  expenseShares,
  expenses,
  groupMembers,
  groups,
  inviteLinks,
  paymentProfiles,
  sessions,
  settlements,
  users,
} from "../db/schema.ts";
import {
  clearUnusedAttachmentLink,
  toAttachmentSummary,
  validateAttachmentsForExpense,
} from "./attachments.ts";
import { errorHasText, ServiceError } from "./errors.ts";
import { newId, newSecret, sha256Hex } from "./ids.ts";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  readonly userId: string;
  readonly displayName: string;
  readonly provider: AuthProviderId;
  readonly subject: string;
  readonly primaryEmail?: string | null;
}

export interface AuditContext {
  readonly via: "web" | "mcp";
  readonly clientId?: string;
}

const DEFAULT_AUDIT: AuditContext = { via: "web" };

type MemberRow = typeof groupMembers.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;
type ShareRow = typeof expenseShares.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;

export function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

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

export async function resolveGoogleUser(
  db: LedgerDb,
  claims: { readonly sub: string; readonly email: string; readonly name?: string },
): Promise<SessionUser> {
  const normalizedEmail = claims.email.trim().toLowerCase();
  const [identity] = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, "google"), eq(authIdentities.subject, claims.sub)))
    .limit(1);
  const now = new Date();
  if (identity) {
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
    if (!user) throw new ServiceError(500, "missing_user", "身份沒有對應的使用者。");
    if (user.primaryEmail !== normalizedEmail) {
      await db.update(users).set({ primaryEmail: normalizedEmail, updatedAt: now }).where(eq(users.id, user.id));
    }
    return {
      userId: user.id,
      displayName: user.displayName,
      provider: "google",
      subject: identity.subject,
      primaryEmail: normalizedEmail,
    };
  }

  const userId = newId("usr");
  const displayName = claims.name?.trim() || normalizedEmail.split("@")[0] || "Google 使用者";
  await db.batch([
    db.insert(users).values({
      id: userId,
      displayName,
      primaryEmail: normalizedEmail,
      mcpAllowed: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(authIdentities).values({
      id: newId("idn"),
      userId,
      provider: "google",
      subject: claims.sub,
      createdAt: now,
    }),
  ]);
  return {
    userId,
    displayName,
    provider: "google",
    subject: claims.sub,
    primaryEmail: normalizedEmail,
  };
}

export async function isUserMcpAuthorized(
  db: LedgerDb,
  allowedEmailsRaw: string | undefined,
  userId: string,
  emailHint?: string,
): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return false;
  if (user.mcpAllowed) return true;
  const email = (user.primaryEmail ?? emailHint)?.trim().toLowerCase();
  if (!email) return false;
  return parseAllowedEmails(allowedEmailsRaw).includes(email);
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
    primaryEmail: user.primaryEmail,
  };
}

export async function deleteSession(db: LedgerDb, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}

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

export async function addMember(
  db: LedgerDb,
  actor: SessionUser,
  input: { readonly groupId: string; readonly displayName: string; readonly virtual: boolean; readonly userId?: string },
  audit: AuditContext = DEFAULT_AUDIT,
) {
  const { members } = await requireMembership(db, input.groupId, actor.userId);
  if (input.virtual) {
    const now = new Date();
    const memberId = newId("mem");
    const token = newSecret();
    await db.batch([
      db.insert(groupMembers).values({
        id: memberId,
        groupId: input.groupId,
        displayName: input.displayName,
        userId: null,
        role: "member",
        claimTokenHash: await sha256Hex(token),
        claimedAt: null,
        createdAt: now,
      }),
      activityInsert(db, {
        groupId: input.groupId,
        actorUserId: actor.userId,
        action: "member.virtual_created",
        entityType: "member",
        entityId: memberId,
        summary: `建立虛擬成員「${input.displayName}」`,
        audit,
        createdAt: now,
      }),
    ]);
    return {
      ...toMember({
        id: memberId,
        groupId: input.groupId,
        displayName: input.displayName,
        userId: null,
        role: "member",
        claimedAt: null,
      }),
      claim: { claimPath: `/claim/${token}`, token },
    };
  }

  if (input.userId === undefined) {
    throw new ServiceError(422, "user_required", "已登入的成員需要 userId。還沒有帳號的人請設 virtual。");
  }
  const linked = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!linked[0]) throw new ServiceError(404, "not_found", "找不到要加入的使用者。請先讓對方在這台機器登入一次。");
  if (members.some((member) => member.userId === input.userId)) {
    throw new ServiceError(409, "already_member", "這個人已經在群組裡。");
  }
  const now = new Date();
  const memberId = newId("mem");
  const userId = input.userId;
  try {
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
        audit,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (isDuplicateMembership(error)) throw new ServiceError(409, "already_member", "這個人已經在群組裡。");
    throw error;
  }
  return {
    ...toMember({
      id: memberId,
      groupId: input.groupId,
      displayName: input.displayName,
      userId,
      role: "member",
      claimedAt: null,
    }),
    claim: null,
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

export async function createInvite(
  db: LedgerDb,
  actor: SessionUser,
  groupId: string,
  audit: AuditContext = DEFAULT_AUDIT,
) {
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
      audit,
      createdAt: now,
    }),
  ]);
  return { invitePath: `/invite/${token}`, token };
}

export async function previewInvite(db: LedgerDb, actor: SessionUser, token: string) {
  const invite = await requireInvite(db, token);
  const group = await requireGroup(db, invite.groupId);
  const members = await listMembers(db, invite.groupId);
  return {
    groupId: group.id,
    groupName: group.name,
    currency: group.defaultCurrency,
    alreadyMember: members.some((member) => member.userId === actor.userId),
  };
}

export async function acceptInvite(db: LedgerDb, actor: SessionUser, token: string) {
  const invite = await requireInvite(db, token);
  const members = await listMembers(db, invite.groupId);
  const existing = members.find((member) => member.userId === actor.userId);
  if (existing) return { groupId: invite.groupId, member: toMember(existing), alreadyMember: true };
  const now = new Date();
  const memberId = newId("mem");
  try {
    await db.batch([
      db.insert(groupMembers).values({
        id: memberId,
        groupId: invite.groupId,
        displayName: actor.displayName,
        userId: actor.userId,
        role: "member",
        claimTokenHash: null,
        claimedAt: null,
        createdAt: now,
      }),
      activityInsert(db, {
        groupId: invite.groupId,
        actorUserId: actor.userId,
        action: "member.joined",
        entityType: "member",
        entityId: memberId,
        summary: `用邀請連結加入，成為「${actor.displayName}」`,
        audit: DEFAULT_AUDIT,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (!isDuplicateMembership(error)) throw error;
    const winner = (await listMembers(db, invite.groupId)).find((member) => member.userId === actor.userId);
    if (!winner) throw new ServiceError(409, "already_member", "你已經是這個群組的成員。");
    return { groupId: invite.groupId, member: toMember(winner), alreadyMember: true };
  }
  return {
    groupId: invite.groupId,
    member: toMember({
      id: memberId,
      groupId: invite.groupId,
      displayName: actor.displayName,
      userId: actor.userId,
      role: "member",
      claimedAt: null,
    }),
    alreadyMember: false,
  };
}

export async function previewClaim(db: LedgerDb, actor: SessionUser, token: string) {
  const member = await findClaimMember(db, token);
  const group = await requireGroup(db, member.groupId);
  const members = await listMembers(db, member.groupId);
  const mine = members.find((row) => row.userId === actor.userId);
  let status: "open" | "yours" | "taken" | "already_member";
  if (member.userId === actor.userId) status = "yours";
  else if (member.userId !== null) status = "taken";
  else if (mine) status = "already_member";
  else status = "open";
  return {
    groupId: group.id,
    groupName: group.name,
    currency: group.defaultCurrency,
    memberId: member.id,
    displayName: member.displayName,
    status,
  };
}

export async function claimMember(db: LedgerDb, actor: SessionUser, token: string) {
  const member = await findClaimMember(db, token);
  if (member.userId !== null) {
    throw new ServiceError(409, "already_claimed", "這位成員已經被認領。");
  }
  const members = await listMembers(db, member.groupId);
  if (members.some((row) => row.userId === actor.userId)) {
    throw new ServiceError(409, "already_member", "你已經是這個群組的成員，不能再認領另一個位置。");
  }
  const now = new Date();
  try {
    await db
      .update(groupMembers)
      .set({ userId: actor.userId, claimedAt: now, claimTokenHash: null })
      .where(and(eq(groupMembers.id, member.id), isNull(groupMembers.userId)));
  } catch (error) {
    if (isDuplicateMembership(error)) {
      throw new ServiceError(409, "already_member", "你已經是這個群組的成員，不能再認領另一個位置。");
    }
    throw error;
  }
  const saved = await db.select().from(groupMembers).where(eq(groupMembers.id, member.id)).limit(1);
  const row = saved[0];
  if (!row || row.userId !== actor.userId) {
    throw new ServiceError(409, "claim_conflict", "這位成員剛剛被認領了。");
  }
  await db.batch([
    activityInsert(db, {
      groupId: member.groupId,
      actorUserId: actor.userId,
      action: "member.claimed",
      entityType: "member",
      entityId: member.id,
      summary: `認領了「${member.displayName}」。過去的份額仍掛在同一位成員。`,
      audit: DEFAULT_AUDIT,
      createdAt: now,
    }),
  ]);
  return { groupId: member.groupId, member: toMember(row) };
}

export async function rotateClaimLink(db: LedgerDb, actor: SessionUser, groupId: string, memberId: string) {
  await requireMembership(db, groupId, actor.userId);
  const rows = await db.select().from(groupMembers).where(eq(groupMembers.id, memberId)).limit(1);
  const member = rows[0];
  if (!member || member.groupId !== groupId) throw new ServiceError(404, "not_found", "找不到這位成員。");
  if (member.userId !== null) {
    throw new ServiceError(409, "already_claimed", "這位成員已經認領，不能再發認領連結。");
  }
  const token = newSecret();
  const now = new Date();
  await db.batch([
    db
      .update(groupMembers)
      .set({ claimTokenHash: await sha256Hex(token) })
      .where(and(eq(groupMembers.id, memberId), isNull(groupMembers.userId))),
    activityInsert(db, {
      groupId,
      actorUserId: actor.userId,
      action: "member.claim_link_rotated",
      entityType: "member",
      entityId: memberId,
      summary: `重新產生「${member.displayName}」的認領連結。舊連結失效。`,
      audit: DEFAULT_AUDIT,
      createdAt: now,
    }),
  ]);
  return { claimPath: `/claim/${token}`, token };
}

async function requireGroup(db: LedgerDb, groupId: string) {
  const groupRows = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  const group = groupRows[0];
  if (!group) throw new ServiceError(404, "not_found", "找不到這個群組。");
  return group;
}

async function listMembers(db: LedgerDb, groupId: string): Promise<MemberRow[]> {
  return db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.createdAt), asc(groupMembers.id));
}

async function requireMembership(db: LedgerDb, groupId: string, userId: string) {
  const group = await requireGroup(db, groupId);
  const members = await listMembers(db, groupId);
  const actor = members.find((member) => member.userId === userId);
  if (!actor) throw new ServiceError(403, "not_a_member", "你不是這個群組的成員。");
  return { group, members, actor };
}

async function requireInvite(db: LedgerDb, token: string) {
  const rows = await db
    .select()
    .from(inviteLinks)
    .where(eq(inviteLinks.tokenHash, await sha256Hex(token)))
    .limit(1);
  const invite = rows[0];
  if (!invite || invite.revokedAt) throw new ServiceError(404, "not_found", "這條邀請連結無效。");
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new ServiceError(404, "not_found", "這條邀請連結已經過期。");
  }
  return invite;
}

async function findClaimMember(db: LedgerDb, token: string): Promise<MemberRow> {
  const rows = await db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.claimTokenHash, await sha256Hex(token)))
    .limit(1);
  const member = rows[0];
  if (!member) throw new ServiceError(404, "not_found", "這條認領連結無效，或這位成員已經被認領。");
  return member;
}

async function loadExpense(db: LedgerDb, groupId: string, expenseId: string): Promise<ExpenseRow> {
  const rows = await db.select().from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  const row = rows[0];
  if (!row || row.groupId !== groupId) throw new ServiceError(404, "not_found", "找不到這筆支出。");
  return row;
}

async function loadLedger(db: LedgerDb, groupId: string) {
  const [expenseRows, shareRows, settlementRows, attachmentRows] = await db.batch([
    db.select().from(expenses).where(eq(expenses.groupId, groupId)).orderBy(asc(expenses.createdAt), asc(expenses.id)),
    db.select({
      expenseId: expenseShares.expenseId,
      memberId: expenseShares.memberId,
      amountMinor: expenseShares.amountMinor,
      originalAmountMinor: expenseShares.originalAmountMinor,
    })
      .from(expenseShares)
      .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
      .where(eq(expenses.groupId, groupId))
      .orderBy(asc(expenseShares.memberId)),
    db.select().from(settlements).where(eq(settlements.groupId, groupId))
      .orderBy(desc(settlements.createdAt), desc(settlements.id)),
    db.select().from(attachments)
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

function activeLedger({ expenseRows, shares, settlementRows }: Awaited<ReturnType<typeof loadLedger>>) {
  const activeExpenses = expenseRows.filter((row) => row.voidedAt === null).map((row) => {
    const parts = shares.get(row.id) ?? [];
    if (parts.length === 0) throw new ServiceError(500, "missing_shares", "這筆支出沒有份額。");
    return {
      payerId: row.payerMemberId,
      amount: minorFromSafeInteger(row.convertedAmountMinor ?? row.amountMinor),
      participantIds: parts.map((part) => part.memberId),
      split: {
        type: "exact" as const,
        amounts: Object.fromEntries(parts.map(({ memberId, amountMinor }) => [memberId, minorFromSafeInteger(amountMinor)])),
      },
      category: row.category,
    };
  });
  const transfers = settlementRows.filter((row) => row.voidedAt === null).map((row) => ({
    fromId: row.fromMemberId,
    toId: row.toMemberId,
    amount: minorFromSafeInteger(row.amountMinor),
  }));
  return { expenses: activeExpenses, transfers };
}

async function projectBalances(db: LedgerDb, groupId: string) {
  const { expenses, transfers } = activeLedger(await loadLedger(db, groupId));
  return computeBalances(expenses, transfers);
}

function wireBalances(nets: readonly NetBalance[]) {
  return nets.map(({ participantId, net }) => ({ participantId, net: formatMinor(net) }));
}

function toSettlementView(row: typeof settlements.$inferSelect): SettlementView {
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

function toMember(row: {
  readonly id: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly userId: string | null;
  readonly role: "owner" | "member";
  readonly claimedAt: Date | null;
}) {
  return {
    id: row.id,
    groupId: row.groupId,
    displayName: row.displayName,
    userId: row.userId,
    role: row.role,
    virtual: row.userId === null,
    claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
  };
}

function toExpenseView(
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

function readSplit(raw: string | null): SplitWire {
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
    readonly audit: AuditContext;
    readonly createdAt: Date;
    readonly shares?: readonly { readonly participantId: string; readonly amount: string }[];
    readonly payload?: Record<string, unknown>;
  },
  condition?: SQL,
  payloadJson: string | SQL = JSON.stringify({
    summary: input.summary,
    shares: input.shares ?? null,
    via: input.audit.via,
    ...(input.audit.clientId ? { clientId: input.audit.clientId } : {}),
    ...input.payload,
  }),
) {
  const values = {
    id: newId("act"),
    groupId: input.groupId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    payloadJson,
    createdAt: input.createdAt,
  };
  const insert = db.insert(activityLog);
  if (!condition) return insert.values(values);
  return insert.select(sql`select ${values.id}, ${values.groupId}, ${values.actorUserId}, ${values.action},
    ${values.entityType}, ${values.entityId}, ${payloadJson}, ${values.createdAt.getTime()} where ${condition}`);
}

function readActivityMeta(
  payloadJson: string,
  action: string,
): { readonly summary: string; readonly via: "web" | "mcp"; readonly clientId: string | null } {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (isRecord(parsed)) {
      const summary = typeof parsed.summary === "string" && parsed.summary.length > 0 ? parsed.summary : action;
      const via = parsed.via === "mcp" ? "mcp" : "web";
      const clientId = typeof parsed.clientId === "string" && parsed.clientId.length > 0 ? parsed.clientId : null;
      return { summary, via, clientId };
    }
  } catch {
    return { summary: action, via: "web", clientId: null };
  }
  return { summary: action, via: "web", clientId: null };
}

function isDuplicateMembership(error: unknown): boolean {
  return errorHasText(error, "UNIQUE constraint failed") && errorHasText(error, "group_members.user_id");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
