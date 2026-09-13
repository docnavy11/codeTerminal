/* Runs in the page's own world before its scripts (manifest content_scripts,
   document_start). Keeps a small ring buffer of what the page logs and what
   it fetches, so the agent can read console errors and failed requests
   without a debugger: console.* and uncaught errors/rejections; fetch and
   XMLHttpRequest with method, URL, status and duration (no bodies, no
   headers). Everything else about the page is untouched: console output
   still reaches DevTools, requests still go out exactly as before.
   The buffers live on globalThis.__ct and reset with the document. */
(() => {
  if (globalThis.__ct) return;
  const CAP = 500, TEXT = 2000;
  const ct = globalThis.__ct = { console: [], net: [], dropped: { console: 0, net: 0 } };
  const push = (list, key, e) => { if (list.length >= CAP) { list.shift(); ct.dropped[key]++; } list.push(e); };
  const str = (v) => {
    try {
      if (typeof v === "string") return v;
      if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? "\n" + String(v.stack).split("\n").slice(1, 4).join("\n") : ""}`;
      if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? "#" + v.id : ""}>`;
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    } catch { return String(v); }
  };
  const fmt = (args) => args.map(str).join(" ").slice(0, TEXT);
  for (const level of ["log", "info", "warn", "error", "debug", "trace", "assert"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    console[level] = function (...args) {
      try {
        if (level === "assert") { if (!args[0]) push(ct.console, "console", { t: Date.now(), level: "error", text: "Assertion failed: " + fmt(args.slice(1)) }); }
        else push(ct.console, "console", { t: Date.now(), level: level === "trace" || level === "debug" ? "log" : level, text: fmt(args) });
      } catch { /* never break the page's logging */ }
      return orig.apply(this, args);
    };
  }
  window.addEventListener("error", (e) => {
    const msg = String(e.message ?? "");
    push(ct.console, "console", { t: Date.now(), level: "error", text: (/^Uncaught /.test(msg) ? msg : `Uncaught ${msg}`).slice(0, TEXT),
      source: e.lineno ? `${(e.filename || "").split("/").pop() || "(page)"}:${e.lineno}:${e.colno}` : undefined, uncaught: true });
  });
  window.addEventListener("unhandledrejection", (e) => {
    push(ct.console, "console", { t: Date.now(), level: "error", text: `Unhandled rejection: ${str(e.reason)}`.slice(0, TEXT), uncaught: true });
  });

  // fetch: observe, never alter — same arguments, same response object back.
  const ofetch = window.fetch;
  if (typeof ofetch === "function") {
    window.fetch = function (input, init) {
      const t0 = Date.now();
      let method = "GET", url = "";
      try { url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input); method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(); } catch { /* keep defaults */ }
      const p = ofetch.apply(this, arguments);
      try {
        p.then((r) => push(ct.net, "net", { t: t0, type: "fetch", method, url: String(url).slice(0, 500), status: r.status, ok: r.ok, ms: Date.now() - t0 }),
               (e) => push(ct.net, "net", { t: t0, type: "fetch", method, url: String(url).slice(0, 500), status: 0, ok: false, error: str(e).slice(0, 200), ms: Date.now() - t0 }));
      } catch { /* observing must not throw */ }
      return p;
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { try { this.__ct = { method: String(method).toUpperCase(), url: String(url).slice(0, 500) }; } catch { /* ignore */ } return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try {
      const m = this.__ct ?? { method: "GET", url: "" }; const t0 = Date.now();
      this.addEventListener("loadend", () => push(ct.net, "net", { t: t0, type: "xhr", method: m.method, url: m.url, status: this.status, ok: this.status >= 200 && this.status < 400, ms: Date.now() - t0 }));
    } catch { /* ignore */ }
    return XS.apply(this, arguments);
  };
})();
