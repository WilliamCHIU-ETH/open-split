export const AUTH_DEV_IDENTITIES_VAR = "AUTH_DEV_IDENTITIES";
export const ENVIRONMENT_VAR = "ENVIRONMENT";

/** Fake identities are allowed only in these non-deployed environments. */
export const DEV_AUTH_ENVIRONMENTS = ["development", "test"] as const;

export type DevAuthEnvironment = (typeof DEV_AUTH_ENVIRONMENTS)[number];

export type AuthProviderId = "line" | "google";

export interface ExternalIdentity {
  readonly provider: AuthProviderId;
  readonly subject: string;
  readonly displayName: string;
}

/**
 * Shared shape for LINE Login (primary) and Google (secondary).
 * Production providers gain OAuth completion in a later slice.
 * They must not grow a `signInAs` method: named fake users are a dev-only capability.
 */
export interface AuthProvider {
  readonly provider: AuthProviderId;
  readonly mode: "production" | "dev";
}

export interface ProductionAuthProvider extends AuthProvider {
  readonly mode: "production";
}

export interface DevIdentityProvider extends AuthProvider {
  readonly mode: "dev";
  signInAs(name: string): ExternalIdentity;
}

export interface AuthEnv {
  readonly environment: string;
  /** True only when the process was explicitly told to allow fake identities. */
  readonly authDevIdentities: boolean;
}

export interface DeployConfigViolation {
  readonly path: string;
  readonly message: string;
}

export interface DevUserFixture {
  readonly name: string;
  readonly displayName: string;
  readonly lineSubject: string;
  readonly googleSubject: string;
}

/** Canonical users for the acceptance runner. Subjects are stable on purpose. */
export const DEV_USERS: readonly DevUserFixture[] = [
  {
    name: "alice",
    displayName: "Alice",
    lineSubject: "dev-line:alice",
    googleSubject: "dev-google:alice",
  },
  {
    name: "bob",
    displayName: "Bob",
    lineSubject: "dev-line:bob",
    googleSubject: "dev-google:bob",
  },
];

const ENABLED = new Set(["true", "1", "yes", "on"]);

export function parseAuthFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ENABLED.has(value.trim().toLowerCase());
}

export function parseAuthEnv(raw: {
  readonly environment?: string;
  readonly authDevIdentities?: string;
}): AuthEnv {
  return {
    environment: raw.environment?.trim() ?? "",
    authDevIdentities: parseAuthFlag(raw.authDevIdentities),
  };
}

export function isDevAuthEnvironment(environment: string): environment is DevAuthEnvironment {
  return (DEV_AUTH_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * Refuse fake LINE/Google identities outside local wrangler dev and test D1.
 * Deployed config must keep the flag off; `.dev.vars` is the only switch, and Wrangler does not upload it.
 */
export function assertDevAuthAllowed(env: AuthEnv): void {
  if (!env.authDevIdentities) return;
  if (isDevAuthEnvironment(env.environment)) return;
  const where = env.environment.length > 0 ? env.environment : "(empty)";
  throw new Error(
    `AUTH_DEV_IDENTITIES 在「${where}」被拒絕。WHY: 假的 LINE／Google 身份會繞過真正的登入。` +
      `這個開關只允許 ENVIRONMENT=development 或 test，而且只能來自本機 .dev.vars 或測試程式自己傳入的綁定。` +
      `正式環境、預覽環境與 wrangler deploy 的設定必須維持 AUTH_DEV_IDENTITIES=false。`,
  );
}

export function createDevLineProvider(): DevIdentityProvider {
  return createDevProvider("line");
}

export function createDevGoogleProvider(): DevIdentityProvider {
  return createDevProvider("google");
}

function createDevProvider(provider: AuthProviderId): DevIdentityProvider {
  return {
    provider,
    mode: "dev",
    signInAs(name: string): ExternalIdentity {
      const fixture = resolveDevUser(name);
      return {
        provider,
        subject: provider === "line" ? fixture.lineSubject : fixture.googleSubject,
        displayName: fixture.displayName,
      };
    },
  };
}

function resolveDevUser(name: string): DevUserFixture {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(
      `假身份名稱「${name}」不合法。請用小寫英文開頭，例如 alice 或 bob。WHY: 測試身份必須可重跑，不能吃到顯示名稱裡的空白或大小寫差異。`,
    );
  }
  const known = DEV_USERS.find((user) => user.name === name);
  if (known) return known;
  return {
    name,
    displayName: name,
    lineSubject: `dev-line:${name}`,
    googleSubject: `dev-google:${name}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a parsed wrangler config. Any enabled AUTH_DEV_IDENTITIES is a violation,
 * including env.test: `wrangler deploy --env test` would publish fake login.
 * Top-level vars must explicitly disable it, because that object is what `wrangler deploy` ships.
 */
export function auditWranglerConfig(config: unknown): readonly DeployConfigViolation[] {
  const violations: DeployConfigViolation[] = [];
  if (!isRecord(config)) {
    violations.push({ path: "$", message: "wrangler 設定必須是物件。" });
    return violations;
  }

  collectEnabledFlags(config, "$", violations);

  const vars = config.vars;
  const safe =
    isRecord(vars) && vars.ENVIRONMENT === "production" && vars.AUTH_DEV_IDENTITIES === "false";
  if (!safe) {
    violations.push({
      path: "$.vars",
      message:
        "頂層 vars 是 wrangler deploy 的預設環境。ENVIRONMENT 必須是 \"production\"，AUTH_DEV_IDENTITIES 必須是 \"false\"。" +
        "WHY: 假登入一旦跟著部署出去，任何人都能假裝成 alice。本機 wrangler dev 與測試 D1 只從 .dev.vars（不會上傳）或測試綁定打開這個開關。",
    });
  }
  return violations;
}

function collectEnabledFlags(value: unknown, path: string, violations: DeployConfigViolation[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEnabledFlags(item, `${path}[${index}]`, violations));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`;
    if (key === AUTH_DEV_IDENTITIES_VAR && isEnabledValue(child)) {
      violations.push({
        path: next,
        message:
          "部署設定把 AUTH_DEV_IDENTITIES 打開了。WHY: 這個旗標代表假 LINE／Google 身份。" +
          "請改回 \"false\"。本機要測登入時，把開關寫在 apps/worker/.dev.vars，不要寫進 wrangler.jsonc。",
      });
    }
    collectEnabledFlags(child, next, violations);
  }
}

function isEnabledValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string" && ENABLED.has(value.trim().toLowerCase())) return true;
  return false;
}
