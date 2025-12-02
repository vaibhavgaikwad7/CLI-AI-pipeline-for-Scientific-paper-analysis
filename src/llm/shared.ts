export const FEW_SHOT = `You are extracting metadata fields from scientific content. Output strictly JSON with keys:
{"document_type": string|null, "authors": string[]|null, "document_date": string|null, "summary": string|null, "methods_summary": string|null, "findings_summary": string|null, "confidences": {"document_type": number, "authors": number, "document_date": number, "summary": number, "methods_summary": number, "findings_summary": number}}

Example 1 (short):
TEXT: "Title: Efficient Transformers. Authors: Jane Doe, John Smith. Abstract: We study... Methods: We benchmark... Results: Our model... 2021."
JSON: {"document_type":"Conference Paper","authors":["Jane Doe","John Smith"],"document_date":"2021-01-01","summary":"Investigates efficient Transformer variants.","methods_summary":"Benchmarks multiple architectures across standard NLP tasks.","findings_summary":"Achieves similar accuracy with lower compute.","confidences":{"document_type":0.9,"authors":0.95,"document_date":0.8,"summary":0.8,"methods_summary":0.75,"findings_summary":0.75}}
`;

export const safeParseJSON = (s: string) => {
  const stripped = s.replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();
  try { return JSON.parse(stripped); } catch { return {}; }
};
