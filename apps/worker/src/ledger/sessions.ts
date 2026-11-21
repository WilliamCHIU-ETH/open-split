import { and, asc, eq } from "drizzle-orm";
import {
  createDevGoogleProvider,
  createDevLineProvider,
  type AuthProviderId,
} from "@open-split/auth";
import type { LedgerDb } from "../db/client.ts";
import { authIdentities, sessions, users } from "../db/schema.ts";
import type { SessionUser } from "./context.ts";
import { ServiceError } from "./errors.ts";
import { newId, newSecret, sha256Hex } from "./ids.ts";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function devSignIn(
  db: LedgerDb,
  input: { readonly name: string; readonly provider: AuthProviderId },
): Promise<SessionUser & { readonly token: string }> {
  const provider = input.provider === "line" ? createDevLineProvider() : createDevGoogleProvider();
  let identity: ReturnType<typeof provider.signInAs>;
  try {
    identity = provider.signInAs(input.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法建立假身份。";
    throw new ServiceError(400, "invalid_identity", message);
  }

  const existing = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, identity.provider), eq(authIdentities.subject, identity.subject)))
    .limit(1);
  const found = existing[0];
  const now = new Date();
  let userId: string;
  let displayName: string;
  if (found) {
    userId = found.userId;
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user) throw new ServiceError(500, "missing_user", "身份沒有對應的使用者。");
    displayName = user.displayName;
  } else {
    userId = newId("usr");
    displayName = identity.displayName;
    await db.batch([
      db.insert(users).values({
        id: userId,
        displayName,
        primaryEmail: null,
        mcpAllowed: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(authIdentities).values({
        id: newId("idn"),
        userId,
        provider: identity.provider,
        subject: identity.subject,
        createdAt: now,
      }),
    ]);
  }

  const token = newSecret();
  await db.insert(sessions).values({
    id: newId("ses"),
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + SESSION_MS),
    createdAt: now,
  });

  return { token, userId, displayName, provider: identity.provider, subject: identity.subject };
}

export async function resolveGoogleUser(
  db: LedgerDb,
  claims: { readonly sub: string; readonly email: string; readonly name?: string },
): Promise<SessionUser> {
  const normalizedEmail = claims.email.trim().toLowerCase();
  const [identity] = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, "google"), eq(authIdentities.subject, claims.sub)))
    .limit(1);
  const now = new Date();
  if (identity) {
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
    if (!user) throw new ServiceError(500, "missing_user", "身份沒有對應的使用者。");
    if (user.primaryEmail !== normalizedEmail) {
      await db.update(users).set({ primaryEmail: normalizedEmail, updatedAt: now }).where(eq(users.id, user.id));
    }
    return {
      userId: user.id,
      displayName: user.displayName,
      provider: "google",
      subject: identity.subject,
      primaryEmail: normalizedEmail,
    };
  }

  const userId = newId("usr");
  const displayName = claims.name?.trim() || normalizedEmail.split("@")[0] || "Google 使用者";
  await db.batch([
    db.insert(users).values({
      id: userId,
      displayName,
      primaryEmail: normalizedEmail,
      mcpAllowed: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(authIdentities).values({
      id: newId("idn"),
      userId,
      provider: "google",
      subject: claims.sub,
      createdAt: now,
    }),
  ]);
  return {
    userId,
    displayName,
    provider: "google",
    subject: claims.sub,
    primaryEmail: normalizedEmail,
  };
}

export async function isUserMcpAuthorized(
  db: LedgerDb,
  allowedEmailsRaw: string | undefined,
  userId: string,
  emailHint?: string,
): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return false;
  if (user.mcpAllowed) return true;
  const email = (user.primaryEmail ?? emailHint)?.trim().toLowerCase();
  if (!email) return false;
  return parseAllowedEmails(allowedEmailsRaw).includes(email);
}

export async function listDevUsers(db: LedgerDb): Promise<SessionUser[]> {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      provider: authIdentities.provider,
      subject: authIdentities.subject,
    })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .orderBy(asc(users.displayName), asc(authIdentities.subject));
  return rows;
}

export async function readSession(db: LedgerDb, token: string): Promise<SessionUser | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, await sha256Hex(token)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userRows[0];
  if (!user) return null;
  const identityRows = await db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.userId, user.id))
    .limit(1);
  const identity = identityRows[0];
  if (!identity) return null;
  return {
    userId: user.id,
    displayName: user.displayName,
    provider: identity.provider,
    subject: identity.subject,
    primaryEmail: user.primaryEmail,
  };
}

export async function deleteSession(db: LedgerDb, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}
