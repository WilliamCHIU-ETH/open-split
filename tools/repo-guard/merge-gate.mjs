// 合併閘門：把 docs/05-agent-workflow.md 裡 CI 看不到的合併條件變成一個 commit status。
// 分支保護要求 check、accept 與 merge-gate 三個狀態都成功，GitHub auto-merge 才會合併。
//
//   node tools/repo-guard/merge-gate.mjs <PR 編號>                 只印結果
//   node tools/repo-guard/merge-gate.mjs <PR 編號> --report-status 寫入 merge-gate 狀態（CI 用）
//   node tools/repo-guard/merge-gate.mjs <PR 編號> --request-review 留言請 Codex 審查目前的 head
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const MAX_CHANGED_LINES = 1000;
export const OWNER_LABEL = "owner-approved";
export const HOLD_LABEL = "hold";

// 改到這些檔案就要擁有者同意（加上 owner-approved 標籤）。
const OWNER_FILES = new Set([
  "docs/00-intent.md",
  "docs/01-product-review.md",
  "docs/05-agent-workflow.md",
  "CLAUDE.md",
  ".dependency-cruiser.cjs",
  "eslint.config.js",
  "package.json",
  "apps/worker/wrangler.jsonc",
]);
const OWNER_PATTERNS = [/(^|\/)AGENTS\.md$/];
const OWNER_PREFIXES = [
  ".github/workflows/",
  ".cursor/rules/",
  "tools/repo-guard/",
  "tools/constraint-check/",
  "tools/eslint-plugin-open-split/",
  "tools/web-quality/",
];
// 這兩個目錄允許新增檔案，改或刪既有檔案才要擁有者同意。
const APPEND_ONLY_PREFIXES = ["docs/adr/", "apps/worker/migrations/"];

const EXCLUDED_FROM_SIZE = [
  /(^|\/)test\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.md$/,
];

export function parseCodexState(body) {
  const match = /<!--\s*codex-review-state:v1\s*(\{.*?\})\s*-->/s.exec(body ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** 純函式：輸入 PR、檔案、留言，輸出 success／pending／failure 與原因。 */
export function evaluate({ pr, files, comments }) {
  const blockers = [];
  const waits = [];
  const labels = new Set((pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)));
  const ownerApproved = labels.has(OWNER_LABEL);

  if (pr.draft) waits.push("PR 還是草稿");
  if (labels.has(HOLD_LABEL)) blockers.push("有 hold 標籤");

  const ownerTouched = files
    .filter((f) => {
      const paths = [f.filename, f.previous_filename].filter(Boolean);
      return paths.some(
        (p) =>
          OWNER_FILES.has(p) ||
          OWNER_PATTERNS.some((re) => re.test(p)) ||
          OWNER_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
          (APPEND_ONLY_PREFIXES.some((prefix) => p.startsWith(prefix)) && f.status !== "added"),
      );
    })
    .map((f) => f.filename);
  if (ownerTouched.length > 0 && !ownerApproved) {
    blockers.push(`改到需要擁有者同意的檔案（${ownerTouched.join("、")}），要有 ${OWNER_LABEL} 標籤`);
  }

  const changed = files
    .filter((f) => !EXCLUDED_FROM_SIZE.some((re) => re.test(f.filename)))
    .reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  if (changed > MAX_CHANGED_LINES && !ownerApproved) {
    blockers.push(`非測試、非文件變更 ${changed} 行，超過 ${MAX_CHANGED_LINES}：請拆成幾份 PR`);
  }

  const codexComments = comments.filter(
    (c) => c.user?.login === CODEX_LOGIN && parseCodexState(c.body),
  );
  const latest = codexComments.at(-1);
  const parsedState = latest ? parseCodexState(latest.body) : null;
  const review = parsedState?.code_review ?? null;
  const securityReview = parsedState?.security_review ?? null;
  const needsCodexReview = !review || review.commit_sha !== pr.headSha || review.status !== "completed";
  if (needsCodexReview) {
    waits.push(`等 Codex 審查 ${pr.headSha.slice(0, 7)}（可用 --request-review 請它審）`);
  } else if (
    review.has_unresolved_findings ||
    (securityReview?.commit_sha === pr.headSha && securityReview.has_unresolved_findings)
  ) {
    blockers.push("Codex 還有未處理的意見：修掉或回覆後把對話標成 resolved");
  }

  const state = blockers.length > 0 ? "failure" : waits.length > 0 ? "pending" : "success";
  const reasons = [...blockers, ...waits];
  return { state, reasons, changedLines: changed, needsCodexReview };
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  throw new Error("需要 GH_TOKEN，或先 gh auth login");
}

function repo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const result = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  throw new Error("需要 GITHUB_REPOSITORY");
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token()}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function paged(path) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${sep}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function main() {
  const args = process.argv.slice(2);
  const number = Number(args.find((a) => /^\d+$/.test(a)));
  if (!Number.isInteger(number) || number <= 0) {
    console.error("用法：merge-gate.mjs <PR 編號> [--report-status] [--request-review]");
    process.exit(2);
  }
  const r = repo();
  const raw = await api(`/repos/${r}/pulls/${number}`);
  if (raw.state !== "open") {
    console.log(`PR #${number} 不是 open（${raw.state}），略過`);
    return;
  }
  const pr = { draft: raw.draft, labels: raw.labels, headSha: raw.head.sha };
  const files = await paged(`/repos/${r}/pulls/${number}/files`);
  const comments = await paged(`/repos/${r}/issues/${number}/comments`);
  const result = evaluate({ pr, files, comments });

  console.log(`merge-gate PR #${number} @ ${pr.headSha.slice(0, 7)}: ${result.state}`);
  for (const reason of result.reasons) console.log(`- ${reason}`);

  if (args.includes("--report-status")) {
    const description =
      result.state === "success" ? "合併條件都成立" : result.reasons.join("；").slice(0, 138);
    await api(`/repos/${r}/statuses/${pr.headSha}`, {
      method: "POST",
      body: JSON.stringify({ state: result.state, context: "merge-gate", description }),
    });
  }
  if (args.includes("--request-review") && result.needsCodexReview) {
    await api(`/repos/${r}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "@codex review" }),
    });
    console.log("已請 Codex 審查目前的 head");
  }
  if (!args.includes("--report-status") && result.state !== "success") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
