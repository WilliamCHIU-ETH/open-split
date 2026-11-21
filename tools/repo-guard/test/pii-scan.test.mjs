import { describe, expect, it } from "vitest";
import { scanText } from "../pii-scan.mjs";

describe("pii-scan", () => {
  it("allows placeholder domains", () => {
    expect(scanText("a", "owner@example.test bob@mail.example.com x@users.noreply.github.com")).toEqual([]);
  });

  it("flags real-looking emails, LINE ids, and tokens", () => {
    const text = [
      "someone@gmail.com",
      `U${"0123456789abcdef".repeat(2)}`,
      `ghp_${"A".repeat(36)}`,
    ].join("\n");
    expect(scanText("a", text).map((f) => f.kind)).toEqual(["email", "line-user-id", "github-token"]);
  });

  it("honours the ignore marker", () => {
    expect(scanText("a", "someone@gmail.com // pii-scan-ignore")).toEqual([]);
  });
});
