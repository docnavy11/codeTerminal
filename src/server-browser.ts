/**
 * The server browser: a headless Chromium on this machine with a persistent
 * profile, our extension loaded into it and dialled at this server, so the
 * agent's browser tools can act in it — and a live view, so a person can
 * see the tab, click, type and log in from their laptop.
 *
 * Talks to Chromium over the DevTools protocol on a private port (no
 * Playwright, no desktop): Page.startScreencast streams JPEG frames of the
 * viewed tab to each viewer socket; the viewer's mouse and key events go
 * back as Input.dispatchMouseEvent / dispatchKeyEvent — the same calls the
 * `type` and `press` tools use, so what a person can do here, the agent can.
 *
 * Logins live in the profile directory and renew the way any browser's do,
 * because it is one. Sites that bind a session to a device or an IP may
 * still challenge a login from a VPS; only trying tells (see README).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

/** The instance id the extension inside the server browser announces; the bridge and the UI know it. */
export const SERVER_BROWSER_ID = "server-browser";
/** manifest.json's name — how our extension is told apart from Chromium's built-in ones. */
const EXTENSION_NAME = "code terminal bridge";

export type ServerBrowserOptions = {
  /** Chromium binary; auto-detected when unset (see findChromium). */
  chromium?: string;
  /** Persistent profile: cookies, logins, extension state. */
  profileDir: string;
  /** Our unpacked extension, loaded into the browser. */
  extensionDir: string;
  /** Where that extension dials: this server's /ext (a function when the port is only known after listen). */
  serverWsUrl: string | (() => string);
  width?: number;
  height?: number;
  /** Present as an ordinary Chrome (default): the UA without "Headless", no webdriver flag, a screen that matches the window. */
  plain?: boolean;
  /** IANA time zone for the browser (default: the server's). Sites compare it with the IP's. */
  timezone?: string;
  /** Accept-Language / navigator.languages, e.g. "en-US,en;q=0.9,nl;q=0.8". */
  lang?: string;
  /** A proxy for all of the browser's traffic, e.g. socks5://laptop.tailnet:1080 — a way round datacenter-IP blocks. */
  proxy?: string;
  log?: (l: string) => void;
  warn?: (l: string) => void;
};

export type ServerBrowserStatus = {
  running: boolean;
  chromium: string | null;
  profileDir: string;
  pid?: number;
  startedAt?: number;
  viewers: number;
  extensionId?: string;
  tabs?: { id: string; title: string; url: string; attachedViewers: number }[];
  lastError?: string;
};

type Target = { targetId: string; type: string; title: string; url: string; attached?: boolean };

/** Where a Chromium might be: an env override, PATH, then Playwright's cache (newest build). */
export function findChromium(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  if (env.CODETERM_CHROMIUM && existsSync(env.CODETERM_CHROMIUM)) return env.CODETERM_CHROMIUM;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const dir of (env.PATH ?? "").split(":")) { const p = join(dir, name); if (dir && existsSync(p)) return p; }
  }
  const cache = join(home, ".cache", "ms-playwright");
  try {
    const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const b of builds) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) { const p = join(cache, b, sub); if (existsSync(p)) return p; }
  } catch { /* no cache */ }
  return null;
}

