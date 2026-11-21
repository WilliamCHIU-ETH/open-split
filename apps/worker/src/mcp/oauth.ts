import OAuthProvider, {
  authorizationErrorRedirect,
  OAuthError,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { assertDevAuthAllowed, isDevAuthEnvironment, parseAuthEnv } from "@open-split/auth";
import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { authIdentities, users } from "../db/schema.ts";
import {
  isUserMcpAuthorized,
  parseAllowedEmails,
  resolveGoogleUser,
} from "../ledger/service.ts";
import { readBoundedBytes } from "../shared/bytes.ts";
import { handleMcpRequest, type McpTokenProps } from "./server.ts";

export interface OAuthGatewayOptions {
  /** Only tests inject mock Google OIDC endpoints. */
  readonly google?: {
    readonly authorize: string;
    readonly token: string;
    readonly jwks: string;
    readonly issuer: string;
  };
  readonly allowLoopbackOrigin?: boolean;
}

export type OAuthWorkerEnv = Env & {
  OAUTH_PROVIDER?: OAuthHelpers;
};

interface UpstreamState {
  readonly verifier: string;
  readonly nonce: string;
  readonly approvedScopes: readonly string[];
}

const GOOGLE_ENDPOINTS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuer: "https://accounts.google.com",
} as const;

