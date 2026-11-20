/**
 * legacy-scan exits 0 even when it finds legacy patterns.
 * The harness fails unless every finding is named in the allowlist with a reason.
 * An empty allowlist means any finding fails the check.
 */

export function unallowlistedFindings(report, allowlist) {
  const allowed = Array.isArray(allowlist?.allow) ? allowlist.allow : [];
  const missed = [];
  for (const guide of report?.guides ?? []) {
    for (const rule of guide.rules ?? []) {
      for (const finding of rule.findings ?? []) {
        const match = allowed.find(
          (entry) =>
            entry.ruleId === rule.ruleId &&
            entry.file === finding.file &&
            typeof entry.reason === "string" &&
            entry.reason.trim().length > 0,
        );
        if (!match) {
          missed.push({
            guideId: guide.guideId,
            ruleId: rule.ruleId,
            file: finding.file,
            line: finding.line,
            message: finding.message,
          });
        }
      }
    }
  }
  return missed;
}
