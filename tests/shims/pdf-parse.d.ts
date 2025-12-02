
declare module "pdf-parse" {
  export interface PdfParseResult {
    text?: string;
    info?: any;
  }
  export type PdfParse = (data: unknown) => Promise<PdfParseResult>;
  const pdfParse: PdfParse;
  export default pdfParse;
}
