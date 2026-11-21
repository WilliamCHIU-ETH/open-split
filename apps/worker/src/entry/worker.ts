import { assertDevAuthAllowed, parseAuthEnv } from "@open-split/auth";
import { createApp } from "../http/app.ts";
import { createOAuthGateway, isOAuthPath, type OAuthGatewayOptions, type OAuthWorkerEnv } from "../mcp/oauth.ts";

/**
 * Top-level Cloudflare Worker fetch composition root.
 * Runs the production fake-identity guard once, then routes OAuth/MCP endpoints
 * separately from the Hono HTTP API (and Workers Static Assets in production).
 */
export function createWorkerHandler(options: OAuthGatewayOptions = {}) {
  const webApp = createApp();
  const oauthGateway = createOAuthGateway(options);

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
        return Response.json(
          { error: "dev_auth_refused", detail: message },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
      }

      const url = new URL(request.url);
      if (isOAuthPath(url.pathname)) {
        return oauthGateway.fetch(request, env, ctx);
      }
      return webApp.fetch(request, env, ctx);
    },
  };
}
