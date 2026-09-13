/* Live view of the server browser: JPEG frames of the viewed tab arrive on
   /browser/live; the pointer and keyboard go back as real input events.
   Click the image to give it keyboard focus; type as you would in the tab. */
(() => {
  const $ = (id) => document.getElementById(id);
  const screen = $("screen"), st = $("st"), url = $("url"), tabs = $("tabs");
  let ws = null, meta = null, retry = null, current = null, viewing = null, lastUrl = "";
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const modsOf = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  const note = (text, action, onAct) => { $("notetext").textContent = text; const b = $("noteact"); b.hidden = !action; b.textContent = action || ""; b.onclick = onAct || null; $("note").hidden = !text; };

  function connect() {
    clearTimeout(retry);
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/browser/live`);
    ws.onopen = () => { st.textContent = "live"; st.classList.remove("bad"); note(""); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.kind) {
        case "frame": meta = m.meta; screen.src = "data:image/jpeg;base64," + m.data; break;
        case "viewing": viewing = m.id; if (document.activeElement !== url) url.value = m.url === "about:blank" ? "" : m.url; lastUrl = m.url; break;
        case "url": if (document.activeElement !== url) url.value = m.url === "about:blank" ? "" : m.url; lastUrl = m.url; break;
        case "tabs": {
          current = m.current; tabs.replaceChildren();
          for (const t of m.tabs) { const o = new Option((t.title || t.url || "(untitled)").slice(0, 60), t.id); tabs.append(o); }
          tabs.value = m.current || ""; break;
        }
        case "dialog": showDialog(m); break;
        case "gone": st.textContent = "stopped"; st.classList.add("bad"); note(m.reason + ".", "Start it", startAndReconnect); break;
        case "error": st.textContent = m.message; st.classList.add("bad"); setTimeout(() => { if (ws?.readyState === 1) { st.textContent = "live"; st.classList.remove("bad"); } }, 3000); break;
      }
    };
    ws.onclose = () => { if (st.textContent === "live") { st.textContent = "reconnecting…"; } retry = setTimeout(connect, 2000); };
    ws.onerror = () => {};
  }
  async function startAndReconnect() {
    note("starting…");
    try { const r = await fetch("/browser/server/start", { method: "POST" }); if (!r.ok) throw new Error((await r.json()).error || r.status); note(""); connect(); }
    catch (e) { note("could not start: " + e.message, "Retry", startAndReconnect); }
  }

  /* ---- pointer: image pixels → CSS pixels of the tab's viewport ---- */
  const pos = (e) => {
    const r = screen.getBoundingClientRect();
    const w = meta?.deviceWidth || screen.naturalWidth || r.width, h = meta?.deviceHeight || screen.naturalHeight || r.height;
    return { x: (e.clientX - r.left) / r.width * w, y: (e.clientY - r.top) / r.height * h };
  };
  const BTN = ["left", "middle", "right"];
  let pressed = 0;
  screen.addEventListener("contextmenu", (e) => e.preventDefault());
  screen.addEventListener("mousedown", (e) => { e.preventDefault(); screen.focus(); pressed = e.buttons; const { x, y } = pos(e); send({ type: "mouse", kind: "mousePressed", x, y, button: BTN[e.button] || "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modsOf(e) }); });
  screen.addEventListener("mouseup", (e) => { pressed = e.buttons; const { x, y } = pos(e); send({ type: "mouse", kind: "mouseReleased", x, y, button: BTN[e.button] || "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modsOf(e) }); });
  let lastMove = 0;
  screen.addEventListener("mousemove", (e) => { const now = performance.now(); if (now - lastMove < 30 && !pressed) return; lastMove = now; const { x, y } = pos(e); send({ type: "mouse", kind: "mouseMoved", x, y, button: pressed ? "left" : "none", buttons: e.buttons, modifiers: modsOf(e) }); });
  screen.addEventListener("wheel", (e) => { e.preventDefault(); const { x, y } = pos(e); send({ type: "mouse", kind: "mouseWheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modsOf(e) }); }, { passive: false });

  /* ---- keyboard: real key events; printable keys carry text ---- */
  const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, " ": 32,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123, Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20 };
  const vkOf = (e) => VK[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0);
  screen.addEventListener("keydown", (e) => {
    // the browser's own shortcuts stay with the browser: reload, find, tabs, devtools
    if ((e.ctrlKey || e.metaKey) && /^[rtwnfl]$/i.test(e.key) && !e.shiftKey) return;
    if (e.key === "F5" || e.key === "F12") return;
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
    send({ type: "key", kind: text ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, vk: vkOf(e), modifiers: modsOf(e), ...(text ? { text } : {}) });
  });
  screen.addEventListener("keyup", (e) => { if ((e.ctrlKey || e.metaKey) && /^[rtwnfl]$/i.test(e.key) && !e.shiftKey) return; e.preventDefault(); send({ type: "key", kind: "keyUp", key: e.key, code: e.code, vk: vkOf(e), modifiers: modsOf(e) }); });
  screen.addEventListener("paste", (e) => { const t = e.clipboardData?.getData("text"); if (t) { e.preventDefault(); send({ type: "text", text: t }); } });
  $("paste").onclick = async () => { try { const t = await navigator.clipboard.readText(); if (t) send({ type: "text", text: t }); screen.focus(); } catch { st.textContent = "clipboard not readable here"; } };

  /* ---- chrome ---- */
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") { send({ type: "navigate", url: url.value }); screen.focus(); } if (e.key === "Escape") { url.value = lastUrl === "about:blank" ? "" : lastUrl; screen.focus(); } });
  $("back").onclick = () => { send({ type: "back" }); screen.focus(); };
  $("fwd").onclick = () => { send({ type: "forward" }); screen.focus(); };
  $("reload").onclick = () => { send({ type: "reload" }); screen.focus(); };
  $("newtab").onclick = () => { send({ type: "newtab" }); url.focus(); };
  $("closetab").onclick = () => { send({ type: "closetab" }); screen.focus(); };
  tabs.onchange = () => { if (tabs.value && tabs.value !== viewing) send({ type: "tab", id: tabs.value }); screen.focus(); };

  function showDialog(m) {
    $("dlgtext").textContent = `${m.type}: ${m.message || ""}`;
    const inp = $("dlginput"); inp.hidden = m.type !== "prompt"; inp.value = m.defaultPrompt || "";
    $("dialog").hidden = false;
    $("dlgok").onclick = () => { send({ type: "dialog", accept: true, ...(m.type === "prompt" ? { text: inp.value } : {}) }); $("dialog").hidden = true; screen.focus(); };
    $("dlgcancel").onclick = () => { send({ type: "dialog", accept: false }); $("dialog").hidden = true; screen.focus(); };
    if (m.type === "prompt") inp.focus();
  }

  connect();
  screen.focus();
})();
