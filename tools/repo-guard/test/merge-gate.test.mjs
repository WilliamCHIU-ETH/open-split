import { describe, expect, it } from "vitest";
import { CODEX_LOGIN, evaluate, parseCodexState } from "../merge-gate.mjs";

const sha = "a".repeat(40);
const codex = (state, login = CODEX_LOGIN) => ({
  user: { login },
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: state })} -->`,
});
const clean = codex({ commit_sha: sha, status: "completed", has_unresolved_findings: false });
const base = { pr: { draft: false, labels: [], headSha: sha }, files: [], comments: [clean] };
const file = (filename, status = "modified", additions = 10) => ({ filename, status, additions, deletions: 0 });

describe("merge-gate", () => {
  it("passes a small reviewed PR", () => {
    expect(evaluate({ ...base, files: [file("apps/web/src/App.tsx")] }).state).toBe("success");
  });

  it("waits when Codex reviewed an older commit", () => {
    const old = codex({ commit_sha: "b".repeat(40), status: "completed", has_unresolved_findings: false });
    expect(evaluate({ ...base, comments: [old] }).state).toBe("pending");
  });

  it("ignores review-state comments from other accounts", () => {
    const fake = codex({ commit_sha: sha, status: "completed", has_unresolved_findings: false }, "someone");
    expect(evaluate({ ...base, comments: [fake] }).state).toBe("pending");
  });

  it("fails on unresolved Codex findings", () => {
    const open = codex({ commit_sha: sha, status: "completed", has_unresolved_findings: true });
    expect(evaluate({ ...base, comments: [open] }).state).toBe("failure");
  });

  it("uses the latest Codex summary", () => {
    const open = codex({ commit_sha: sha, status: "completed", has_unresolved_findings: true });
    expect(evaluate({ ...base, comments: [open, clean] }).state).toBe("success");
  });

  it("needs the owner label for intent, rules, guardrails, and deploy config", () => {
    const protectedPaths = [
      "docs/00-intent.md",
      "AGENTS.md",
      "apps/worker/AGENTS.md",
      "CLAUDE.md",
      ".cursor/rules/web-frontend.mdc",
      ".dependency-cruiser.cjs",
      "eslint.config.js",
      "package.json",
      "apps/worker/wrangler.jsonc",
      ".github/workflows/ci.yml",
      "tools/repo-guard/merge-gate.mjs",
      "tools/constraint-check/test/harness.test.ts",
      "tools/eslint-plugin-open-split/index.js",
      "tools/web-quality/budget.mjs",
    ];
    for (const name of protectedPaths) {
      expect(evaluate({ ...base, files: [file(name)] }).state, name).toBe("failure");
      const approved = { ...base, pr: { ...base.pr, labels: [{ name: "owner-approved" }] } };
      expect(evaluate({ ...approved, files: [file(name)] }).state, name).toBe("success");
    }
    expect(evaluate({ ...base, files: [file("apps/web/package.json")] }).state).toBe("success");
  });

  it("blocks unresolved security_review findings on the current head only", () => {
    const withSecurityIssue = {
      user: { login: CODEX_LOGIN },
      body: `<!-- codex-review-state:v1 ${JSON.stringify({
        code_review: { commit_sha: sha, status: "completed", has_unresolved_findings: false },
        security_review: { commit_sha: sha, status: "completed", has_unresolved_findings: true },
      })} -->`,
    };
    const staleSecurityIssue = {
      user: { login: CODEX_LOGIN },
      body: `<!-- codex-review-state:v1 ${JSON.stringify({
        code_review: { commit_sha: sha, status: "completed", has_unresolved_findings: false },
        security_review: { commit_sha: "b".repeat(40), status: "completed", has_unresolved_findings: true },
      })} -->`,
    };
    expect(evaluate({ ...base, comments: [withSecurityIssue] }).state).toBe("failure");
    expect(evaluate({ ...base, comments: [staleSecurityIssue] }).state).toBe("success");
  });

  it("allows new ADRs and migrations but not edits to existing ones", () => {
    expect(evaluate({ ...base, files: [file("docs/adr/0010-x.md", "added")] }).state).toBe("success");
    expect(evaluate({ ...base, files: [file("apps/worker/migrations/0005_x.sql", "added")] }).state).toBe("success");
    expect(evaluate({ ...base, files: [file("docs/adr/0003-auth-separation.md")] }).state).toBe("failure");
    expect(evaluate({ ...base, files: [file("apps/worker/migrations/0001_slice1.sql")] }).state).toBe("failure");
  });

  it("catches a rename out of a protected path", () => {
    const renamed = { ...file("docs/old.md", "renamed"), previous_filename: "docs/00-intent.md" };
    expect(evaluate({ ...base, files: [renamed] }).state).toBe("failure");
  });

  it("counts size without tests, docs, and the lockfile", () => {
    const big = [file("apps/worker/src/a.ts", "modified", 600), file("apps/worker/src/b.ts", "modified", 500)];
    expect(evaluate({ ...base, files: big }).state).toBe("failure");
    const testsOnly = [file("apps/worker/test/a.test.ts", "modified", 5000), file("pnpm-lock.yaml", "modified", 5000)];
    expect(evaluate({ ...base, files: testsOnly }).state).toBe("success");
  });

  it("holds on the hold label and waits on drafts", () => {
    expect(evaluate({ ...base, pr: { ...base.pr, labels: ["hold"] } }).state).toBe("failure");
    expect(evaluate({ ...base, pr: { ...base.pr, draft: true } }).state).toBe("pending");
  });

  it("parses the Codex state marker", () => {
    expect(parseCodexState(clean.body)?.code_review?.commit_sha).toBe(sha);
    expect(parseCodexState("no marker")).toBeNull();
  });
});
