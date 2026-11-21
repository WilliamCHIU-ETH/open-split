import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { AuthProviderId } from "@open-split/auth";
import type { LedgerDb } from "../db/client.ts";
import { activityLog, attachments, expenseShares, expenses, groupMembers, groups } from "../db/schema.ts";
import { errorHasText, ServiceError } from "./errors.ts";
import { newId } from "./ids.ts";

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

export const DEFAULT_AUDIT: AuditContext = { via: "web" };

export type MemberRow = typeof groupMembers.$inferSelect;
export type ExpenseRow = typeof expenses.$inferSelect;
export type ShareRow = typeof expenseShares.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

export async function requireGroup(db: LedgerDb, groupId: string) {
  const groupRows = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  const group = groupRows[0];
  if (!group) throw new ServiceError(404, "not_found", "找不到這個群組。");
  return group;
}

export async function listMembers(db: LedgerDb, groupId: string): Promise<MemberRow[]> {
  return db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.createdAt), asc(groupMembers.id));
}

export async function requireMembership(db: LedgerDb, groupId: string, userId: string) {
  const group = await requireGroup(db, groupId);
  const members = await listMembers(db, groupId);
  const actor = members.find((member) => member.userId === userId);
  if (!actor) throw new ServiceError(403, "not_a_member", "你不是這個群組的成員。");
  return { group, members, actor };
}

export function toMember(row: {
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

export function blankToNull(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value;
}

export function activityInsert(
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

export function readActivityMeta(
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

export function isDuplicateMembership(error: unknown): boolean {
  return errorHasText(error, "UNIQUE constraint failed") && errorHasText(error, "group_members.user_id");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
