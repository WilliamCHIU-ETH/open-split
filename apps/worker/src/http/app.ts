import { assertDevAuthAllowed, isDevAuthEnvironment, parseAuthEnv } from "@open-split/auth";
import {
  ATTACHMENT_MAX_BYTES,
  addMemberInputSchema,
  attachmentUploadIntentInputSchema,
  claimTokenSchema,
  createGroupInputSchema,
  devSignInSchema,
  expenseInputSchema,
  idempotencyKeySchema,
  idSchema,
  inviteTokenSchema,
  paymentProfileWriteSchema,
  plannedHttpRoutes,
  settlementWriteSchema,
} from "@open-split/contracts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb } from "../db/client.ts";
import {
  authorizeAttachmentUpload,
  createAttachmentUploadIntent,
  deleteAttachment,
  downloadAttachmentObject,
  listGroupAttachments,
  uploadAttachmentBinary,
} from "../ledger/attachments.ts";
import { asServiceError, ServiceError } from "../ledger/errors.ts";
import { runIdempotent } from "../ledger/idempotency.ts";
import {
  acceptInvite,
  addExpense,
  addMember,
  claimMember,
  clearPaymentProfile,
  createGroup,
  createInvite,
  deleteSession,
  devSignIn,
  getBalances,
  getGroupDetail,
  getGroupSummary,
  getSettlementPlan,
  listActivity,
  listDevUsers,
  listGroups,
  previewClaim,
  previewInvite,
  readSession,
  recordSettlement,
  rotateClaimLink,
  updateExpense,
  updatePaymentProfile,
  voidExpense,
  voidSettlement,
  type SessionUser,
} from "../ledger/service.ts";
import { readBoundedBytes } from "../mcp/server.ts";

const SESSION_COOKIE = "os_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const REQUEST_HEADER = "x-open-split-request";
const IDEMPOTENCY_HEADER = "idempotency-key";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ATTACHMENT_CONTENT_PATH = /^\/api\/groups\/[^/]+\/attachments\/[^/]+\/content$/;

type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    token: string;
    bearer: boolean;
  };
};

