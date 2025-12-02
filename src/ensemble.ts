import { Field, Metadata, ParsedDoc, Sections } from "./types";
import { toISODate } from "./utils";

/* Preprint detection */
export function preprintSignals(sections: Sections): number {
  const t = ((sections.headerText || "") + "\n" + (sections.body || "")).toLowerCase();
  const cues = [
    /\bpreprint\b/,
    /has not been peer reviewed/,
    /\bssrn\b/,
    /social\s+science\s+research\s+network/,
    /\barxiv\b|arxiv\.org\/abs\//,
    /\bmedrxiv\b/,
    /\bbiorxiv\b/,
    /\bresearch\s*square\b/,
    /electronic copy available at:\s*ssrn\.com/i,
    /this version posted|first posted|posted:\s*\w+\s+\d{1,2},\s+\d{4}/i,
  ];
  let score = 0;
  for (const re of cues) if (re.test(t)) score++;
  return score;
}

export function strongPreprintHeuristic(sections: Sections): string | null {
  return preprintSignals(sections) >= 2 ? "Preprint" : null;
}

/* Doc-type normalization
 */
const normalizeDocType = (s: string | null): string | null => {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("preprint")) return "Preprint";
  if (t.includes("conference") || t.includes("proceedings") || t.includes("abstract"))
    return "Conference Paper";
  if (t.includes("journal")) return "Journal Article";
  if (t.includes("thesis") || t.includes("dissertation")) return "Thesis";
  return s.trim();
};

/* Person-name heuristics (tight)*/

/** Affiliation/org cue words (lowercase). */
const ORG_WORDS = [
  // classic
  "university","univ","institute","department","dept","school","college","laboratory",
  "centre","center","hospital","clinic","commission","authority","ministry","agency",
  "federal","court","board","foundation","trust","unit","division","bureau","office",
  // added to catch leaks like “Perinatal Medicine”, “Health Sciences”, etc.
  "medicine","medical","health","healthcare","science","sciences","research",
  "perinatal","neonatal","pediatrics","pediatric","childrens","children's",
  "london","ontario","canada","united","kingdom","usa"
];

/** Typical non-author labels we’ve seen in headers (lowercased match). */
const DOC_LABELS = [
  "original article","research article","review article","systematic review",
  "meta-analysis","meta analysis","brief report","short report","short communication",
  "case report","editorial","commentary","perspective","viewpoint","protocol",
  "special article","open access","letter to the editor","technical note",
  "methods article","article info","article information","article history",
  "how to cite","correspondence"
];

function isDocLabelLine(s: string): boolean {
  const x = s.toLowerCase().replace(/\s+/g, " ");
  return DOC_LABELS.some(p => x.includes(p));
}

function hasOrgCue(s: string): boolean {
  const x = s.toLowerCase();
  return ORG_WORDS.some(w => new RegExp(`\\b${w}\\b`, "i").test(x));
}

function isLikelyPersonName(s: string): boolean {
  // Strip a leading “By ”
  const name = s.replace(/^\s*by\s+/i, "").trim();

  // Reject document labels and affiliation/org lines
  if (isDocLabelLine(name) || hasOrgCue(name)) return false;

  // Token rules: 2–5 tokens; allow initials and hyphenated parts
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;

  // Person-like token pattern
  const tokenOK = (tok: string) =>
    /^[A-Z][a-z'’-]+$/.test(tok) ||        // "Viola" / "O’Connor"
    /^[A-Z]\.$/.test(tok) ||               // "A."
    /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(tok); // "Smith-Jones"

  // Require most tokens to pass (e.g., 3/4, or 2/2)
  let good = 0;
  for (const tok of tokens) if (tokenOK(tok)) good++;
  return good >= Math.max(2, tokens.length - 1);
}

/** Clean & dedupe author list from either parser or LLM output. */
const cleanAuthors = (a: string[] | null): string[] | null => {
  if (!a || !a.length) return null;

  // Strip degrees and leading "By "
  const dropDegree = /\s*,\s*(PhD|MSc|BSc|MD|MPH|MBA|Ph\.?D\.?)\b/gi;

  const normalized = a
    .map(s => (typeof s === "string" ? s : ""))
    .map(s => s.replace(dropDegree, "").replace(/^\s*by\s+/i, "").replace(/\s+/g, " ").trim())
    .filter(s => s.length >= 3)
    .filter(s => !isDocLabelLine(s))
    .filter(s => isLikelyPersonName(s));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of normalized) {
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(n);
    }
  }
  return out.length ? out.slice(0, 24) : null;
};