const SUPPORTED_SCOPES = ["mcp:read", "mcp:write"] as const;
const MAX_OAUTH_BODY_BYTES = 131_072;
const TRUSTED_REDIRECT_HOSTS = new Set(["claude.ai", "www.claude.ai", "claude.com"]);
const OAUTH_EXACT_PATHS = new Set([
  "/mcp",
  "/authorize",
  "/callback",
  "/oauth/token",
  "/oauth/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);

const DEV_FALLBACK_COOKIE_KEY = "open-split-dev-only-cookie-key-32ch";

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_EXACT_PATHS.has(pathname);
}

export function createOAuthGateway(options: OAuthGatewayOptions = {}) {
  const google = options.google ?? GOOGLE_ENDPOINTS;
  const jwks = createRemoteJWKSet(new URL(google.jwks), { timeoutDuration: 5000, cooldownDuration: 30000 });

  return {
    async fetch(request: Request, env: OAuthWorkerEnv, ctx: ExecutionContext): Promise<Response> {
      try {
        assertDevAuthAllowed(
          parseAuthEnv({
            environment: env.ENVIRONMENT,
            authDevIdentities: env.AUTH_DEV_IDENTITIES,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ message: "dev auth refused", error: message }));
        return safeJson(500, "dev_auth_refused", { detail: message });
      }

      const url = new URL(request.url);
      if (!isOAuthPath(url.pathname)) {
        return safeJson(404, "not_found");
      }

      if (url.pathname === "/mcp" && url.search) {
        return safeJson(404, "not_found");
      }
      if (!env.OAUTH_KV || typeof env.OAUTH_KV.get !== "function") {
        return safeJson(503, "oauth_kv_unavailable");
      }

      const isDev = devEnabled(env);
      const baseUrl = resolveBaseUrl(url, env, isDev || Boolean(options.allowLoopbackOrigin));
      if (!baseUrl) {
        return safeJson(403, "invalid_host");
      }

      if (request.method === "POST" || request.body !== null) {
        try {
          const bytes = await readBoundedBytes(request, MAX_OAUTH_BODY_BYTES);
          request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: bytes as BodyInit,
            signal: request.signal,
          });
        } catch {
          return safeJson(413, "request_too_large");
        }
      }

      const cookieSecret = resolveCookieSecret(env, isDev);
      if (!cookieSecret) {
        return safeJson(503, "oauth_cookie_secret_missing");
      }

      const useGoogleOidc = Boolean(options.google || (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET));

      const oauthApp = new Hono<{ Bindings: OAuthWorkerEnv }>();
      oauthApp.onError((err) => {
        console.error(JSON.stringify({ message: "oauth_handler_error", error: err instanceof Error ? err.message : String(err) }));
        return safeJson(400, "authorization_failed", { "X-Auth-Diag": "authorization_exception" });
      });

      oauthApp.get("/authorize", async (c) => {
        const oauth = c.env.OAUTH_PROVIDER;
        if (!oauth) return safeJson(503, "oauth_provider_missing");

        const auth = await oauth.parseAuthRequest(c.req.raw);
        const requestedScopes = normalizeScopes(auth.scope);
        if (!requestedScopes) {
          return safeJson(400, "invalid_scope", { "X-Auth-Diag": "invalid_scope" });
        }
        auth.scope = requestedScopes;

        const client = await oauth.lookupClient(auth.clientId);
        if (
          !client ||
          !client.redirectUris.includes(auth.redirectUri) ||
          auth.codeChallengeMethod !== "S256" ||
          !auth.codeChallenge ||
          !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge) ||
          !auth.state ||
          auth.resource !== `${baseUrl}/mcp`
        ) {
          return safeJson(400, "invalid_authorization_request", { "X-Auth-Diag": "invalid_authorization_params" });
        }

        if (useGoogleOidc && env.GOOGLE_CLIENT_ID) {
          const remembered =
            c.req.query("prompt") !== "consent" &&
            (await oauth.isConsentRemembered(c.req.raw, auth, { secret: cookieSecret }));
          if (remembered) {
            const verifier = crypto.randomUUID() + crypto.randomUUID();
            const nonce = await boundNonce(cookieSecret);
            const upstream = await oauth.beginUpstream(auth, {
              data: { verifier, nonce, approvedScopes: requestedScopes } satisfies UpstreamState,
            });
            const target = new URL(google.authorize);
            target.search = new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID,
              redirect_uri: `${baseUrl}/callback`,
              response_type: "code",
              scope: "openid email",
              state: upstream.state,
              nonce,
              code_challenge: await sha256Base64Url(verifier),
              code_challenge_method: "S256",
              prompt: "select_account",
            }).toString();
            upstream.headers.set("Referrer-Policy", "no-referrer");
            upstream.headers.set("X-Auth-Diag", "consent_remembered_fastpath");
            upstream.headers.set("Location", target.href);
            return new Response(null, { status: 302, headers: upstream.headers });
          }
        } else if (!isDev) {
          return safeJson(503, "google_oauth_not_configured");
        }

        const details = await oauth.describeConsent(auth);
        const consent = await oauth.beginConsent(auth);
        const redirectOrigin = new URL(auth.redirectUri).origin;
        const formActionOrigins = useGoogleOidc
          ? `'self' ${new URL(google.authorize).origin} ${redirectOrigin}`
          : `'self' ${redirectOrigin}`;

        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        consent.headers.set(
          "Content-Security-Policy",
          `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionOrigins}; frame-ancestors 'none'; base-uri 'none'`,
        );
        consent.headers.set("Referrer-Policy", "same-origin");
        consent.headers.set("X-Content-Type-Options", "nosniff");

        const defaultDevEmail = parseAllowedEmails(c.env.MCP_ALLOWED_EMAILS)[0] ?? "";
        const devUsers = !useGoogleOidc && isDev
          ? await createDb(c.env.DB)
              .select({
                id: users.id,
                displayName: users.displayName,
                primaryEmail: users.primaryEmail,
                provider: authIdentities.provider,
              })
              .from(users)
              .innerJoin(authIdentities, eq(authIdentities.userId, users.id))
          : [];

        return new Response(
          renderConsentPage(details, consent.handle, `${baseUrl}/mcp`, {
            devMode: !useGoogleOidc && isDev,
            defaultDevEmail,
            devUsers,
          }),
          { headers: consent.headers },
        );
      });

      oauthApp.post("/authorize", async (c) => {
        if (c.req.header("Origin") !== baseUrl) {
          return safeJson(403, "invalid_origin", { "X-Auth-Diag": "origin_mismatch" });
        }
        const form = await c.req.raw.formData();
        const handle = String(form.get("handle") ?? "");
        const oauth = c.env.OAUTH_PROVIDER;
        if (!oauth) return safeJson(503, "oauth_provider_missing");

        if (form.get("decision") === "deny") {
          const denied = await oauth.denyConsent(c.req.raw, handle);
          denied.headers.set("Referrer-Policy", "no-referrer");
          denied.headers.set("X-Auth-Diag", "user_denied");
          return new Response(null, { status: 302, headers: denied.headers });
        }
        if (form.get("decision") !== "approve") {
          return safeJson(400, "invalid_decision", { "X-Auth-Diag": "invalid_decision" });
        }

        const requestedRaw = form.getAll("scope").map(String).filter(Boolean);
        const parsedRequested = requestedRaw.length > 0 ? normalizeScopes(requestedRaw) : undefined;
        if (requestedRaw.length > 0 && !parsedRequested) {
          return safeJson(400, "invalid_scope", { "X-Auth-Diag": "invalid_scope" });
        }

        const remember =
          form.get("remember") === "1" ? { secret: cookieSecret, maxAgeSeconds: 2_592_000 } : undefined;
        const approved = await oauth.approveConsent(c.req.raw, handle, {
          ...(remember ? { remember } : {}),
        });
        const grantedScopes = normalizeScopes(approved.request.scope);
        if (!grantedScopes) {
          return safeJson(400, "invalid_scope", { "X-Auth-Diag": "invalid_scope" });
        }
        if (parsedRequested && parsedRequested.some((scope) => !grantedScopes.includes(scope))) {
          return safeJson(400, "invalid_scope", { "X-Auth-Diag": "scope_escalation_rejected" });
        }
        const approvedScopes = parsedRequested ?? grantedScopes;

        if (useGoogleOidc && c.env.GOOGLE_CLIENT_ID) {
          const verifier = crypto.randomUUID() + crypto.randomUUID();
          const nonce = await boundNonce(cookieSecret);
          const upstream = await oauth.beginUpstream(approved.request, {
            data: { verifier, nonce, approvedScopes } satisfies UpstreamState,
            headers: approved.headers,
          });
          const target = new URL(google.authorize);
          target.search = new URLSearchParams({
            client_id: c.env.GOOGLE_CLIENT_ID,
            redirect_uri: `${baseUrl}/callback`,
            response_type: "code",
            scope: "openid email",
            state: upstream.state,
            nonce,
            code_challenge: await sha256Base64Url(verifier),
            code_challenge_method: "S256",
            prompt: "select_account",
          }).toString();
          upstream.headers.set("Referrer-Policy", "no-referrer");
          upstream.headers.set("X-Auth-Diag", "upstream_redirect");
          upstream.headers.set("Location", target.href);
          return new Response(null, { status: 302, headers: upstream.headers });
        }

        if (!isDev) {
          return safeJson(503, "google_oauth_not_configured");
        }

        // Local development/test OAuth completion without real Google secrets.
        const db = createDb(c.env.DB);
        const devUserId = String(form.get("dev_user_id") ?? "").trim();
        const devEmail = String(form.get("dev_email") ?? "").trim().toLowerCase();

        const denyWhitelist = () => {
          const headers = new Headers(approved.headers);
          headers.set("Referrer-Policy", "no-referrer");
          headers.set("X-Auth-Diag", "mcp_whitelist_denied");
          headers.set("Location", authorizationErrorRedirect(approved.request, "access_denied", "mcp_whitelist_denied"));
          return new Response(null, { status: 302, headers });
        };

        let actorProps: McpTokenProps;
        if (devUserId) {
          const [row] = await db.select().from(users).where(eq(users.id, devUserId)).limit(1);
          if (!row) return denyWhitelist();
          const ok = await isUserMcpAuthorized(db, c.env.MCP_ALLOWED_EMAILS, row.id, row.primaryEmail ?? undefined);
          if (!ok) return denyWhitelist();
          const [identity] = await db
            .select()
            .from(authIdentities)
            .where(eq(authIdentities.userId, row.id))
            .limit(1);
          actorProps = {
            userId: row.id,
            displayName: row.displayName,
            subject: identity?.subject ?? row.id,
            email: row.primaryEmail ?? "",
          };
        } else if (devEmail) {
          const allowedEmails = parseAllowedEmails(c.env.MCP_ALLOWED_EMAILS);
          const existingByEmail = await db
            .select()
            .from(users)
            .where(eq(users.primaryEmail, devEmail))
            .limit(1);
          const existingAllowed = existingByEmail[0]?.mcpAllowed === true;
          if (!allowedEmails.includes(devEmail) && !existingAllowed) {
            return denyWhitelist();
          }
          const resolved = await resolveGoogleUser(db, {
            sub: `google-dev:${devEmail}`,
            email: devEmail,
            name: devEmail.split("@")[0] || "Dev User",
          });
          actorProps = {
            userId: resolved.userId,
            displayName: resolved.displayName,
            subject: resolved.subject,
            email: devEmail,
          };
        } else {
          return denyWhitelist();
        }

        const completed = await oauth.completeAuthorization({
          request: approved.request,
          userId: actorProps.userId,
          metadata: { provider: "dev", email: actorProps.email },
          scope: approvedScopes,
          props: actorProps,
        });
        const headers = new Headers(approved.headers);
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Auth-Diag", "authorized");
        headers.set("Location", completed.redirectTo);
        return new Response(null, { status: 302, headers });
      });

      oauthApp.get("/callback", async (c) => {
        const oauth = c.env.OAUTH_PROVIDER;
        if (!oauth) return safeJson(503, "oauth_provider_missing");
        const resumed = await oauth.finishUpstream<UpstreamState>(c.req.raw);
        const deny = (stage: string) => {
          resumed.headers.set("Referrer-Policy", "no-referrer");
          resumed.headers.set("X-Auth-Diag", stage);
          resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied", stage));
          return new Response(null, { status: 302, headers: resumed.headers });
        };

        if (c.req.query("error")) return deny("upstream_oauth_error");
        const code = c.req.query("code");
        if (!code) return deny("upstream_code_missing");
        if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
          return deny("google_oauth_not_configured");
        }

        try {
          const tokenRes = await fetch(google.token, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: c.env.GOOGLE_CLIENT_ID,
              client_secret: c.env.GOOGLE_CLIENT_SECRET,
              redirect_uri: `${baseUrl}/callback`,
              code,
              code_verifier: resumed.data.verifier,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!tokenRes.ok) return deny("upstream_token_http_error");
          const tokenPayload = (await tokenRes.json()) as { id_token?: string };
          if (!tokenPayload.id_token) return deny("upstream_id_token_missing");

          const issuers =
            google.issuer === GOOGLE_ENDPOINTS.issuer
              ? [GOOGLE_ENDPOINTS.issuer, "accounts.google.com"]
              : [google.issuer];

          let payload;
          try {
            ({ payload } = await jwtVerify(tokenPayload.id_token, jwks, {
              issuer: issuers,
              audience: c.env.GOOGLE_CLIENT_ID,
              algorithms: ["RS256"],
              requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"],
              maxTokenAge: "5m",
            }));
          } catch {
            return deny("upstream_jwt_verify_failed");
          }

          if (
            payload.nonce !== resumed.data.nonce ||
            (payload.azp && payload.azp !== c.env.GOOGLE_CLIENT_ID) ||
            (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.env.GOOGLE_CLIENT_ID)
          ) {
            return deny("upstream_nonce_or_azp_mismatch");
          }

          const sub = typeof payload.sub === "string" ? payload.sub : "";
          const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
          const emailVerified = payload.email_verified === true;
          const displayName = typeof payload.name === "string" ? payload.name : undefined;
          if (!sub || !email || !emailVerified) {
            return deny("upstream_unverified_email");
          }

          const db = createDb(c.env.DB);
          const allowedEmails = parseAllowedEmails(c.env.MCP_ALLOWED_EMAILS);
          const existingIdentity = await db
            .select()
            .from(authIdentities)
            .where(and(eq(authIdentities.provider, "google"), eq(authIdentities.subject, sub)))
            .limit(1);
          let userAuthorized = allowedEmails.includes(email);
          if (!userAuthorized && existingIdentity[0]) {
            const [existingUser] = await db
              .select({ mcpAllowed: users.mcpAllowed })
              .from(users)
              .where(eq(users.id, existingIdentity[0].userId))
              .limit(1);
            userAuthorized = existingUser?.mcpAllowed === true;
          }
          if (!userAuthorized) {
            return deny("mcp_whitelist_denied");
          }

          const user = await resolveGoogleUser(db, { sub, email, name: displayName });
          const props: McpTokenProps = {
            userId: user.userId,
            displayName: user.displayName,
            subject: user.subject,
            email,
          };
          const completed = await oauth.completeAuthorization({
            request: resumed.request,
            userId: user.userId,
            metadata: { provider: "google", email },
            scope: [...resumed.data.approvedScopes],
            props,
          });
          resumed.headers.set("Referrer-Policy", "no-referrer");
          resumed.headers.set("X-Auth-Diag", "authorized");
          resumed.headers.set("Location", completed.redirectTo);
          return new Response(null, { status: 302, headers: resumed.headers });
        } catch {
          return deny("callback_internal_error");
        }
      });

      const provider = new OAuthProvider<OAuthWorkerEnv>({
        apiRoute: "/mcp",
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: [...SUPPORTED_SCOPES],
        resourceMetadata: {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
        },
        clientIdMetadataDocumentEnabled: false,
        accessTokenTTL: 300,
        refreshTokenTTL: 86_400,
        allowTokenExchangeGrant: false,
        onError: ({ internal }) => {
          console.warn(JSON.stringify({ message: "oauth_provider_error", diag: `${internal.category}:${internal.reason}` }));
        },
        clientRegistrationCallback: ({ clientMetadata }) => {
          const invalid = { code: "invalid_client_metadata", description: "Invalid client metadata", status: 400 };
          const uris = clientMetadata.redirect_uris;
          if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) return invalid;
          if (
            clientMetadata.client_name !== undefined &&
            (typeof clientMetadata.client_name !== "string" || clientMetadata.client_name.length > 128)
          ) {
            return invalid;
          }
          for (const uri of uris) {
            if (typeof uri !== "string" || uri.length > 512 || uri.includes("#")) return invalid;
            try {
              const target = new URL(uri);
              if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopback(target))) {
                return invalid;
              }
            } catch {
              return invalid;
            }
          }
          return undefined;
        },
        tokenExchangeCallback: async (exchange) => {
          const exchangeEnv = exchange.env;
          const props = exchange.props as Partial<McpTokenProps> | undefined;
          if (!props || typeof props.userId !== "string" || exchange.userId !== props.userId) {
            throw new OAuthError("invalid_grant", { description: "Authorization is no longer valid." });
          }
          const db = createDb(exchangeEnv.DB);
          const stillAllowed = await isUserMcpAuthorized(
            db,
            exchangeEnv.MCP_ALLOWED_EMAILS,
            props.userId,
            props.email,
          );
          if (!stillAllowed) {
            throw new OAuthError("invalid_grant", { description: "Account removed from MCP whitelist." });
          }
          const scopes = normalizeScopes(exchange.requestedScope);
          if (!scopes || exchange.resource !== `${baseUrl}/mcp`) {
            throw new OAuthError("invalid_scope", { description: "Invalid resource or scope for MCP." });
          }
        },
        defaultHandler: {
          fetch: (req, e, context) => oauthApp.fetch(req, e, context),
        },
        apiHandler: {
          async fetch(req, e, context) {
            const verified = context as OAuthResourceContext<McpTokenProps>;
            return handleMcpRequest(req, e, verified);
          },
        },
      });

      const isMetadataRequest =
        request.method === "GET" &&
        (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
          url.pathname === "/.well-known/oauth-authorization-server");
      if (isMetadataRequest && url.pathname === "/.well-known/oauth-protected-resource") {
        const target = new URL(request.url);
        target.pathname = "/.well-known/oauth-protected-resource/mcp";
        request = new Request(target, request);
      }

      const response = await provider.fetch(request, env, ctx);
      if (isMetadataRequest) {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    },
  };
}

