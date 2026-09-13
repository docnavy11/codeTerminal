import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText, looksLikePdf } from "../src/pdf.js";

/** A minimal, valid, hand-built PDF: one or more pages of Helvetica text. */
export function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  const pagesId = objs.length + 1 + pages.length * 2;   // reserved below
  for (const lines of pages) {
    const stream = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  assert.equal(pagesObj, pagesId);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("extractPdfText", () => {
  test("reads text page by page, keeps line order, counts pages", async () => {
    const pdf = makePdf([["Invoice PUR1/2026/01/0039", "Total: 1 250,00 EUR"], ["Page two", "VAT 21%"]]);
    assert.equal(looksLikePdf(pdf), true);
    const r = await extractPdfText(pdf);
    assert.equal(r.pages, 2); assert.equal(r.truncated, false);
    assert.match(r.text, /--- page 1 ---\nInvoice PUR1\/2026\/01\/0039\nTotal: 1 250,00 EUR/);
    assert.match(r.text, /--- page 2 ---\nPage two\nVAT 21%/);
  });
  test("caps characters and pages, and says so", async () => {
    const pdf = makePdf(Array.from({ length: 5 }, (_, p) => [`page ${p + 1} ` + "x".repeat(200)]));
    const r = await extractPdfText(pdf, { maxChars: 300 });
    assert.equal(r.truncated, true); assert.ok(r.text.endsWith("…[truncated]")); assert.ok(r.text.length < 400);
    const r2 = await extractPdfText(pdf, { maxPages: 2 });
    assert.equal(r2.truncated, true); assert.ok(r2.text.includes("--- page 2 ---") && !r2.text.includes("--- page 3 ---"));
  });
  test("garbage is not a PDF", async () => {
    assert.equal(looksLikePdf(Buffer.from("<html>")), false);
    await assert.rejects(extractPdfText(Buffer.from("not a pdf at all")));
  });
});