/* Generic text field scorer
 */
const qualityTextField = (v: string | null, prov: any): Field<string> => {
  const txt = v ? v.replace(/\s+/g, " ").trim() : null;
  const hasLetters = txt && /[a-z]/i.test(txt);
  const len = txt ? txt.length : 0;

  let confidence = 0.5;
  if (hasLetters && len >= 30) confidence = 0.85;
  if (len > 1200) confidence = Math.max(confidence, 0.9);
  const capped = txt && txt.length > 1200 ? txt.slice(0, 1200) : txt || null;

  return { value: capped, confidence, provenance: prov };
};

/* Guess doc type from text */
export const guessDocumentType = (sections: Sections): string | null => {
  const t = (sections.headerText || "").toLowerCase();
  if (preprintSignals(sections) >= 2) return "Preprint";
  if (/\barxiv\b|arxiv\.org\/abs\//.test(t)) return "Preprint";
  if (/proceedings of|in:\s|acm\b|ieee\b|springer\b|aaai\b|neurips\b|icml\b|iclr\b/.test(t))
    return "Conference Paper";
  if (/doi:10\./.test(t) && /(vol\.|issue|journal|nature|science|elsevier|wiley|springer)/.test(t))
    return "Journal Article";
  if (/thesis|dissertation/.test(t)) return "Thesis";
  return "Journal/Conference Article";
};

/* Date evidence & sanitizer (aligned with pdf.ts) */

/**
 * Recognize “evidence” phrases that justify keeping day precision:
 * - verbs: posted / this version posted / published / published online / accepted / received / available online / first published / epub ahead of print
 * - date shapes: MDY (“May 2, 2024”) OR DMY (“2 May 2024”) OR ISO (“2024-05-02”)
 * - allow optional colon/dash between verb and date
 */
function hasPostedDateEvidence(sections: Sections): boolean {
  const t = ((sections.headerText || "") + "\n" + (sections.body || "")).toLowerCase();
  const verb =
    "(?:posted|this\\s+version\\s+posted|published(?:\\s+online)?|accepted|received|available\\s+online|first\\s+published|epub(?:\\s+ahead\\s+of\\s+print)?)";
  const month =
    "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const dateMDY = `${month}\\s+\\d{1,2},\\s*\\d{4}`;
  const dateDMY = `\\d{1,2}\\s+${month}\\s+\\d{4}`;
  const dateISO = `\\d{4}-\\d{2}-\\d{2}`;
  const pat = new RegExp(`${verb}\\s*[:\\-–]?\\s*(?:${dateMDY}|${dateDMY}|${dateISO})`, "i");
  return pat.test(t);
}

function isValidISO(iso: string): boolean {
  if (/^\d{4}$/.test(iso)) return true;
  const m = iso.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return false;
  const year = +m[1], month = +m[2], day = m[3] ? +m[3] : null;
  if (month < 1 || month > 12) return false;
  if (day !== null) {
    if (day < 1 || day > 31) return false;
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return false;
  }
  return true;
}

/**
 * - Keeps ISO-like inputs as-is (YYYY | YYYY-MM | YYYY-MM-DD).
 * - Otherwise converts via toISODate.
 * - Rejects future or <1900 years.
 * - Drops day precision unless we have header “evidence” OR pdf.ts flagged meta.dateFromHeader.
 * - If day is dropped, keeps YYYY-MM if present, else YYYY.
 */
function sanitizeDocumentDate(
  dateStr: string | null,
  sections: Sections,
  forceAcceptDayFromHeader: boolean = false
): string | null {
  if (!dateStr) return null;

  // If it already looks like ISO, keep verbatim; else try to normalize.
  const isoLike = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
  const iso = isoLike.test(dateStr) ? dateStr : (toISODate(dateStr || undefined) || null);
  if (!iso) return null;

  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(iso)) return null;

  const y = parseInt(iso.slice(0, 4), 10);
  const now = new Date().getFullYear();
  if (y < 1900 || y > now + 1) return null;

  const hasDay = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  if (hasDay && !hasPostedDateEvidence(sections) && !forceAcceptDayFromHeader) {
    // keep year/month (if present) rather than nulling everything
    const ym = iso.match(/^(\d{4}-\d{2})-/);
    return ym ? ym[1] : String(y);
  }
  return isValidISO(iso) ? iso : null;
}