type AppContext = Context<AppEnv>;

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    try {
      assertDevAuthAllowed(
        parseAuthEnv({
          environment: c.env.ENVIRONMENT,
          authDevIdentities: c.env.AUTH_DEV_IDENTITIES,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "dev auth refused", error: message }));
      return c.json({ error: "dev_auth_refused", detail: message }, 500);
    }
    return next();
  });

  app.onError((error, c) => {
    const service = asServiceError(error);
    if (service) return c.json({ error: service.code, detail: service.message }, service.status);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "unhandled", error: message }));
    return c.json({ error: "internal", detail: "沒有完成這次請求。" }, 500);
  });

  app.get("/health", (c) => {
    console.log(JSON.stringify({ message: "health", path: "/health" }));
    return c.json({ ok: true, service: "open-split" });
  });

  app.get("/api/dev/session", (c) => {
    if (!devEnabled(c.env)) return c.json({ error: "not_found", detail: "這個環境沒有本機假登入。" }, 404);
    return c.json({ enabled: true });
  });

  app.post("/api/dev/session", async (c) => {
    if (!devEnabled(c.env)) return c.json({ error: "not_found", detail: "這個環境沒有本機假登入。" }, 404);
    requireRequestHeader(c);
    const body = parseWith(devSignInSchema, await readJson(c));
    const session = await devSignIn(createDb(c.env.DB), body);
    setSessionCookie(c, session.token);
    console.log(JSON.stringify({ message: "dev_session", provider: session.provider, userId: session.userId }));
    return c.json(session);
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/dev/session") return next();
    if (c.req.method === "PUT" && ATTACHMENT_CONTENT_PATH.test(c.req.path) && c.req.header("x-upload-token")) {
      return next();
    }
    const presented = presentedToken(c);
    if (!presented) return c.json({ error: "unauthenticated", detail: "請先登入。" }, 401);
    if (!presented.bearer && MUTATING.has(c.req.method) && c.req.header(REQUEST_HEADER) !== "1") {
      return c.json({ error: "csrf", detail: "缺少同源請求標頭。" }, 403);
    }
    const user = await readSession(createDb(c.env.DB), presented.token);
    if (!user) return c.json({ error: "unauthenticated", detail: "工作階段無效或已過期。" }, 401);
    c.set("user", user);
    c.set("token", presented.token);
    c.set("bearer", presented.bearer);
    return next();
  });

  app.get("/api/session", (c) => c.json(sessionBody(c.get("user"))));

  app.delete("/api/session", async (c) => {
    await deleteSession(createDb(c.env.DB), c.get("token"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/dev/users", async (c) => {
    if (!devEnabled(c.env)) return c.json({ error: "not_found", detail: "這個環境沒有本機假登入。" }, 404);
    return c.json({ users: await listDevUsers(createDb(c.env.DB)) });
  });

  app.get("/api/groups", async (c) => c.json({ groups: await listGroups(createDb(c.env.DB), c.get("user")) }));

  app.post("/api/groups", async (c) => {
    const body = parseWith(createGroupInputSchema, await readJson(c));
    const group = await createGroup(createDb(c.env.DB), c.get("user"), body, { via: "web" });
    console.log(JSON.stringify({ message: "group.created", groupId: group.id }));
    return c.json(group, 201);
  });

  app.get("/api/groups/:groupId", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await getGroupDetail(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.post("/api/groups/:groupId/members", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const body = parseWith(addMemberInputSchema, { ...(await readJsonObject(c)), groupId });
    const member = await addMember(createDb(c.env.DB), c.get("user"), body, { via: "web" });
    console.log(JSON.stringify({ message: "member.added", groupId, memberId: member.id, virtual: member.virtual }));
    return c.json(member, 201);
  });

  app.post("/api/groups/:groupId/expenses", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const input = parseWith(expenseInputSchema, await readJson(c));
    assertSameGroup(input.groupId, groupId);
    const db = createDb(c.env.DB);
    const user = c.get("user");
    const key = parseIdempotencyHeader(c);
    const result = await runIdempotent(db, user.userId, "http:add_expense", key, input, () =>
      addExpense(db, user, input, { via: "web" }),
    );
    console.log(JSON.stringify({ message: "expense.created", groupId, expenseId: result.id }));
    return c.json(result, 201);
  });

  app.patch("/api/groups/:groupId/expenses/:expenseId", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const expenseId = parseId(c.req.param("expenseId"), "expenseId");
    const input = parseWith(expenseInputSchema, await readJson(c));
    assertSameGroup(input.groupId, groupId);
    const db = createDb(c.env.DB);
    const user = c.get("user");
    const key = parseIdempotencyHeader(c);
    const result = await runIdempotent(db, user.userId, "http:update_expense", key, { expenseId, ...input }, () =>
      updateExpense(db, user, expenseId, input, { via: "web" }),
    );
    console.log(JSON.stringify({ message: "expense.updated", groupId, expenseId }));
    return c.json(result);
  });

  app.post("/api/groups/:groupId/expenses/:expenseId/void", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const expenseId = parseId(c.req.param("expenseId"), "expenseId");
    const result = await voidExpense(createDb(c.env.DB), c.get("user"), groupId, expenseId, { via: "web" });
    console.log(JSON.stringify({ message: "expense.voided", groupId, expenseId }));
    return c.json(result);
  });

  app.get("/api/groups/:groupId/balances", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await getBalances(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.get("/api/groups/:groupId/settlement-plan", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await getSettlementPlan(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.post("/api/groups/:groupId/settlements", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const input = parseWith(settlementWriteSchema, await readJson(c));
    const db = createDb(c.env.DB);
    const user = c.get("user");
    const key = parseIdempotencyHeader(c);
    const result = await runIdempotent(db, user.userId, "http:record_settlement", key, { groupId, ...input }, () =>
      recordSettlement(db, user, groupId, input, { via: "web" }),
    );
    console.log(JSON.stringify({ message: "settlement.recorded", groupId, settlementId: result.id }));
    return c.json(result, 201);
  });

  app.post("/api/groups/:groupId/settlements/:settlementId/void", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const settlementId = parseId(c.req.param("settlementId"), "settlementId");
    const result = await voidSettlement(createDb(c.env.DB), c.get("user"), groupId, settlementId, { via: "web" });
    console.log(JSON.stringify({ message: "settlement.voided", groupId, settlementId }));
    return c.json(result);
  });

  app.put("/api/groups/:groupId/members/:memberId/payment-profile", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const memberId = parseId(c.req.param("memberId"), "memberId");
    const profile = parseWith(paymentProfileWriteSchema, await readJson(c));
    return c.json(await updatePaymentProfile(createDb(c.env.DB), c.get("user"), groupId, memberId, profile, { via: "web" }));
  });

  app.delete("/api/groups/:groupId/members/:memberId/payment-profile", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const memberId = parseId(c.req.param("memberId"), "memberId");
    return c.json(await clearPaymentProfile(createDb(c.env.DB), c.get("user"), groupId, memberId, { via: "web" }));
  });

  app.get("/api/groups/:groupId/summary", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await getGroupSummary(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.get("/api/groups/:groupId/activity", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await listActivity(createDb(c.env.DB), c.get("user"), groupId));
  });

  // --- R2 Receipt Attachments (Slice 5) ---

  app.get("/api/groups/:groupId/attachments", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const expenseIdRaw = c.req.query("expenseId");
    const expenseId = expenseIdRaw ? parseId(expenseIdRaw, "expenseId") : undefined;
    return c.json(await listGroupAttachments(createDb(c.env.DB), c.env.RECEIPTS_BUCKET, c.get("user"), groupId, expenseId));
  });

  app.post("/api/groups/:groupId/attachments/upload-intent", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const raw = await readJsonObject(c);
    const input = parseWith(attachmentUploadIntentInputSchema, { ...raw, groupId });
    const db = createDb(c.env.DB);
    const user = c.get("user");
    const key = parseIdempotencyHeader(c);
    const result = await runIdempotent(
      db,
      user.userId,
      "http:attachment_intent",
      key,
      input,
      () => createAttachmentUploadIntent(db, c.env.RECEIPTS_BUCKET, user, input),
      { redactResult: () => true },
    );
    return c.json(result, 201);
  });

  app.put("/api/groups/:groupId/attachments/:attachmentId/content", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const attachmentId = parseId(c.req.param("attachmentId"), "attachmentId");
    const uploadToken = c.req.header("x-upload-token") ?? null;
    const actor = uploadToken ? null : c.get("user");
    const contentType = c.req.header("content-type") ?? null;
    const db = createDb(c.env.DB);
    const pending = await authorizeAttachmentUpload(db, c.env.RECEIPTS_BUCKET, {
      groupId,
      attachmentId,
      uploadToken,
      actor,
      contentType,
      contentLengthHeader: c.req.header("content-length") ?? null,
    });
    const body = await readBoundedBytes(c.req.raw, Math.min(ATTACHMENT_MAX_BYTES, pending.byteSize));
    const via = c.req.header("x-open-split-request") === "1" || (!uploadToken && actor) ? "web" : "mcp";
    const summary = await uploadAttachmentBinary(db, c.env.RECEIPTS_BUCKET, {
      groupId,
      attachmentId,
      uploadToken,
      actor,
      body,
      contentType,
      authorizedRow: pending,
      audit: { via },
    });
    console.log(JSON.stringify({ message: "attachment.uploaded", groupId, attachmentId }));
    return c.json(summary);
  });

  app.get("/api/groups/:groupId/attachments/:attachmentId", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const attachmentId = parseId(c.req.param("attachmentId"), "attachmentId");
    const { row, object } = await downloadAttachmentObject(
      createDb(c.env.DB),
      c.env.RECEIPTS_BUCKET,
      c.get("user"),
      groupId,
      attachmentId,
    );
    const asciiName = row.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encodedName = encodeURIComponent(row.filename).replace(
      /[!'()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const headers = new Headers();
    headers.set("Content-Type", row.mimeType);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("Cache-Control", "private, no-store");
    return new Response(object.body, { status: 200, headers });
  });

  app.delete("/api/groups/:groupId/attachments/:attachmentId", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const attachmentId = parseId(c.req.param("attachmentId"), "attachmentId");
    const result = await deleteAttachment(createDb(c.env.DB), c.env.RECEIPTS_BUCKET, c.get("user"), groupId, attachmentId, {
      via: "web",
    });
    console.log(JSON.stringify({ message: "attachment.deleted", groupId, attachmentId }));
    return c.json(result);
  });

  app.post("/api/groups/:groupId/members/:memberId/claim-link", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const memberId = parseId(c.req.param("memberId"), "memberId");
    const claim = await rotateClaimLink(createDb(c.env.DB), c.get("user"), groupId, memberId);
    console.log(JSON.stringify({ message: "member.claim_link_rotated", groupId, memberId }));
    return c.json(claim);
  });

  app.get("/api/claims/:token", async (c) => {
    const token = parseToken(claimTokenSchema, c.req.param("token"));
    return c.json(await previewClaim(createDb(c.env.DB), c.get("user"), token));
  });

  app.post("/api/claims/:token", async (c) => {
    const token = parseToken(claimTokenSchema, c.req.param("token"));
    const result = await claimMember(createDb(c.env.DB), c.get("user"), token);
    console.log(JSON.stringify({ message: "member.claimed", groupId: result.groupId, memberId: result.member.id }));
    return c.json(result);
  });

  app.post("/api/groups/:groupId/invites", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const invite = await createInvite(createDb(c.env.DB), c.get("user"), groupId, { via: "web" });
    console.log(JSON.stringify({ message: "invite.created", groupId }));
    return c.json(invite, 201);
  });

  app.get("/api/invites/:token", async (c) => {
    const token = parseToken(inviteTokenSchema, c.req.param("token"));
    return c.json(await previewInvite(createDb(c.env.DB), c.get("user"), token));
  });

  app.post("/api/invites/:token/accept", async (c) => {
    const token = parseToken(inviteTokenSchema, c.req.param("token"));
    const result = await acceptInvite(createDb(c.env.DB), c.get("user"), token);
    console.log(
      JSON.stringify({ message: "invite.accepted", groupId: result.groupId, alreadyMember: result.alreadyMember }),
    );
    return c.json(result, result.alreadyMember ? 200 : 201);
  });

  app.all("/api/*", (c) => {
    console.log(JSON.stringify({ message: "not_implemented", path: c.req.path }));
    return c.json(
      {
        error: "not_implemented",
        detail: "這個路徑還沒有實作。見 docs/04-vertical-slices.md。",
        routes: plannedHttpRoutes,
      },
      501,
    );
  });

  return app;
}

