import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
import { boot, type Running, type ServerConfig } from "../../src/server.js";
import { fakeSdk, type FakeOpts } from "./sdk.js";

/** A whole server in-process on a free port: temp dirs, fake SDK, no tailscale. */
export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;

export async function startTestServer(opts: { sdk?: FakeOpts; cfg?: Partial<ServerConfig> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ct-srv-"));
  for (const d of ["ws", "files/sub", "files/secret", "projects/p1", "projects/p2", "home"]) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(root, "files", "hello.txt"), "hello world\n");
  await writeFile(join(root, "files", "sub", "nested.txt"), "nested");
  await writeFile(join(root, "files", "secret", "key"), "TOP SECRET");
  await writeFile(join(root, "files", "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const port = await freePort();
  const logs: string[] = []; const warns: string[] = [];
  const sdk = fakeSdk(opts.sdk);
  const cfg: ServerConfig = {
    host: "127.0.0.1", port, workspace: join(root, "ws"), chatsDir: join(root, "chats"),
    filesRoot: join(root, "files"), projectsRoot: join(root, "projects"),
    promptsPath: join(root, "prompts.json"), usagePath: join(root, "usage.json"),
    maxUpload: 64 * 1024, maxZip: 128 * 1024, extraOrigins: [], forceLocal: true,
    denyExtra: [join(root, "files", "secret")], home: join(root, "home"),
    spawnQuery: sdk.spawnQuery, titler: async () => null,
    log: (l) => logs.push(l), warn: (l) => warns.push(l),
    ...opts.cfg,
  };
  const running: Running = await boot(cfg);
  const base = `http://127.0.0.1:${running.port}`;
  const origin = base;

  const req = (path: string, init: RequestInit = {}) => fetch(base + path, init);
  const json = async (path: string, init: RequestInit = {}) => { const r = await req(path, init); return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null, headers: r.headers }; };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    json(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  /** A ws client that collects parsed frames. */
  const socket = (route: string, headers: Record<string, string> = {}) => new Promise<{ ws: WebSocket; got: Record<string, unknown>[]; raw: Buffer[]; kind: (k: string) => Record<string, unknown>[]; wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>; send: (m: unknown) => void; closed: Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${running.port}${route}`, { headers: { origin, ...headers } });
    const got: Record<string, unknown>[] = []; const raw: Buffer[] = [];
    ws.on("message", (d, isBinary) => { if (isBinary) raw.push(d as Buffer); else { try { got.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    const wait = (pred: (m: Record<string, unknown>) => boolean, ms = 3000) => new Promise<Record<string, unknown>>((res, rej) => {
      const t0 = Date.now();
      const tick = () => { const m = got.find(pred); if (m) return res(m); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for a frame")); setTimeout(tick, 10); };
      tick();
    });
    ws.once("open", () => resolve({ ws, got, raw, kind: (k) => got.filter((m) => m.kind === k), wait, send: (m) => ws.send(JSON.stringify(m)), closed }));
    ws.once("error", reject);
  });

  const stop = async () => { await running.shutdown("test"); await rm(root, { recursive: true, force: true }); };
  return { root, running, port: running.port, base, origin, sdk, logs, warns, req, json, post, socket, stop };
}
