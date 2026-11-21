import { and, asc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_EXPENSE,
  GROUP_ATTACHMENT_QUOTA_BYTES,
  type AttachmentMimeType,
  type AttachmentSummary,
  type AttachmentUploadIntentInput,
  type AttachmentUploadIntentResult,
} from "@open-split/contracts";
import type { LedgerDb } from "../db/client.ts";
import { activityLog, attachments, expenses, groupMembers, groups } from "../db/schema.ts";
import { ServiceError } from "./errors.ts";
import { newId, newSecret, sha256Hex, sha256HexBytes } from "./ids.ts";

const UPLOAD_TTL_MS = 15 * 60 * 1000;
const STALE_ATTACHMENT_MS = 24 * 60 * 60 * 1000;

export interface AttachmentActor {
  readonly userId: string;
}

export interface AttachmentAudit {
  readonly via: "web" | "mcp";
  readonly clientId?: string;
}

export function detectReceiptMimeType(bytes: Uint8Array): AttachmentMimeType | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WEBP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // PDF: %PDF-
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return null;
}

export function toAttachmentSummary(row: typeof attachments.$inferSelect): AttachmentSummary {
  return {
    id: row.id,
    groupId: row.groupId,
    expenseId: row.expenseId,
    filename: row.filename,
    mimeType: row.mimeType as AttachmentMimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    downloadPath: `/api/groups/${row.groupId}/attachments/${row.id}`,
  };
}

export async function cleanupStalePendingAttachments(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  groupId: string,
): Promise<void> {
  if (!bucket) return;
  const cutoff = new Date(Date.now() - STALE_ATTACHMENT_MS);
  const stale = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.groupId, groupId),
        isNull(attachments.deletedAt),
        lt(attachments.createdAt, cutoff),
        or(eq(attachments.status, "pending"), and(eq(attachments.status, "ready"), isNull(attachments.expenseId))),
      ),
    )
    .limit(20);
  if (stale.length === 0) return;
  const now = new Date();
  const cleanedIds: string[] = [];
  for (const row of stale) {
    try {
      await bucket.delete(row.r2Key);
      cleanedIds.push(row.id);
    } catch {
      // Retry on the next cleanup sweep if R2 deletion fails.
    }
  }
  if (cleanedIds.length === 0) return;
  await db
    .update(attachments)
    .set({ deletedAt: now, uploadTokenHash: null, expenseId: null })
    .where(inArray(attachments.id, cleanedIds));
}

export async function createAttachmentUploadIntent(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  actor: AttachmentActor,
  input: AttachmentUploadIntentInput,
): Promise<AttachmentUploadIntentResult> {
  if (!bucket) {
    throw new ServiceError(500, "r2_not_configured", "尚未設定收據儲存空間。");
  }
  await requireGroupMember(db, input.groupId, actor.userId);
  await cleanupStalePendingAttachments(db, bucket, input.groupId);

  const id = newId("att");
  const r2Key = `groups/${input.groupId}/receipts/${id}`;
  const uploadToken = newSecret();
  const uploadTokenHash = await sha256Hex(uploadToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
  const expenseIdValue = input.expenseId ?? null;

  const quotaGuard = sql`(select coalesce(sum(${attachments.byteSize}), 0) from ${attachments} where ${attachments.groupId} = ${input.groupId} and ${attachments.deletedAt} is null) + ${input.byteSize} <= ${GROUP_ATTACHMENT_QUOTA_BYTES}`;
  const insertCondition = input.expenseId
    ? and(
        quotaGuard,
        sql`exists (select 1 from ${expenses} where ${expenses.id} = ${input.expenseId} and ${expenses.groupId} = ${input.groupId} and ${expenses.voidedAt} is null)`,
        sql`(select count(*) from ${attachments} where ${attachments.groupId} = ${input.groupId} and ${attachments.expenseId} = ${input.expenseId} and ${attachments.deletedAt} is null) < ${ATTACHMENT_MAX_PER_EXPENSE}`,
      )
    : quotaGuard;

  const inserted = await db
    .insert(attachments)
    .select(
      sql`select ${id}, ${input.groupId}, ${expenseIdValue}, ${r2Key}, ${input.filename}, ${input.mimeType}, ${input.byteSize}, ${input.sha256}, ${"pending"}, ${uploadTokenHash}, ${expiresAt.getTime()}, ${null}, ${actor.userId}, ${now.getTime()} where ${insertCondition}`,
    )
    .returning();

  const row = inserted[0];
  if (!row) {
    if (input.expenseId) {
      const [expense] = await db
        .select({ voidedAt: expenses.voidedAt })
        .from(expenses)
        .where(and(eq(expenses.id, input.expenseId), eq(expenses.groupId, input.groupId)))
        .limit(1);
      if (!expense) throw new ServiceError(404, "not_found", "找不到這筆支出。");
      if (expense.voidedAt) throw new ServiceError(409, "voided", "作廢的支出不能再附加收據。");

      const existingForExpense = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            eq(attachments.groupId, input.groupId),
            eq(attachments.expenseId, input.expenseId),
            isNull(attachments.deletedAt),
          ),
        );
      if (existingForExpense.length >= ATTACHMENT_MAX_PER_EXPENSE) {
        throw new ServiceError(422, "attachment_limit", `每筆支出最多只能附加 ${String(ATTACHMENT_MAX_PER_EXPENSE)} 份檔案。`);
      }
    }
    throw new ServiceError(422, "group_quota_exceeded", "這個群組的收據儲存配額已滿（上限 100 MiB）。");
  }

  return {
    attachment: toAttachmentSummary(row),
    uploadPath: `/api/groups/${input.groupId}/attachments/${id}/content`,
    uploadMethod: "PUT",
    uploadHeaders: {
      "content-type": input.mimeType,
      "x-upload-token": uploadToken,
    },
    expiresAt: expiresAt.toISOString(),
  };
}

