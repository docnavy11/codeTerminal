import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Auth } from "./auth.js";

/**
 * The setup & status report behind /setup: every question a person has while
 * getting this running, answered from what the server already knows. The
 * page renders it; the README's quick start ends with "open /setup.html".
 */
export type Check = { ok: boolean; level: "ok" | "warn" | "bad"; text: string; hint?: string };

export type SetupInput = {
  version: string;
  node: string;
  host: string;
  port: number;
  auth: Pick<Auth, "mode" | "self" | "allowedOrigins" | "trustedCidrs">;
  extOrigin?: string;
  extensionInstances: string[];
  readySeen: boolean;
  chats: number;
  home: string;
  workspace: string;
  filesRoot: string;
  projectsRoot: string;
  bypassAllowed: boolean;
  /** Standing browser sites; null when the gate is disabled. */
  browserSites?: number | null;
  /** In-process MCP servers as the last session start reported them; null before any session. */
  mcpServers?: { name: string; status: string }[] | null;
  /** Scheduled prompts: how many, and the next run time (ms) if any. */
  schedules?: { count: number; next: number | null };
  /** Phone notification targets configured (telegram, webhook, ntfy). */
  notifyTargets?: string[];
  /** Where the config and the state are kept, for the setup page's Paths list. */
  statePaths?: Record<string, string>;
  /** The .env this install reads (it may not exist). */
  envPath?: string;
  /** Set by systemd for every process it starts. */
  systemd: boolean;
  /** Test hook: how to look at the filesystem. */
  fs?: { exists: (p: string) => boolean; isDir: (p: string) => boolean };
};

const realFs = {
  exists: (p: string) => existsSync(p),
  isDir: (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } },
};