function normalizeScopes(scopes: readonly string[] | undefined): string[] | null {
  if (!scopes || scopes.length === 0) return ["mcp:read"];
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(scope)) return null;
  }
  return unique;
}

function devEnabled(env: Env): boolean {
  const parsed = parseAuthEnv({
    environment: env.ENVIRONMENT,
    authDevIdentities: env.AUTH_DEV_IDENTITIES,
  });
  return parsed.authDevIdentities && isDevAuthEnvironment(parsed.environment);
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function resolveBaseUrl(requestUrl: URL, env: Env, allowLoopback: boolean): string | null {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      return null;
    }
    const validScheme = parsed.protocol === "https:" || (allowLoopback && parsed.protocol === "http:" && isLoopback(parsed));
    if (!validScheme || parsed.origin !== configured) return null;
    return requestUrl.origin === parsed.origin ? parsed.origin : null;
  }
  if (allowLoopback && isLoopback(requestUrl) && requestUrl.protocol === "http:") {
    return requestUrl.origin;
  }
  return null;
}

function resolveCookieSecret(env: Env, isDev: boolean): string | null {
  const key = env.COOKIE_ENCRYPTION_KEY?.trim();
  if (key && key.length >= 32) return key;
  if (isDev) return DEV_FALLBACK_COOKIE_KEY;
  return null;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function boundNonce(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, crypto.getRandomValues(new Uint8Array(32))));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

