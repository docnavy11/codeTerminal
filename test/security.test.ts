import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Pull one directive's source list out of a CSP string. */
function directive(csp: string, name: string): string | null {
  const m = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith(name + " ") || d === name);
  return m ? m.slice(name.length).trim() : null;
}

describe("H2 — replies cannot exfiltrate to an off-origin URL", () => {
  // A model reply is shaped by untrusted page content and rendered as HTML in a
  // logged-in context. DOMPurify stops script; CSP stops the remaining channel,
  // an auto-loading <img> whose URL smuggles out what the model saw. Proven at
  // the network layer: control page fired the pixel, CSP page fired nothing.
  test("the server sends a CSP that locks img-src to our origin", () => {
    const src = read("src/server.ts");
    const block = src.match(/const CSP = \[([\s\S]*?)\]\.join/)?.[1] ?? "";
    assert.ok(block, "server defines a CSP");
    // Each element is a "directive 'self' …" double-quoted literal (the CSP
    // keywords inside use single quotes), so match double-quoted strings only.
    const csp = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("; ");
    const img = directive(csp, "img-src") ?? "";
    assert.match(img, /'self'/, "img-src pinned to self");
    assert.ok(!img.includes("*") && !/https?:/.test(img), "img-src must not allow off-origin hosts");
    assert.equal(directive(csp, "connect-src"), "'self'", "connect-src pinned to self on served pages");
    // And it is actually installed as a response header.
    assert.match(src, /setHeader\(\s*["']Content-Security-Policy["']/);
  });

  test("the extension locks img-src too, since the panel renders the same replies", () => {
    const csp = JSON.parse(read("extension/manifest.json")).content_security_policy?.extension_pages;
    assert.ok(csp, "extension_pages CSP is declared");
    assert.match(directive(csp, "img-src") ?? "", /^'self' data: blob:$/, "img-src locked in the extension");
    assert.equal(directive(csp, "media-src"), "'self' data: blob:", "media-src locked in the extension");
    // MV3 requires a self-only script-src with no unsafe-* — also what stops
    // injected markup from executing, which is why broad connect-src is safe.
    const script = directive(csp, "script-src") ?? "";
    assert.match(script, /'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(script), "script-src must be self-only");
  });

  test("no page ships a CSP that re-opens the hole", () => {
    for (const f of ["public/m.html", "public/index.html"]) {
      const meta = read(f).match(/http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']*)["']/i)?.[1];
      if (meta) assert.ok(!/img-src[^;]*https?:/.test(meta), `${f} meta CSP must not allow off-origin images`);
    }
  });
});
