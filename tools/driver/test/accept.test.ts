import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type DriverIo } from "../src/run.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("driver", () => {
  it("runs login, group, expense, and share link for alice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "open-split-driver-"));
    directories.push(dir);
    const output = await capture(["accept", "--state", join(dir, "state.json")]);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("login.subject: dev-line:alice");
    expect(output.stdout).toContain("member_virtual: true");
    expect(output.stdout).toContain("invariant.balances_sum_to_zero: pass");
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
      groups: { id: string; currency: string; expenses: unknown[]; invites: unknown[]; members: unknown[] }[];
    };
    const oldGroup = saved.groups.find((group) => group.id === "grp_old");
    const created = saved.groups.find((group) => group.id !== "grp_old");
    expect(oldGroup?.expenses).toEqual([]);
    expect(oldGroup?.invites).toEqual([]);
    expect(oldGroup?.members).toHaveLength(1);
    expect(created?.currency).toBe("JPY");
    expect(created?.members).toHaveLength(2);
    expect(created?.expenses).toHaveLength(1);
    expect(created?.invites).toHaveLength(1);
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
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("login.subject: dev-google:bob");
  });

  it("refuses fake login when pointed at production", async () => {
    const output = await capture(["login", "--as", "alice", "--environment", "production"]);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain("AUTH_DEV_IDENTITIES");
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
