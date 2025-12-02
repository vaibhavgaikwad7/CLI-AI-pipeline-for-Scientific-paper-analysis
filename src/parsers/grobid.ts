import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";
// @ts-ignore CJS default
import pdfParse from "pdf-parse";
import { ensureFetch, normalizeText, parsePdfCreationDate, toISODate } from "../utils";
import { Metadata, ParsedDoc, Sections } from "../types";

export const parseWithGrobid = async (pdfPath: string, baseUrl: string): Promise<ParsedDoc | null> => {
  try {
    const fetchImpl = await ensureFetch();
    const { FormData } = await import("formdata-node");
    const { fileFromPath } = await import("formdata-node/file-from-path");
    const form = new FormData();
    const file = await fileFromPath(pdfPath);
    form.set("input", file);

    const res = await fetchImpl(`${baseUrl}/api/processFulltextDocument`, { method: "POST", body: form as any });
    if (!res.ok) throw new Error(`GROBID HTTP ${res.status}`);
    const teiXml = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const tei = parser.parse(teiXml);
    const teiHeader = tei?.TEI?.teiHeader;
    const fileDesc = teiHeader?.fileDesc;
    const profileDesc = teiHeader?.profileDesc;
    const textBody = tei?.TEI?.text?.body;

    const title = fileDesc?.titleStmt?.title ?? null;
    const authorElems = (fileDesc?.titleStmt?.author || []) as any[];
    const authors = Array.isArray(authorElems)
      ? authorElems
        .map((a: any) => {
          const p = a?.persName;
          if (!p) return null;
          const given = p?.forename?.[0] || p?.forename || "";
          const surname = p?.surname || "";
          const name = `${[given, surname].filter(Boolean).join(" ")}`.trim();
          return name || null;
        })
        // use a type guard so TS narrows to string[]
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    : null;
    const abstract = profileDesc?.abstract?.p || null;
    const pubDate = fileDesc?.publicationStmt?.date?.when || fileDesc?.publicationStmt?.date || null;

    const sections: Sections = { title: typeof title === "string" ? title : undefined };
    const getText = (node: any): string => {
      if (!node) return "";
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(getText).join("\n");
      if (node.p) return getText(node.p);
      if (node.s) return getText(node.s);
      return Object.values(node).map(getText).join("\n");
    };
    const divs = Array.isArray(textBody?.div) ? textBody.div : textBody ? [textBody.div] : [];
    const findByHead = (names: string[]) => {
      for (const div of divs) {
        const headText = (div?.head && getText(div.head))?.toLowerCase?.() || "";
        if (names.some(n => headText.includes(n))) return getText(div);
      }
      return "";
    };
    sections.abstract = typeof abstract === "string" ? abstract : Array.isArray(abstract) ? abstract.join("\n") : undefined;
    sections.methods = findByHead(["method","materials and methods","experimental","approach","study design","procedure"]);
    sections.results = findByHead(["result","finding","evaluation","experiment"]);
    sections.discussion = findByHead(["discussion"]);
    sections.conclusion = findByHead(["conclusion"]);

    const pdfData = await pdfParse(await fs.readFile(pdfPath));
    const raw = normalizeText(pdfData.text || "");
    sections.body = raw;
    sections.headerText = raw.slice(0, 4000);

    const candidates: Partial<Metadata> = {
      authors: authors && authors.length ? authors : null,
      document_date: toISODate(pubDate) || parsePdfCreationDate((pdfData as any).info?.CreationDate) || null,
      
    };
    
    return { ok: true, method: "grobid", sections, candidates };
  } catch (e) {
    return null;
  }
};
