/* Structured reads of the current page, run inside it (MAIN world). One
   function, several modes, no dependencies — injected by the extension's
   read_page and unit-tested in a plain page by the browser suite.

     text      the visible text (innerText), as before
     markdown  the main content as compact markdown: headings, paragraphs,
               lists, links, code, tables — navigation, ads and chrome dropped
     links     [{ text, href }] for the visible links, deduped
     tables    [{ caption, headers, rows }] per <table>
     forms     [{ ref, action, method, fields: [{ ref, tag, type, name, label,
               value, options, checked, required }] }] — refs are data-ct-ref,
               the same ones click/fill accept

   Everything is capped: `maxChars` for text/markdown, fixed counts for the
   rest, so a giant page cannot produce a giant result. */
(() => {
  // For markdown: chrome, and form controls (forms are their own mode).
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "BUTTON", "SELECT", "INPUT", "TEXTAREA", "LABEL"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "LI", "TR", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "TABLE", "DL", "DT", "DD", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY"]);
  const visible = (el) => {
    if (!(el instanceof Element)) return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    return true;
  };
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const abs = (href) => { try { return new URL(href, location.href).href; } catch { return href; } };

  /** Where the content is: <main>, <article>, [role=main], else body. */
  const root = () => document.querySelector("main, article, [role=main]") || document.body;

  /* This file is injected afresh on every call, but the refs it hands out
     stay on the elements. A counter that restarted at 0 each time gave a new
     element a ref an old one still carried (reproduced: find "Delete" → f1,
     find "Cancel" → f1 as well, and click f1 pressed Delete). So the next
     number continues from the highest ref already in the page. */
  let refSeq = null;
  const refOf = (el) => {
    let r = el.getAttribute("data-ct-ref");
    if (!r) {
      if (refSeq === null) {
        refSeq = 0;
        for (const e of document.querySelectorAll("[data-ct-ref^='f']")) {
          const n = Number(e.getAttribute("data-ct-ref").slice(1));
          if (Number.isInteger(n) && n > refSeq) refSeq = n;
        }
      }
      r = "f" + (++refSeq); el.setAttribute("data-ct-ref", r);
    }
    return r;
  };
  const labelOf = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const l = id || el.closest("label");
    return clean((l && l.innerText) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };

  function toMarkdown(node, out, depth) {
    if (node.nodeType === Node.TEXT_NODE) { const t = clean(node.nodeValue || ""); if (t) out.push({ inline: t }); return; }
    if (!(node instanceof Element) || SKIP.has(node.tagName) || !visible(node)) return;
    const tag = node.tagName;
    const flush = () => { const parts = []; while (out.length && out[out.length - 1].inline !== undefined) parts.unshift(out.pop().inline); if (parts.length) out.push(parts.join(" ").replace(/\s+([.,;:!?)])/g, "$1")); };
    if (/^H[1-6]$/.test(tag)) { flush(); out.push("#".repeat(Number(tag[1])) + " " + clean(node.innerText)); return; }
    if (tag === "PRE") { flush(); out.push("```\n" + (node.innerText || "").replace(/\n+$/, "") + "\n```"); return; }
    if (tag === "CODE" && node.parentElement?.tagName !== "PRE") { out.push({ inline: "`" + clean(node.innerText) + "`" }); return; }
    if (tag === "A" && node.getAttribute("href")) { const t = clean(node.innerText); if (t) out.push({ inline: `[${t}](${abs(node.getAttribute("href"))})` }); return; }
    if (tag === "IMG") { const alt = clean(node.getAttribute("alt") || ""); if (alt) out.push({ inline: `![${alt}]` }); return; }
    if (tag === "BR") { flush(); return; }
    if (tag === "TABLE") { flush(); out.push(tableMd(node)); return; }
    if (tag === "UL" || tag === "OL") {
      flush();
      // one block per list, items on consecutive lines
      let i = 0; const items = [];
      for (const li of node.children) { if (li.tagName !== "LI" || !visible(li)) continue; const sub = []; for (const c of li.childNodes) toMarkdown(c, sub, depth + 1); flushInto(sub); items.push("  ".repeat(depth) + (tag === "OL" ? `${++i}. ` : "- ") + sub.join("\n" + "  ".repeat(depth + 1))); }
      if (items.length) out.push(items.join("\n"));
      return;
    }
    if (tag === "BLOCKQUOTE") { flush(); const sub = []; for (const c of node.childNodes) toMarkdown(c, sub, depth); flushInto(sub); out.push(sub.map((l) => "> " + l).join("\n")); return; }
    if (BLOCK.has(tag)) flush();
    for (const c of node.childNodes) toMarkdown(c, out, depth);
    if (BLOCK.has(tag)) flush();
  }
  function flushInto(arr) { const parts = []; while (arr.length && arr[arr.length - 1].inline !== undefined) parts.unshift(arr.pop().inline); if (parts.length) arr.push(parts.join(" ")); for (let i = 0; i < arr.length; i++) if (arr[i].inline !== undefined) arr[i] = arr[i].inline; }

  function tableData(table) {
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      if (!visible(tr)) continue;
      rows.push([...tr.children].filter((c) => /^T[HD]$/.test(c.tagName)).map((c) => clean(c.innerText)));
      if (rows.length >= 200) break;
    }
    const headerRow = rows.length && [...table.querySelectorAll("tr")].find(visible)?.querySelector("th") ? rows.shift() : null;
    return { caption: clean(table.querySelector("caption")?.innerText || ""), headers: headerRow || [], rows };
  }
  function tableMd(table) {
    const t = tableData(table);
    const width = Math.max(t.headers.length, ...t.rows.map((r) => r.length), 1);
    const line = (cells) => "| " + Array.from({ length: width }, (_, i) => (cells[i] ?? "").replace(/\|/g, "\\|")).join(" | ") + " |";
    const head = t.headers.length ? t.headers : Array.from({ length: width }, () => "");
    return (t.caption ? `**${t.caption}**\n` : "") + [line(head), "| " + Array.from({ length: width }, () => "---").join(" | ") + " |", ...t.rows.map(line)].join("\n");
  }

  /* ---- find: text or regex in the visible text, or an element by role and
     accessible name. Each match gets a ref (data-ct-ref) on the nearest
     useful ancestor, so click/fill/scroll can take it from here. ---- */
  const INTERACTIVE = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="option"]';
  const roleOf = (el) => {
    const r = el.getAttribute("role"); if (r) return r;
    const t = el.tagName;
    if (t === "A" && el.getAttribute("href")) return "link";
    if (t === "BUTTON") return "button";
    if (t === "INPUT") { const ty = (el.getAttribute("type") || "text").toLowerCase(); return ty === "checkbox" ? "checkbox" : ty === "radio" ? "radio" : ty === "submit" || ty === "button" ? "button" : "textbox"; }
    if (t === "TEXTAREA") return "textbox"; if (t === "SELECT") return "combobox";
    if (/^H[1-6]$/.test(t)) return "heading"; if (t === "IMG") return "img"; if (t === "TABLE") return "table";
    return "";
  };
  const nameOf = (el) => clean(el.getAttribute("aria-label") || labelOf(el) || el.innerText || el.getAttribute("alt") || el.getAttribute("title") || el.value || "");
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const inView = (r) => r.y + r.h > 0 && r.y < innerHeight && r.x + r.w > 0 && r.x < innerWidth;

  globalThis.ctFind = function ctFind(o) {
    const limit = Math.min(o.limit || 25, 100);
    const out = [];
    if (o.role || o.name) {
      const want = (o.role || "").toLowerCase(), name = (o.name || "").toLowerCase();
      for (const el of document.querySelectorAll(want ? `${INTERACTIVE},[role],h1,h2,h3,h4,h5,h6,img,table` : INTERACTIVE)) {
        if (!visible(el)) continue;
        const role = roleOf(el).toLowerCase(); if (want && role !== want) continue;
        const n = nameOf(el); if (name && !n.toLowerCase().includes(name)) continue;
        const rect = rectOf(el); if (!rect.w && !rect.h) continue;
        out.push({ ref: refOf(el), role, name: n.slice(0, 120), tag: el.tagName.toLowerCase(), rect, inViewport: inView(rect) });
        if (out.length >= limit) break;
      }
      return { count: out.length, matches: out };
    }
    const re = o.regex ? new RegExp(o.regex, "i") : o.text ? new RegExp(o.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    if (!re) return { count: 0, matches: [], error: "give text, regex, or role/name" };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement; if (!p || SKIP.has(p.tagName) && p.tagName !== "FORM" && p.tagName !== "LABEL" && p.tagName !== "BUTTON") return NodeFilter.FILTER_REJECT;
      return re.test(n.nodeValue || "") && visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    } });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.nodeValue || ""; const m = re.exec(s); if (!m) continue;
      const el = n.parentElement.closest(INTERACTIVE) || n.parentElement;
      const start = Math.max(0, m.index - 60), end = Math.min(s.length, m.index + m[0].length + 60);
      const rect = rectOf(el);
      out.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), role: roleOf(el), match: m[0], text: clean((start ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "")), rect, inViewport: inView(rect) });
      if (out.length >= limit) break;
    }
    return { count: out.length, matches: out };
  };

  /* ---- scroll: to an element (ref or selector), by pages, or to top/bottom;
     reports where the viewport ended up. ---- */
  globalThis.ctScroll = function ctScroll(o) {
    const target = o.ref ? document.querySelector(`[data-ct-ref="${CSS.escape(o.ref)}"]`) : o.selector ? document.querySelector(o.selector) : null;
    if ((o.ref || o.selector) && !target) return { error: `no element for ${o.ref ? "ref " + o.ref : o.selector}` };
    if (target) target.scrollIntoView({ block: "center", inline: "nearest" });
    else if (o.to === "top") window.scrollTo(0, 0);
    else if (o.to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
    else window.scrollBy(0, (o.direction === "up" ? -1 : 1) * (o.pages || 1) * innerHeight * 0.9);
    const y = Math.round(scrollY), h = document.documentElement.scrollHeight, vh = innerHeight;
    return { scrollY: y, scrollHeight: h, innerHeight: vh, atTop: y <= 0, atBottom: y + vh >= h - 2, percent: h > vh ? Math.round(y / (h - vh) * 100) : 100, ...(target ? { rect: rectOf(target) } : {}) };
  };

  /* ---- wait_for's probe: one look at the page for each condition; the
     extension polls this from outside so a navigation mid-wait is fine. ---- */
  globalThis.ctWaitProbe = function ctWaitProbe(o) {
    const body = (document.body?.innerText || "").toLowerCase();
    const texts = Array.isArray(o.text) ? o.text : o.text ? [o.text] : [];
    const r = { readyState: document.readyState, url: location.href, resources: performance.getEntriesByType("resource").length };
    if (texts.length) { const hit = texts.find((t) => body.includes(String(t).toLowerCase())); r.text = hit ?? null; }
    if (o.gone) r.gone = !body.includes(String(o.gone).toLowerCase());
    if (o.selector) { let el = null; try { el = document.querySelector(o.selector); } catch { r.selectorError = "bad selector"; } r.selector = !!(el && visible(el)); }
    if (o.load) r.load = o.load === "domcontentloaded" ? document.readyState !== "loading" : document.readyState === "complete";
    return r;
  };

  globalThis.ctReadPage = function ctReadPage(mode, maxChars) {
    const max = maxChars || 20000;
    const cap = (s) => (s.length > max ? s.slice(0, max) + "\n…[truncated]" : s);
    switch (mode) {
      case "markdown": {
        const out = []; toMarkdown(root(), out, 0); flushInto(out);
        const md = out.filter((l) => typeof l === "string" && l.trim()).join("\n\n");
        return { mode, chars: md.length, text: cap(md) };
      }
      case "links": {
        const seen = new Set(); const links = [];
        for (const a of document.querySelectorAll("a[href]")) {
          if (!visible(a)) continue;
          const href = abs(a.getAttribute("href")); if (/^(javascript:|#$)/.test(a.getAttribute("href") || "")) continue;
          const text = clean(a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "");
          const key = href + "|" + text; if (seen.has(key)) continue; seen.add(key);
          links.push({ text: text.slice(0, 120), href });
          if (links.length >= 500) break;
        }
        return { mode, count: links.length, links };
      }
      case "tables": {
        const tables = [...document.querySelectorAll("table")].filter(visible).slice(0, 50).map(tableData);
        return { mode, count: tables.length, tables };
      }
      case "forms": {
        const fieldOf = (el) => {
          const f = { ref: refOf(el), tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || (el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : "text"),
            name: el.getAttribute("name") || el.id || "", label: labelOf(el) };
          if (f.type === "password") f.value = el.value ? "•••" : "";
          else if (f.type === "checkbox" || f.type === "radio") f.checked = !!el.checked;
          else f.value = String(el.value ?? "").slice(0, 200);
          if (el.tagName === "SELECT") f.options = [...el.options].slice(0, 100).map((o) => o.text.trim());
          if (el.required) f.required = true;
          return f;
        };
        const seen = new Set(); const forms = [];
        for (const form of [...document.querySelectorAll("form")].filter(visible).slice(0, 30)) {
          const fields = [...form.querySelectorAll("input,select,textarea")].filter((el) => visible(el) && el.type !== "hidden" && el.type !== "submit" && el.type !== "button").map((el) => { seen.add(el); return fieldOf(el); });
          const submit = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
          forms.push({ ref: refOf(form), action: abs(form.getAttribute("action") || location.href), method: (form.getAttribute("method") || "get").toLowerCase(), submit: submit ? { ref: refOf(submit), text: clean(submit.innerText || submit.value || "") } : undefined, fields: fields.slice(0, 100) });
        }
        const loose = [...document.querySelectorAll("input,select,textarea")].filter((el) => !seen.has(el) && visible(el) && el.type !== "hidden" && el.type !== "submit" && el.type !== "button").slice(0, 50).map(fieldOf);
        if (loose.length) forms.push({ ref: null, action: null, method: null, fields: loose });
        return { mode, count: forms.length, forms };
      }
      default: {
        const txt = document.body?.innerText ?? "";
        return { mode: "text", chars: txt.length, text: cap(txt) };
      }
    }
  };
})();

/* Set one form control the way a person would, so frameworks notice:
   text-like inputs, textareas and contenteditables get the value through
   the native setter plus input/change; selects match an option by text or
   value (case-insensitive); checkboxes take true/false (or "on"/"off",
   "yes"/"no", "checked"); radios check the one whose value matches, or the
   element itself. Used by fill and fill_form. */
globalThis.ctSetField = function ctSetField({ ref, selector, value }) {
  const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : selector ? document.querySelector(selector) : null;
  const key = ref || selector || "?";
  if (!el) return { field: key, ok: false, error: "element not found" };
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  const tag = el.tagName; const type = (el.getAttribute("type") || "").toLowerCase();
  try {
    el.focus?.();
    if (tag === "SELECT") {
      const want = String(value).trim().toLowerCase();
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        ?? [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
      if (!opt) return { field: key, ok: false, error: `no option matches "${value}"`, options: [...el.options].slice(0, 30).map((o) => o.text.trim()) };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
      fire("input"); fire("change");
      return { field: key, ok: true, set: opt.text.trim() };
    }
    if (type === "checkbox") {
      const on = typeof value === "boolean" ? value : /^(true|on|yes|checked|1)$/i.test(String(value).trim());
      if (el.checked !== on) el.click(); else fire("change");
      return { field: key, ok: true, set: el.checked };
    }
    if (type === "radio") {
      const group = el.name ? [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)] : [el];
      const want = String(value).trim().toLowerCase();
      const pick = typeof value === "boolean" ? el : group.find((r) => r.value.toLowerCase() === want || (r.labels?.[0]?.innerText || "").trim().toLowerCase() === want) ?? el;
      if (!pick.checked) pick.click();
      return { field: key, ok: true, set: pick.value };
    }
    if (el.isContentEditable) { el.textContent = String(value); fire("input"); return { field: key, ok: true, length: String(value).length }; }
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) return { field: key, ok: false, error: `cannot set a ${tag.toLowerCase()}` };
    setter.call(el, String(value));
    fire("input"); fire("change");
    return { field: key, ok: true, length: String(value).length };
  } catch (e) { return { field: key, ok: false, error: String(e?.message ?? e) }; }
};

