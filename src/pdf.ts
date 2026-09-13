/**
 * Text out of a PDF, for read_page on a PDF tab. Chrome's PDF viewer is not
 * scriptable, so the extension hands over the bytes and this runs pdf.js
 * (pure JS, no canvas) on the server. Text only: layout is approximated by
 * joining a page's items with spaces and line breaks where the y changes.
 */
export type PdfText = { pages: number; text: string; chars: number; truncated: boolean };

export async function extractPdfText(data: Uint8Array, opts: { maxChars?: number; maxPages?: number } = {}): Promise<PdfText> {
  const maxChars = opts.maxChars ?? 20_000, maxPages = opts.maxPages ?? 200;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js insists on a plain Uint8Array (a Buffer is refused), hence the copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    let chars = 0, truncated = false;
    const pages = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= pages && !truncated; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let lastY: number | null = null; const line: string[] = []; const lines: string[] = [];
      for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.join(" ")); line.length = 0; }
        line.push(item.str); lastY = y;
        if (item.hasEOL) { lines.push(line.join(" ")); line.length = 0; }
      }
      if (line.length) lines.push(line.join(" "));
      const pageText = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      const block = `--- page ${n} ---\n${pageText}`;
      chars += block.length;
      if (chars > maxChars) { parts.push(block.slice(0, Math.max(0, maxChars - (chars - block.length)))); truncated = true; }
      else parts.push(block);
      page.cleanup();
    }
    if (doc.numPages > maxPages) truncated = true;
    return { pages: doc.numPages, text: parts.join("\n\n") + (truncated ? "\n…[truncated]" : ""), chars, truncated };
  } finally { await task.destroy(); }
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;   // %PDF
}
