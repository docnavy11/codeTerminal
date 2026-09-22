/**
 * The terminal and the tmux session chooser, shared by every host that has
 * room for them: the web UI's right pane and the Chrome side panel. Like
 * sidepanel.js it is one plain script, loaded from disk by the extension and
 * served as /m/term.js to the page — MV3 forbids remote code, so the sharing
 * only works in that direction.
 *
 * Everything is wrapped in an IIFE and reaches the host through TERMPANE.
 * That is not tidiness: desktop.js and sidepanel.js are two plain scripts in
 * one global scope, and a third one declaring `html` or `ago` at the top level
 * kills the page with "Identifier already declared" — which is exactly how the
 * first version of this file failed.
 *
 * The host owns its own layout and tabs. This file owns the pty socket, the
 * xterm instance, which session is attached, and the chooser's list.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const html = document.documentElement;
  const cssVar = (n) => getComputedStyle(html).getPropertyValue(n).trim();

  let term, fit, termEl;
  let ptyWs, ptyRetry, ptyWasDown = false, ptySeen = 0;
  /* A server started with CODETERM_SHELL=0 has no /pty route. Without asking
     first the host would dial it and retry every 3 s forever. */
  let shellOn = true;
  let homeDir = "";
  let selectShell = () => {};
  /* The host owns its note line — only it knows that its files view shows a
     root path there — so the pane never writes it, it asks for a repaint. */
  let repaintNote = () => {};

  /* The extension talks to a server somewhere else; the page talks to the one
     that served it, where httpBase() is this origin. Same call either way. */
  const api = async (path, opts) => {
    const base = (await PLATFORM.httpBase()) || "";
    const r = await fetch(base + path, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  };

  /* ---------------- which session, and where it is ---------------- */
  /* Held here rather than in the socket: reattaching after a drop must land on
     the same session. */
  let attachedTo = (() => { try { return sessionStorage.getItem("ct.session") || null; } catch { return null; } })();
  const rememberSession = (n) => { try { n ? sessionStorage.setItem("ct.session", n) : sessionStorage.removeItem("ct.session"); } catch { /* private window */ } };
  /* The attached session's current directory. Not remembered with the name: a
     session can `cd` while you are away, so it is read back from tmux rather
     than restored from a stale copy. */
  let attachedPath = "";

  /* `~/projects/x`, and the middle dropped when it is long. The first attempt
     used direction:rtl to ellipsise the left, which moved the leading slash to
     the end: "home/dev/projects/x/". */
  const shortPath = (p) => {
    let t = homeDir && p.startsWith(homeDir) ? "~" + p.slice(homeDir.length) : p;
    if (t.length > 46) { const parts = t.split("/"); t = parts.length > 3 ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}` : "…" + t.slice(-44); }
    return t;
  };
  const shortAgo = (ms) => {
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  /* "session: build · ~/projects/x". The directory is the pane's, so it is what
     the session is working on now, not where it was started. */
  const sessionNote = () => `session: ${attachedTo}` + (attachedPath ? ` · ${shortPath(attachedPath)}` : "");

  /* Read the attached session's directory back from tmux and repaint if it
     moved. Quiet on failure: the note keeps the name, which is the part that
     matters. */
  async function refreshAttachedPath() {
    const want = attachedTo;
    try {
      const found = (await api("/sessions")).sessions.find((s) => s.name === want);
      if (!found || attachedTo !== want || found.path === attachedPath) return;
      attachedPath = found.path;
      repaintNote();
    } catch { /* the note keeps the name */ }
  }

  /* ---------------- the pty socket ---------------- */
  const PTY_STALE_MS = 75_000;
  /* The server beats every 30s on this socket too; silence past that is a dead
     connection the browser has not noticed. Drop it and dial again. */
  function checkPtyLiveness(now = Date.now()) {
    if (!shellOn) return false;
    if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN || !ptySeen || now - ptySeen < PTY_STALE_MS) return false;
    const dead = ptyWs; ptyWs = null; dead.onclose = null; dead.onmessage = null;
    try { dead.close(); } catch { /* half-open */ }
    ptyWasDown = true;
    term.write("\r\n\x1b[90m[connection lost — reconnecting…]\x1b[0m\r\n");
    connectShell();
    return true;
  }

  async function connectShell() {
    clearTimeout(ptyRetry);
    const url = (await PLATFORM.wsUrl()).replace(/\/ws$/, "/pty");
    if (!url) return;
    ptyWs = new WebSocket(url);
    ptyWs.binaryType = "arraybuffer";
    ptyWs.onopen = () => {
      ptySeen = Date.now();
      if (ptyWasDown) {
        ptyWasDown = false;
        term.write(attachedTo
          ? `\r\n\x1b[90m[reattached — ${attachedTo}]\x1b[0m\r\n`
          : "\r\n\x1b[90m[reconnected — new shell]\x1b[0m\r\n");
      }
      ptyWs.send(JSON.stringify({ type: "start", cols: term.cols, rows: term.rows, ...(attachedTo ? { session: attachedTo } : {}) }));
    };
    ptyWs.onmessage = (ev) => {
      ptySeen = Date.now();
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "exit") term.write(`\r\n\x1b[90m[shell exited (${m.code})]\x1b[0m\r\n`);
    };
    // The server closes the socket when the shell exits, and drops it on a
    // restart. Either way come back and start a fresh shell, the way the agent
    // socket does — this pane used to stay dead until the page was reloaded.
    ptyWs.onclose = () => {
      if (!ptyWasDown) term.write("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n");
      ptyWasDown = true;
      ptyRetry = setTimeout(connectShell, 3000);
    };
  }

  /* Drop the socket we are about to replace, handlers and all. close() fires
     its event later, by which time the replacement is already up — and the old
     onclose would schedule another connectShell, leaving two clients on one
     tmux session. Two clients are sized to the smaller of the two, which is one
     way this pane ends up drawing at a geometry nobody asked for. */
  function dropPty() {
    const dead = ptyWs;
    ptyWs = null;
    if (!dead) return;
    dead.onclose = null; dead.onmessage = null; dead.onopen = null;
    try { dead.close(); } catch { /* already gone */ }
  }

  const sendResize = () => {
    // A hidden or collapsed pane has no size, and fitting against zero asks the
    // pty for a nonsense geometry — it comes back as a wrecked terminal when
    // the pane is opened again.
    if (!termEl || !termEl.clientWidth || !termEl.clientHeight) return;
    fit.fit();
    if (ptyWs?.readyState === WebSocket.OPEN) ptyWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };

  function applyTermTheme() {
    term.options.theme = {
      background: cssVar("--code"), foreground: cssVar("--fg"), cursor: cssVar("--accent"),
      selectionBackground: cssVar("--sel"),
      black: cssVar("--line"), red: cssVar("--bad"), green: cssVar("--ok"), yellow: cssVar("--warn"),
      blue: cssVar("--accent"), magenta: "#bb9af7", cyan: "#7dcfe0", white: cssVar("--fg"),
    };
  }

  /* ---------------- attaching ---------------- */
  function attach(name, path) {
    attachedTo = name; rememberSession(name); attachedPath = path ?? "";
    dropPty();
    term.reset();
    connectShell();
    selectShell();
  }
  function detach() {
    if (!attachedTo) return;
    attachedTo = null; rememberSession(null); attachedPath = "";
    dropPty();
    term.reset();
    connectShell();
    selectShell();
  }

  /* What the pane draws can drift from what is really on the other end — a
     resize that landed while it was hidden, a font change the pty never heard
     about, a half-drawn full-screen program. So: put the geometry back first,
     then repaint xterm from its own buffer.

     Attached to a tmux session it also redials, which is the only way to get
     the *remote* side to redraw: tmux paints the whole screen for a client that
     attaches, and the session itself is untouched by the reconnect. A plain
     shell is deliberately not redialled — that socket *is* the shell, and
     dialling again would throw away whatever is running in it. */
  function refreshTerminal() {
    selectShell();                         // also refits, via the host's showView
    sendResize();
    term.clearTextureAtlas?.();            // a stale glyph atlas survives a repaint otherwise
    term.refresh(0, term.rows - 1);
    if (!attachedTo) return;
    dropPty();
    term.reset();
    connectShell();
  }

  /* ---------------- the chooser ----------------
     These are the machine's sessions, not this app's. Anything tty (or you, in
     a real terminal) started is here too, with its working directory — one set
     of sessions, several front doors. */
  const sfail = (msg) => { const n = $("snote"); if (n) { n.textContent = msg; n.className = "bad"; } };
  /* Which kill button is waiting for its second click, and until when. Kept
     out here, not in the row: the list re-renders whenever anything changes
     it, and an armed button that lives only in the row silently goes back to
     saying "kill" underneath your second click. (Measured on CI: the panel
     test clicked kill, the list repainted, and "sure?" never appeared.) */
  let armedKill = { name: null, until: 0 };
  const killArmed = (name) => armedKill.name === name && Date.now() < armedKill.until;

  function renderSessions(sessions) {
    const slist = $("slist"), snote = $("snote");
    slist.replaceChildren();
    snote.className = "";
    snote.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    if (!sessions.length) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "No tmux sessions. Create one above; it keeps running when you close this tab.";
      slist.append(e); return;
    }
    for (const s of sessions) {
      const row = document.createElement("div");
      if (s.name === attachedTo) attachedPath = s.path;          // the list is a free, fresh reading
      row.className = "s" + (s.name === attachedTo ? " live" : "");
      row.title = `${s.name} · ${s.windows} window${s.windows === 1 ? "" : "s"} · created ${new Date(s.createdAt).toLocaleString()}`;
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name;
      const cmd = document.createElement("span"); cmd.className = "cmd"; cmd.textContent = s.command;
      const pth = document.createElement("span"); pth.className = "pth"; pth.textContent = shortPath(s.path); pth.title = s.path;
      const when = document.createElement("span"); when.className = "when";
      when.textContent = (s.attached ? "● " : "") + shortAgo(s.activityAt);
      row.append(nm, cmd, pth, when);

      /* Renaming and killing happen in the row itself. The obvious version
         used prompt() and confirm(), which the web UI was happy with — but an
         MV3 side panel is not a place to rely on native dialogs, and an
         inline field is better anyway: you can see the name you are changing. */
      const ren = document.createElement("button"); ren.textContent = "rename";
      ren.onclick = (e) => {
        e.stopPropagation();
        if (row.querySelector("input")) return;
        const box = document.createElement("input");
        box.className = "rn"; box.value = s.name; box.spellcheck = false;
        const stop = (ev) => ev.stopPropagation();
        box.onclick = stop; box.onmousedown = stop;
        const cancel = () => { box.replaceWith(nm); };
        box.onkeydown = async (ev) => {
          ev.stopPropagation();
          if (ev.key === "Escape") { cancel(); return; }
          if (ev.key !== "Enter") return;
          const to = box.value.trim();
          if (!to || to === s.name) { cancel(); return; }
          try {
            const body = await api(`/sessions/${encodeURIComponent(s.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: to }) });
            /* Before rendering, or the renamed row draws as not-attached — and
               `rememberSession` too, or a reload reattaches to a name that is
               gone and quietly opens a plain shell instead. The tmux client
               survives a rename, so the pane keeps running untouched. */
            if (attachedTo === s.name) { attachedTo = to; rememberSession(to); }   // renaming does not move the pane, so attachedPath stands
            renderSessions(body.sessions);
          } catch (err) { cancel(); sfail(err.message); }
        };
        box.onblur = cancel;
        nm.replaceWith(box);
        box.focus(); box.select();
      };
      /* Two clicks, not a confirm(): whatever is running in there stops. */
      const kill = document.createElement("button");
      const paintKill = () => {
        const armed = killArmed(s.name);
        kill.textContent = armed ? "sure?" : "kill";
        kill.className = armed ? "danger" : "";
      };
      paintKill();
      kill.onclick = async (e) => {
        e.stopPropagation();
        if (!killArmed(s.name)) {
          armedKill = { name: s.name, until: Date.now() + 5000 };
          paintKill();
          setTimeout(paintKill, 5100);
          return;
        }
        armedKill = { name: null, until: 0 };
        try {
          renderSessions((await api(`/sessions/${encodeURIComponent(s.name)}`, { method: "DELETE" })).sessions);
          if (attachedTo === s.name) detach();
        } catch (err) { sfail(err.message); }
      };
      row.append(ren, kill);
      row.onclick = () => attach(s.name, s.path);
      slist.append(row);
    }
  }

  async function loadSessions() {
    try { renderSessions((await api("/sessions")).sessions); }
    catch (e) { $("slist").replaceChildren(); sfail(e.message); }
  }


  /* ---------------- pasted images ----------------
     The CLI on the other end of the pty reads files, not clipboards. So an
     image pasted into the pane is spooled to a file on the server and its
     path is typed into the terminal, where the CLI picks it up like any
     other path you typed. Text paste is untouched — xterm still handles it. */
  const PASTE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;

  /* Local echo only: the pty never sent these, so a redraw wipes them. That is
     the right lifetime for "uploading…" and for an error about a paste. */
  const termNote = (msg) => term.write(`\r\n\x1b[90m[${msg}]\x1b[0m\r\n`);

  /* `files` is the normal shape; `items` is the fallback, because a picture
     copied out of a web page can arrive as an item with no entry in `files`. */
  function imagesIn(dt) {
    if (!dt) return [];
    const out = [...(dt.files ?? [])].filter((f) => PASTE_TYPES.test(f.type));
    if (out.length) return out;
    for (const it of dt.items ?? []) {
      if (it.kind !== "file" || !PASTE_TYPES.test(it.type)) continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    return out;
  }

  async function pasteImages(files) {
    for (const f of files) {
      if (!PASTE_TYPES.test(f.type)) continue;
      try {
        const { path } = await api("/paste/image", { method: "POST", headers: { "Content-Type": f.type }, body: f });
        // A space after it, not Enter: the path joins whatever you were typing,
        // and you say when the prompt goes.
        if (ptyWs?.readyState === WebSocket.OPEN) ptyWs.send(JSON.stringify({ type: "input", data: path + " " }));
        else termNote(`image saved to ${path} — terminal is not connected`);
      } catch (e) {
        termNote(`image paste failed: ${e.message}`);
      }
    }
  }

  /* ---------------- the host's handle ---------------- */
  const TERMPANE = {
    /** Which session the pane is on, or null for a throwaway shell. */
    attached: () => attachedTo,
    /* The live pty socket. The browser tests watch its readyState to know the
       pane has really redialled, which they did against a `ptyWs` global until
       this file took it private. */
    get ws() { return ptyWs; },
    detach,
    sendResize,
    refresh: refreshTerminal,
    loadSessions,
    /** What the host should put in its note line for a view it is showing. */
    noteFor(view) {
      if (view === "sessions") return "tmux sessions on this machine";
      return attachedTo ? sessionNote() : "no approval gate";
    },
    /** The host tells the pane which view it just made visible. */
    showView(view) {
      // tmux knows where the session is now; the copy in hand may be old.
      if (view === "shell" && attachedTo) refreshAttachedPath();
      if (view === "sessions") loadSessions();
      if (view === "shell") sendResize();
    },

    /**
     * Build the terminal and wire the chooser. `selectShell` is how the pane
     * asks the host to bring the terminal forward — the host owns its tabs, so
     * it cannot be done from here. `onConfig` hands back what the server said,
     * for hosts that hide tabs a server does not support.
     */
    init(opts = {}) {
      termEl = $("term");
      const noteEl = opts.note ?? null;
      if (opts.selectShell) selectShell = opts.selectShell;
      if (opts.repaintNote) repaintNote = opts.repaintNote;

      term = new Terminal({
        cursorBlink: true, scrollback: 5000, fontFamily: cssVar("--mono"),
        fontSize: Math.max(8, Math.round(parseFloat(getComputedStyle(html).fontSize) - 1)),
      });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon.WebLinksAddon());
      term.open(termEl);
      applyTermTheme();
      term.onData((d) => { if (ptyWs?.readyState === WebSocket.OPEN) ptyWs.send(JSON.stringify({ type: "input", data: d })); });

      /* ---------------- copying out of the pane ----------------
         Two things sit between a selection and the clipboard. A tmux running
         with `mouse on` swallows the drag: the selection it draws is tmux's
         own, server-side, and the browser never sees it — holding Shift is
         what makes xterm keep the drag for itself (xterm's shouldForceSelection).
         And an xterm selection is painted, not DOM text, so the page's own
         Ctrl+C has nothing to copy even when there is a highlight.
         So the selection is put on the clipboard the moment the drag ends,
         and Ctrl+Shift+C / Cmd+C / Ctrl+Insert copy it again on demand. */
      const copySelection = async () => {
        const text = term.getSelection();
        if (!text) return;
        try { await navigator.clipboard.writeText(text); return; }
        catch { /* no clipboard API: not a secure context, or permission denied */ }
        /* The old way still works over plain http on the tailnet, where
           navigator.clipboard is undefined. */
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.append(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { termNote("could not reach the clipboard"); }
        ta.remove();
        term.focus();
      };
      /* mouseup, not onSelectionChange: the latter fires on every pixel of a
         drag, which would be a clipboard write per mousemove. The timeout lets
         xterm finish the selection it is still computing for this same event. */
      termEl.addEventListener("mouseup", () => setTimeout(copySelection, 0));
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !term.hasSelection()) return true;
        const copyKey = (e.code === "KeyC" && ((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.ctrlKey)))
          || (e.code === "Insert" && e.ctrlKey);
        if (!copyKey) return true;
        copySelection();
        return false;
      });
      /* xterm listens for paste on its own hidden textarea and only looks at
         the text flavour; an image comes through with no text at all, so the
         paste would do nothing. Catching it has to happen in the *capture*
         phase: xterm's handler calls stopPropagation(), so a listener waiting
         for the event to bubble up to this element is never called at all —
         which is how the first version of this silently did nothing. */
      termEl.addEventListener("paste", (e) => {
        const files = imagesIn(e.clipboardData);
        if (!files.length) return;
        /* stopPropagation as well as preventDefault: xterm's own handler runs
           after this one and would send an empty bracketed paste (ESC[200~
           ESC[201~) for the image it found no text in. */
        e.preventDefault(); e.stopPropagation();
        pasteImages(files);
      }, true);

      new ResizeObserver(sendResize).observe(termEl);
      addEventListener("resize", sendResize);
      setInterval(() => checkPtyLiveness(), 15_000);
      // The shared client owns theme and text size: it writes data-theme and
      // the root font-size onto <html>. Follow those rather than duplicating
      // the controls.
      new MutationObserver(() => {
        applyTermTheme();
        term.options.fontSize = Math.max(8, Math.round(parseFloat(getComputedStyle(html).fontSize) - 1));
        sendResize();
      }).observe(html, { attributes: true, attributeFilter: ["data-theme", "style"] });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTermTheme);

      $("srefresh").onclick = loadSessions;
      $("screate").onclick = async () => {
        const snew = $("snew");
        const name = snew.value.trim();
        if (!name) { snew.focus(); return; }
        try {
          renderSessions((await api("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).sessions);
          snew.value = "";
          attach(name);
        } catch (e) { sfail(e.message); }
      };
      $("snew").onkeydown = (e) => { if (e.key === "Enter") $("screate").click(); };
      if (noteEl) {
        // A click on the note while attached is the way back to a plain shell.
        noteEl.onclick = () => { if (attachedTo) detach(); };
        noteEl.title = "click to leave the session and go back to a plain shell";
      }

      /* Ask what this server has before dialling: with CODETERM_SHELL=0 there
         is no /pty route, and the retry loop would knock every three seconds. */
      (async () => {
        /* No server address yet (the extension popup is where it is set) means
           there is nothing to ask and nothing to dial. The page host always
           has one: httpBase() is the origin that served it. */
        if (!(await PLATFORM.httpBase())) { opts.onConfig?.({ shell: false, sessions: false }); return; }
        api("/config").then((c) => {
          shellOn = c.shell !== false;
          homeDir = c.home ?? "";
          // A reload comes back to the session this host was on, not a fresh shell.
          if (!c.sessions) { attachedTo = null; rememberSession(null); }
          if (attachedTo) { repaintNote(); refreshAttachedPath(); }
          opts.onConfig?.({ shell: shellOn, sessions: !!c.sessions && shellOn });
          if (shellOn) connectShell();
        }).catch(() => { opts.onConfig?.({ shell: true, sessions: false }); connectShell(); });
      })();
      sendResize();
    },
  };
  globalThis.TERMPANE = TERMPANE;
})();
