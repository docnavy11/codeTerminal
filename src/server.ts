import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ClientEvent } from "./session.js";
import { Manager } from "./conversation.js";
import { BrowserBridge } from "./browser.js";
import { setBridge } from "./session.js";
import { Shell } from "./shell.js";
import { whois, self as tailnetSelf, normaliseIp, isLoopback } from "./tailnet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HOST = process.env.CODETERM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CODETERM_PORT ?? 8123);
const WORKSPACE = process.env.CODETERM_WORKSPACE ?? join(ROOT, "workspace");
const EXTRA_ORIGINS = (process.env.CODETERM_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (HOST === "0.0.0.0" || HOST === "::") {
  console.error("Refusing to bind all interfaces. /pty is an ungated shell; keep it on the tailnet.");
  process.exit(1);
}
mkdirSync(WORKSPACE, { recursive: true });

// The Chrome extension dials in here; browser tools speak through it.
const bridge = new BrowserBridge((line) => console.log(`[ext] ${line}`));
setBridge(bridge);

// Chats live on disk; only the active one has a running SDK session.
const convo = new Manager(WORKSPACE, join(ROOT, "chats"));
await convo.boot();

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

  // The extension's Origin is chrome-extension://<id>, which can never be a
  // page on a website, so the cross-site concern the Origin check exists for
  // does not apply. Pin a specific id with CODETERM_EXT_ORIGIN if you want.
  if (route === "/ext" && typeof origin === "string" && origin.startsWith("chrome-extension://")) {
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
    if (route === "/ws") attachAgent(ws);
    else if (route === "/ext") bridge.attach(ws);
    else attachShell(ws);
  });
});

/** The Claude session: gated, streaming, and it survives a reload. */
function attachAgent(ws: WebSocket): void {
  const send = (e: ClientEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  };
  // Replays the whole conversation, including any approval still awaiting you.
  convo.attach(send);

  ws.on("message", (raw) => {
    let msg: { type?: string; text?: string; id?: string; decision?: string; mode?: string; answers?: unknown };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const session = convo.session;

    switch (msg.type) {
      case "prompt":
        if (typeof msg.text !== "string" || !msg.text.trim()) return;
        if (session.busy) { send({ kind: "error", message: "Still working — press Stop first." }); return; }
        convo.recordUser(msg.text);
        session.send(msg.text);
        return;

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
  const detach = () => convo.detach(send);
  ws.on("close", detach);
  ws.on("error", detach);
}

/** The shell: a real PTY, no approval gate. */
function attachShell(ws: WebSocket): void {
  const shell = new Shell(
    (chunk) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, "utf8"), { binary: true }); },
    (code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", code }));
      ws.close();
    },
  );

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { shell.write(raw.toString("utf8")); return; }
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "start":  shell.start(WORKSPACE, msg.cols ?? 80, msg.rows ?? 24); return;
      case "input":  if (typeof msg.data === "string") shell.write(msg.data); return;
      case "resize": shell.resize(msg.cols ?? 80, msg.rows ?? 24); return;
    }
  });

  const close = () => shell.kill();
  ws.on("close", close);
  ws.on("error", close);
}

server.listen(PORT, HOST, () => {
  console.log(`code-terminal  http://${HOST}:${PORT}`);
  console.log(`identity       ${SELF.dnsName} · tailnet user ${SELF.userId}`);
  console.log(`workspace      ${WORKSPACE}`);
  console.log(`shell          /pty — real PTY, NO approval gate`);
  console.log(`browser        /ext — extension bridge, tools ungated`);
  console.log(`origins        ${[...ALLOWED_ORIGINS].join("  ")}`);
});
