// Repo 是公開的。這支掃描擋下真實 Email、LINE user id 與常見權杖格式。
// 假值用 example.test／example.com 網域，或寫 [redacted-email]。
// 真的需要保留某一行時，在同一行加上 pii-scan-ignore，並在 PR 說明理由。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALLOWED_EMAIL_DOMAINS = [
  "example.test",
  "example.com",
  "example.org",
  "users.noreply.github.com",
  "anthropic.com",
];

const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

const PATTERNS = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g },
  { kind: "line-user-id", re: /\bU[0-9a-f]{32}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{24,}\b|\bAKIA[0-9A-Z]{16}\b/g },
];

function allowedEmail(domain) {
  const d = domain.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((ok) => d === ok || d.endsWith(`.${ok}`));
}

/** 回傳一個檔案內容裡的發現，不讀檔。 */
export function scanText(path, text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes("pii-scan-ignore")) return;
    for (const { kind, re } of PATTERNS) {
      for (const match of line.matchAll(re)) {
        if (kind === "email" && allowedEmail(match[1])) continue;
        findings.push({ path, line: index + 1, kind });
      }
    }
  });
  return findings;
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\0").filter((f) => f && !SKIP_FILES.has(f.split("/").pop()));
}

function main() {
  const findings = [];
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    findings.push(...scanText(file, text));
  }
  if (findings.length > 0) {
    // 不印出命中的值，避免把個資再寫進 CI 紀錄。
    for (const f of findings) console.error(`${f.path}:${f.line} ${f.kind}`);
    console.error(
      `pii-scan: ${findings.length} 處疑似個資或權杖。這個 repo 是公開的：改成 example.test 假值或從環境變數注入。見 AGENTS.md「公開 repo 規則」。`,
    );
    process.exit(1);
  }
  console.log("pii-scan: 0 findings");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
