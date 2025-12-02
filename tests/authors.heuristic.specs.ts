import { describe, it, expect } from "vitest";
// We’ll import the public function by exercising fuseCandidates with only parser authors,
// since extractAuthorsHeuristic is internal to pdf.ts.
import { fuseCandidates } from "../src/ensemble";
import type { ParsedDoc, Sections } from "../src/types";

function makeSections(headerText: string): Sections {
  return { headerText, body: headerText };
}

describe("author extraction (heuristic, via fuse)", () => {
  it("filters out affiliations/orgs and keeps person-like names", () => {
    const header = `
      A Systematic Review of X
      Jessica Ann Gomez, PhD, APRN, NNP-BC
      Karla Abela, PhD
      Section of Neonatal Medicine, School of Public Health, Imperial College London
      Corresponding author: someone@university.edu
      Abstract
    `;

    const parser: ParsedDoc = {
      ok: true,
      method: "heuristic",
      sections: makeSections(header),
      candidates: {
        // Simulate what pdf.ts would have produced:
        authors: ["Jessica Ann Gomez", "Karla Abela", "Imperial College London"], // last entry should be filtered later
        document_date: "2024-01-01",
      },
    };

    const fused = fuseCandidates({}, parser, {}, makeSections(header));
    const names = fused.authors.value ?? [];

    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("Jessica Ann Gomez");
    expect(names).toContain("Karla Abela");

    // Ensure affiliation-like content isn’t treated as an author
    const asString = names.join(" ").toLowerCase();
    expect(asString).not.toMatch(/imperial|college|university|hospital/);
  });
});
