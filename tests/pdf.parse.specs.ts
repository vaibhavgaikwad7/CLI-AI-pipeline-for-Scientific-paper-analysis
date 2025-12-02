import { describe, it, expect, vi, VitestUtils } from "vitest";
import path from "node:path";
import { parseWithPdfParse } from "../src/parsers/pdf";


describe("parseWithPdfParse (integration)", () => {
  // pdf-parse can be a bit slow on Windows — give it some room
  const PDF = path.resolve(__dirname, "../reference-docs/ssrn-5298091.pdf");

  it("parses authors and a reasonable date", async () => {
    const res = await parseWithPdfParse(PDF);

    expect(res.ok).toBe(true);

    // authors: allow either authority or heuristic — but there should be at least 1+ names or null
    const authors = res.candidates?.authors ?? null;
    expect(authors === null || Array.isArray(authors)).toBe(true);
    if (Array.isArray(authors)) {
      expect(authors.length).toBeGreaterThanOrEqual(1);
      // sanity: first author looks like "Fname Lname"
      expect(authors[0]).toMatch(/^[A-Z][a-z]+(?:[-'\u2019][A-Z][a-z]+)?\s+[A-Z][a-z]+/);
    }

    // date: should be ISO-like: YYYY or YYYY-MM or YYYY-MM-DD
    const date = res.candidates?.document_date ?? null;
    if (date) {
      expect(date).toMatch(/^(19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?$/);
    }
  });
});
