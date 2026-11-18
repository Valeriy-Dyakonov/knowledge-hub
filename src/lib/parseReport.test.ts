import { describe, expect, it } from "vitest";
import { constructs, diagnosisLines, parseReport } from "./parseReport";

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

  it("words the diagnosis of a file and carries it into the report", () => {
    const diagnosis = JSON.stringify({ fixedBy: "strings", kind: "raw", linesBefore: "-3", length: "18", classes: "latin,spaces", punct: "\":", unicode: "U+00A0" });
    const lines = diagnosisLines(diagnosis);
    expect(lines.join(" ")).toContain("U+00A0");
    expect(lines.join(" ")).toContain("18");
    const report = parseReport([{ file: "src/Secret.kt", detail: "", context: "source_file › ERROR", pattern: "class A1 {", first: true, diagnosis }], { extractor: "kotlin-spring" });
    expect(report).toContain(lines[1]);
    expect(report).not.toContain("Secret");
    expect(diagnosisLines("not json")).toEqual([]);
  });
});