function devEnabled(env: Env): boolean {
  const parsed = parseAuthEnv({
    environment: env.ENVIRONMENT,
    authDevIdentities: env.AUTH_DEV_IDENTITIES,
  });
  return parsed.authDevIdentities && isDevAuthEnvironment(parsed.environment);
}

function presentedToken(c: AppContext): { token: string; bearer: boolean } | null {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const token = match?.[1];
    if (token) return { token, bearer: true };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return { token: cookie, bearer: false };
  return null;
}

function requireRequestHeader(c: AppContext): void {
  if (c.req.header(REQUEST_HEADER) !== "1") {
    throw new ServiceError(403, "csrf", "缺少同源請求標頭。");
  }
}

function parseIdempotencyHeader(c: AppContext): string | undefined {
  const raw = c.req.header(IDEMPOTENCY_HEADER);
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(400, "invalid_idempotency_key", "Idempotency-Key 格式不正確。");
  }
  return parsed.data;
}

function setSessionCookie(c: AppContext, token: string): void {
  const url = new URL(c.req.url);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: url.protocol === "https:",
    maxAge: SESSION_MAX_AGE,
  });
}

function sessionBody(user: SessionUser) {
  return {
    userId: user.userId,
    displayName: user.displayName,
    provider: user.provider,
    subject: user.subject,
  };
}

async function readJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ServiceError(400, "invalid_json", "請求本文不是 JSON。");
  }
}

async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  const value = await readJson(c);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, "invalid_json", "請求本文必須是物件。");
  }
  return value as Record<string, unknown>;
}

function parseId(value: string | undefined, name: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ServiceError(400, "invalid_id", `${name} 不是合法的 id。`);
  return parsed.data;
}

function parseToken(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: string } | { success: false; error: { issues: readonly { message: string }[] } };
  },
  value: string | undefined,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceError(400, "invalid_token", "這條連結不正確。");
  return parsed.data;
}

function assertSameGroup(bodyGroupId: string, pathGroupId: string): void {
  if (bodyGroupId !== pathGroupId) {
    throw new ServiceError(400, "group_mismatch", "路徑上的群組與本文不一致。");
  }
}

function parseWith<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError(400, "invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}
