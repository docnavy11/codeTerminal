import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Method names on the object a PLATFORM implementation assigns. */
function platformKeys(src: string): string[] {
  const from = src.indexOf("PLATFORM = {");
  assert.ok(from >= 0, "no PLATFORM assignment found");
  // Stop at the object's own closing brace — anything after it is unrelated
  // code that happens to be indented the same way.
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z]\w*)\s*[({:]/gm)].map((m) => m[1]).sort();
}

describe("mobile shares the side panel, it does not copy it", () => {
  // MV3 forbids remote code, so the extension must load the script from disk.
  // The server serves that same file to /m rather than keeping a second copy,
  // because a second copy is a copy that rots.
  test("the server serves the panel's own script and stylesheet", () => {
    const server = read("src/server.ts");
    assert.match(server, /\/m\/app\.js[\s\S]{0,120}extension\/sidepanel\.js/);
    assert.match(server, /\/m\/panel\.css[\s\S]{0,120}extension\/panel\.css/);
  });

  test("there is no second copy of the panel script or stylesheet", () => {
    for (const stray of ["public/m/app.js", "public/sidepanel.js", "public/m/panel.css"]) {
      assert.ok(!existsSync(join(root, stray)), `${stray} would drift from the original`);
    }
  });

  test("the mobile page loads the shared files, not local ones", () => {
    const m = read("public/m.html");
    assert.match(m, /<script src="\/m\/app\.js">/);
    assert.match(m, /<link rel="stylesheet" href="\/m\/panel\.css">/);
  });

  test("the panel loads them from disk, as MV3 requires", () => {
    const html = read("extension/sidepanel.html");
    assert.match(html, /<script src="sidepanel\.js">/);
    assert.match(html, /<link rel="stylesheet" href="panel\.css">/);
    assert.ok(!/<script src="https?:/.test(html), "MV3 forbids remote code");
  });
});

describe("the PLATFORM shim", () => {
  const shared = read("extension/sidepanel.js");

  // Shared logic must not reach for chrome.* directly, or the mobile page
  // throws the moment that line runs.
  test("shared logic never touches chrome.* APIs", () => {
    const code = shared.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const hits = [...code.matchAll(/\bchrome\.\w+/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], "sidepanel.js must go through PLATFORM");
  });

  test("both hosts implement the same surface", () => {
    const ext = platformKeys(read("extension/platform.js"));
    const web = platformKeys(read("public/m.html"));
    assert.ok(ext.length >= 6, `expected a real surface, got ${ext}`);
    assert.deepEqual(web, ext, "the two implementations have drifted apart");
  });

  test("every PLATFORM call the shared code makes is implemented", () => {
    const used = [...new Set([...shared.matchAll(/PLATFORM\.(\w+)/g)].map((m) => m[1]))].sort();
    const ext = platformKeys(read("extension/platform.js"));
    for (const name of used) {
      assert.ok(ext.includes(name), `PLATFORM.${name} is used but not implemented`);
    }
  });
});

describe("installable on a phone", () => {
  const m = read("public/m.html");

  test("declares a viewport that reaches under the notch", () => {
    assert.match(m, /name="viewport"[^>]*width=device-width/);
    assert.match(m, /name="viewport"[^>]*viewport-fit=cover/);
  });

  test("carries the iOS home-screen metadata", () => {
    assert.match(m, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(m, /rel="apple-touch-icon"/);
    assert.match(m, /rel="manifest"/);
  });

  test("the manifest is valid and its icons exist", () => {
    const mf = JSON.parse(read("public/m/manifest.webmanifest"));
    assert.equal(mf.display, "standalone");
    assert.ok(mf.name && mf.start_url && mf.theme_color);
    assert.ok(mf.icons.length >= 2);
    for (const i of mf.icons) {
      assert.ok(existsSync(join(root, "public", i.src)), `missing icon ${i.src}`);
    }
    assert.ok(mf.icons.some((i: { purpose?: string }) => i.purpose === "maskable"),
      "Android crops a non-maskable icon");
  });

  // 16px is the threshold below which iOS zooms the page on focus, which
  // leaves the layout scrolled sideways with no way back.
  test("text inputs are at least 16px so iOS does not zoom on focus", () => {
    const css = m.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const box = css.match(/#box\s*\{([^}]*)\}/)?.[1] ?? "";
    const size = Number(box.match(/font-size:\s*(\d+)px/)?.[1]);
    assert.ok(size >= 16, `#box is ${size}px, iOS will zoom`);
  });

  test("the layout uses a viewport unit that survives mobile toolbars", () => {
    const css = m.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    assert.match(css, /100svh/, "vh is the largest viewport on iOS; svh is the smallest");
    assert.match(css, /--vvh/, "visualViewport tracking for the keyboard");
    assert.match(css, /env\(safe-area-inset/, "safe-area padding");
  });

  test("the shell is not shipped to mobile", () => {
    assert.ok(!/id="term"/.test(m), "no terminal on the phone");
    assert.ok(!/xterm/.test(m), "no terminal bundle on the phone");
  });
});

describe("the phone has little screen and less when typing", () => {
  const m = read("public/m.html");
  const css = m.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const js = m.match(/<script>([\s\S]*?)<\/script>/g)?.join("\n") ?? "";

  // Two header rows cost 99px of a 664px screen, and the keyboard takes ~336
  // of what is left. The second row was status — set once, read occasionally —
  // so it moves into the settings sheet rather than holding a permanent row.
  test("the bar is one row, with status moved into the settings sheet", () => {
    assert.match(css, /header \.row\.status\s*\{[^}]*display:\s*none/);
    for (const id of ["mode", "tabctx"]) {
      assert.ok(new RegExp(`getElementById\\("${id}"\\)`).test(js),
        `#${id} must be relocated, not left on the bar`);
    }
    assert.match(js, /menu\.prepend/, "relocation into the settings menu");
  });

  // Hiding the permission mode is fine; hiding that it is set to "Never ask"
  // is not.
  test("a mode with consequences still shows on the bar", () => {
    assert.match(css, /#modeflag\.hot/);
    assert.match(css, /#modeflag\.warm/);
    assert.match(js, /MutationObserver/, "must follow the class app.js sets");
  });

  test("the bar folds away while the keyboard is open", () => {
    assert.match(css, /body\.kb header\s*\{[^}]*display:\s*none/);
    assert.match(js, /classList\.toggle\("kb"/);
  });

  // iOS keeps the layout viewport full-height when the keyboard opens and
  // scrolls the document to reveal the input, which let the page drag past the
  // composer. A fixed body has nothing to scroll.
  test("the page itself cannot scroll", () => {
    const body = css.match(/\n\s*body\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(body, /position:\s*fixed/);
    assert.match(body, /overflow:\s*hidden/);
    assert.match(js, /scrollTo\(0,\s*0\)/, "undo Safari's scroll-to-input");
  });

  test("the transcript scrolls without dragging the page with it", () => {
    assert.match(css, /#log\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  // The head script runs before <body> exists; touching it unguarded threw and
  // took the rest of the block — including the relocation — down with it.
  test("the head script survives running before the body exists", () => {
    assert.ok(!/(?<!\?)\bdocument\.body\.classList/.test(js),
      "document.body is null in <head>; use optional chaining");
    assert.match(js, /addEventListener\("DOMContentLoaded", apply\)/);
  });
});
