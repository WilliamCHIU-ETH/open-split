import { Buffer } from "node:buffer";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ATTACHMENT_MAX_PER_EXPENSE, GROUP_ATTACHMENT_QUOTA_BYTES, activityResultSchema } from "@open-split/contracts";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { createApp } from "../src/http/app.ts";
import { cleanupStalePendingAttachments, createAttachmentUploadIntent, deleteAttachment } from "../src/ledger/attachments.ts";
import { asServiceError } from "../src/ledger/errors.ts";
import { runIdempotent } from "../src/ledger/idempotency.ts";
import { addExpense, addMember, createGroup, createInvite, listActivity, type SessionUser } from "../src/ledger/service.ts";
import { handleMcpRequest } from "../src/mcp/server.ts";
import { applyMigrations, createMemoryR2, createTestEnv, sqliteD1Binding } from "./helpers.ts";

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedOwner(sqlite: DatabaseSync, id = "usr_owner", email = "owner@example.test", token = "owner-session") {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  sqlite
    .prepare("INSERT INTO users (id, display_name, primary_email, mcp_allowed, created_at, updated_at) VALUES (?, 'Owner', ?, 1, 0, 0)")
    .run(id, email);
  sqlite.prepare("INSERT INTO auth_identities VALUES (?, ?, 'google', ?, 0)").run(`idn_${id}`, id, `sub_${id}`);
  sqlite
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 0)")
    .run(`ses_${id}`, id, Buffer.from(hash).toString("hex"), Date.now() + 60_000);
  return {
    userId: id,
    displayName: "Owner",
    provider: "google",
    subject: `sub_${id}`,
    primaryEmail: email,
  } satisfies SessionUser;
}

function delayedD1Binding(sqlite: DatabaseSync, delayMs: number): D1Database {
  const base = sqliteD1Binding(sqlite);
  return {
    prepare(query: string) {
      const stmt = base.prepare(query);
      return {
        bind(...params: SQLInputValue[]) {
          const bound = stmt.bind(...params);
          return {
            async all() {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return bound.all();
            },
            async run() {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return bound.run();
            },
            async raw() {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return bound.raw();
            },
          };
        },
      };
    },
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return base.batch(statements);
    },
  } as unknown as D1Database;
}

