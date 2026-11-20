import { ESLint } from "eslint";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditWranglerConfig } from "@open-split/auth";
import { parseJsonc } from "../src/jsonc.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const coreProbe = join(root, "packages/core/src/__violation_probe__.ts");
const workerProbe = join(root, "apps/worker/src/__violation_probe__.ts");

afterEach(async () => {
  await Promise.all([rm(coreProbe, { force: true }), rm(workerProbe, { force: true })]);
});

describe("deployed auth config", () => {
  it("keeps fake identities out of wrangler.jsonc", () => {
    const config = parseJsonc(readFileSync(join(root, "apps/worker/wrangler.jsonc"), "utf8"));
    expect(auditWranglerConfig(config)).toEqual([]);
  });

  it("documents the local LINE Login and LIFF fields", () => {
    const example = readFileSync(join(root, "apps/worker/.dev.vars.example"), "utf8");
    expect(example).toContain("ENVIRONMENT=development");
    expect(example).toContain("AUTH_DEV_IDENTITIES=true");
    expect(example).toContain("LINE_LOGIN_CHANNEL_ID=");
    expect(example).toContain("LINE_LOGIN_CHANNEL_SECRET=");
    expect(example).toContain("LINE_LIFF_ID=");
  });
});

describe("web dependencies", () => {
  it("keeps the shell on React and the shared contract only", () => {
    const pkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-split/contracts", "react", "react-dom"]);
  });
});

describe("executable constraints", () => {
  it("fails eslint and dependency-cruiser on a deliberate violation", async () => {
    await writeFile(
      coreProbe,
      'import fs from "node:fs";\nexport const amount = 1.25;\nexport const snapshot = fs.readFileSync("x");\n',
    );
    await writeFile(
      workerProbe,
      [
        'import { z } from "zod";',
        "export function computeBalances(amount: number): number {",
        "  return amount * 0.1;",
        "}",
        "export const schema = z.string();",
        "",
      ].join("\n"),
    );

    const eslint = new ESLint({ cwd: root });
    const results = await eslint.lintFiles([coreProbe, workerProbe]);
    const ruleIds = results.flatMap((result) => result.messages.map((message) => message.ruleId));
    expect(ruleIds).toContain("open-split/core-no-io");
    expect(ruleIds).toContain("open-split/no-number-money");
    expect(ruleIds).toContain("open-split/no-ledger-math-outside-core");
    expect(ruleIds).toContain("open-split/no-zod-outside-contracts");

    const cruise = spawnSync(
      "pnpm",
      ["exec", "depcruise", "--output-type", "err-long", "--config", ".dependency-cruiser.cjs", coreProbe],
      { cwd: root, encoding: "utf8" },
    );
    const output = `${cruise.stdout}\n${cruise.stderr}`;
    expect(cruise.status, output).not.toBe(0);
    expect(output).toContain("core-is-pure");
    expect(output).toContain("純確定性帳本");
  });
});
