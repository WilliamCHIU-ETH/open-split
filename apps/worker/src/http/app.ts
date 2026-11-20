import { assertDevAuthAllowed, isDevAuthEnvironment, parseAuthEnv } from "@open-split/auth";
import {
  addMemberInputSchema,
  createGroupInputSchema,
  devSignInSchema,
  expenseInputSchema,
  idSchema,
  plannedHttpRoutes,
} from "@open-split/contracts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb } from "../db/client.ts";
import { asServiceError, ServiceError } from "../ledger/errors.ts";
import {
  addExpense,
  addMember,
  createGroup,
  createInvite,
  deleteSession,
  devSignIn,
  getBalances,
  getGroupDetail,
  listActivity,
  listDevUsers,
  listGroups,
  previewSettlement,
  readSession,
  updateExpense,
  voidExpense,
  type SessionUser,
} from "../ledger/service.ts";

const SESSION_COOKIE = "os_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const REQUEST_HEADER = "x-open-split-request";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
    const group = await createGroup(createDb(c.env.DB), c.get("user"), body);
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
    const member = await addMember(createDb(c.env.DB), c.get("user"), body);
    console.log(JSON.stringify({ message: "member.added", groupId, memberId: member.id, virtual: member.virtual }));
    return c.json(member, 201);
  });

  app.post("/api/groups/:groupId/expenses", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const input = parseWith(expenseInputSchema, await readJson(c));
    assertSameGroup(input.groupId, groupId);
    const result = await addExpense(createDb(c.env.DB), c.get("user"), input);
    console.log(JSON.stringify({ message: "expense.created", groupId, expenseId: result.id }));
    return c.json(result, 201);
  });

  app.patch("/api/groups/:groupId/expenses/:expenseId", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const expenseId = parseId(c.req.param("expenseId"), "expenseId");
    const input = parseWith(expenseInputSchema, await readJson(c));
    assertSameGroup(input.groupId, groupId);
    const result = await updateExpense(createDb(c.env.DB), c.get("user"), expenseId, input);
    console.log(JSON.stringify({ message: "expense.updated", groupId, expenseId }));
    return c.json(result);
  });

  app.post("/api/groups/:groupId/expenses/:expenseId/void", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const expenseId = parseId(c.req.param("expenseId"), "expenseId");
    const result = await voidExpense(createDb(c.env.DB), c.get("user"), groupId, expenseId);
    console.log(JSON.stringify({ message: "expense.voided", groupId, expenseId }));
    return c.json(result);
  });

  app.get("/api/groups/:groupId/balances", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await getBalances(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.get("/api/groups/:groupId/settlement-preview", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await previewSettlement(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.get("/api/groups/:groupId/activity", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    return c.json(await listActivity(createDb(c.env.DB), c.get("user"), groupId));
  });

  app.post("/api/groups/:groupId/invites", async (c) => {
    const groupId = parseId(c.req.param("groupId"), "groupId");
    const invite = await createInvite(createDb(c.env.DB), c.get("user"), groupId);
    console.log(JSON.stringify({ message: "invite.created", groupId }));
    return c.json(invite, 201);
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