export async function authorizeAttachmentUpload(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  params: {
    readonly groupId: string;
    readonly attachmentId: string;
    readonly uploadToken: string | null;
    readonly actor: AttachmentActor | null;
    readonly contentType: string | null;
    readonly contentLengthHeader?: string | null;
  },
): Promise<typeof attachments.$inferSelect> {
  if (!bucket) {
    throw new ServiceError(500, "r2_not_configured", "尚未設定收據儲存空間。");
  }
  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, params.attachmentId), eq(attachments.groupId, params.groupId)))
    .limit(1);
  if (!row || row.deletedAt) throw new ServiceError(404, "not_found", "找不到這份附檔。");

  if (params.uploadToken) {
    const presentedHash = await sha256Hex(params.uploadToken);
    if (!row.uploadTokenHash || !constantTimeEqual(presentedHash, row.uploadTokenHash)) {
      throw new ServiceError(403, "invalid_upload_token", "上傳憑證無效或已使用。");
    }
    if (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() <= Date.now()) {
      throw new ServiceError(403, "upload_token_expired", "上傳憑證已過期。");
    }
  } else if (params.actor) {
    await requireGroupMember(db, params.groupId, params.actor.userId);
    if (row.createdByUserId !== params.actor.userId) {
      throw new ServiceError(403, "forbidden", "只有建立上傳的人可以上傳這個檔案。");
    }
  } else {
    throw new ServiceError(401, "unauthenticated", "缺少上傳憑證或登入階段。");
  }

  if (row.status !== "pending") {
    throw new ServiceError(409, "already_uploaded", "這個附檔已經上傳完成。");
  }
  if (params.contentType && params.contentType.split(";")[0]?.trim().toLowerCase() !== row.mimeType) {
    throw new ServiceError(415, "unsupported_media_type", "Content-Type 與宣告的檔案型別不一致。");
  }
  if (params.contentLengthHeader !== undefined && params.contentLengthHeader !== null) {
    if (!/^\d+$/.test(params.contentLengthHeader) || Number(params.contentLengthHeader) > ATTACHMENT_MAX_BYTES) {
      throw new ServiceError(413, "payload_too_large", "檔案大小超出限制（0 < size <= 10 MiB）。");
    }
    if (Number(params.contentLengthHeader) !== row.byteSize) {
      throw new ServiceError(422, "size_mismatch", "上傳位元組大小與宣告不符。");
    }
  }
  return row;
}