export function buildSetup(i: SetupInput) {
  const fs = i.fs ?? realFs;
  const base = `${i.host}:${i.port}`;
  const credPath = join(i.home, ".claude", ".credentials.json");
  const hasCreds = fs.exists(credPath);
  const local = i.auth.mode === "localhost";
  const ext = i.extensionInstances;
  const [major] = i.node.replace(/^v/, "").split(".").map(Number);

  // Every origin the server accepts is also a valid extension address.
  const extUrls = [`ws://${base}/ext`, ...[...i.auth.allowedOrigins]
    .filter((o) => o.startsWith("http://") && !o.includes("localhost"))
    .map((o) => o.replace(/^http/, "ws") + "/ext")].filter((u, k, a) => a.indexOf(u) === k);

  const paths = Object.fromEntries((["workspace", "filesRoot", "projectsRoot"] as const)
    .map((k) => [k, { path: i[k], exists: fs.isDir(i[k]) }]));

  const checks: Record<string, Check> = {
    node: major >= 22
      ? { ok: true, level: "ok", text: `Node ${i.node}` }
      : { ok: false, level: "bad", text: `Node ${i.node} — 22 or newer is required` },
    network: local
      ? { ok: true, level: "ok", text: `localhost mode — http://${base}/, this machine only`,
          hint: "To reach it from a phone or another device, bind a tailnet or VPN address in .env (CODETERM_HOST) and restart." }
      : i.auth.mode === "tailnet"
        ? { ok: true, level: "ok", text: `tailnet mode — ${i.auth.self?.dnsName ?? base}, only your own tailnet identity is admitted` }
        : { ok: true, level: "ok", text: `VPN mode — ${base}, trusting ${i.auth.trustedCidrs.length} private range(s)` },
    login: !hasCreds
      ? { ok: false, level: "bad", text: `No Claude Code login found (${credPath})`,
          hint: "On this machine run `claude` and log in (npm i -g @anthropic-ai/claude-code if you do not have it), then restart the server." }
      : i.readySeen
        ? { ok: true, level: "ok", text: "Claude Code login present; a session has started this run" }
        : { ok: true, level: "warn", text: "Claude Code login present; no session has started yet this run",
            hint: "Send any message in a chat — the first turn proves the login works." },
    tools: !i.mcpServers
      ? { ok: true, level: "warn", text: "Tool servers: not checked yet — no session has started this run",
          hint: "Send any message in a chat; the session start reports whether every tool server came up." }
      : i.mcpServers.some((s) => s.status !== "connected")
        ? { ok: false, level: "bad", text: `Tool server${i.mcpServers.filter((s) => s.status !== "connected").length > 1 ? "s" : ""} not connected: ${i.mcpServers.filter((s) => s.status !== "connected").map((s) => `${s.name} (${s.status})`).join(", ")} — those tools are missing from every session`,
            hint: "Check the server log. The usual cause is a tool schema the CLI cannot convert; `npm run check` lists every server through a real MCP client and fails on it." }
        : { ok: true, level: "ok", text: `Tool servers connected: ${i.mcpServers.map((s) => s.name).join(", ")}` },
    schedules: !i.schedules || i.schedules.count === 0
      ? { ok: true, level: "ok", text: "No scheduled prompts", hint: "The manage page's Schedules tab runs a prepared prompt by itself at set times, in the server browser." }
      : { ok: true, level: "ok", text: `${i.schedules.count} scheduled prompt${i.schedules.count === 1 ? "" : "s"}${i.schedules.next ? ` — next at ${new Date(i.schedules.next).toISOString().slice(0, 16).replace("T", " ")} UTC` : " — all paused"}` },
    notifications: i.notifyTargets?.length
      ? { ok: true, level: "ok", text: `Phone notifications: ${i.notifyTargets.join(", ")}`, hint: "The Schedules tab has a “send test” button." }
      : { ok: true, level: "warn", text: "No phone notifications configured", hint: "Scheduled runs then report only in the browser: the extension's notification, a strip in open chats, the Schedules tab. For a phone, set CODETERM_TELEGRAM_TOKEN + CODETERM_TELEGRAM_CHAT, or CODETERM_NOTIFY_WEBHOOK (ntfy or a Home Assistant webhook), in .env and restart." },
    extension: ext.length
      ? { ok: true, level: "ok", text: `Browser extension connected (${ext.length} browser${ext.length > 1 ? "s" : ""})` }
      : { ok: true, level: "warn", text: "No browser extension connected",
          hint: `Optional. chrome://extensions → Developer mode → Load unpacked → the extension/ folder. Click its icon and enter ${extUrls[0]}${local ? " (the browser must be on this machine in localhost mode)" : ""}.` },
    mobile: local
      ? { ok: true, level: "warn", text: "Phone: not reachable in localhost mode", hint: "Bind a tailnet or VPN address to use /m from a phone." }
      : { ok: true, level: "ok", text: `Phone: http://${i.auth.self?.dnsName ?? i.host}:${i.port}/m — open it and add to the home screen` },
    service: i.systemd
      ? { ok: true, level: "ok", text: "Running as a systemd service" }
      : { ok: true, level: "warn", text: "Running in the foreground", hint: "Linux: `sudo deploy/install.sh` installs a unit that survives reboots." },
    paths: Object.values(paths).every((p) => p.exists)
      ? { ok: true, level: "ok", text: "Workspace, files root and projects root all exist" }
      : { ok: false, level: "warn", text: "A configured directory is missing", hint: "See the paths below; set CODETERM_WORKSPACE / CODETERM_FILES_ROOT / CODETERM_PROJECTS_ROOT in .env." },
    browser: i.browserSites === null
      ? { ok: true, level: "warn", text: "Browser tools act on any site without asking (CODETERM_BROWSER_GATE=0)" }
      : { ok: true, level: "ok", text: `Browser tools ask before a new site; ${i.browserSites ?? 0} site${i.browserSites === 1 ? "" : "s"} allowed without asking`, hint: "Read and act are separate answers; manage the list on the manage page; eval asks every time." },
    permissions: i.bypassAllowed
      ? { ok: true, level: "warn", text: "\"Never ask\" (bypassPermissions) is enabled — the agent can run and edit with nobody approving" }
      : { ok: true, level: "ok", text: "Every change asks for approval; \"Never ask\" is disabled", hint: "CODETERM_ALLOW_BYPASS=1 enables it." },
  };

  return {
    version: i.version, node: i.node,
    mode: i.auth.mode, host: i.host, port: i.port,
    origins: [...i.auth.allowedOrigins],
    urls: { ui: `http://${base}/`, mobile: `http://${base}/m`, manage: `http://${base}/manage.html`, extension: extUrls },
    extension: { connected: ext, pinned: i.extOrigin ?? null },
    login: { credentials: hasCreds, path: credPath, readySeen: i.readySeen },
    service: { systemd: i.systemd },
    paths,
    chats: i.chats,
    permissions: { bypassAllowed: i.bypassAllowed },
    checks,
    ready: Object.values(checks).every((c) => c.ok),
  };
}
