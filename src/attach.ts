import type { WebSocket } from "ws";
import { stat } from "node:fs/promises";
import type { Manager, LiveChat } from "./conversation.js";
import type { BrowserBridge } from "./browser.js";
import { SERVER_BROWSER_ID } from "./server-browser.js";
import { Shell } from "./shell.js";
import * as files from "./files.js";
import { wantsContext } from "./prompt.js";
import { resolveProject } from "./projects.js";
import { parseAgentMessage, type AgentMessage, type ClientEvent, type ShellMessage } from "./protocol.js";

/**
 * The per-connection protocol loops for /ws (agent) and /pty (shell). Pulled
 * out of server.ts so the composition root stops being the place that also
 * knows every message type.
 */
export type AttachContext = {
  convo: Manager;
  bridge: BrowserBridge;
  filesRoot: string;
  workspace: string;
  /** Every attached client's list refresher, so a rename shows up everywhere. */
  clients: Set<() => void>;
  /** Every attached client's browsers-list sender, for when a browser connects or drops. */
  browserWatchers?: Set<() => void>;
  /** Cross-connection state that is "whatever was most recent" by design. */
  state: {
    /** The chat most recently attached to; a shell pane opens in its cwd. */
    lastChat: LiveChat | null;
    /** The most recently opened shell pane; the agent reads that one. */
    activeShell: Shell | null;
  };
};

/**
 * Every attached client picks its own conversation, so two browsers can hold
 * two different chats at once.
 */
