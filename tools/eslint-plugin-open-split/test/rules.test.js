import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin from "../index.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tester.run("no-number-money", plugin.rules["no-number-money"], {
  valid: [
    {
      filename: "/workspace/packages/core/src/money.ts",
      code: "export function minorFromSafeInteger(value: number): bigint { return BigInt(value); }",
    },
    {
      filename: "/workspace/apps/web/src/App.tsx",
      code: "export const padding = 16;",
    },
  ],
  invalid: [
    {
      filename: "/workspace/apps/worker/src/preview.ts",
      code: "export function preview(amount: number): number { return amount * 0.1; }",
      errors: [{ messageId: "numberMoney" }, { messageId: "moneyArithmetic" }, { messageId: "floatLiteral" }],
    },
    {
      filename: "/workspace/packages/core/src/bad.ts",
      code: "export const ratio = 0.1;",
      errors: [{ messageId: "floatLiteral" }],
    },
  ],
});

tester.run("no-ledger-math-outside-core", plugin.rules["no-ledger-math-outside-core"], {
  valid: [
    {
      filename: "/workspace/packages/core/src/balance.ts",
      code: "export function computeBalances() { return []; }",
    },
    {
      filename: "/workspace/apps/worker/src/index.ts",
      code: "export function health() { return { ok: true }; }",
    },
  ],
  invalid: [
    {
      filename: "/workspace/apps/worker/src/local.ts",
      code: "export function computeBalances(amount: number) { return amount; }",
      errors: [{ messageId: "localLedger" }],
    },
  ],
});

tester.run("no-zod-outside-contracts", plugin.rules["no-zod-outside-contracts"], {
  valid: [
    {
      filename: "/workspace/packages/contracts/src/money.ts",
      code: 'import { z } from "zod"; export const s = z.string();',
    },
  ],
  invalid: [
    {
      filename: "/workspace/apps/worker/src/local.ts",
      code: 'import { z } from "zod"; export const s = z.string();',
      errors: [{ messageId: "zodImport" }],
    },
  ],
});

tester.run("core-no-io", plugin.rules["core-no-io"], {
  valid: [
    {
      filename: "/workspace/packages/core/src/money.ts",
      code: 'import { minor } from "./money.ts"; export const x = minor;',
    },
    {
      filename: "/workspace/apps/worker/src/index.ts",
      code: 'import { Hono } from "hono"; export const app = Hono;',
    },
  ],
  invalid: [
    {
      filename: "/workspace/packages/core/src/bad.ts",
      code: 'import fs from "node:fs"; export const read = fs;',
      errors: [{ messageId: "ioImport" }],
    },
  ],
});
