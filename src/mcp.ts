/**
 * codeTerminal as an MCP server, at /mcp, for other agents (Claude Code on a
 * laptop, Claude Desktop, another box on the tailnet) to use this one.
 *
 * Mounted behind the same guard as every other route, so the same people can
 * reach it: the tailnet owner, loopback, or a trusted CIDR — never a browser
 * page on another origin. Stateless Streamable HTTP: a server and transport
 * per request, nothing to expire or leak between calls.
 *
 * What it deliberately leaves out: answering approval cards. The caller is
 * itself an agent, and an agent that could approve its own Bash would have
 * turned the gate into a formality. A turn that stops on a card is reported
 * as waiting, with the link a person opens to answer it. The browser tools
 * are left out for the same reason — their site gate asks in a chat, and
 * there is no chat on this side to ask in.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Manager, LiveChat } from "./conversation.js";
import type { ClientEvent } from "./protocol.js";

export type McpDeps = {
  convo: Manager;
  /** Where a person opens a chat: links in results point here. */
  publicBase: string;
  /** Scheduled prompts, already shaped for display (read-only here). */
  schedules?: () => unknown[];
  /** Named terminal sessions, when the machine has tmux and the shell is on. */
  tmux?: { list: () => Promise<{ name: string; path: string; windows: number }[]>; capture: (name: string, lines: number) => Promise<string> };
  version?: string;
};

/** A turn waited on longer than this comes back as "still running", not as an error. */
export const MAX_WAIT_S = 600;
const EVENT_TEXT_CAP = 2000;

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

/** The readable part of a chat's history: what was said, which tools ran, what was noted. */
export function transcript(events: ClientEvent[], last: number): string[] {
  const out: string[] = [];
  for (const e of events) {
    const cap = (s: string) => (s.length > EVENT_TEXT_CAP ? `${s.slice(0, EVENT_TEXT_CAP)}…` : s);
    if (e.kind === "user") out.push(`user: ${cap(e.text)}`);
    else if (e.kind === "text") out.push(`assistant: ${cap(e.text)}`);
    else if (e.kind === "local") out.push(`note: ${cap(e.text)}`);
    else if (e.kind === "tool") out.push(`tool: ${e.name}`);
    else if (e.kind === "error") out.push(`error: ${cap(e.message)}`);
  }
  return out.slice(-Math.max(1, last));
}

