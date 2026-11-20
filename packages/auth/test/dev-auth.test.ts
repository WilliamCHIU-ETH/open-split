import { describe, expect, it } from "vitest";
import {
  assertDevAuthAllowed,
  auditWranglerConfig,
  createDevGoogleProvider,
  createDevLineProvider,
  parseAuthEnv,
} from "../src/index.ts";

describe("dev identity providers", () => {
  it("signs alice and bob in with stable subjects", () => {
    const line = createDevLineProvider();
    const google = createDevGoogleProvider();
    expect(line.mode).toBe("dev");
    expect(line.signInAs("alice")).toEqual({
      provider: "line",
      subject: "dev-line:alice",
      displayName: "Alice",
    });
    expect(google.signInAs("bob")).toEqual({
      provider: "google",
      subject: "dev-google:bob",
      displayName: "Bob",
    });
  });

  it("rejects display-name noise so reruns stay deterministic", () => {
    expect(() => createDevLineProvider().signInAs("Alice")).toThrow(/不合法/);
  });
});

describe("assertDevAuthAllowed", () => {
  it("allows the flag only for development and test", () => {
    expect(() =>
      assertDevAuthAllowed({ environment: "development", authDevIdentities: true }),
    ).not.toThrow();
    expect(() => assertDevAuthAllowed({ environment: "test", authDevIdentities: true })).not.toThrow();
  });

  it("refuses the flag in production, staging, and empty environments", () => {
    expect(() =>
      assertDevAuthAllowed({ environment: "production", authDevIdentities: true }),
    ).toThrow(/AUTH_DEV_IDENTITIES/);
    expect(() => assertDevAuthAllowed({ environment: "staging", authDevIdentities: true })).toThrow(
      /staging/,
    );
    expect(() => assertDevAuthAllowed({ environment: "", authDevIdentities: true })).toThrow(
      /AUTH_DEV_IDENTITIES/,
    );
  });

  it("allows production when the flag is off", () => {
    expect(() =>
      assertDevAuthAllowed(parseAuthEnv({ environment: "production", authDevIdentities: "false" })),
    ).not.toThrow();
  });
});

describe("auditWranglerConfig", () => {
  it("accepts the safe deploy default", () => {
    expect(
      auditWranglerConfig({
        vars: { ENVIRONMENT: "production", AUTH_DEV_IDENTITIES: "false" },
      }),
    ).toEqual([]);
  });

  it("fails when production config turns fake login on", () => {
    const violations = auditWranglerConfig({
      vars: { ENVIRONMENT: "production", AUTH_DEV_IDENTITIES: "false" },
      env: { production: { vars: { AUTH_DEV_IDENTITIES: "true" } } },
    });
    expect(violations.some((item) => item.path === "$.env.production.vars.AUTH_DEV_IDENTITIES")).toBe(
      true,
    );
  });

  it("fails closed when the top-level safe default is missing", () => {
    const violations = auditWranglerConfig({ name: "open-split" });
    expect(violations.some((item) => item.path === "$.vars")).toBe(true);
  });
});