export async function uploadAttachmentBinary(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  params: {
    readonly groupId: string;
    readonly attachmentId: string;
    readonly uploadToken: string | null;
    readonly actor: AttachmentActor | null;
    readonly body: Uint8Array;
    readonly contentType: string | null;
    readonly authorizedRow?: typeof attachments.$inferSelect;
    readonly audit?: AttachmentAudit;
  },
): Promise<AttachmentSummary> {
  if (!bucket) {
    throw new ServiceError(500, "r2_not_configured", "尚未設定收據儲存空間。");
  }
  const row =
    params.authorizedRow ??
    (await authorizeAttachmentUpload(db, bucket, {
      groupId: params.groupId,
      attachmentId: params.attachmentId,
      uploadToken: params.uploadToken,
      actor: params.actor,
      contentType: params.contentType,
    }));

  if (params.body.byteLength === 0 || params.body.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new ServiceError(413, "payload_too_large", "檔案大小超出限制（0 < size <= 10 MiB）。");
  }
  if (params.body.byteLength !== row.byteSize) {
    throw new ServiceError(422, "size_mismatch", "上傳位元組大小與宣告不符。");
  }
  const detected = detectReceiptMimeType(params.body);
  if (!detected || detected !== row.mimeType) {
    throw new ServiceError(415, "invalid_file_magic", "檔案內容格式不符或是不支援的危險格式。");
  }
  const digest = await sha256HexBytes(params.body);
  if (digest !== row.sha256) {
    throw new ServiceError(422, "sha256_mismatch", "檔案 SHA-256 雜湊值與宣告不符。");
  }

  await bucket.put(row.r2Key, params.body, {
    httpMetadata: { contentType: row.mimeType },
    customMetadata: { groupId: row.groupId, attachmentId: row.id, sha256: digest },
  });

  const now = new Date();
  const actorUserId = params.actor?.userId ?? row.createdByUserId;
  const via = params.audit?.via ?? (params.actor ? "web" : "mcp");
  const isStillPending = sql`exists (select 1 from ${attachments} where ${attachments.id} = ${row.id} and ${attachments.status} = ${"pending"} and ${attachments.deletedAt} is null)`;
  const [, updated] = await db.batch([
    db
      .insert(activityLog)
      .select(
        sql`select ${newId("act")}, ${row.groupId}, ${actorUserId}, ${"attachment.uploaded"}, ${"attachment"}, ${row.id}, ${JSON.stringify({
          summary: `上傳收據附檔「${row.filename}」`,
          filename: row.filename,
          via,
          ...(params.audit?.clientId ? { clientId: params.audit.clientId } : {}),
        })}, ${now.getTime()} where ${isStillPending}`,
      ),
    db
      .update(attachments)
      .set({ status: "ready", uploadTokenHash: null })
      .where(and(eq(attachments.id, row.id), eq(attachments.status, "pending"), isNull(attachments.deletedAt)))
      .returning(),
  ]);
  if (!updated[0]) {
    const [latest] = await db
      .select({ status: attachments.status, deletedAt: attachments.deletedAt })
      .from(attachments)
      .where(eq(attachments.id, row.id))
      .limit(1);
    if (!latest || latest.deletedAt !== null) {
      try {
        await bucket.delete(row.r2Key);
      } catch {
        // Ignore cleanup failure for concurrently deleted attachment.
      }
      throw new ServiceError(409, "attachment_deleted", "這份附檔在上傳期間已被刪除。");
    }
    throw new ServiceError(409, "already_uploaded", "這個附檔已經完成上傳。");
  }
  return toAttachmentSummary(updated[0]);
}

