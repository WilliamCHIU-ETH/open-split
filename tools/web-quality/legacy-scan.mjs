import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unallowlistedFindings } from "./gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "apps/web");
const allowlistPath = join(target, "legacy-scan.allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

const result = spawnSync(
  "pnpm",
  ["exec", "modern-web-guidance", "legacy-scan", target, "--json"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DISABLE_TELEMETRY: "1" },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const jsonStart = combined.indexOf("{");
if (result.status !== 0 && jsonStart === -1) {
  console.error(combined);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(combined.slice(jsonStart));
} catch {
  console.error(combined);
  console.error("legacy-scan 沒有印出 JSON。");
  process.exit(1);
}

const missed = unallowlistedFindings(report, allowlist);
if (missed.length > 0) {
  console.error(
    `legacy-scan 在 apps/web 找到 ${String(missed.length)} 筆未放行的舊式寫法。門檻是零筆。` +
      "WHY: 前端要沿用瀏覽器平台，而不是事後再清 legacy。若某筆是指引要求留下的 fallback，請在 apps/web/legacy-scan.allowlist.json 寫明 ruleId、file 與 reason。",
  );
  for (const finding of missed) {
    console.error(`${finding.file}:${String(finding.line)} [${finding.ruleId}] ${finding.message}`);
  }
  process.exit(1);
}

console.log(
  `legacy-scan ok: ${String(report.totalFindings ?? 0)} finding(s), ${String(missed.length)} unallowlisted.`,
);
