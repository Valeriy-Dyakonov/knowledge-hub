import { describe, expect, it } from "vitest";
import { parseDetail, parseReport } from "./parseReport";

describe("parse error report", () => {
  it("reads the detail written by the Rust extractor", () => {
    expect(parseDetail("line 12: `companion object { val T = 1 }`; line 15: `x`")).toEqual([[12, "companion object { val T = 1 }"], [15, "x"]]);
  });

  it("quotes the code around the error lines with secrets removed", async () => {
    const file = Array.from({ length: 20 }, (_, i) => (i === 11 ? "  companion object { val T = 1 }" : i === 9 ? 'val password = "hunter2"' : `line ${i + 1}`)).join("\n");
    const text = await parseReport([{ file: "src/A.kt", detail: "line 12: `companion object { val T = 1 }`" }], async () => file, { extractor: "kotlin-spring", version: "0.1.0", commit: "abcdef123" });
    expect(text).toContain("## src/A.kt");
    expect(text).toContain(">>   12 |   companion object { val T = 1 }");
    expect(text).toContain("     8 | line 8");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("syntax.rs");
    expect(text).toContain("abcdef1");
  });
});