export async function listGroupAttachments(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  actor: AttachmentActor,
  groupId: string,
  expenseId?: string,
): Promise<{ readonly attachments: AttachmentSummary[] }> {
  await requireGroupMember(db, groupId, actor.userId);
  await cleanupStalePendingAttachments(db, bucket, groupId);
  const rows = await db
    .select()
    .from(attachments)
    .where(
      expenseId
        ? and(
            eq(attachments.groupId, groupId),
            eq(attachments.expenseId, expenseId),
            eq(attachments.status, "ready"),
            isNull(attachments.deletedAt),
          )
        : and(eq(attachments.groupId, groupId), eq(attachments.status, "ready"), isNull(attachments.deletedAt)),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return { attachments: rows.map(toAttachmentSummary) };
}

export async function downloadAttachmentObject(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  actor: AttachmentActor,
  groupId: string,
  attachmentId: string,
) {
  if (!bucket) {
    throw new ServiceError(500, "r2_not_configured", "尚未設定收據儲存空間。");
  }
  await requireGroupMember(db, groupId, actor.userId);
  const [row] = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.groupId, groupId),
        eq(attachments.status, "ready"),
        isNull(attachments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ServiceError(404, "not_found", "找不到這份附檔。");
  const object = await bucket.get(row.r2Key);
  if (!object) throw new ServiceError(404, "not_found", "儲存空間找不到這份附檔。");
  return { row, object };
}

export async function deleteAttachment(
  db: LedgerDb,
  bucket: R2Bucket | undefined,
  actor: AttachmentActor,
  groupId: string,
  attachmentId: string,
  audit: AttachmentAudit = { via: "web" },
): Promise<{ readonly id: string; readonly deleted: true }> {
  await requireGroupMember(db, groupId, actor.userId);
  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.groupId, groupId), isNull(attachments.deletedAt)))
    .limit(1);
  if (!row) throw new ServiceError(404, "not_found", "找不到這份附檔。");

  if (bucket) {
    await bucket.delete(row.r2Key);
  }
  const now = new Date();
  await db.batch([
    db
      .update(attachments)
      .set({ deletedAt: now, uploadTokenHash: null, expenseId: null })
      .where(and(eq(attachments.id, attachmentId), isNull(attachments.deletedAt))),
    db.insert(activityLog).values({
      id: newId("act"),
      groupId,
      actorUserId: actor.userId,
      action: "attachment.deleted",
      entityType: "attachment",
      entityId: attachmentId,
      payloadJson: JSON.stringify({
        summary: `刪除收據附檔「${row.filename}」`,
        filename: row.filename,
        via: audit.via,
        ...(audit.clientId ? { clientId: audit.clientId } : {}),
      }),
      createdAt: now,
    }),
  ]);
  return { id: attachmentId, deleted: true as const };
}

export async function validateAttachmentsForExpense(
  db: LedgerDb,
  groupId: string,
  expenseId: string | null,
  attachmentIds: readonly string[],
): Promise<typeof attachments.$inferSelect[]> {
  if (attachmentIds.length === 0) return [];
  const uniqueIds = [...new Set(attachmentIds)];
  if (uniqueIds.length > ATTACHMENT_MAX_PER_EXPENSE) {
    throw new ServiceError(422, "attachment_limit", `每筆支出最多只能附加 ${String(ATTACHMENT_MAX_PER_EXPENSE)} 份檔案。`);
  }
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.groupId, groupId), inArray(attachments.id, uniqueIds), isNull(attachments.deletedAt)));
  if (rows.length !== uniqueIds.length) {
    throw new ServiceError(422, "invalid_attachment", "有不存在或不屬於這個群組的附檔。");
  }
  for (const row of rows) {
    if (row.status !== "ready") {
      throw new ServiceError(422, "attachment_not_ready", `附檔「${row.filename}」尚未完成上傳。`);
    }
    if (row.expenseId !== null && row.expenseId !== expenseId) {
      throw new ServiceError(409, "attachment_in_use", `附檔「${row.filename}」已綁定到另一筆支出。`);
    }
  }
  return rows;
}

export function clearUnusedAttachmentLink(
  db: LedgerDb,
  groupId: string,
  expenseId: string,
  keepIds: readonly string[],
  guard?: SQL,
) {
  if (keepIds.length === 0) {
    return db
      .update(attachments)
      .set({ expenseId: null })
      .where(
        and(
          eq(attachments.groupId, groupId),
          eq(attachments.expenseId, expenseId),
          isNull(attachments.deletedAt),
          ...(guard ? [guard] : []),
        ),
      );
  }
  return db
    .update(attachments)
    .set({ expenseId: null })
    .where(
      and(
        eq(attachments.groupId, groupId),
        eq(attachments.expenseId, expenseId),
        isNull(attachments.deletedAt),
        ...(guard ? [guard] : []),
        ...keepIds.map((id) => ne(attachments.id, id)),
      ),
    );
}

async function requireGroupMember(db: LedgerDb, groupId: string, userId: string): Promise<void> {
  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!group) throw new ServiceError(404, "not_found", "找不到這個群組。");
  const [member] = await db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  if (!member) throw new ServiceError(403, "not_a_member", "你不是這個群組的成員。");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