export function buildMcpServer(d: McpDeps): McpServer {
  const server = new McpServer({ name: "codeterminal", version: d.version ?? "0.0.0" });
  const link = (id: string) => `${d.publicBase}/?chat=${encodeURIComponent(id)}`;
  const chatOrNull = (id: string): LiveChat | null => d.convo.get(id);

  server.registerTool("list_chats", {
    description: "List the conversations on this codeTerminal server, newest first: id, title, project, turns, when last active.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("How many (default 30)") },
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => text(d.convo.list().slice(0, limit ?? 30).map((c) => ({
    id: c.id, title: c.title, project: c.project, turns: c.turns,
    updatedAt: new Date(c.updatedAt).toISOString(), ...(c.scheduleId ? { scheduled: true } : {}),
  }))));

  server.registerTool("read_chat", {
    description: "Read the recent history of one conversation: user messages, assistant replies, tool names, notes. Also says whether it is busy or waiting for a person.",
    inputSchema: { chatId: z.string(), last: z.number().int().min(1).max(500).optional().describe("How many entries from the end (default 30)") },
    annotations: { readOnlyHint: true },
  }, async ({ chatId, last }) => {
    // read(), not get(): reading must not start a Claude session for a cold chat.
    const rec = d.convo.read(chatId);
    if (!rec) return fail(`No chat ${chatId}.`);
    const status = liveStatus(d.convo, chatId);
    return text({ id: rec.id, title: rec.title, link: link(rec.id), ...(status ? { status } : {}), entries: transcript(rec.events, last ?? 30) });
  });

  server.registerTool("send_prompt", {
    description:
      "Send a prompt to a conversation on this server — an existing one by id, or a new one if chatId is omitted — and optionally wait for the reply. " +
      "The chat's own approval gate still applies: if the turn stops for a person to approve something, this returns status 'waiting' with a link for them; it cannot approve anything itself.",
    inputSchema: {
      text: z.string().min(1).max(100_000),
      chatId: z.string().optional().describe("Omit to start a new chat"),
      wait: z.boolean().optional().describe("Wait for the turn to end and return the reply (default true)"),
      timeoutSec: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`How long to wait (default 120, max ${MAX_WAIT_S})`),
    },
  }, async ({ text: prompt, chatId, wait, timeoutSec }) => {
    const chat = chatId ? chatOrNull(chatId) : d.convo.create();
    if (!chat) return fail(`No chat ${chatId}.`);
    if (chat.busy) return fail(`Chat ${chat.id} is busy with another turn; try again when it is done, or stop it first.`);
    const waiter = wait === false ? null : waitForTurn(chat, (timeoutSec ?? 120) * 1000);
    try {
      await chat.prompt(prompt, async () => undefined);
    } catch (e) {
      waiter?.cancel();
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (!waiter) return text({ chatId: chat.id, status: "sent", link: link(chat.id) });
    const r = await waiter.done;
    return text({ chatId: chat.id, link: link(chat.id), ...r });
  });

  server.registerTool("stop_chat", {
    description: "Interrupt the turn a conversation is running.",
    inputSchema: { chatId: z.string() },
  }, async ({ chatId }) => {
    const chat = chatOrNull(chatId);
    if (!chat) return fail(`No chat ${chatId}.`);
    if (!chat.busy) return text({ chatId, status: "idle", note: "Nothing was running." });
    await chat.session.interrupt().catch(() => {});
    return text({ chatId, status: "stopped" });
  });

  if (d.schedules) {
    const schedules = d.schedules;
    server.registerTool("list_schedules", {
      description: "List the scheduled prompts on this server: title, when, project, next and last run.",
      annotations: { readOnlyHint: true },
    }, async () => text(schedules()));
  }

  if (d.tmux) {
    const tmux = d.tmux;
    server.registerTool("list_terminals", {
      description: "List the named terminal (tmux) sessions on this machine.",
      annotations: { readOnlyHint: true },
    }, async () => text(await tmux.list()));
    server.registerTool("read_terminal", {
      description: "Read the recent output of a named terminal (tmux) session.",
      inputSchema: { name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), lines: z.number().int().min(1).max(2000).optional().describe("Default 200") },
      annotations: { readOnlyHint: true },
    }, async ({ name, lines }) => {
      try { return text(await tmux.capture(name, lines ?? 200)); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    });
  }
  return server;
}

/** Busy / waiting for a person / idle — only for a chat already in memory; a cold one is idle. */
function liveStatus(convo: Manager, id: string): string | null {
  const live = convo.live(id);
  if (!live) return null;
  const s = live.session.status();
  return s.state === "awaiting" ? `waiting for a person (${s.detail})` : live.busy ? "busy" : "idle";
}

type TurnResult = { status: "done" | "waiting" | "timeout"; reply?: string; waitingFor?: string; costUsd?: number };

/**
 * Collect the reply of the next turn. Resolves at turn_end; or as soon as the
 * turn stops on a card or a question, since nobody on this side may answer it;
 * or at the timeout, leaving the turn running.
 */
function waitForTurn(chat: LiveChat, timeoutMs: number): { done: Promise<TurnResult>; cancel: () => void } {
  let texts: string[] = [];
  let resolve!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((r) => { resolve = r; });
  const finish = (r: TurnResult) => { clearTimeout(timer); chat.detach(watch); resolve(r); };
  const watch = (e: ClientEvent) => {
    if (e.kind === "user") texts = [];
    else if (e.kind === "text") texts.push(e.text);
    else if (e.kind === "approval") finish({ status: "waiting", waitingFor: `approval: ${e.tool}`, reply: texts.join("\n\n") || undefined });
    else if (e.kind === "question") finish({ status: "waiting", waitingFor: "a question for the user", reply: texts.join("\n\n") || undefined });
    else if (e.kind === "turn_end") finish({ status: "done", reply: texts.join("\n\n"), ...(e.costUsd ? { costUsd: e.costUsd } : {}) });
  };
  const timer = setTimeout(() => finish({ status: "timeout", reply: texts.join("\n\n") || undefined }), timeoutMs);
  chat.attach(watch, false);
  return { done, cancel: () => { clearTimeout(timer); chat.detach(watch); } };
}

/** The Express handler: one stateless server + transport per request. */
export function mcpHandler(d: McpDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = buildMcpServer(d);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null });
    }
  };
}
