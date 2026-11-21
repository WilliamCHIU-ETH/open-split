import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkerHandler } from "../src/entry/worker.ts";
import { applyMigrations, createMemoryKv, createMemoryR2, createTestEnv } from "./helpers.ts";

const BASE = "https://split.example.com";
const GOOGLE_ISSUER = "https://mock-google.example";
const GOOGLE_AUTH = `${GOOGLE_ISSUER}/o/oauth2/v2/auth`;
const GOOGLE_TOKEN = `${GOOGLE_ISSUER}/token`;
const GOOGLE_JWKS = `${GOOGLE_ISSUER}/certs`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function sha256B64u(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("base64url");
}

function pngBytes(): Uint8Array {
  // Valid PNG signature + minimal payload
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

it("enforces Google OAuth PKCE + Gmail whitelist, scope isolation, MCP read/write idempotency, and R2 receipt verification", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite);
    const kv = createMemoryKv();
    const r2 = createMemoryR2();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "mock-k1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    let nextEmail = "owner@example.test";
    let nextSub = "google-bill-sub";
    let nextName = "Bill";
    const originalFetch = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === GOOGLE_JWKS) {
        return Response.json({ keys: [publicJwk] });
      }
      if (target === GOOGLE_TOKEN) {
        const bodyText = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
        const params = new URLSearchParams(bodyText);
        expect(params.get("grant_type")).toBe("authorization_code");
        const nonce = pendingNonce;
        const idToken = await new SignJWT({
          email: nextEmail,
          email_verified: true,
          name: nextName,
          nonce,
          azp: "mock-google-client-id",
        })
          .setProtectedHeader({ alg: "RS256", kid: "mock-k1" })
          .setIssuer(GOOGLE_ISSUER)
          .setAudience("mock-google-client-id")
          .setSubject(nextSub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ access_token: "mock-g-at", id_token: idToken });
      }
      return originalFetch(input, init);
    });

    const worker = createWorkerHandler({
      google: {
        authorize: GOOGLE_AUTH,
        token: GOOGLE_TOKEN,
        jwks: GOOGLE_JWKS,
        issuer: GOOGLE_ISSUER,
      },
    });

    const env = createTestEnv(sqlite, {
      OAUTH_KV: kv,
      RECEIPTS_BUCKET: r2,
      PUBLIC_BASE_URL: BASE,
      COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-at-least-32-chars",
      MCP_ALLOWED_EMAILS: "owner@example.test",
      GOOGLE_CLIENT_ID: "mock-google-client-id",
      GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
    });

    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = (req: Request, e = env) => worker.fetch(req, e, ctx);

    // 1. Metadata discovery (RFC 9728 / RFC 8414)
    const prmRes = await call(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    expect(prmRes.status).toBe(200);
    expect(await prmRes.json()).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });

    const asRes = await call(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(asRes.status).toBe(200);
    expect(await asRes.json()).toMatchObject({
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      scopes_supported: ["mcp:read", "mcp:write"],
    });

    // 2. Dynamic Client Registration + reject dangerous redirect URI
    const badDcr = await call(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Bad", redirect_uris: ["http://evil.example/cb"] }),
      }),
    );
    expect(badDcr.status).toBe(400);

    const dcrRes = await call(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    const { client_id: clientId } = (await dcrRes.json()) as { client_id: string };

    // Helper to execute full OAuth PKCE + consent + Google callback flow
    let pendingNonce = "";
    async function runOAuthAuthorize(email: string, sub: string, scopes: string[], targetClientId = clientId) {
      nextEmail = email;
      nextSub = sub;
      nextName = email.split("@")[0] ?? "User";
      const verifier = "verifier-0123456789012345678901234567890123456789012";
      const challenge = await sha256B64u(verifier);
      const authUrl = new URL(`${BASE}/authorize`);
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: targetClientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state-xyz",
        scope: scopes.join(" "),
        resource: `${BASE}/mcp`,
      }).toString();

      const consentGet = await call(new Request(authUrl.href));
      expect(consentGet.status).toBe(200);
      expect(consentGet.headers.get("content-security-policy")).toContain("form-action 'self'");
      const consentCookie = consentGet.headers.get("set-cookie")?.split(";")[0] ?? "";
      const html = await consentGet.text();
      const handleMatch = /name="handle"\s+value="([^"]+)"/.exec(html);
      const handle = handleMatch?.[1];
      expect(handle).toBeTruthy();
      if (!handle) throw new Error("missing handle");

      const form = new URLSearchParams({ handle, decision: "approve" });
      for (const s of scopes) form.append("scope", s);

      const postConsent = await call(
        new Request(`${BASE}/authorize`, {
          method: "POST",
          headers: {
            Origin: BASE,
            Cookie: consentCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        }),
      );
      expect(postConsent.status).toBe(302);
      const googleRedirect = new URL(postConsent.headers.get("location")!);
      expect(googleRedirect.origin + googleRedirect.pathname).toBe(GOOGLE_AUTH);
      pendingNonce = googleRedirect.searchParams.get("nonce")!;
      const upstreamState = googleRedirect.searchParams.get("state")!;
      const upstreamCookies = postConsent.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

      const callbackRes = await call(
        new Request(`${BASE}/callback?code=google-code-123&state=${encodeURIComponent(upstreamState)}`, {
          headers: { Cookie: upstreamCookies },
        }),
      );
      expect(callbackRes.status).toBe(302);
      const clientRedirect = new URL(callbackRes.headers.get("location")!);
      return { clientRedirect, verifier };
    }

    // 3. Non-whitelisted email denied
    const denied = await runOAuthAuthorize("stranger@example.com", "google-stranger", ["mcp:read"]);
    expect(denied.clientRedirect.searchParams.get("error")).toBe("access_denied");

    // 4. Whitelisted email authorized with read+write
    const allowed = await runOAuthAuthorize("owner@example.test", "google-bill-sub", ["mcp:read", "mcp:write"]);
    const authCode = allowed.clientRedirect.searchParams.get("code");
    expect(authCode).toBeTruthy();

    const tokenRes = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode!,
          code_verifier: allowed.verifier,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken, refresh_token: refreshToken } = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // 5. Token separation: MCP token rejected on /api/groups; unauthenticated/fake token rejected on /mcp
    const webAttempt = await call(
      new Request(`${BASE}/api/groups`, { headers: { authorization: `Bearer ${accessToken}` } }),
    );
    expect(webAttempt.status).toBe(401);

    const mcpFakeAttempt = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer not-a-valid-oauth-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(mcpFakeAttempt.status).toBe(401);

    async function mcpCall(method: string, params?: Record<string, unknown>, token = accessToken, e = env) {
      return call(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, ...(params ? { params } : {}) }),
        }),
        e,
      );
    }

    // 6. Initialize + tools/list
    const initRes = await mcpCall("initialize");
    expect(initRes.status).toBe(200);
    const listRes = await mcpCall("tools/list");
    const listJson = (await listRes.json()) as { result: { tools: { name: string }[] } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["create_group", "add_expense", "create_attachment_upload", "get_summary"]),
    );

    // 7. Create group + receipt upload (R2 + magic bytes + SHA-256) + add_expense w/ idempotency
    const createdGroup = (await (
      await mcpCall("tools/call", {
        name: "create_group",
        arguments: { name: "MCP 東京行", defaultCurrency: "TWD", idempotencyKey: "grp-1" },
      })
    ).json()) as { result: { structuredContent: { id: string; ownerMemberId: string } } };
    const { id: groupId, ownerMemberId } = createdGroup.result.structuredContent;

    const friend = (await (
      await mcpCall("tools/call", {
        name: "add_member",
        arguments: { groupId, displayName: "小華", virtual: true },
      })
    ).json()) as { result: { structuredContent: { id: string } } };
    const friendId = friend.result.structuredContent.id;

    const png = pngBytes();
    const pngSha = await sha256Hex(png);
    const intentRes = (await (
      await mcpCall("tools/call", {
        name: "create_attachment_upload",
        arguments: { groupId, filename: "dinner.png", mimeType: "image/png", byteSize: png.byteLength, sha256: pngSha },
      })
    ).json()) as {
      result: { structuredContent: { attachment: { id: string }; uploadPath: string; uploadHeaders: Record<string, string> } };
    };
    const attachmentId = intentRes.result.structuredContent.attachment.id;
    const uploadPath = intentRes.result.structuredContent.uploadPath;
    const uploadHeaders = intentRes.result.structuredContent.uploadHeaders;
    expect(uploadPath).not.toContain("token=");
    expect(uploadHeaders["x-upload-token"]).toBeTruthy();

    // Upload disguised SVG (same byteSize) -> 415 invalid_file_magic!
    const svg = new TextEncoder().encode("<svg></svg>!");
    const badUpload = await call(
      new Request(`${BASE}${uploadPath}`, {
        method: "PUT",
        headers: uploadHeaders,
        body: svg,
      }),
    );
    expect(badUpload.status).toBe(415);
    expect(r2.objects.size).toBe(0);

    // Upload valid PNG -> 200 ready in R2!
    const goodUpload = await call(
      new Request(`${BASE}${uploadPath}`, {
        method: "PUT",
        headers: uploadHeaders,
        body: png,
      }),
    );
    expect(goodUpload.status).toBe(200);
    expect(r2.objects.get(`groups/${groupId}/receipts/${attachmentId}`)?.bytes).toEqual(png);

    // Token cannot be reused
    const reuseUpload = await call(
      new Request(`${BASE}${uploadPath}`, { method: "PUT", headers: uploadHeaders, body: png }),
    );
    expect(reuseUpload.status).toBe(403);

    // Idempotent add_expense with foreign currency + attachment
    const expArgs = {
      groupId,
      payerId: ownerMemberId,
      amount: "1000",
      currency: "JPY",
      fxRate: { numerator: 21, denominator: 100 },
      participantIds: [ownerMemberId, friendId],
      split: { type: "equal" },
      attachmentIds: [attachmentId],
      idempotencyKey: "exp-key-1",
    };
    const firstExp = (await (
      await mcpCall("tools/call", { name: "add_expense", arguments: expArgs })
    ).json()) as { result: { structuredContent: { id: string } } };
    const retryExp = (await (
      await mcpCall("tools/call", { name: "add_expense", arguments: expArgs })
    ).json()) as { result: { structuredContent: { id: string } } };
    expect(retryExp.result.structuredContent.id).toBe(firstExp.result.structuredContent.id);

    const conflictExp = (await (
      await mcpCall("tools/call", {
        name: "add_expense",
        arguments: { ...expArgs, amount: "2000" },
      })
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(conflictExp.result.isError).toBe(true);
    expect(conflictExp.result.content[0]?.text).toContain("idempotency_conflict");

    // 8. Check private download security headers (requires web session cookie/bearer)
    const billSession = "bill-web-session";
    const billHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(billSession));
    const billRow = sqlite.prepare("SELECT id FROM users WHERE primary_email = 'owner@example.test'").get() as { id: string };
    sqlite.prepare("INSERT INTO sessions VALUES ('ses_bill', ?, ?, ?, 0)").run(billRow.id, Buffer.from(billHash).toString("hex"), Date.now() + 60_000);
    const dlRes = await call(
      new Request(`${BASE}/api/groups/${groupId}/attachments/${attachmentId}`, {
        headers: { authorization: `Bearer ${billSession}` },
      }),
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-disposition")).toContain("attachment");
    expect(dlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dlRes.headers.get("content-security-policy")).toBe("sandbox");
    expect(dlRes.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await dlRes.arrayBuffer())).toEqual(png);

    // Delete attachment removes R2 object & logs activity
    await mcpCall("tools/call", { name: "delete_attachment", arguments: { groupId, attachmentId } });
    expect(r2.objects.size).toBe(0);

    // 9. Scope check: read-only token cannot invoke write tool
    const roDcrRes = await call(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ReadOnlyViewer",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const { client_id: roClientId } = (await roDcrRes.json()) as { client_id: string };
    const readOnlyAuth = await runOAuthAuthorize("owner@example.test", "google-bill-sub", ["mcp:read"], roClientId);
    const readOnlyTokenRes = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: roClientId,
          code: readOnlyAuth.clientRedirect.searchParams.get("code")!,
          code_verifier: readOnlyAuth.verifier,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
    );
    const { access_token: readOnlyToken } = (await readOnlyTokenRes.json()) as { access_token: string };
    const readOk = await mcpCall("tools/call", { name: "list_groups", arguments: {} }, readOnlyToken);
    expect(readOk.status).toBe(200);
    const writeBlocked = await mcpCall(
      "tools/call",
      { name: "void_expense", arguments: { groupId, expenseId: firstExp.result.structuredContent.id } },
      readOnlyToken,
    );
    expect(writeBlocked.status).toBe(403);

    // 10. Immediate revocation when removed from whitelist
    const revokedEnv = { ...env, MCP_ALLOWED_EMAILS: "other@example.test" } as Env;
    const revokedCall = await mcpCall("tools/list", undefined, accessToken, revokedEnv);
    expect(revokedCall.status, await revokedCall.clone().text()).toBe(403);

    const revokedRefresh = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
      revokedEnv,
    );
    expect(revokedRefresh.status).toBe(400);
    expect(revokedRefresh.headers.has("X-OAuth-Diag")).toBe(false);
  } finally {
    sqlite.close();
  }
});