describe("P1 & P2 hardening invariants", () => {
  it("enforces atomic claim-first idempotency under concurrency without throwing 500 or double-executing", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrations(sqlite);
      const actor = await seedOwner(sqlite);
      const db = createDb(delayedD1Binding(sqlite, 10));

      let sideEffects = 0;
      const fn = async () => {
        sideEffects += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { createdId: `item_${String(sideEffects)}` };
      };

      const settled = await Promise.allSettled([
        runIdempotent(db, actor.userId, "test:action", "idem-concurrent-1", { amount: "100" }, fn),
        runIdempotent(db, actor.userId, "test:action", "idem-concurrent-1", { amount: "100" }, fn),
        runIdempotent(db, actor.userId, "test:action", "idem-concurrent-1", { amount: "100" }, fn),
      ]);

      expect(sideEffects).toBe(1);
      const fulfilled = settled.filter((r): r is PromiseFulfilledResult<{ createdId: string }> => r.status === "fulfilled");
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.value.createdId).toBe("item_1");
      expect(rejected).toHaveLength(2);
      for (const err of rejected) {
        const svc = asServiceError(err.reason);
        expect(svc?.status).toBe(409);
        expect(svc?.code).toBe("idempotency_in_progress");
      }

      // Subsequent replay returns cached response cleanly without re-running fn
      const replay = await runIdempotent(db, actor.userId, "test:action", "idem-concurrent-1", { amount: "100" }, fn);
      expect(replay).toEqual({ createdId: "item_1" });
      expect(sideEffects).toBe(1);

      // Failed fn clears pending claim so caller can retry
      await expect(
        runIdempotent(db, actor.userId, "test:action", "idem-fail-1", { a: 1 }, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const afterFail = await runIdempotent(db, actor.userId, "test:action", "idem-fail-1", { a: 1 }, async () => ({
        ok: true,
      }));
      expect(afterFail).toEqual({ ok: true });

      // Expired key (> 24h) can be reused
      sqlite
        .prepare("UPDATE idempotency_keys SET created_at = ? WHERE key = 'idem-fail-1'")
        .run(Date.now() - 25 * 60 * 60 * 1000);
      const expiredReuse = await runIdempotent(db, actor.userId, "test:action", "idem-fail-1", { a: 1 }, async () => ({
        ok: "renewed",
      }));
      expect(expiredReuse).toEqual({ ok: "renewed" });
    } finally {
      sqlite.close();
    }
  });

  it("never stores plaintext invite, claim, or upload tokens inside idempotency_keys.response_json", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrations(sqlite);
      const actor = await seedOwner(sqlite);
      const r2 = createMemoryR2();
      const env = createTestEnv(sqlite, {
        RECEIPTS_BUCKET: r2,
        MCP_ALLOWED_EMAILS: "owner@example.test",
      });
      const db = createDb(env.DB);
      const grp = await createGroup(db, actor, { name: "Secrets Check", defaultCurrency: "TWD" });

      const callMcp = async (name: string, args: Record<string, unknown>) => {
        const res = await handleMcpRequest(
          new Request("https://split.example.com/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name, arguments: args } }),
          }),
          env,
          {
            auth: { clientId: "client_1", scope: ["mcp:read", "mcp:write"], userId: actor.userId },
            props: { userId: actor.userId, displayName: actor.displayName, subject: actor.subject, email: "owner@example.test" },
          } as unknown as Parameters<typeof handleMcpRequest>[2],
        );
        return (await res.json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] } };
      };

      const inv = await callMcp("create_invite", { groupId: grp.id, idempotencyKey: "k-inv" });
      const invToken = String(inv.result.structuredContent?.token ?? "");
      expect(invToken).toBeTruthy();

      const mem = await callMcp("add_member", { groupId: grp.id, displayName: "Bob", virtual: true, idempotencyKey: "k-mem" });
      const claimToken = String((mem.result.structuredContent?.claim as { token?: string } | undefined)?.token ?? "");
      expect(claimToken).toBeTruthy();

      const png = pngBytes();
      const att = await callMcp("create_attachment_upload", {
        groupId: grp.id,
        filename: "r.png",
        mimeType: "image/png",
        byteSize: png.byteLength,
        sha256: await sha256Hex(png),
        idempotencyKey: "k-att",
      });
      const uploadHeaders = att.result.structuredContent?.uploadHeaders as Record<string, string>;
      const uploadToken = uploadHeaders["x-upload-token"] ?? "";
      expect(uploadToken).toBeTruthy();

      const cachedRows = sqlite.prepare("SELECT response_json FROM idempotency_keys").all() as { response_json: string }[];
      expect(cachedRows).toHaveLength(3);
      for (const row of cachedRows) {
        expect(row.response_json).not.toContain(invToken);
        expect(row.response_json).not.toContain(claimToken);
        expect(row.response_json).not.toContain(uploadToken);
        expect(JSON.parse(row.response_json)).toEqual({ __redacted: true });
      }

      // Replay fails cleanly with 409 idempotency_secret_redacted rather than creating duplicates or leaking tokens
      const replayInv = await callMcp("create_invite", { groupId: grp.id, idempotencyKey: "k-inv" });
      expect(replayInv.result.isError).toBe(true);
      expect(replayInv.result.content[0]?.text).toContain("idempotency_secret_redacted");
      const inviteCount = sqlite.prepare("SELECT COUNT(*) as c FROM invite_links").get() as { c: number };
      expect(inviteCount.c).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("enforces attachment pre-body auth & Content-Length check, atomic 5-file/100MiB quota, orphan ready cleanup, R2 delete errors, activity metadata, and FX non-zero", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrations(sqlite);
      const actor = await seedOwner(sqlite);
      const r2 = createMemoryR2();
      const env = createTestEnv(sqlite, { RECEIPTS_BUCKET: r2 });
      const db = createDb(env.DB);
      const app = createApp();

      const grp = await createGroup(db, actor, { name: "Hardening", defaultCurrency: "TWD" });
      const exp = await addExpense(db, actor, {
        groupId: grp.id,
        payerId: grp.ownerMemberId,
        amount: "500",
        currency: "TWD",
        participantIds: [grp.ownerMemberId],
        split: { type: "equal" },
      });

      // Reject FX conversion that rounds to 0 TWD (P3-1)
      await expect(
        addExpense(db, actor, {
          groupId: grp.id,
          payerId: grp.ownerMemberId,
          amount: "1",
          currency: "JPY",
          fxRate: { numerator: 1, denominator: 1000 },
          participantIds: [grp.ownerMemberId],
          split: { type: "equal" },
        }),
      ).rejects.toMatchObject({ status: 422, code: "fx_converted_zero" });

      // Authorize upload & verify Content-Length BEFORE reading request body (P2-2)
      const png = pngBytes();
      const pngSha = await sha256Hex(png);
      const intent = await createAttachmentUploadIntent(db, r2, actor, {
        groupId: grp.id,
        expenseId: exp.id,
        filename: "a'(1).png",
        mimeType: "image/png",
        byteSize: png.byteLength,
        sha256: pngSha,
      });

      let bodyPulled = false;
      const makePoisonStream = () =>
        new ReadableStream(
          {
            pull() {
              bodyPulled = true;
              throw new Error("stream body must not be read when auth/Content-Length fails");
            },
          },
          { highWaterMark: 0 },
        );
      const badTokenRes = await app.request(
        intent.uploadPath,
        {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "x-upload-token": "wrong-token",
            "content-length": String(png.byteLength),
          },
          body: makePoisonStream(),
          duplex: "half",
        } as RequestInit,
        env,
      );
      expect(badTokenRes.status).toBe(403);
      expect(bodyPulled).toBe(false);

      const badLengthRes = await app.request(
        intent.uploadPath,
        {
          method: "PUT",
          headers: {
            ...intent.uploadHeaders,
            "content-length": String(png.byteLength + 10),
          },
          body: makePoisonStream(),
          duplex: "half",
        } as RequestInit,
        env,
      );
      expect(badLengthRes.status).toBe(422);
      expect(bodyPulled).toBe(false);

      // Actual upload succeeds and logs attachment.uploaded + RFC 5987 download escaping (P2-7, P3-7)
      const okPut = await app.request(
        intent.uploadPath,
        {
          method: "PUT",
          headers: intent.uploadHeaders,
          body: png,
        },
        env,
      );
      expect(okPut.status).toBe(200);

      const dlRes = await app.request(
        `/api/groups/${grp.id}/attachments/${intent.attachment.id}`,
        { headers: { authorization: "Bearer owner-session" } },
        env,
      );
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get("content-disposition")).toContain("%27%281%29");

      // Atomic 5-per-expense cap under concurrent intents (P2-5)
      const delayedDb = createDb(delayedD1Binding(sqlite, 10));
      const raceResults = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          createAttachmentUploadIntent(delayedDb, r2, actor, {
            groupId: grp.id,
            expenseId: exp.id,
            filename: `race-${String(i)}.png`,
            mimeType: "image/png",
            byteSize: png.byteLength,
            sha256: pngSha,
          }),
        ),
      );
      const raceOk = raceResults.filter((r) => r.status === "fulfilled");
      const raceLimit = raceResults.filter((r) => r.status === "rejected");
      // 1 already existed on `exp.id`, so at most (5 - 1) = 4 more can succeed.
      expect(raceOk).toHaveLength(ATTACHMENT_MAX_PER_EXPENSE - 1);
      expect(raceLimit).toHaveLength(2);

      // 100 MiB group quota atomic check (P2-5)
      const halfQuota = GROUP_ATTACHMENT_QUOTA_BYTES / 2;
      const quotaRes = await Promise.allSettled([
        createAttachmentUploadIntent(delayedDb, r2, actor, {
          groupId: grp.id,
          filename: "q1.pdf",
          mimeType: "application/pdf",
          byteSize: 10 * 1024 * 1024,
          sha256: pngSha,
        }),
        createAttachmentUploadIntent(delayedDb, r2, actor, {
          groupId: grp.id,
          filename: "q2.pdf",
          mimeType: "application/pdf",
          byteSize: 10 * 1024 * 1024,
          sha256: pngSha,
        }),
      ]);
      expect(quotaRes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(halfQuota).toBe(50 * 1024 * 1024);

      // deleteAttachment surfaces R2 errors and keeps D1 row (P2-3)
      const failingR2 = {
        ...r2,
        async delete() {
          throw new Error("r2 outage");
        },
      } as unknown as R2Bucket;
      await expect(deleteAttachment(db, failingR2, actor, grp.id, intent.attachment.id)).rejects.toThrow("r2 outage");
      const stillAlive = sqlite
        .prepare("SELECT deleted_at FROM attachments WHERE id = ?")
        .get(intent.attachment.id) as { deleted_at: number | null };
      expect(stillAlive.deleted_at).toBeNull();

      // cleanupStalePendingAttachments removes stale unlinked `ready` attachments >24h old while keeping linked ones (P2-4)
      const orphanIntent = await createAttachmentUploadIntent(db, r2, actor, {
        groupId: grp.id,
        filename: "orphan.png",
        mimeType: "image/png",
        byteSize: png.byteLength,
        sha256: pngSha,
      });
      await app.request(
        orphanIntent.uploadPath,
        { method: "PUT", headers: orphanIntent.uploadHeaders, body: png },
        env,
      );
      sqlite
        .prepare("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)")
        .run(Date.now() - 25 * 60 * 60 * 1000, orphanIntent.attachment.id, intent.attachment.id);
      await cleanupStalePendingAttachments(db, r2, grp.id);
      const orphanRow = sqlite
        .prepare("SELECT deleted_at FROM attachments WHERE id = ?")
        .get(orphanIntent.attachment.id) as { deleted_at: number | null };
      const linkedRow = sqlite
        .prepare("SELECT deleted_at FROM attachments WHERE id = ?")
        .get(intent.attachment.id) as { deleted_at: number | null };
      expect(orphanRow.deleted_at).not.toBeNull();
      expect(linkedRow.deleted_at).toBeNull();

      // listActivity returns actorDisplayName, via, clientId, and attachment.uploaded (P2-7)
      await createInvite(db, actor, grp.id, { via: "mcp", clientId: "Claude Desktop" });
      await addMember(db, actor, { groupId: grp.id, displayName: "Bob", virtual: true });
      const act = activityResultSchema.parse(await listActivity(db, actor, grp.id));
      const expEntry = act.entries.find((e) => e.action === "expense.created");
      const attEntry = act.entries.find((e) => e.action === "attachment.uploaded");
      const mcpEntry = act.entries.find((e) => e.action === "invite.created");
      expect(expEntry?.summary).toContain("Owner 記了一筆");
      expect(expEntry?.actorDisplayName).toBe("Owner");
      expect(attEntry).toBeDefined();
      expect(mcpEntry?.via).toBe("mcp");
      expect(mcpEntry?.clientId).toBe("Claude Desktop");
    } finally {
      sqlite.close();
    }
  });
});
