import { mkdtemp, rm } from "node:fs/promises";
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
