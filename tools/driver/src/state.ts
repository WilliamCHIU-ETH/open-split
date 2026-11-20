import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SplitWire } from "@open-split/contracts";
import { DriverFailure } from "./failure.ts";

export interface Session {
  readonly provider: "line" | "google";
  readonly name: string;
  readonly subject: string;
  readonly displayName: string;
  readonly userId: string;
  readonly token: string;
}

export interface MemberRecord {
  readonly id: string;
  readonly name: string;
  virtual: boolean;
  subject: string | null;
  claimToken?: string | null;
}

export interface ExpenseRecord {
  readonly id: string;
  readonly payerId: string;
  readonly amount: string;
  readonly currency: string;
  readonly participantIds: readonly string[];
  readonly split: SplitWire;
  voided: boolean;
}

export interface InviteRecord {
  readonly id: string;
  readonly token: string;
  readonly path: string;
  readonly createdBySubject: string;
}

export interface GroupRecord {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly createdBySubject: string;
  readonly members: MemberRecord[];
  readonly expenses: ExpenseRecord[];
  readonly invites: InviteRecord[];
}

export interface DriverState {
  readonly version: 1;
  session: Session | null;
  groups: GroupRecord[];
}

export function emptyState(): DriverState {
  return { version: 1, session: null, groups: [] };
}

export async function loadState(path: string): Promise<DriverState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DriverFailure(1, `狀態檔 ${path} 不是 JSON。`);
  }
  if (!isState(parsed)) throw new DriverFailure(1, `狀態檔 ${path} 不是 driver 第 1 版。`);
  return parsed;
}

export async function saveState(path: string, state: DriverState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isState(value: unknown): value is DriverState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { version?: unknown; groups?: unknown };
  return record.version === 1 && Array.isArray(record.groups);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
