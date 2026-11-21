import { describe, expect, it } from "vitest";
import { isBackendPath, parseRoute, shouldInterceptNavigation } from "../src/router.ts";

describe("web router", () => {
  it("parses valid app routes and handles malformed percent-encoding without throwing", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
    expect(parseRoute("/groups/grp_abc-123")).toEqual({ name: "group", id: "grp_abc-123" });
    expect(parseRoute("/invite/tok%201")).toEqual({ name: "invite", token: "tok 1" });
    expect(parseRoute("/claim/clm_42")).toEqual({ name: "claim", token: "clm_42" });
    expect(parseRoute("/invite/%E0%A4%A")).toEqual({ name: "home" });
    expect(parseRoute("/claim/%E0%A4%A")).toEqual({ name: "home" });
  });

  it("identifies Worker-owned backend paths accurately", () => {
    expect(isBackendPath("/api")).toBe(true);
    expect(isBackendPath("/api/groups/grp_1/attachments/att_1/content")).toBe(true);
    expect(isBackendPath("/auth/line")).toBe(true);
    expect(isBackendPath("/authorize")).toBe(true);
    expect(isBackendPath("/callback")).toBe(true);
    expect(isBackendPath("/mcp")).toBe(true);
    expect(isBackendPath("/oauth/token")).toBe(true);
    expect(isBackendPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isBackendPath("/health")).toBe(true);

    expect(isBackendPath("/")).toBe(false);
    expect(isBackendPath("/groups/api")).toBe(false);
    expect(isBackendPath("/groups/auth-test")).toBe(false);
    expect(isBackendPath("/invite/health")).toBe(false);
  });

  it("never intercepts backend links, download links, external links, or non-self targets", () => {
    const origin = "https://split.example.com";
    expect(
      shouldInterceptNavigation({
        href: "/groups/grp_1?liff.state=%2Fgroups%2Fgrp_1",
        resolvedHref: `${origin}/groups/grp_1?liff.state=%2Fgroups%2Fgrp_1`,
        origin,
      }),
    ).toBe(true);

    expect(
      shouldInterceptNavigation({
        href: "/auth/line",
        resolvedHref: `${origin}/auth/line`,
        origin,
      }),
    ).toBe(false);

    expect(
      shouldInterceptNavigation({
        href: "/api/groups/grp_1/attachments/att_1/content",
        resolvedHref: `${origin}/api/groups/grp_1/attachments/att_1/content`,
        origin,
      }),
    ).toBe(false);

    expect(
      shouldInterceptNavigation({
        href: "/groups/grp_1",
        resolvedHref: `${origin}/groups/grp_1`,
        origin,
        hasDownload: true,
      }),
    ).toBe(false);

    expect(
      shouldInterceptNavigation({
        href: "/groups/grp_1",
        resolvedHref: `${origin}/groups/grp_1`,
        origin,
        target: "_blank",
      }),
    ).toBe(false);

    expect(
      shouldInterceptNavigation({
        href: "https://line.me/R/ti/p/example",
        resolvedHref: "https://line.me/R/ti/p/example",
        origin,
      }),
    ).toBe(false);
  });
});
