import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * All CSS a page actually applies: inline <style> plus any stylesheet it links.
 * The side panel's rules moved into extension/panel.css so the mobile page at
 * /m could share them verbatim; reading only <style> silently found nothing
 * and every rule these tests check looked absent.
 */
function pageCss(file: string): string {
  const html = readFileSync(join(root, file), "utf8");
  let css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    const href = m[1];
    if (/^https?:/.test(href)) continue;
    const abs = href.startsWith("/")
      ? join(root, "public", href.slice(1))
      : join(root, dirname(file), href);
    try { css += "\n" + readFileSync(abs, "utf8"); } catch { /* served, not on disk */ }
  }
  return css;
}

/** The rules that style the navigation bar, by selector. */
function navRules(style: string, extra: RegExp[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!sel || sel.startsWith("@")) continue;
    const isNav = /(^|[\s,>])header\b/.test(sel) || extra.some((r) => r.test(sel));
    if (isNav) out.push([sel, m[2]]);
  }
  return out;
}

function fontSizes(rules: Array<[string, string]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [sel, body] of rules) {
    for (const m of body.matchAll(/font-size\s*:\s*([^;}]+)/g)) out.push([sel, m[1].trim()]);
  }
  return out;
}

const PAGES: Array<[string, string, RegExp[]]> = [
  ["public/index.html", "main UI", []],
  ["extension/sidepanel.html", "side panel", [/^#meta\b/, /^\.tabs\b/]],
];

for (const [file, label, extra] of PAGES) {
  describe(`nav bar — ${label}`, () => {
    const html = readFileSync(join(root, file), "utf8");
    const sizes = fontSizes(navRules(pageCss(file), extra));

    test("has font sizes to check at all", () => {
      assert.ok(sizes.length >= 3, `only found ${sizes.length} in ${file}`);
    });

    // A-/A+ resizes the transcript by rewriting the root font-size. While the
    // bar was sized in rem it followed along, so turning the reading text down
    // took the navigation to 10px — and the manage link to 9.2px — with it.
    test("is sized in px, so A-/A+ cannot shrink it", () => {
      const rem = sizes.filter(([, v]) => /\brem\b|\bem\b|%/.test(v));
      assert.deepEqual(rem, [], `nav must not scale with the root font size (${file})`);
    });

    test("never specifies type below 11px", () => {
      const tooSmall = sizes.filter(([, v]) => {
        const px = Number(v.match(/^([\d.]+)px$/)?.[1]);
        return Number.isFinite(px) && px < 11;
      });
      assert.deepEqual(tooSmall, [], `unreadably small nav type in ${file}`);
    });

    test("uses few enough sizes to read as one scale", () => {
      const distinct = new Set(sizes.map(([, v]) => v));
      assert.ok(distinct.size <= 4, `${distinct.size} nav type sizes in ${file}: ${[...distinct]}`);
    });
  });
}

describe("nav bar — side panel layout", () => {
  const html = readFileSync(join(root, "extension/sidepanel.html"), "utf8");

  // Eleven controls never fit one 400px line. The old bar was nowrap plus
  // overflow:hidden, which hid the overflow rather than preventing it: A+ and
  // the status text were clipped off the right edge and unreachable.
  test("does not clip its own controls", () => {
    const rule = pageCss("extension/sidepanel.html").match(/\n\s*header\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(rule, "found the header rule");
    assert.ok(!/overflow\s*:\s*hidden/.test(rule), "header must not hide its own controls");
    assert.ok(!/flex-wrap\s*:\s*nowrap/.test(rule), "header must not force one line");
  });

  test("keeps every control it had", () => {
    const header = html.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? "";
    for (const id of ["dot", "mode", "chatsbtn", "newchat", "openui", "manage",
                      "tabctx", "theme", "fsdown", "fsup", "meta"]) {
      assert.ok(header.includes(`id="${id}"`), `#${id} missing from the bar`);
    }
    assert.ok(header.includes('data-view="chat"') && header.includes('data-view="files"'));
  });
});

describe("nav bar — hierarchy", () => {
  const pages: Array<[string, string, string]> = [
    ["main UI", "public/index.html", "reset"],
    ["side panel", "extension/sidepanel.html", "newchat"],
  ];

  for (const [label, file, primaryId] of pages) {
    const html = readFileSync(join(root, file), "utf8");
    const header = html.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? "";
    const bar = header.replace(/<div id="moremenu"[\s\S]*?<\/div>\s*(?=<div id="chatlist"|$)/, "");

    // One filled control. Two primaries is no hierarchy at all.
    test(`${label}: exactly one primary action`, () => {
      const style = pageCss(file).replace(/\/\*[\s\S]*?\*\//g, "");
      const filled = [...style.matchAll(/([^{}]*)\{[^{}]*background\s*:\s*var\(--accent\)/g)]
        .map((m) => m[1].trim())
        .filter((sel) => sel.startsWith("header") && !sel.includes(":hover"));
      assert.equal(filled.length, 1, `filled header controls: ${filled}`);
      assert.ok(filled[0].includes(primaryId) || filled[0].includes("primary"),
        `the filled control should be the primary action, got ${filled[0]}`);
    });

    // The complaint that started this: an unlabelled ↗ and ⚙ in the bar.
    test(`${label}: no unlabelled glyph controls in the bar`, () => {
      for (const m of bar.matchAll(/<(button|a|div)\b([^>]*)>([^<]*)</g)) {
        const [, , attrs, text] = m;
        // Containers, not controls.
        if (/\bid="(chatlist|moremenu)"/.test(attrs)) continue;
        if (!/\bid=|\bclass="[^"]*\b(nav|mitem)\b/.test(attrs)) continue;
        const label2 = text.trim();
        const wordy = /[a-z]{3}/i.test(label2);
        if (!wordy) {
          assert.match(attrs, /title="[^"]{4,}"/,
            `glyph control ${JSON.stringify(label2)} needs a title`);
        }
      }
    });

    // Set-once controls belong behind the menu, where they get real words.
    test(`${label}: settings are labelled with words, not glyphs`, () => {
      const menu = header.match(/<div id="moremenu"[^>]*>([\s\S]*?)\n  <\/div>/)?.[1] ?? "";
      assert.ok(menu, "settings menu exists");
      for (const id of ["theme", "fsdown", "fsup"]) {
        assert.ok(menu.includes(`id="${id}"`), `#${id} should live in the settings menu`);
      }
      assert.ok(/Manage[^<]*chats/i.test(menu), "manage is spelled out");
      assert.ok(!/>\s*[↗⚙]\s*</.test(bar), "no bare ↗ / ⚙ left in the bar");
    });
  }
});

describe("chrome vs content typography", () => {
  for (const [label, file] of [["main UI", "public/index.html"],
                               ["side panel", "extension/sidepanel.html"],
                               ["manage", "public/manage.html"]] as const) {
    const html = readFileSync(join(root, file), "utf8");

    // The whole document was set in the monospace stack, chrome included, which
    // is what made it read as a terminal emulator rather than an application.
    test(`${label}: body is set in the UI stack, not the mono one`, () => {
      const body = pageCss(file).match(/\n\s*body\s*\{([^}]*)\}/g)?.join(" ") ?? "";
      assert.match(body, /var\(--ui\)/, "body should use --ui");
      assert.ok(!/font\s*:[^;}]*var\(--mono\)/.test(body), "body must not be mono");
    });

    test(`${label}: defines both stacks`, () => {
      const css = pageCss(file);
      assert.match(css, /--ui:\s*system-ui/);
      assert.match(css, /--mono:\s*ui-monospace/);
    });
  }

  // Mono still has to survive where the character grid means something. The
  // transcript is deliberately one of those places: it is the conversation
  // record, and it is full of commands, paths and output.
  test("the transcript, terminal and paths keep monospace", () => {
    for (const [file, extra] of [["public/index.html", "#term"],
                                 ["extension/sidepanel.html", "#meta"]] as const) {
      const rule = pageCss(file).match(/([^{}]*)\{\s*font-family:\s*var\(--mono\)\s*;?\s*\}/)?.[1] ?? "";
      for (const sel of ["#log", extra, ".fpath"]) {
        assert.ok(rule.includes(sel), `${sel} should stay monospace in ${file}`);
      }
    }
  });
});

describe("resolved cards stay readable", () => {
  // .q.done opacity .5 multiplied by the .4 on disabled buttons gave an
  // effective .2 — measured at 1.36:1 against the background, at 9.5px.
  for (const [label, file] of [["main UI", "public/index.html"],
                               ["side panel", "extension/sidepanel.html"]] as const) {
    const html = readFileSync(join(root, file), "utf8");
    const style = pageCss(file).replace(/\/\*[\s\S]*?\*\//g, "");

    test(`${label}: a done card never fades below full opacity`, () => {
      for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim();
        if (!/\.(q|card)\.done\b/.test(sel)) continue;
        for (const o of m[2].matchAll(/opacity\s*:\s*([\d.]+)/g)) {
          assert.equal(Number(o[1]), 1, `${sel} dims to ${o[1]}`);
        }
      }
    });

    test(`${label}: disabled controls inside a done card are re-lit`, () => {
      assert.match(style, /\.(q|card)\.done[^{]*(button|\.opt):disabled[^{]*\{[^}]*opacity\s*:\s*1/,
        "the global button:disabled{opacity:.4} must be overridden");
    });
  }
});

describe("controls are chrome wherever they sit", () => {
  // Approve/Deny, option buttons, card headings and chips live inside #log, so
  // they inherited its monospace and went on looking like a terminal dialog
  // after the chrome around them had already moved to the UI stack.
  for (const [label, file] of [["main UI", "public/index.html"],
                               ["side panel", "extension/sidepanel.html"]] as const) {
    const html = readFileSync(join(root, file), "utf8");
    const style = pageCss(file).replace(/\/\*[\s\S]*?\*\//g, "");

    test(`${label}: transcript controls use the UI stack`, () => {
      const rule = [...style.matchAll(/([^{}]+)\{\s*font-family:\s*var\(--ui\)\s*;?\s*\}/g)]
        .map((m) => m[1].trim()).join(" ");
      for (const sel of ["#log button", "#log .chip", "#log .card h4"]) {
        assert.ok(rule.includes(sel), `${sel} should use --ui in ${file}`);
      }
    });

    test(`${label}: code inside a control stays monospace`, () => {
      const rule = [...style.matchAll(/([^{}]+)\{\s*font-family:\s*var\(--mono\)\s*;?\s*\}/g)]
        .map((m) => m[1].trim()).join(" ");
      assert.ok(rule.includes("#log .opt pre"), `option code previews must stay mono in ${file}`);
    });

    test(`${label}: scrollbars are slimmed, not left at the default slab`, () => {
      assert.match(style, /scrollbar-width:\s*thin/);
      assert.match(style, /::-webkit-scrollbar\s*\{[^}]*width:\s*\d+px/);
    });
  }
});

describe("approval cards", () => {
  for (const [label, htmlFile, jsFile] of [
    ["main UI", "public/index.html", "public/index.html"],
    ["side panel", "extension/sidepanel.html", "extension/sidepanel.js"],
  ] as const) {
    const js = readFileSync(join(root, jsFile), "utf8");
    const style = pageCss(htmlFile).replace(/\/\*[\s\S]*?\*\//g, "");

    // The side panel lost its base `select, button` rule to the nav rewrite and
    // every control outside the header silently fell back to Chrome's default
    // widget — which is exactly what an OS dialog from 1995 looks like.
    test(`${label}: a base button rule exists`, () => {
      const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => /(^|,)\s*(select\s*,\s*)?button\s*(,|$)/.test(m[1].trim()));
      const body = rules.map((m) => m[2]).join(";");
      for (const prop of ["border", "background", "border-radius"]) {
        assert.match(body, new RegExp(`${prop}\\s*:`), `base button must set ${prop} in ${htmlFile}`);
      }
    });

    // A long command used to sit behind a horizontal scrollbar — a wide grey
    // slab across the card, hiding the end of the thing you are approving.
    test(`${label}: the command wraps instead of scrolling sideways`, () => {
      const pre = style.match(/\.card pre\s*\{([^}]*)\}/)?.[1] ?? "";
      assert.ok(pre, ".card pre rule exists");
      assert.match(pre, /white-space\s*:\s*pre-wrap/);
      assert.match(pre, /overflow-x\s*:\s*hidden/);
    });

    // "Always" shares the .allow class with "Approve", so colour must key off
    // the decision or the irreversible option looks like the easy one.
    test(`${label}: decision buttons are styled per decision`, () => {
      for (const d of ["allow", "deny", "always"]) {
        assert.ok(style.includes(`[data-decision="${d}"]`), `${d} styling missing in ${htmlFile}`);
      }
      assert.match(js, /dataset\.decision\s*=\s*decision/, `${jsFile} must stamp the decision`);
    });
  }
});
