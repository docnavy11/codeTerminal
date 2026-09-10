import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

/**
 * The prompt pipeline, exercised through a real server and a real Claude
 * session. The unit tests in prompt.test.ts cover the rule; this covers the
 * wiring around it, which is where the slash-command regression actually hid.
 *
 * Opt-in: it needs working Claude Code credentials and takes ~30s.
 *   CODETERM_E2E=1 npm test
 *
 * `/context` is a local command, so it costs no inference.
 */
const RUN = process.env.CODETERM_E2E === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

let proc: ChildProcess | null = null;
let port = 0;
let origin = "";
let fakeExt: WebSocket | null = null;

/**
 * A stand-in for the Chrome extension. Without one, activeTab() resolves to
 * null and no context is ever attached — so the slash-command test would pass
 * even with the bug reintroduced. This makes the regression reproducible.
 */
function connectFakeExtension(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, {
      headers: { Origin: "chrome-extension://e2etestextensionidaaaaaaaaaaaaaa" },
    });
    ws.on("open", () => { fakeExt = ws; resolve(); });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (!m.id) return;
      ws.send(JSON.stringify({
        id: m.id,
        ok: true,
        result: m.action === "active_tab"
          ? { id: 1, title: "E2E Fixture Page", url: "https://e2e.example/fixture", selection: "" }
          : {},
      }));
    });
  });
}

before(async () => {
  if (!RUN) return;
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  proc = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "src", "server.ts")],
    {
      cwd: ROOT,
      // Loopback so the whois check takes the same-box exemption, and a
      // throwaway chats dir so a test run cannot touch real conversations.
      env: {
        ...process.env,
        CODETERM_HOST: "127.0.0.1",
        CODETERM_PORT: String(port),
        CODETERM_CHATS: join(ROOT, ".e2e-chats"),
      },
      stdio: "ignore",
    },
  );
  // Wait for it to accept connections rather than sleeping a guessed amount.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${origin}/`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  await connectFakeExtension();
});

after(async () => {
  fakeExt?.close();
  proc?.kill("SIGTERM");
  const { rm } = await import("node:fs/promises");
  await rm(join(ROOT, ".e2e-chats"), { recursive: true, force: true });
});

/** Send one prompt into a fresh chat and return everything the turn produced. */
function turn(text: string, withTab?: boolean): Promise<{ out: string; context: string | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin } });
    let replaying = false, phase = 0, out = "";
    let context: string | null = null;
    const timer = setTimeout(() => { ws.close(); reject(new Error("timed out")); }, 120_000);

    ws.on("open", () => setTimeout(() => { phase = 1; ws.send(JSON.stringify({ type: "new" })); }, 800));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.kind === "cleared") { replaying = true; return; }
      if (m.kind === "replayed") {
        replaying = false;
        if (phase === 1) {
          phase = 2;
          setTimeout(() => ws.send(JSON.stringify({ type: "prompt", text, withTab })), 500);
        }
        return;
      }
      if (replaying || phase < 2) return;
      if (m.kind === "user") context = m.context ?? null;
      if (m.kind === "text" || m.kind === "local") out += m.text + "\n";
      if (m.kind === "turn_end") { clearTimeout(timer); ws.close(); resolve({ out, context }); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

describe("end to end: the prompt pipeline", { skip: !RUN && "set CODETERM_E2E=1 to run" }, () => {
  test("the fixture extension really does supply context", async () => {
    // If this fails the slash-command test below proves nothing, because no
    // context would be attached to anything.
    const { context } = await turn("Reply with exactly: ctx-check", true);
    assert.ok(context?.includes("e2e.example/fixture"),
      `no context attached — got ${JSON.stringify(context)}`);
  });

  test("a slash command expands even while a tab is attached", async () => {
    const { out, context } = await turn("/context", true);
    assert.equal(context, null, "context must not be attached to a command");
    // The real /context prints a usage table; a model talking *about* the
    // command instead is exactly the regression this guards.
    assert.match(out, /Context Usage|Tokens:/i,
      `/context did not expand — got: ${out.slice(0, 200)}`);
  });

  test("an ordinary prompt still reaches the model", async () => {
    const { out } = await turn("Reply with exactly: pipeline-ok", false);
    assert.match(out, /pipeline-ok/);
  });
});
