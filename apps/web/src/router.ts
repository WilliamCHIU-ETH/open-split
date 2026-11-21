export type Route =
  | { readonly name: "home" }
  | { readonly name: "group"; readonly id: string }
  | { readonly name: "invite"; readonly token: string }
  | { readonly name: "claim"; readonly token: string };

export interface AppLocation {
  readonly pathname: string;
  readonly search: string;
}

/**
 * Prefixes owned by the Cloudflare Worker (API, auth/OAuth callbacks, MCP, health).
 * Anchor clicks targeting these paths must trigger full browser navigation so
 * redirects, cookies, and file downloads work instead of being intercepted by SPA pushState.
 */
export const BACKEND_PATH_PREFIXES = [
  "/api",
  "/auth",
  "/authorize",
  "/callback",
  "/mcp",
  "/oauth",
  "/.well-known",
  "/health",
] as const;

export function isBackendPath(pathname: string): boolean {
  return BACKEND_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function shouldInterceptNavigation(input: {
  readonly href: string | null;
  readonly resolvedHref: string;
  readonly origin: string;
  readonly target?: string | null;
  readonly hasDownload?: boolean;
}): boolean {
  if (!input.href || input.href.startsWith("#")) return false;
  if (input.hasDownload) return false;
  if (input.target && input.target !== "_self") return false;
  let url: URL;
  try {
    url = new URL(input.resolvedHref, input.origin);
  } catch {
    return false;
  }
  if (url.origin !== input.origin) return false;
  if (isBackendPath(url.pathname)) return false;
  return true;
}

export function readBrowserLocation(): AppLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

export function parseRoute(pathname: string): Route {
  const group = /^\/groups\/([A-Za-z][A-Za-z0-9_-]{0,80})$/.exec(pathname);
  const groupId = group?.[1];
  if (groupId) return { name: "group", id: groupId };

  const invite = /^\/invite\/([^/]+)$/.exec(pathname);
  const inviteToken = invite?.[1];
  if (inviteToken) {
    const decoded = safeDecodeSegment(inviteToken);
    if (decoded !== null) return { name: "invite", token: decoded };
  }

  const claim = /^\/claim\/([^/]+)$/.exec(pathname);
  const claimToken = claim?.[1];
  if (claimToken) {
    const decoded = safeDecodeSegment(claimToken);
    if (decoded !== null) return { name: "claim", token: decoded };
  }

  return { name: "home" };
}

export function routeTitle(route: Route): string {
  if (route.name === "group") return "群組帳本";
  if (route.name === "invite") return "邀請連結";
  if (route.name === "claim") return "認領";
  return "open-split 帳本";
}

function safeDecodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
