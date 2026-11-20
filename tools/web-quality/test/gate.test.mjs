import { describe, expect, it } from "vitest";
import { unallowlistedFindings } from "../gate.mjs";

const report = {
  guides: [
    {
      guideId: "secure-external-subresources",
      rules: [
        {
          ruleId: "secure-external-subresources",
          findings: [{ file: "index.html", line: 1, message: "missing integrity" }],
        },
      ],
    },
  ],
};

describe("legacy-scan gate", () => {
  it("fails when the allowlist is empty", () => {
    expect(unallowlistedFindings(report, { allow: [] })).toHaveLength(1);
  });

  it("accepts a finding only when the reason is written down", () => {
    expect(
      unallowlistedFindings(report, {
        allow: [{ ruleId: "secure-external-subresources", file: "index.html", reason: " " }],
      }),
    ).toHaveLength(1);
    expect(
      unallowlistedFindings(report, {
        allow: [
          {
            ruleId: "secure-external-subresources",
            file: "index.html",
            reason: "指引要求保留的 fallback。",
          },
        ],
      }),
    ).toEqual([]);
  });
});
