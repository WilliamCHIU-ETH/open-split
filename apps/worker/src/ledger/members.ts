import { and, eq, isNull } from "drizzle-orm";
import type { LedgerDb } from "../db/client.ts";
import { groupMembers, inviteLinks, users } from "../db/schema.ts";
import {
  activityInsert,
  DEFAULT_AUDIT,
  isDuplicateMembership,
  listMembers,
  requireGroup,
  requireMembership,
  toMember,
  type AuditContext,
  type MemberRow,
  type SessionUser,
} from "./context.ts";
import { ServiceError } from "./errors.ts";
import { newId, newSecret, sha256Hex } from "./ids.ts";

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
