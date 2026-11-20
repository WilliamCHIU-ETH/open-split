/** Enough for wrangler.jsonc: line comments, block comments, and strings. No trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let mode: "code" | "string" | "line" | "block" = "code";
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (mode === "code") {
      if (current === '"') {
        mode = "string";
        out += current;
      } else if (current === "/" && next === "/") {
        mode = "line";
        index += 1;
      } else if (current === "/" && next === "*") {
        mode = "block";
        index += 1;
      } else {
        out += current;
      }
    } else if (mode === "string") {
      out += current;
      if (current === "\\") {
        out += next;
        index += 1;
      } else if (current === '"') {
        mode = "code";
      }
    } else if (mode === "line") {
      if (current === "\n") {
        mode = "code";
        out += current;
      }
    } else if (current === "*" && next === "/") {
      mode = "code";
      index += 1;
    }
  }
  return JSON.parse(out) as unknown;
}