function renderConsentPage(
  d: ConsentDescription,
  handle: string,
  resource: string,
  dev: {
    readonly devMode: boolean;
    readonly defaultDevEmail: string;
    readonly devUsers: readonly { id: string; displayName: string; primaryEmail: string | null; provider: string }[];
  },
): string {
  const trusted = TRUSTED_REDIRECT_HOSTS.has(d.redirectHost.toLowerCase());
  const scopes = d.scope.map(escapeHtml).join(" ");
  const devSelector = dev.devMode
    ? `<fieldset class="meta">
        <legend class="label">本機測試授權帳號（限 dev 環境）</legend>
        <label class="row" style="display:block">
          <span class="label">Google 白名單 Email</span>
          <input name="dev_email" value="${escapeHtml(dev.defaultDevEmail)}" placeholder="owner@example.test" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:8px" />
        </label>
        <label class="row" style="display:block">
          <span class="label">或選擇既有本機帳號（驗證白名單拒絕）</span>
          <select name="dev_user_id" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:8px">
            <option value="">（使用上方 Email）</option>
            ${dev.devUsers.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(`${u.displayName} (${u.provider}${u.primaryEmail ? `: ${u.primaryEmail}` : ""})`)}</option>`).join("")}
          </select>
        </label>
      </fieldset>`
    : "";

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授權 MCP 用戶端 · Open-Split</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#ffffff;--border:#e2e8f0;--text:#0f172a;--muted:#475569;--accent:#0f766e;--accent-fg:#ffffff;--badge-bg:#f0fdfa;--badge-fg:#115e59;--warn-bg:#fffbeb;--warn-fg:#92400e}
@media(prefers-color-scheme:dark){:root{--bg:#090d16;--card:#111827;--border:#1f2937;--text:#f8fafc;--muted:#94a3b8;--accent:#14b8a6;--accent-fg:#042f2e;--badge-bg:#134e4a;--badge-fg:#99f6e4;--warn-bg:#451a03;--warn-fg:#fde68a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 10px 25px -5px rgba(0,0,0,.08)}
.brand{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
h1{font-size:20px;margin:0 0 8px;font-weight:700}
.note{font-size:13px;color:var(--muted);margin:0 0 18px}
.meta{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:13px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0}
.row+.row{border-top:1px solid var(--border)}
.label{color:var(--muted)}
.val{font-weight:600;word-break:break-all;text-align:right}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--badge-bg);color:var(--badge-fg);margin-left:6px}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:16px}
.remember{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-bottom:20px;cursor:pointer}
.actions{display:flex;gap:10px}
button{flex:1;padding:11px 16px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text)}
button[value="approve"]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
</style></head><body><main class="card">
<div class="brand">Open-Split · MCP OAuth 2.1</div>
<h1>允許 ${escapeHtml(d.clientName)} 存取你的分帳本？</h1>
<p class="note">用戶端名稱由申請者自行宣告，請確認回呼主機與權限範圍後再授權。</p>
${d.redirectIsLoopback ? '<div class="warn">這會交給本機應用程式；只在你剛發起授權時繼續。</div>' : ""}
<div class="meta">
<div class="row"><span class="label">回呼接收主機：</span><span class="val"><strong>${escapeHtml(d.redirectHost)}</strong>${trusted ? '<span class="badge">已白名單驗證</span>' : ""}</span></div>
<div class="row"><span class="label">MCP resource：</span><span class="val">${escapeHtml(resource)}</span></div>
<div class="row"><span class="label">權限範圍：</span><span class="val">${scopes}</span></div>
</div>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${d.scope.map((s) => `<input type="hidden" name="scope" value="${escapeHtml(s)}">`).join("")}
${devSelector}
<label class="remember"><input type="checkbox" name="remember" value="1"> 記住此客戶端授權（30 天內自動放行）</label>
<div class="actions"><button name="decision" value="deny">拒絕</button><button name="decision" value="approve">允許</button></div>
</form></main></body></html>`;
}

function safeJson(status: number, error: string, extra: HeadersInit = {}): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store", ...extra } },
  );
}
