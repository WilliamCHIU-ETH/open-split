import { and, eq, lt, or } from "drizzle-orm";
import type { LedgerDb } from "../db/client.ts";
import { idempotencyKeys } from "../db/schema.ts";
import { errorHasText, ServiceError } from "./errors.ts";
import { newId, sha256Hex } from "./ids.ts";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 5 * 60 * 1000;
const PENDING_SENTINEL = "__PENDING__";

export interface IdempotentOptions<T> {
  readonly redactResult?: (result: T) => boolean;
}

export async function runIdempotent<T>(
  db: LedgerDb,
  userId: string,
  action: string,
  key: string | undefined,
  requestBody: unknown,
  fn: () => Promise<T>,
  options?: IdempotentOptions<T>,
): Promise<T> {
  if (!key) return fn();
  const requestHash = await sha256Hex(stableJson(requestBody));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date();
    const expiredCutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
    const stalePendingCutoff = new Date(now.getTime() - STALE_PENDING_MS);

    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.action, action),
          eq(idempotencyKeys.key, key),
          or(
            lt(idempotencyKeys.createdAt, expiredCutoff),
            and(eq(idempotencyKeys.responseJson, PENDING_SENTINEL), lt(idempotencyKeys.createdAt, stalePendingCutoff)),
          ),
        ),
      );

    const claimId = newId("idp");
    let claimed = false;
    try {
      await db.insert(idempotencyKeys).values({
        id: claimId,
        userId,
        action,
        key,
        requestHash,
        responseJson: PENDING_SENTINEL,
        createdAt: now,
      });
      claimed = true;
    } catch (error) {
      if (!errorHasText(error, "UNIQUE constraint failed")) {
        throw error;
      }
      const [existing] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.action, action), eq(idempotencyKeys.key, key)))
        .limit(1);
      if (!existing) {
        // Owner failed and deleted the pending row between insert and select; retry claim once.
        continue;
      }
      if (existing.requestHash !== requestHash) {
        throw new ServiceError(422, "idempotency_conflict", "相同的 idempotencyKey 不能用於不同的請求內容。");
      }
      if (existing.responseJson === PENDING_SENTINEL) {
        throw new ServiceError(409, "idempotency_in_progress", "相同 idempotencyKey 的請求正在處理中，請稍後重試。");
      }
      const parsed = JSON.parse(existing.responseJson) as unknown;
      if (isRedactedRecord(parsed)) {
        throw new ServiceError(
          409,
          "idempotency_secret_redacted",
          "這個操作會產生單次憑證，為保護機密不會暫存原權杖；請改用新的 idempotencyKey 重試。",
        );
      }
      return parsed as T;
    }

    if (claimed) {
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        try {
          await db
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.id, claimId), eq(idempotencyKeys.responseJson, PENDING_SENTINEL)));
        } catch {
          // Best-effort cleanup so failed attempts do not poison future retries.
        }
        throw error;
      }

      const storedJson = options?.redactResult?.(result)
        ? JSON.stringify({ __redacted: true })
        : JSON.stringify(result);
      await db
        .update(idempotencyKeys)
        .set({ responseJson: storedJson })
        .where(and(eq(idempotencyKeys.id, claimId), eq(idempotencyKeys.responseJson, PENDING_SENTINEL)));
      return result;
    }
  }

  throw new ServiceError(409, "idempotency_in_progress", "相同 idempotencyKey 的請求正在處理中，請稍後重試。");
}

function isRedactedRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { __redacted?: unknown }).__redacted === true;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}
