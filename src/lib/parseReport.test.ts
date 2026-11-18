import { describe, expect, it } from "vitest";
import { constructs, parseReport } from "./parseReport";

const problem = (file: string, pattern: string) => ({ file, detail: "line 3: `x`", context: "class_declaration › class_body › ERROR", pattern });

describe("parse error report", () => {
  it("groups errors by construct, most widespread first", () => {
    const list = constructs([problem("a/A.kt", "companion object { val A1 = 0 }"), problem("b/B.kt", "companion object { val A1 = 0 }"), problem("b/B.kt", "x1 = \"…\"")]);
    expect(list.map((c) => [c.files.length, c.count])).toEqual([[2, 2], [1, 1]]);
  });

  it("contains the anonymised constructs and no file names", () => {
    const text = parseReport([problem("src/main/kotlin/com/acme/secret/Billing.kt", "companion object { val A1 = 0 }")], { extractor: "kotlin-spring", version: "0.1.0" });
    expect(text).toContain("companion object { val A1 = 0 }");
    expect(text).toContain("class_declaration › class_body › ERROR");
    expect(text).toContain("syntax.rs");
    expect(text).not.toContain("acme");
    expect(text).not.toContain("Billing");
    expect(text).not.toContain("line 3");
  });
});
