import { describe, expect, it } from "vitest";
import { scanText } from "../pii-scan.mjs";

// 在執行時才組出命中字串，避免測試檔本身被掃描擋下。
const realEmail = ["someone", "gmail.com"].join("@");

describe("pii-scan", () => {
  it("allows placeholder domains", () => {
    expect(scanText("a", "owner@example.test bob@mail.example.com x@users.noreply.github.com")).toEqual([]);
  });

  it("flags real-looking emails, LINE ids, and tokens", () => {
    const text = [
      realEmail,
      `U${"0123456789abcdef".repeat(2)}`,
      `ghp_${"A".repeat(36)}`,
    ].join("\n");
    expect(scanText("a", text).map((f) => f.kind)).toEqual(["email", "line-user-id", "github-token"]);
  });

  it("honours the ignore marker", () => {
    expect(scanText("a", `${realEmail} // pii-scan-ignore`)).toEqual([]);
  });
});
