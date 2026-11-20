import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run, type DriverIo } from "../src/run.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directories: string[] = [];
let worker: ChildProcess | undefined;
let persistDir = "";

beforeAll(async () => {
  persistDir = await mkdtemp(join(tmpdir(), "open-split-d1-"));
  const port = await freePort();
  const inspectorPort = await freePort();
  await execWrangler([
    "d1",
    "migrations",
    "apply",
    "open-split",
    "--local",
    "--persist-to",
    persistDir,
    "--force",
  ]);
  const logs: string[] = [];
  worker = spawn(
    "pnpm",
    [
      "--filter",
      "@open-split/worker",
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--ip",
      "127.0.0.1",
      "--local",
      "--persist-to",
      persistDir,
      "--var",
      "ENVIRONMENT:test",
      "--var",
      "AUTH_DEV_IDENTITIES:true",
      "--log-level",
      "info",
      "--show-interactive-dev-session",
      "false",
    ],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  worker.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  worker.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (logs.join("").includes("Ready on")) break;
    if (worker.exitCode !== null) break;
    await delay(200);
  }
  if (!logs.join("").includes("Ready on")) {
    throw new Error(`Worker 沒有啟動。\n${logs.join("")}`);
  }
  process.env.OPEN_SPLIT_API_URL = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  delete process.env.OPEN_SPLIT_API_URL;
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {
      worker.kill("SIGTERM");
    }
  }
  if (persistDir) await rm(persistDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("driver", () => {
  it("runs the slice 1 ledger against the local worker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "open-split-driver-"));
    directories.push(dir);
    const output = await capture(["accept", "--state", join(dir, "state.json")]);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(output.stdout).toContain("login.subject: dev-line:alice");
    expect(output.stdout).toContain("login.subject: dev-google:bob");
    expect(output.stdout).toContain("login.subject: dev-line:kenji");
    expect(output.stdout).toContain("member_virtual: false");
    expect(output.stdout).toContain("member_virtual: true");
    expect(output.stdout).toContain("activity: member.virtual_created");
    expect(output.stdout).toContain("expense_split: exact");
    expect(output.stdout).toContain("expense_split: percentage");
    expect(output.stdout).toContain("expense_split: shares");
    expect(output.stdout).toContain("expense_participants: 2");
    expect(output.stdout).toContain("expense_updated:");
    expect(output.stdout).toContain("expense_voided:");
    expect(output.stdout).toContain("invariant.shares_sum_to_amount: pass");
    expect(output.stdout).toContain("invariant.balances_sum_to_zero: pass");
    expect(output.stdout).toContain("invariant.balances_match_splits: pass");
    expect(output.stdout).toContain("invariant.claim_keeps_member_id: pass");
    expect(output.stdout).toContain("invariant.claim_keeps_shares: pass");
    expect(output.stdout).toContain("activity: member.claimed");
    expect(output.stdout).toContain("join.already_member: false");
    expect(output.stdout).toContain("invariant.transfer_bound: pass");
    expect(output.stdout).toContain("invariant.settled_to_zero: pass");
    expect(output.stdout).toContain("invite_path: /invite/");
  });

  it("exercises the group created in this run when the state file already has one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "open-split-driver-"));
    directories.push(dir);
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          session: null,
          groups: [
            {
              id: "grp_old",
              name: "舊群",
              currency: "TWD",
              createdBySubject: "dev-line:someone",
              members: [{ id: "mem_old", name: "Old", virtual: false, subject: "dev-line:someone" }],
              expenses: [],
              invites: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const output = await capture(["accept", "--state", statePath]);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(output.stdout).not.toContain("group_id: grp_old");

    const saved = JSON.parse(await readFile(statePath, "utf8")) as {
      groups: {
        id: string;
        currency: string;
        expenses: unknown[];
        invites: unknown[];
        members: { name: string; virtual: boolean }[];
      }[];
    };
    const oldGroup = saved.groups.find((group) => group.id === "grp_old");
    const created = saved.groups.find((group) => group.id !== "grp_old");
    expect(oldGroup?.expenses).toEqual([]);
    expect(oldGroup?.invites).toEqual([]);
    expect(oldGroup?.members).toHaveLength(1);
    expect(created?.currency).toBe("JPY");
    expect(created?.members).toHaveLength(4);
    expect(created?.expenses).toHaveLength(6);
    expect(created?.invites).toHaveLength(1);
    expect(created?.members.some((member) => member.name === "店員" && member.virtual === false)).toBe(true);
  });

  it("signs bob in with the secondary Google provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "open-split-driver-"));
    directories.push(dir);
    const output = await capture([
      "login",
      "--as",
      "bob",
      "--provider",
      "google",
      "--state",
      join(dir, "state.json"),
    ]);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(output.stdout).toContain("login.subject: dev-google:bob");
  });

  it("refuses fake login when pointed at production", async () => {
    const output = await capture(["login", "--as", "alice", "--environment", "production"]);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain("AUTH_DEV_IDENTITIES");
  });

  it("records an exact split and a virtual member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "open-split-driver-"));
    directories.push(dir);
    const state = join(dir, "state.json");
    const login = await capture(["login", "--as", "alice", "--state", state]);
    expect(login.exitCode, login.stderr).toBe(0);
    const group = await capture(["create-group", "--name", "不平均", "--currency", "JPY", "--state", state]);
    expect(group.exitCode, group.stderr).toBe(0);
    const groupId = /group_id: (\S+)/.exec(group.stdout)?.[1] ?? "";
    const ownerId = /owner_member_id: (\S+)/.exec(group.stdout)?.[1] ?? "";
    const guest = await capture(["add-member", "--group", groupId, "--name", "店員", "--virtual", "--state", state]);
    expect(guest.exitCode, guest.stderr).toBe(0);
    expect(guest.stdout).toContain("member_virtual: true");
    expect(guest.stdout).toContain("claim_path: /claim/");
    const guestId = /member_id: (\S+)/.exec(guest.stdout)?.[1] ?? "";
    const output = await capture([
      "add-expense",
      "--group",
      groupId,
      "--payer",
      ownerId,
      "--amount",
      "3000",
      "--currency",
      "JPY",
      "--participants",
      `${ownerId},${guestId}`,
      "--split",
      "exact",
      "--amounts",
      `${ownerId}=1000,${guestId}=2000`,
      "--state",
      state,
    ]);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(output.stdout).toContain("expense_split: exact");
    expect(output.stdout).toContain("invariant.shares_sum_to_amount: pass");
    expect(output.stdout).toContain("invariant.balances_match_splits: pass");
  });

  it("prints the dinner story without a state file", async () => {
    const output = await capture(["demo"]);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("balance.me: 2400");
    expect(output.stdout).toContain("invariant.balances_sum_to_zero: pass");
  });
});

async function capture(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: DriverIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const exitCode = await run(argv, io);
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function execWrangler(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "@open-split/worker", "exec", "wrangler", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler ${args.join(" ")} 結束碼 ${String(code)}\n${output}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("沒有可用的連接埠。"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
