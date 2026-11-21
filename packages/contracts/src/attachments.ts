import { z } from "zod";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_EXPENSE,
  GROUP_ATTACHMENT_QUOTA_BYTES,
  attachmentMimeTypes,
} from "./attachment-limits.ts";
import { idSchema } from "./money.ts";

export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_EXPENSE,
  GROUP_ATTACHMENT_QUOTA_BYTES,
  attachmentMimeTypes,
};

export const attachmentMimeTypeSchema = z.enum(attachmentMimeTypes);

export const attachmentSummarySchema = z.strictObject({
  id: idSchema,
  groupId: idSchema,
  expenseId: idSchema.nullable(),
  filename: z.string().min(1).max(180),
  mimeType: attachmentMimeTypeSchema,
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "ready"]),
  createdAt: z.iso.datetime(),
  downloadPath: z.string().min(1),
});

export const attachmentUploadIntentInputSchema = z.strictObject({
  groupId: idSchema,
  expenseId: idSchema.optional(),
  filename: z.string().trim().min(1).max(180),
  mimeType: attachmentMimeTypeSchema,
  byteSize: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 必須是 64 位小寫十六進位字串。"),
});

export const attachmentUploadIntentResultSchema = z.strictObject({
  attachment: attachmentSummarySchema,
  uploadPath: z.string().min(1),
  uploadMethod: z.literal("PUT"),
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

export const attachmentListSchema = z.strictObject({
  attachments: z.array(attachmentSummarySchema),
});

export const attachmentDeleteResultSchema = z.strictObject({
  id: idSchema,
  deleted: z.literal(true),
});

export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;
export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;
export type AttachmentUploadIntentInput = z.infer<typeof attachmentUploadIntentInputSchema>;
export type AttachmentUploadIntentResult = z.infer<typeof attachmentUploadIntentResultSchema>;
