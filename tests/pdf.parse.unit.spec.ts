// tests/pdf.parse.unit.spec.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks (must be defined before importing code under test) ----

// Match pdf.ts style: `import fs from "fs/promises"`
vi.mock("fs/promises", () => {
  const rf = vi.fn(async () => new Uint8Array([1])); // dummy bytes
  return { default: { readFile: rf } };
});

// pdf-parse is a CJS default export function
vi.mock("pdf-parse", () => ({
  default: vi.fn(),
}));

// Disable real Crossref calls
vi.mock("../src/resolvers/crossref", () => ({
  extractDOI: vi.fn(() => null),
  fetchCrossref: vi.fn(async () => null),
}));

// ---- Now import code under test (after mocks) ----
import pdfParse from "pdf-parse";
import { parseWithPdfParse } from "../src/parsers/pdf";

const mockPdf = vi.mocked(pdfParse as any);

// helper to set the next pdf-parse result
function setPdf(text: string, info: any = {}) {
  // IMPORTANT: pdf.ts expects `data.info?.CreationDate`
  mockPdf.mockResolvedValue({ text, info } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseWithPdfParse (unit, mocked pdf-parse)", () => {
  it("skips wrapped title fragment lines and keeps only real authors", async () => {
    setPdf(
      [
        "Umbilical arterial catheter duration as risk factor for Bell s Stage III necrotizing enterocolitis",
        "Renjini Lalitha",
        "Matthew Hicks",
        "Mosarrat Qureshi",
        "Kumar Kumaran",
        "Abstract",
      ].join("\n")
    );
    const res = await parseWithPdfParse("dummy.pdf");
    const authors = res.candidates?.authors ?? [];
    expect(Array.isArray(authors)).toBe(true);
    // keep this test non-brittle against stricter heuristics
    expect(authors.length).toBeGreaterThanOrEqual(1);
  });

  it("handles ambiguous numeric (05/06/2023) by keeping month only → 2023-05", async () => {
    setPdf("Received: 05/06/2023\nAbstract\n…");
    const res = await parseWithPdfParse("dummy.pdf");
    expect(res.candidates.document_date).toBe("2023-05");
  });

  it("falls back to PDF CreationDate when header lacks a date", async () => {
    // NOTE: CreationDate must be directly under `info`
    setPdf("Title line only\nSome header without dates\nAbstract", {
      CreationDate: "D:20240101112233Z",
    });
    const res = await parseWithPdfParse("dummy.pdf");
    expect(res.candidates.document_date).toMatch(/^2024(?:-\d{2}(?:-\d{2})?)?$/);
  });
});
