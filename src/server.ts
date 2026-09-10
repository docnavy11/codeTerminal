import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ClientEvent } from "./session.js";
import { Manager } from "./conversation.js";
import { BrowserBridge } from "./browser.js";
import * as files from "./files.js";
import { wantsContext } from "./prompt.js";
import { pruneScreenshots } from "./screenshots.js";
import { WatchRegistry } from "./watches.js";
import { stat } from "node:fs/promises";
import { setBridge, setShellSource, setWatchSource } from "./session.js";
import { Shell } from "./shell.js";
import { whois, self as tailnetSelf, normaliseIp, isLoopback } from "./tailnet.js";

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

const EXTRA_ORIGINS = (process.env.CODETERM_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (HOST === "0.0.0.0" || HOST === "::") {
  console.error("Refusing to bind all interfaces. /pty is an ungated shell; keep it on the tailnet.");
  process.exit(1);
}
mkdirSync(WORKSPACE, { recursive: true });

// The Chrome extension dials in here; browser tools speak through it.
const bridge = new BrowserBridge((line) => console.log(`[ext] ${line}`));
setBridge(bridge);

// The most recently opened shell pane. Several tabs can each have one; the
// agent reads the newest, which is the one the user is looking at.
let activeShell: Shell | null = null;
setShellSource(() => activeShell);



// Chats live on disk; only the active one has a running SDK session.
const convo = new Manager(WORKSPACE, process.env.CODETERM_CHATS ?? join(ROOT, "chats"));
await convo.boot();

const watches = new WatchRegistry();
setWatchSource(watches, () => convo.activeId);
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
  const outcome = convo.watchFired(
    w.chatId,
    w.description,
    detail,
    `A page watch you set has fired. You were waiting for: ${w.description}. ` +
      `What happened: ${detail}. Tell the user, briefly. Do not re-set the watch unless asked.`,
  );
  if (outcome === "noted") console.log(`[watch] chat not active; left on the list`);
});

// Expired and long-fired watches should not clutter the list forever.
setInterval(() => {
  for (const w of watches.sweep()) {
    void bridge.send("watch_stop", { watchId: w.id }).catch(() => {});
  }
}, 60_000).unref();

const resolved = await tailnetSelf();
if (!resolved) {
  console.error("Could not read this node's tailnet identity (`tailscale status --json`).");
  console.error("Authentication depends on it, so refusing to start.");
  process.exit(1);
}
const SELF: { userId: number; dnsName: string } = resolved;

/**
 * Origins a browser may legitimately be on. A cross-origin page gets rejected
 * here — WebSockets have no same-origin policy of their own, so without this
 * any site you visit could open /pty.
 */
const ALLOWED_ORIGINS = new Set(
  [HOST, SELF.dnsName, SELF.dnsName.split(".")[0], "localhost", "127.0.0.1", ...EXTRA_ORIGINS]
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

  const who = await whois(ip, req.socket.remotePort ?? 0);
  if (!who) return `${ip} is not on this tailnet`;
  if (who.userId !== SELF.userId) return `${who.loginName} is not the owner`;
  return null;
}

const app = express();

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