export function attachAgent(ws: WebSocket, ctx: AttachContext, replay = true, wantId: string | null = null): void {
  const { convo, bridge, state } = ctx;
  const send = (e: ClientEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };

  // Land on the chat this client asked for (each window remembers its own), else
  // the most recent one; the client can switch immediately either way.
  const startId = (wantId && convo.get(wantId) ? wantId : null) ?? convo.newestId();
  let chat: LiveChat = (startId && convo.get(startId)) || convo.create();
  let clientBrowser: string | undefined;
  state.lastChat = chat;

  const listFor = () => send({ kind: "chats", chats: convo.list(), activeId: chat.id });
  const sendProject = (c: LiveChat) => { const p = c.project(convo.projects()); send({ kind: "project", id: p.id, name: p.name }); };
  const enter = (next: LiveChat, clear: boolean) => {
    chat.detach(send);
    chat = next;
    state.lastChat = next;
    next.useBrowser(clientBrowser);
    if (clear) send({ kind: "cleared" });
    next.attach(send, true);
    listFor();
    send({ kind: "mode", mode: next.mode });
    send({ kind: "model", model: next.model });
    sendProject(next);
  };

  const sendBrowsers = () => send({ kind: "browsers", list: bridge.instances.filter((i) => !i.startsWith("pending:")).map((id) => ({ id, server: id === SERVER_BROWSER_ID })) });
  ctx.browserWatchers?.add(sendBrowsers);
  chat.attach(send, replay);
  listFor();
  sendBrowsers();
  send({ kind: "mode", mode: chat.mode });
  send({ kind: "model", model: chat.model });
  sendProject(chat);

  ws.on("message", (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }
    const msg = parseAgentMessage(parsed);
    if (!msg) return;

    // A throw here would be an uncaught exception — one bad message from an
    // authorised client took the whole server down. Report it to that client.
    try { dispatch(msg); }
    catch (e) { send({ kind: "error", message: e instanceof Error ? e.message : String(e) }); }
  });

  function dispatch(msg: AgentMessage): void {
    switch (msg.type) {
      case "prompt": {
        const target = chat;
        // Bind the browser at send time, not attach time: two clients can start
        // on the same chat and the last to attach would otherwise capture it.
        target.useBrowser(clientBrowser);
        const attach = msg.withTab !== false && wantsContext(msg.text);
        // The chat is busy from here on, including while the tab lookup (up to
        // 2.5s) is still pending — a second prompt in that window is refused.
        target.prompt(msg.text, async () => {
          const tab = attach ? await bridge.activeTab(target.extInstance) : null;
          return tab?.url
            ? [`active tab: ${tab.title ?? "(untitled)"} — ${tab.url}`,
               tab.selection ? `selected text:\n${tab.selection}` : null].filter(Boolean).join("\n")
            : undefined;
        }, msg.images ?? []).catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      }
      // Which browser this client is in; follows the person across chats.
      case "browser":
        clientBrowser = msg.instance || undefined; chat.useBrowser(clientBrowser); return;
      case "answer":
        chat.session.answer(msg.id, msg.answers); return;
      case "decision":
        chat.session.decide(msg.id, msg.decision, msg.mode); return;
      case "cwd": {
        const target = chat;
        files.safePath(ctx.filesRoot, msg.path)
          .then(async (abs) => {
            if (!(await stat(abs)).isDirectory()) throw new Error("not a directory");
            await target.setCwd(abs);
          })
          .catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      }
      case "project":
        chat.setProject(resolveProject(convo.projects(), msg.id))
          .catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      // Per chat: only the conversation this client is on. Its other attached
      // clients hear about it through the session's own "mode" event; a client
      // on a different chat is untouched.
      case "mode":
        chat.setMode(msg.mode)
          .catch((e: unknown) => send({ kind: "error", message: String(e) }));
        return;
      case "model":
        chat.setModel(msg.model).catch((e: unknown) => send({ kind: "error", message: String(e) }));
        return;
      case "rewind":
        chat.rewind(msg.uuid, msg.dryRun).catch((e: unknown) => send({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
        return;
      case "interrupt":
        chat.session.interrupt().catch(() => {}); return;
      case "new":
        enter(convo.create(chat), true); return;
      // Switches THIS client only. Another browser keeps whatever it was on.
      case "open": {
        if (msg.id === chat.id) return;
        const next = convo.get(msg.id);
        if (next) enter(next, true);
        return;
      }
      case "rename":
        convo.rename(msg.id, msg.title); return;
      case "delete": {
        const removingCurrent = msg.id === chat.id;
        convo.remove(msg.id);
        if (removingCurrent) {
          const nextId = convo.newestId();
          enter((nextId && convo.get(nextId)) || convo.create(), true);
        } else listFor();
        return;
      }
    }
  }

  const refresh = () => listFor();
  ctx.clients.add(refresh);
  const detach = () => { chat.detach(send); ctx.clients.delete(refresh); ctx.browserWatchers?.delete(sendBrowsers); };
  ws.on("close", detach);
  ws.on("error", detach);
}

/** Each /pty socket is a process; a page that opens sockets in a loop must not be able to fork-bomb the host. */
export const MAX_SHELLS = 8;
let openShells = 0;

/** The shell: a real PTY, no approval gate. */
export function attachShell(ws: WebSocket, ctx: AttachContext): void {
  const { state } = ctx;
  if (openShells >= MAX_SHELLS) {
    ws.send(JSON.stringify({ type: "exit", code: -1, reason: `too many shells open (${MAX_SHELLS})` }));
    ws.close(1013, "too many shells");
    return;
  }
  openShells++;
  const shell = new Shell(
    (chunk) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, "utf8"), { binary: true }); },
    (code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", code }));
      ws.close();
    },
  );
  state.activeShell = shell;

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { shell.write(raw.toString("utf8")); return; }
    let msg: ShellMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      // The shell opens where the newest attached chat works, so both panes agree.
      case "start":  shell.start(state.lastChat?.cwd ?? ctx.workspace, msg.cols ?? 80, msg.rows ?? 24); return;
      case "input":  if (typeof msg.data === "string") shell.write(msg.data); return;
      case "resize": shell.resize(msg.cols ?? 80, msg.rows ?? 24); return;
    }
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; openShells--;
    if (state.activeShell === shell) state.activeShell = null;   // unless a newer pane took over
    shell.kill();
  };
  ws.on("close", close);
  ws.on("error", close);
}
