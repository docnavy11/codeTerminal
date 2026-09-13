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

  let refSeq = 0;
  const refOf = (el) => {
    let r = el.getAttribute("data-ct-ref");
    if (!r) { r = "f" + (++refSeq); el.setAttribute("data-ct-ref", r); }
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
