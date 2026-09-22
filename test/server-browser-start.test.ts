import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ServerBrowser, devToolsUrl } from "../src/server-browser.js";

/* Starting the server browser, without a real Chromium: a stand-in binary
   that announces a DevTools port on stderr like Chromium does, records its
   pid, and stays alive until killed. */
let dir: string;
const pids = new Set<number>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); return cond(); };

before(async () => { dir = await mkdtemp(join(tmpdir(), "ct-sbstart-")); });
after(async () => {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await rm(dir, { recursive: true, force: true });
});

/** A port nothing listens on: bound, then released. */
async function closedPort(): Promise<number> {
  const srv = createServer(); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port; await new Promise((r) => srv.close(r)); return port;
}

describe("server browser start", () => {
  test("a failure after Chromium announced its port kills that Chromium; the next start has one, not two", async () => {
    const port = await closedPort();
    const pidFile = join(dir, "pids");
    const fake = join(dir, "fake-chromium");
    await writeFile(fake, `#!${process.execPath}
require("fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
process.stderr.write("some noise\\nDevTools listening on ws://127.0.0.1:${port}/devtools/browser/fake\\n");
setInterval(() => {}, 1000);
`);
    await chmod(fake, 0o755);
    const sb = new ServerBrowser({ chromium: fake, plain: false, profileDir: join(dir, "profile"), extensionDir: join(dir, "ext"), serverWsUrl: "ws://127.0.0.1:1/ext" });
    const readPids = async () => (await readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);

    await assert.rejects(sb.start(), "the socket to a closed port fails");
    const [first] = await readPids(); pids.add(first);
    assert.ok(await until(() => !alive(first)), "the Chromium that failed to connect was killed");
    const st = await sb.status();
    assert.equal(st.running, false); assert.ok(st.lastError, "the failure is on the status page");

    await assert.rejects(sb.start());
    const all = await readPids(); all.forEach((p) => pids.add(p));
    assert.equal(all.length, 2, "the second start spawned again");
    assert.ok(await until(() => all.every((p) => !alive(p))), "and nothing is left running");
  });
});

describe("devToolsUrl", () => {
  const fakeProc = () => { const p = new EventEmitter() as EventEmitter & { stderr: PassThrough }; p.stderr = new PassThrough(); return p; };
  test("finds the line across chunks, then stops listening and leaves stderr draining", async () => {
    const p = fakeProc();
    const url = devToolsUrl(p as unknown as ChildProcess, 5000);
    p.stderr.write("x".repeat(100_000));
    p.stderr.write("\nDevTools listening on ws://127.0.0.1:9/devtools/bro");   // the URL cut mid-way: not yet
    await new Promise((r) => setImmediate(r));
    p.stderr.write("wser/abc\n");
    assert.equal(await url, "ws://127.0.0.1:9/devtools/browser/abc", "the whole URL, not the part in the first chunk");
    assert.equal(p.stderr.listenerCount("data"), 0, "nothing keeps buffering stderr once the port is known");
    assert.equal(p.listenerCount("exit"), 0);
    assert.equal(p.stderr.readableFlowing, true, "stderr keeps draining, so Chromium never blocks on a full pipe");
  });
  test("an exit before the line rejects with a bounded tail of stderr", async () => {
    const p = fakeProc();
    const url = devToolsUrl(p as unknown as ChildProcess, 5000);
    p.stderr.write("y".repeat(50_000) + "boom");
    await new Promise((r) => setImmediate(r));
    p.emit("exit", 1);
    await assert.rejects(url, (e: Error) => /exited with code 1 .*y{396}boom$/.test(e.message));
  });
});
