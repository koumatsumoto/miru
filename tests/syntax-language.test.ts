import { describe, expect, it } from "vite-plus/test";
import {
  fenceLanguage,
  fileLanguage,
  isHighlightable,
  syntaxLimits,
} from "../src/web/syntax-language";

describe("syntax highlighting eligibility", () => {
  it("selects known file grammars and aliases without detecting arbitrary text", () => {
    expect(fileLanguage("tsconfig.JSON")).toBe("json");
    expect(fileLanguage("entry.mts")).toBe("typescript");
    expect(fileLanguage("page.TSX")).toBe("tsx");
    expect(fileLanguage("Dockerfile.dev")).toBe("docker");
    expect(fileLanguage(".zshrc")).toBe("shellscript");
    expect(fileLanguage("README")).toBeUndefined();
    expect(fileLanguage("script.txt")).toBeUndefined();
  });
  it("only uses explicitly supported fence languages", () => {
    expect(fenceLanguage(" Py ")).toBe("python");
    expect(fenceLanguage("bash")).toBe("shellscript");
    expect(fenceLanguage("c++")).toBe("cpp");
    expect(fenceLanguage("mermaid")).toBeUndefined();
    expect(fenceLanguage("__proto__")).toBeUndefined();
  });
  it("rejects empty and oversized inputs or long lines before creating a worker", () => {
    expect(isHighlightable("")).toBe(false);
    expect(isHighlightable("x".repeat(syntaxLimits.line))).toBe(true);
    expect(isHighlightable("x".repeat(syntaxLimits.line + 1))).toBe(false);
    expect(isHighlightable("x\r\n".repeat(syntaxLimits.lines))).toBe(false);
    expect(isHighlightable("x".repeat(syntaxLimits.block + 1))).toBe(false);
  });
});