/** The binary's own version, as the UA an ordinary Chrome of that version sends. */
export function userAgentFor(bin: string): string {
  let major = "";
  try { major = /(\d+)\.\d+\.\d+\.\d+/.exec(execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }))?.[1] ?? ""; } catch { /* unknown build */ }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major || "120"}.0.0.0 Safari/537.36`;
}

/** A minimal DevTools-protocol client over the browser websocket: request ids, session routing, events. */
class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(sessionId: string | undefined, method: string, params: Record<string, unknown>) => void>();
  onClose: () => void = () => {};
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (raw) => {
      let m: { id?: number; sessionId?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (typeof m.id === "number") {
        const p = this.#pending.get(m.id); if (!p) return; this.#pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method) {
        for (const l of this.#listeners) { try { l(m.sessionId, m.method, m.params ?? {}); } catch { /* a listener must not break the loop */ } }
      }
    });
    ws.on("close", () => { for (const p of this.#pending.values()) p.reject(new Error("browser connection closed")); this.#pending.clear(); this.onClose(); });
    ws.on("error", () => { /* close follows */ });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (e) => { if (e) { this.#pending.delete(id); reject(e); } });
    });
  }
  on(f: (sessionId: string | undefined, method: string, params: Record<string, unknown>) => void): () => void { this.#listeners.add(f); return () => this.#listeners.delete(f); }
  close(): void { try { this.#ws.close(); } catch { /* gone */ } }
}

/** One viewer: its socket, the tab it looks at, and the CDP session on that tab. */
type Viewer = { ws: WebSocket; targetId: string | null; sessionId: string | null; meta: Record<string, unknown> | null };

export class ServerBrowser {
  #o: ServerBrowserOptions;
  #proc: ChildProcess | null = null;
  #cdp: Cdp | null = null;
  #viewers = new Set<Viewer>();
  #startedAt = 0;
  #extensionId: string | undefined;
  #lastError: string | undefined;
  #starting: Promise<void> | null = null;
  #log: (l: string) => void;
  #warn: (l: string) => void;
  onChange: () => void = () => {};

  constructor(o: ServerBrowserOptions) {
    this.#o = o;
    this.#log = o.log ?? (() => {});
    this.#warn = o.warn ?? (() => {});
  }

  get running(): boolean { return !!this.#proc && !!this.#cdp; }
  #serverHosts(): string[] {
    const u = typeof this.#o.serverWsUrl === "function" ? this.#o.serverWsUrl() : this.#o.serverWsUrl;
    try { return [new URL(u).hostname]; } catch { return []; }
  }
  /** The id Chromium gave our unpacked extension inside; known once started. */
  get extensionId(): string | undefined { return this.#extensionId; }
  get chromium(): string | null { return this.#o.chromium ?? findChromium(); }

  async status(): Promise<ServerBrowserStatus> {
    const base: ServerBrowserStatus = { running: this.running, chromium: this.chromium, profileDir: this.#o.profileDir, viewers: this.#viewers.size, ...(this.#lastError ? { lastError: this.#lastError } : {}) };
    if (!this.running) return base;
    let tabs: ServerBrowserStatus["tabs"];
    try {
      tabs = (await this.#pages()).map((t) => ({ id: t.targetId, title: t.title, url: t.url, attachedViewers: [...this.#viewers].filter((v) => v.targetId === t.targetId).length }));
    } catch { tabs = []; }
    return { ...base, pid: this.#proc!.pid, startedAt: this.#startedAt, extensionId: this.#extensionId, tabs };
  }

  /** Launch Chromium (idempotent), connect, bootstrap the extension, make sure one tab exists. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const bin = this.chromium;
    if (!bin) throw new Error("no Chromium found: set CODETERM_CHROMIUM to a chrome/chromium binary (Playwright's ~/.cache/ms-playwright/chromium-*/ works)");
    await mkdir(this.#o.profileDir, { recursive: true });
    const w = this.#o.width ?? 1280, h = this.#o.height ?? 800;
    const args = [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.#o.profileDir}`,
      `--disable-extensions-except=${this.#o.extensionDir}`, `--load-extension=${this.#o.extensionDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox",
      `--window-size=${w},${h}`, "--hide-crash-restore-bubble", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      ...(this.#o.lang ? [`--lang=${this.#o.lang.split(",")[0]}`, `--accept-lang=${this.#o.lang}`] : []),
      // The proxy is for the sites; the extension's own socket to this server
      // and anything on loopback go direct.
      ...(this.#o.proxy ? [`--proxy-server=${this.#o.proxy}`, `--proxy-bypass-list=${["127.0.0.1", "localhost", "<-loopback>", ...this.#serverHosts()].join(";")}`] : []),
    ];
    if (this.#o.plain !== false) {
      // Measured before this: UA "HeadlessChrome/151", navigator.webdriver true,
      // screen 800×600 under a 1280-wide viewport — three ways to say
      // "automation", and sites answered with blocks. This is your own
      // browser for your own logins; let it look like one.
      args.push(`--user-agent=${userAgentFor(bin)}`, "--disable-blink-features=AutomationControlled", `--screen-info={${w}x${h}}`);
    }
    args.push("about:blank");
    this.#lastError = undefined;
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...(this.#o.timezone ? { TZ: this.#o.timezone } : {}) } });
    this.#proc = proc;
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error(`Chromium did not announce its DevTools port in 20s${buf ? `; stderr: ${buf.slice(-400)}` : ""}`)), 20_000);
      proc.stderr!.on("data", (d) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      proc.once("exit", (code) => { clearTimeout(t); reject(new Error(`Chromium exited with code ${code} before it was ready${buf ? `; stderr: ${buf.slice(-400)}` : ""}`)); });
    }).catch((e) => { this.#lastError = e.message; this.#kill(); throw e; });
    proc.on("exit", (code) => {
      if (this.#proc !== proc) return;
      this.#warn(`[server-browser] Chromium exited (${code})`);
      this.#proc = null; this.#cdp?.close(); this.#cdp = null;
      for (const v of this.#viewers) { this.#tell(v, { kind: "gone", reason: "the server browser stopped" }); try { v.ws.close(); } catch { /* */ } }
      this.#viewers.clear(); this.onChange();
    });
    const sock = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => { sock.once("open", () => resolve()); sock.once("error", (e) => reject(e)); });
    const cdp = new Cdp(sock);
    this.#cdp = cdp;
    cdp.onClose = () => { if (this.#cdp === cdp) { this.#cdp = null; this.onChange(); } };
    this.#startedAt = Date.now();
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.#bootstrapExtension().catch((e) => this.#warn(`[server-browser] extension bootstrap: ${e instanceof Error ? e.message : e}`));
    if (!(await this.#pages()).length) await cdp.send("Target.createTarget", { url: "about:blank" });
    this.#log(`[server-browser] started pid ${proc.pid}, ${bin}, profile ${this.#o.profileDir}`);
    this.onChange();
  }

  /** Point the extension inside at this server: set its storage the way the popup would. */
  async #bootstrapExtension(): Promise<void> {
    const cdp = this.#cdp!;
    // Chromium ships built-in component extensions whose workers are also
    // called background.js (measured: two candidates besides ours); the one
    // that is ours says so in its manifest.
    const isOurs = async (t: Target): Promise<string | null> => {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      try {
        const r = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : null", returnByValue: true }, sessionId);
        if (r.result.value === EXTENSION_NAME) return sessionId;
      } catch { /* not ours, or not ready */ }
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      return null;
    };
    let worker: Target | undefined; let sessionId: string | null = null;
    const tried = new Set<string>();
    for (let i = 0; i < 100 && !sessionId; i++) {
      const { targetInfos } = await cdp.send<{ targetInfos: Target[] }>("Target.getTargets");
      for (const t of targetInfos) {
        if (t.type !== "service_worker" || !t.url.startsWith("chrome-extension://") || tried.has(t.targetId)) continue;
        tried.add(t.targetId);
        const sid = await isOurs(t);
        if (sid) { worker = t; sessionId = sid; break; }
      }
      if (!sessionId) await new Promise((r) => setTimeout(r, 100));
    }
    if (!worker || !sessionId) throw new Error(`the extension's service worker did not appear (is ${this.#o.extensionDir} the unpacked MV3 extension?)`);
    this.#extensionId = /^chrome-extension:\/\/([a-z]+)\//.exec(worker.url)?.[1];
    try {
      const serverUrl = typeof this.#o.serverWsUrl === "function" ? this.#o.serverWsUrl() : this.#o.serverWsUrl;
      const expr = `chrome.storage.local.set(${JSON.stringify({ serverUrl, instanceId: SERVER_BROWSER_ID, enabled: true })}).then(() => "ok")`;
      const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "storage set failed");
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc; const cdp = this.#cdp;
    this.#proc = null; this.#cdp = null;
    for (const v of this.#viewers) { this.#tell(v, { kind: "gone", reason: "the server browser was stopped" }); try { v.ws.close(); } catch { /* */ } }
    this.#viewers.clear();
    if (cdp) { await cdp.send("Browser.close").catch(() => {}); cdp.close(); }
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } resolve(); }, 3000);
        proc.once("exit", () => { clearTimeout(t); resolve(); });
        try { proc.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
      });
    }
    this.#log("[server-browser] stopped");
    this.onChange();
  }

  #kill(): void { const p = this.#proc; this.#proc = null; this.#cdp?.close(); this.#cdp = null; if (p && p.exitCode === null) { try { p.kill("SIGKILL"); } catch { /* */ } } }

  async #pages(): Promise<Target[]> {
    const { targetInfos } = await this.#cdp!.send<{ targetInfos: Target[] }>("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension://") && !t.url.startsWith("devtools://"));
  }

  /** Run an expression in a tab (tests and the status page). */
  async evaluate(expression: string, targetId?: string): Promise<unknown> {
    if (!this.#cdp) throw new Error("the server browser is not running");
    const id = targetId ?? (await this.#pages())[0]?.targetId;
    if (!id) throw new Error("no tab");
    const { sessionId } = await this.#cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: id, flatten: true });
    try {
      const r = await this.#cdp.send<{ result: { value?: unknown; description?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "evaluation failed");
      return r.result.value;
    } finally { await this.#cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}); }
  }

  async navigate(url: string, targetId?: string): Promise<void> {
    if (!this.#cdp) throw new Error("the server browser is not running");
    const id = targetId ?? (await this.#pages())[0]?.targetId;
    if (!id) throw new Error("no tab");
    const { sessionId } = await this.#cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: id, flatten: true });
    try { await this.#cdp.send("Page.navigate", { url }, sessionId); }
    finally { await this.#cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}); }
  }

  /* ---------------- live view ---------------- */

  /** A viewer socket: frames out, input in. Closes with the browser. */
  attachViewer(ws: WebSocket): void {
    const v: Viewer = { ws, targetId: null, sessionId: null, meta: null };
    this.#viewers.add(v);
    if (!this.running) { this.#tell(v, { kind: "gone", reason: "the server browser is not running" }); try { ws.close(); } catch { /* */ } this.#viewers.delete(v); return; }
    const cdp = this.#cdp!;
    const off = cdp.on((sessionId, method, params) => {
      if (sessionId !== v.sessionId) return;
      if (method === "Page.screencastFrame") {
        v.meta = params.metadata as Record<string, unknown>;
        this.#tell(v, { kind: "frame", data: params.data, meta: params.metadata });
        cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, v.sessionId!).catch(() => {});
      } else if (method === "Page.frameNavigated" && !(params.frame as { parentId?: string })?.parentId) {
        this.#tell(v, { kind: "url", url: (params.frame as { url: string }).url });
      } else if (method === "Page.javascriptDialogOpening") {
        this.#tell(v, { kind: "dialog", type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
      }
    });
    ws.on("message", (raw) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      this.#viewerMessage(v, m).catch((e) => this.#tell(v, { kind: "error", message: e instanceof Error ? e.message : String(e) }));
    });
    ws.on("close", () => { off(); this.#viewers.delete(v); void this.#detach(v); this.onChange(); });
    void this.#view(v, null).catch((e) => this.#tell(v, { kind: "error", message: e instanceof Error ? e.message : String(e) }));
    this.onChange();
  }

  #tell(v: Viewer, m: Record<string, unknown>): void { if (v.ws.readyState === WebSocket.OPEN) v.ws.send(JSON.stringify(m)); }

  async #detach(v: Viewer): Promise<void> {
    const cdp = this.#cdp; const sid = v.sessionId; v.sessionId = null; v.targetId = null;
    if (!cdp || !sid) return;
    await cdp.send("Page.stopScreencast", {}, sid).catch(() => {});
    await cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
  }

  /** Look at a tab (the first page when null): attach, enable events, start the screencast. */
  async #view(v: Viewer, targetId: string | null): Promise<void> {
    const cdp = this.#cdp; if (!cdp) return;
    await this.#detach(v);
    const pages = await this.#pages();
    const target = (targetId && pages.find((p) => p.targetId === targetId)) ?? pages[0];
    if (!target) throw new Error("no tab to show");
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    v.sessionId = sessionId; v.targetId = target.targetId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Target.activateTarget", { targetId: target.targetId }).catch(() => {});
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: this.#o.width ?? 1280, maxHeight: this.#o.height ?? 800, everyNthFrame: 1 }, sessionId);
    this.#tell(v, { kind: "viewing", id: target.targetId, url: target.url, title: target.title });
    await this.#sendTabs(v);
  }

  async #sendTabs(v: Viewer): Promise<void> {
    const pages = await this.#pages();
    this.#tell(v, { kind: "tabs", current: v.targetId, tabs: pages.map((p) => ({ id: p.targetId, title: p.title, url: p.url })) });
  }

  async #viewerMessage(v: Viewer, m: Record<string, unknown>): Promise<void> {
    const cdp = this.#cdp; if (!cdp) return;
    const sid = v.sessionId;
    switch (m.type) {
      case "mouse": {
        if (!sid) return;
        const { x, y } = this.#scale(v, Number(m.x), Number(m.y));
        await cdp.send("Input.dispatchMouseEvent", {
          type: String(m.kind), x, y, button: (m.button as string) ?? "none", buttons: Number(m.buttons ?? 0), clickCount: Number(m.clickCount ?? 0), modifiers: Number(m.modifiers ?? 0),
          ...(m.kind === "mouseWheel" ? { deltaX: Number(m.deltaX ?? 0), deltaY: Number(m.deltaY ?? 0) } : {}),
        }, sid);
        return;
      }
      case "key": {
        if (!sid) return;
        const text = typeof m.text === "string" ? m.text : undefined;
        await cdp.send("Input.dispatchKeyEvent", {
          type: String(m.kind), key: String(m.key ?? ""), code: String(m.code ?? ""), modifiers: Number(m.modifiers ?? 0),
          windowsVirtualKeyCode: Number(m.vk ?? 0), nativeVirtualKeyCode: Number(m.vk ?? 0),
          ...(text ? { text, unmodifiedText: text } : {}),
        }, sid);
        return;
      }
      case "text": {   // pasted or IME text: one insertText
        if (!sid) return;
        await cdp.send("Input.insertText", { text: String(m.text ?? "") }, sid);
        return;
      }
      case "navigate": {
        if (!sid) return;
        let url = String(m.url ?? "").trim();
        if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        await cdp.send("Page.navigate", { url }, sid);
        return;
      }
      case "back": case "forward": {
        if (!sid) return;
        const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, sid);
        const e = h.entries[h.currentIndex + (m.type === "back" ? -1 : 1)];
        if (e) await cdp.send("Page.navigateToHistoryEntry", { entryId: e.id }, sid);
        return;
      }
      case "reload": if (sid) await cdp.send("Page.reload", {}, sid); return;
      case "dialog": if (sid) await cdp.send("Page.handleJavaScriptDialog", { accept: !!m.accept, ...(typeof m.text === "string" ? { promptText: m.text } : {}) }, sid); return;
      case "tabs": await this.#sendTabs(v); return;
      case "tab": await this.#view(v, String(m.id)); return;
      case "newtab": {
        const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: typeof m.url === "string" && m.url ? m.url : "about:blank" });
        await this.#view(v, targetId);
        return;
      }
      case "closetab": {
        const id = String(m.id ?? v.targetId);
        const pages = await this.#pages();
        if (pages.length <= 1) { await cdp.send("Target.createTarget", { url: "about:blank" }); }
        await cdp.send("Target.closeTarget", { targetId: id });
        if (v.targetId === id) { v.sessionId = null; v.targetId = null; await this.#view(v, null); } else await this.#sendTabs(v);
        return;
      }
      case "resize": return;   // viewers scale the fixed-size frame; no viewport change per viewer
      default: return;
    }
  }

  /** The viewer converts its pointer position to CSS pixels of the viewport (it knows the
      frame's displayed size and the metadata's deviceWidth); here they pass through, clamped. */
  #scale(v: Viewer, x: number, y: number): { x: number; y: number } {
    const meta = v.meta as { deviceWidth?: number; deviceHeight?: number } | null;
    const w = meta?.deviceWidth ?? this.#o.width ?? 1280, h = meta?.deviceHeight ?? this.#o.height ?? 800;
    return { x: Math.max(0, Math.min(w, Math.round(x))), y: Math.max(0, Math.min(h, Math.round(y))) };
  }
}
