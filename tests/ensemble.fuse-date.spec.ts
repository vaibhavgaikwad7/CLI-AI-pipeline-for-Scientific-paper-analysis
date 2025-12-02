import { describe, it, expect } from "vitest";
import { fuseCandidates } from "../src/ensemble";
import type { ParsedDoc, Sections } from "../src/types";

function makeSections(text = ""): Sections {
  return { headerText: text, body: text };
}

describe("fuseCandidates → document_date handling", () => {
  it("drops the day if there is no posted/published evidence", () => {
    const parser: ParsedDoc = {
      ok: true,
      method: "heuristic",
      sections: makeSections("no header evidence here"),
      candidates: {
        authors: ["Jane Doe"],
        document_date: "2024-05-13", // full day present
      },
    };

    const fused = fuseCandidates({}, parser, {}, makeSections("no evidence"));
    expect(fused.document_date.value).toBe("2024-05"); // day should be dropped
  });

  it("keeps the day when parser.meta.dateFromHeader is true", () => {
    const parser: ParsedDoc = {
      ok: true,
      method: "heuristic",
      sections: makeSections("May 13, 2024 (Published)"),
      candidates: {
        authors: ["Jane Doe"],
        document_date: "2024-05-13",
      },
      // pdf.ts sets this when it actually sees a day-precision date near the top
      meta: { dateFromHeader: true },
    };

    const fused = fuseCandidates({}, parser, {}, makeSections("anything"));
    expect(fused.document_date.value).toBe("2024-05-13"); // full precision retained
  });

  it("prefers parser date over LLM when both exist", () => {
    const parser: ParsedDoc = {
      ok: true,
      method: "heuristic",
      sections: makeSections(),
      candidates: { authors: ["Jane Doe"], document_date: "2024-05" },
    };
    const llm = { document_date: "2023" };

    const fused = fuseCandidates({}, parser, llm, makeSections());
    expect(fused.document_date.value).toBe("2024-05");
    expect(fused.document_date.provenance).not.toBe("llm");
  });
});