/* Would this click / Enter submit a form? For the confirm-before-submit card.
   click: the element is a submit control of a form (button[type=submit],
   a <button> with no type, input[type=submit|image]). Enter: the focused
   element is a text-like input in a form that submits implicitly (it has a
   submit button, or a single text field). Reports the form's action, method,
   the button's text and the visible fields with their values (passwords
   masked), so the card can show what is about to be sent. A GET form with
   nothing filled (a search box) is not worth a card. */
globalThis.ctSubmitProbe = function ctSubmitProbe({ ref, selector, key }) {
  const submitControl = (el) => !!el && !!el.form && (el.type === "submit" || el.type === "image");
  const textLike = (el) => el && el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image|hidden|range|color)$/i.test(el.type || "text");
  let el, form, button, via;
  if (key) {
    if (!/^(Enter|NumpadEnter)$/.test(key)) return { submit: false };
    el = document.activeElement; via = "enter";
    if (!textLike(el) || !el.form) return { submit: false };
    form = el.form;
    button = form.querySelector('button[type=submit],input[type=submit],input[type=image],button:not([type])');
    const texts = [...form.querySelectorAll("input")].filter(textLike);
    if (!button && texts.length !== 1) return { submit: false };
  } else {
    el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : selector ? document.querySelector(selector) : null;
    if (!submitControl(el)) return { submit: false };
    form = el.form; button = el; via = "click";
  }
  const mask = (f) => (f.type === "password" ? "•••" : String(f.value ?? "").slice(0, 80));
  const fields = [...form.querySelectorAll("input,select,textarea")]
    .filter((f) => !/^(hidden|submit|button|reset|image)$/i.test(f.type || "") && (f.offsetParent !== null || f.type === "checkbox" || f.type === "radio"))
    .map((f) => {
      const name = f.getAttribute("name") || f.id || (globalThis.ctLabelOf ? globalThis.ctLabelOf(f) : "") || f.tagName.toLowerCase();
      if (f.type === "checkbox" || f.type === "radio") return f.checked ? { name, value: f.value === "on" ? "checked" : f.value } : null;
      const value = mask(f); return value ? { name, value } : null;
    }).filter(Boolean).slice(0, 30);
  const method = (form.getAttribute("method") || "get").toLowerCase();
  if (!fields.length && method === "get") return { submit: false };
  let action = form.getAttribute("action") || location.href;
  try { action = new URL(action, location.href).href; } catch { /* keep as is */ }
  return { submit: true, via, form: { action, method, button: (button?.innerText || button?.value || button?.getAttribute("aria-label") || "").trim().slice(0, 60) || undefined, fields, filled: fields.length } };
};