/* Candidate chooser
*/
function chooseField<T>(cands: Field<T>[], fitness: (v: T | null) => number): Field<T> {
  let best = cands[0];
  for (const c of cands.slice(1)) {
    const fBest = fitness(best.value);
    const fCand = fitness(c.value);
    if (fCand > fBest || (fCand === fBest && (c.confidence || 0) > (best.confidence || 0))) best = c;
  }
  return { ...best, provenance: best.provenance };
}

/* Fusion
*/
export function fuseCandidates(
  base: Partial<Metadata>,
  parser: ParsedDoc | null,
  llm: any,
  sections: Sections
) {
  // 1) Document type
  const heuristicType = guessDocumentType(sections);
  const docType: Field<string> = chooseField(
    [
      { value: normalizeDocType(llm.document_type), confidence: 0.7, provenance: "llm" as any },
      { value: heuristicType, confidence: 0.6, provenance: parser?.method || "heuristic" },
    ],
    v => (v ? 1 : 0)
  );
  const strongPreprint = strongPreprintHeuristic(sections);
  if (strongPreprint && docType.value !== "Preprint") {
    docType.value = "Preprint";
    docType.confidence = Math.max(docType.confidence, 0.9);
    docType.provenance = "heuristic";
  }

  // 2) Authors: prefer parser/heuristic when present, else LLM; STRICT cleaning
  const authorsParsedRaw = parser?.candidates.authors || base.authors || null;
  const authorsParsed = cleanAuthors(authorsParsedRaw);
  const authorsLLM = cleanAuthors(llm.authors);

  const authors: Field<string[]> = chooseField(
    [
      { value: authorsParsed, confidence: authorsParsed ? 0.96 : 0.2, provenance: parser?.method || "heuristic" },
      { value: authorsLLM, confidence: authorsLLM ? 0.72 : 0.3, provenance: "llm" as any },
    ],
    v => (Array.isArray(v) && v.length ? 1 : 0)
  );

  // 3) Document date (sanitize BEFORE scoring; 
  const dateParsedRaw = parser?.candidates.document_date || base.document_date || null;
  const dateLLMRaw = (llm?.document_date ?? null) as string | null;

  // if pdf.ts flagged an explicit day near the header, allow day precision to persist
  const cameFromHeader = !!(parser as any)?.meta?.dateFromHeader;

  // sanitize both sides prior to scoring (never fabricate precision)
  const dateParsed = sanitizeDocumentDate(dateParsedRaw, sections, cameFromHeader);
  const dateLLM = sanitizeDocumentDate(dateLLMRaw, sections, false);

  let datePicked: Field<string> = chooseField(
    [
      { value: dateParsed, confidence: dateParsed ? 0.92 : 0.2, provenance: parser?.method || "heuristic" },
      { value: dateLLM, confidence: dateLLM ? 0.7 : 0.3, provenance: "llm" as any },
    ],
    v => {
      if (!v) return 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 1;
      if (/^\d{4}-\d{2}$/.test(v)) return 0.8;
      if (/^\d{4}$/.test(v)) return 0.6;
      return 0.4;
    }
  );

  // (idempotent safety pass)
  const finalSanitized = sanitizeDocumentDate(datePicked.value ?? null, sections, cameFromHeader);
  datePicked = {
    ...datePicked,
    value: finalSanitized,
    confidence: finalSanitized ? datePicked.confidence : 0.2,
  };


  // 4) Summaries
  const summary: Field<string> = qualityTextField(llm.summary, "llm");
  const methods_summary: Field<string> = qualityTextField(llm.methods_summary, "llm");
  const findings_summary: Field<string> = qualityTextField(llm.findings_summary, "llm");

  return {
    document_type: docType,
    authors,
    document_date: datePicked,
    summary,
    methods_summary,
    findings_summary,
  };
}