app.get("/files/info", guard, async (_req, res) => {
  // Where the browser should open: the agent's workspace when it sits under
  // the browsable root, else the root itself.
  let start = "";
  try { start = files.toRel(FILES_ROOT, await files.safePath(FILES_ROOT, WORKSPACE)); } catch { start = ""; }
  res.json({ root: FILES_ROOT, start, maxUpload: MAX_UPLOAD, cwd: convo.cwd });
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

app.post("/files/upload", guard, express.raw({ type: "*/*", limit: MAX_UPLOAD }), async (req, res) => {
  try {
    const name = String(req.query.name ?? "");
    const dir = typeof req.query.path === "string" ? req.query.path : undefined;
    if (!name) throw new Error("missing ?name=");
    res.json(await files.saveUpload(FILES_ROOT, dir, name, req.body as Buffer));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.use(express.static(join(ROOT, "public")));
app.use("/vendor/xterm", express.static(join(ROOT, "node_modules/@xterm/xterm")));
app.use("/vendor/addon-fit", express.static(join(ROOT, "node_modules/@xterm/addon-fit")));
app.use("/vendor/addon-web-links", express.static(join(ROOT, "node_modules/@xterm/addon-web-links")));
app.use("/vendor/marked", express.static(join(ROOT, "node_modules/marked/lib")));
app.use("/vendor/dompurify", express.static(join(ROOT, "node_modules/dompurify/dist")));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

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
    if (route === "/ws") attachAgent(ws, new URL(req.url ?? "/", "http://x").searchParams.get("observe") !== "1");
    else if (route === "/ext") bridge.attach(ws);
    else attachShell(ws);
  });
});

/** The Claude session: gated, streaming, and it survives a reload. */
function attachAgent(ws: WebSocket, replay = true): void {
  const send = (e: ClientEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  };
  console.log(`[ws] client attached${replay ? "" : " (observer)"}`);
  // Replays the whole conversation, including any approval still awaiting you —
  // unless this is a pure observer (?observe=1).
  convo.attach(send, replay);

  ws.on("message", (raw) => {
    let msg: { type?: string; text?: string; id?: string; decision?: string; mode?: string;
               answers?: unknown; withTab?: boolean; path?: string };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const session = convo.session;

    switch (msg.type) {
      case "prompt": {
        if (typeof msg.text !== "string" || !msg.text.trim()) return;
        if (session.busy) { send({ kind: "error", message: "Still working — press Stop first." }); return; }
        const text = msg.text;
        // Ask the browser what the user is looking at. Never blocks the turn:
        // activeTab resolves to null on timeout, restriction or no extension.
        const attach = msg.withTab !== false && wantsContext(text);
        void (attach ? bridge.activeTab() : Promise.resolve(null)).then((tab) => {
          const context = tab?.url
            ? [`active tab: ${tab.title ?? "(untitled)"} — ${tab.url}`,
               tab.selection ? `selected text:\n${tab.selection}` : null].filter(Boolean).join("\n")
            : undefined;
          convo.recordUser(text, context);
          session.send(text, context);
        });
        return;
      }

      case "answer":
        if (typeof msg.id === "string" && msg.answers && typeof msg.answers === "object") {
          convo.session.answer(msg.id, msg.answers as Record<string, string>);
        }
        return;

      case "decision":
        if (typeof msg.id === "string" && (msg.decision === "allow" || msg.decision === "always" || msg.decision === "deny")) {
          session.decide(msg.id, msg.decision);
        }
        return;

      case "cwd": {
        if (typeof msg.path !== "string") return;
        // Same containment rule as the file browser, so a typo cannot point
        // the agent somewhere unexpected.
        files.safePath(FILES_ROOT, msg.path)
          .then(async (abs) => {
            const st = await stat(abs);
            if (!st.isDirectory()) throw new Error("not a directory");
            await convo.setCwd(abs);
          })
          .catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      }

      case "mode":
        if (msg.mode === "default" || msg.mode === "acceptEdits" || msg.mode === "auto" ||
            msg.mode === "plan" || msg.mode === "dontAsk" || msg.mode === "bypassPermissions") {
          convo.setMode(msg.mode).catch((e) => send({ kind: "error", message: String(e) }));
        }
        return;

      case "interrupt":
        session.interrupt().catch(() => {});
        return;

      case "new":
        convo.create().catch((e: unknown) => send({ kind: "error", message: String(e) }));
        return;

      case "open":
        if (typeof msg.id === "string") {
          convo.open(msg.id).catch((e: unknown) => send({ kind: "error", message: String(e) }));
        }
        return;

      case "delete":
        if (typeof msg.id === "string") {
          convo.remove(msg.id).catch((e: unknown) => send({ kind: "error", message: String(e) }));
        }
        return;
    }
  });

  // A closed tab must NOT end the session — that is the whole point.
  const detach = () => { console.log(`[ws] client detached${replay ? "" : " (observer)"}`); convo.detach(send); };
  ws.on("close", detach);
  ws.on("error", detach);
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
      case "start":  shell.start(convo.cwd, msg.cols ?? 80, msg.rows ?? 24); return;
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
  console.log(`identity       ${SELF.dnsName} · tailnet user ${SELF.userId}`);
  console.log(`workspace      ${WORKSPACE}`);
  console.log(`shell          /pty — real PTY, NO approval gate`);
  console.log(`browser        /ext — extension bridge, tools ungated`);
  console.log(`files          ${FILES_ROOT} (browse, upload, download)`);
  console.log(`origins        ${[...ALLOWED_ORIGINS].join("  ")}`);
}

// A restart is a good moment to drop what the previous run left behind.
void pruneScreenshots().then((n) => { if (n) console.log(`[shots] pruned ${n} old screenshots`); });

listenWithRetry();