it("enforces least-privilege default scope, blocks consent scope escalation, rejects changed non-whitelisted Google emails, and rolls back attachment conflicts", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite);
    const kv = createMemoryKv();
    const r2 = createMemoryR2();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "mock-k2";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    let nextEmail = "owner@example.test";
    const nextSub = "google-bill-sub";
    let pendingNonce = "";
    const originalFetch = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === GOOGLE_JWKS) {
        return Response.json({ keys: [publicJwk] });
      }
      if (target === GOOGLE_TOKEN) {
        const idToken = await new SignJWT({
          email: nextEmail,
          email_verified: true,
          name: "Bill",
          nonce: pendingNonce,
          azp: "mock-google-client-id",
        })
          .setProtectedHeader({ alg: "RS256", kid: "mock-k2" })
          .setIssuer(GOOGLE_ISSUER)
          .setAudience("mock-google-client-id")
          .setSubject(nextSub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ access_token: "mock-g-at", id_token: idToken });
      }
      return originalFetch(input);
    });

    const worker = createWorkerHandler({
      google: {
        authorize: GOOGLE_AUTH,
        token: GOOGLE_TOKEN,
        jwks: GOOGLE_JWKS,
        issuer: GOOGLE_ISSUER,
      },
    });
    const env = createTestEnv(sqlite, {
      OAUTH_KV: kv,
      RECEIPTS_BUCKET: r2,
      PUBLIC_BASE_URL: BASE,
      COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-at-least-32-chars",
      MCP_ALLOWED_EMAILS: "owner@example.test",
      GOOGLE_CLIENT_ID: "mock-google-client-id",
      GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = (req: Request) => worker.fetch(req, env, ctx);

    const dcr = await call(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "RegressionClient",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const { client_id: clientId } = (await dcr.json()) as { client_id: string };

    // 1) POST /authorize must reject scope escalation (GET mcp:read -> POST mcp:write)
    const verifier = "verifier-0123456789012345678901234567890123456789012";
    const challenge = await sha256B64u(verifier);
    const escalatedGet = await call(
      new Request(
        `${BASE}/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "st-esc",
            scope: "mcp:read",
            resource: `${BASE}/mcp`,
          }).toString(),
      ),
    );
    expect(escalatedGet.status).toBe(200);
    const escHtml = await escalatedGet.text();
    expect(escHtml).not.toContain('name="remember" value="1" checked');
    const escHandle = /name="handle"\s+value="([^"]+)"/.exec(escHtml)?.[1];
    const escCookie = escalatedGet.headers.get("set-cookie")?.split(";")[0] ?? "";
    const escPost = await call(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { Origin: BASE, Cookie: escCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle: escHandle!, decision: "approve", scope: "mcp:write" }).toString(),
      }),
    );
    expect(escPost.status).toBe(400);

    // 2) GET /authorize with omitted scope defaults to least-privilege mcp:read only
    const defaultGet = await call(
      new Request(
        `${BASE}/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "st-default",
            resource: `${BASE}/mcp`,
          }).toString(),
      ),
    );
    expect(defaultGet.status).toBe(200);
    const defHtml = await defaultGet.text();
    const defHandle = /name="handle"\s+value="([^"]+)"/.exec(defHtml)?.[1];
    const defCookie = defaultGet.headers.get("set-cookie")?.split(";")[0] ?? "";
    const defPost = await call(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { Origin: BASE, Cookie: defCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle: defHandle!, decision: "approve" }).toString(),
      }),
    );
    expect(defPost.status).toBe(302);
    const gUrl1 = new URL(defPost.headers.get("location")!);
    pendingNonce = gUrl1.searchParams.get("nonce")!;
    const cb1 = await call(
      new Request(
        `${BASE}/callback?code=c1&state=${encodeURIComponent(gUrl1.searchParams.get("state")!)}`,
        { headers: { Cookie: defPost.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } },
      ),
    );
    const code1 = new URL(cb1.headers.get("location")!).searchParams.get("code")!;
    const tok1Res = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code1,
          code_verifier: verifier,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
    );
    const { access_token: defaultRoToken } = (await tok1Res.json()) as { access_token: string };
    const roWrite = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${defaultRoToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/call",
          params: { name: "create_group", arguments: { name: "Blocked", defaultCurrency: "TWD" } },
        }),
      }),
    );
    expect(roWrite.status).toBe(403);
    expect(roWrite.headers.has("X-OAuth-Diag")).toBe(false);

    // 3) Same Google sub logging in with changed non-whitelisted email must be denied when mcp_allowed is false
    nextEmail = "bill.changed@example.com";
    const changedGet = await call(
      new Request(
        `${BASE}/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "st-changed",
            scope: "mcp:read",
            resource: `${BASE}/mcp`,
          }).toString(),
      ),
    );
    const chHtml = await changedGet.text();
    const chHandle = /name="handle"\s+value="([^"]+)"/.exec(chHtml)?.[1];
    const chCookie = changedGet.headers.get("set-cookie")?.split(";")[0] ?? "";
    const chPost = await call(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { Origin: BASE, Cookie: chCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle: chHandle!, decision: "approve", scope: "mcp:read" }).toString(),
      }),
    );
    const gUrl2 = new URL(chPost.headers.get("location")!);
    pendingNonce = gUrl2.searchParams.get("nonce")!;
    const cb2 = await call(
      new Request(
        `${BASE}/callback?code=c2&state=${encodeURIComponent(gUrl2.searchParams.get("state")!)}`,
        { headers: { Cookie: chPost.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } },
      ),
    );
    expect(cb2.status).toBe(302);
    expect(new URL(cb2.headers.get("location")!).searchParams.get("error")).toBe("access_denied");

    // 4) Claiming an already-used attachmentId fails atomically with no orphan expense or share rows
    nextEmail = "owner@example.test";
    const rwGet = await call(
      new Request(
        `${BASE}/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "st-rw",
            scope: "mcp:read mcp:write",
            resource: `${BASE}/mcp`,
          }).toString(),
      ),
    );
    const rwHtml = await rwGet.text();
    const rwHandle = /name="handle"\s+value="([^"]+)"/.exec(rwHtml)?.[1];
    const rwCookie = rwGet.headers.get("set-cookie")?.split(";")[0] ?? "";
    const rwPost = await call(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { Origin: BASE, Cookie: rwCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          handle: rwHandle!,
          decision: "approve",
          scope: "mcp:read",
        }).toString() + "&scope=mcp%3Awrite",
      }),
    );
    const gUrl3 = new URL(rwPost.headers.get("location")!);
    pendingNonce = gUrl3.searchParams.get("nonce")!;
    const cb3 = await call(
      new Request(
        `${BASE}/callback?code=c3&state=${encodeURIComponent(gUrl3.searchParams.get("state")!)}`,
        { headers: { Cookie: rwPost.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } },
      ),
    );
    const code3 = new URL(cb3.headers.get("location")!).searchParams.get("code")!;
    const tok3Res = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code3,
          code_verifier: verifier,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
    );
    const { access_token: rwToken } = (await tok3Res.json()) as { access_token: string };
    const callRw = (name: string, args: Record<string, unknown>) =>
      call(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name, arguments: args } }),
        }),
      );

    const grp = (await (await callRw("create_group", { name: "Atomic Test", defaultCurrency: "TWD" })).json()) as {
      result: { structuredContent: { id: string; ownerMemberId: string } };
    };
    const { id: groupId, ownerMemberId } = grp.result.structuredContent;
    const png = pngBytes();
    const intent = (await (
      await callRw("create_attachment_upload", {
        groupId,
        filename: "r.png",
        mimeType: "image/png",
        byteSize: png.byteLength,
        sha256: await sha256Hex(png),
      })
    ).json()) as {
      result: { structuredContent: { attachment: { id: string }; uploadPath: string; uploadHeaders: Record<string, string> } };
    };
    await call(
      new Request(`${BASE}${intent.result.structuredContent.uploadPath}`, {
        method: "PUT",
        headers: intent.result.structuredContent.uploadHeaders,
        body: png,
      }),
    );

    const firstOk = await (
      await callRw("add_expense", {
        groupId,
        payerId: ownerMemberId,
        amount: "100",
        currency: "TWD",
        participantIds: [ownerMemberId],
        split: { type: "equal" },
        attachmentIds: [intent.result.structuredContent.attachment.id],
      })
    ).json() as { result: { isError?: boolean } };
    expect(firstOk.result.isError).not.toBe(true);

    const conflictAttempt = (await (
      await callRw("add_expense", {
        groupId,
        payerId: ownerMemberId,
        amount: "200",
        currency: "TWD",
        participantIds: [ownerMemberId],
        split: { type: "equal" },
        attachmentIds: [intent.result.structuredContent.attachment.id],
      })
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(conflictAttempt.result.isError).toBe(true);
    expect(conflictAttempt.result.content[0]?.text).toContain("attachment_in_use");

    const expCount = sqlite.prepare("SELECT COUNT(*) as c FROM expenses WHERE group_id = ?").get(groupId) as { c: number };
    const shareCount = sqlite.prepare("SELECT COUNT(*) as c FROM expense_shares").get() as { c: number };
    expect(expCount.c).toBe(1);
    expect(shareCount.c).toBe(1);
  } finally {
    sqlite.close();
  }
});
