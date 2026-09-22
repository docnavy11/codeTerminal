import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { BrowserBridge } from "../src/browser.js";
import { FakeWs } from "./fakes/ws.js";

/** The extension side of the bridge, with fake sockets: registration, routing, timeouts, disconnects. */
function bridge(timeoutMs = 50) {
  const log: string[] = [];
  const events: { msg: Record<string, unknown>; instance: string }[] = [];
  const b = new BrowserBridge((l) => log.push(l), timeoutMs);
  b.onEvent((msg, instance) => events.push({ msg, instance }));
  const connect = (instance?: string) => {
    const ws = new FakeWs();
    b.attach(ws as unknown as WebSocket);
    if (instance) ws.frame({ type: "hello", instance });
    return ws;
  };
  return { b, log, events, connect };
}

describe("BrowserBridge: connections", () => {
  test("a hello registers the browser; before it, the connection is not pickable", async () => {
    const { b, connect, log } = bridge();
    const ws = connect();
    assert.equal(b.connected, true);
    await assert.rejects(b.send("list_tabs", {}), /No Chrome extension is connected|timed out/);
    ws.frame({ type: "hello", instance: "browser-A" });
    assert.deepEqual(b.instances, ["browser-A"]);
    assert.match(log.at(-1)!, /extension connected \(/);
  });

  test("a reload of the same browser replaces its own connection with 4001; another browser is untouched", () => {
    const { b, connect } = bridge();
    const a1 = connect("browser-A"); const other = connect("browser-B");
    const a2 = connect("browser-A");
    assert.equal(a1.closeCode, 4001);
    assert.equal(other.readyState, 1);
    assert.equal(a2.readyState, 1);
    assert.deepEqual(new Set(b.instances), new Set(["browser-A", "browser-B"]));
  });

  test("a replaced connection's commands in flight fail at once, not after the timeout", async () => {
    // A real socket's close event arrives later, after the new connection is
    // registered; the fake's is synchronous, so defer it the same way.
    class SlowClose extends FakeWs {
      override close(code = 1000, reason = ""): void { this.closeCode = code; setImmediate(() => super.close(code, reason)); }
    }
    const b = new BrowserBridge(() => {}, 5000);
    const a1 = new SlowClose(); b.attach(a1 as unknown as WebSocket); a1.frame({ type: "hello", instance: "browser-A" });
    const pending = b.send("read_page", {}, "browser-A");
    const t0 = Date.now();
    const a2 = new FakeWs(); b.attach(a2 as unknown as WebSocket); a2.frame({ type: "hello", instance: "browser-A" });
    await assert.rejects(pending, /reconnected while this command was running/);
    assert.ok(Date.now() - t0 < 1000, "rejected on the reconnect, not by the 5 s timeout");
    assert.equal(a1.closeCode, 4001);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(b.instances, ["browser-A"], "the old socket's late close leaves the new one registered");
  });

  test("the replaced socket's close does not unregister the newer one", () => {
    const { b, connect } = bridge();
    connect("browser-A"); connect("browser-A");
    assert.deepEqual(b.instances, ["browser-A"]);
  });

  test("disconnect: unregistered, pending commands rejected", async () => {
    const { b, connect, log } = bridge(1000);
    const ws = connect("browser-A");
    const p = b.send("list_tabs", {});
    ws.close();
    await assert.rejects(p, /disconnected mid-command/);
    assert.equal(b.connected, false);
    assert.match(log.at(-1)!, /disconnected/);
  });
});

describe("BrowserBridge: commands", () => {
  test("resolves with the extension's result, rejects with its error", async () => {
    const { b, connect } = bridge();
    const ws = connect("browser-A");
    const p = b.send("read_page", { tabId: 3 });
    const sent = ws.sent.at(-1) as { id: string; action: string; params: unknown };
    assert.equal(sent.action, "read_page"); assert.deepEqual(sent.params, { tabId: 3 });
    ws.frame({ id: sent.id, ok: true, result: { text: "hi" } });
    assert.deepEqual(await p, { text: "hi" });
    const p2 = b.send("click", {});
    ws.frame({ id: (ws.sent.at(-1) as { id: string }).id, ok: false, error: "no such ref" });
    await assert.rejects(p2, /no such ref/);
    const p3 = b.send("click", {});
    ws.frame({ id: (ws.sent.at(-1) as { id: string }).id, ok: false });
    await assert.rejects(p3, /unknown error/);
  });

  test("times out, and a late reply after the timeout is ignored", async () => {
    const { b, connect } = bridge(30);
    const ws = connect("browser-A");
    const p = b.send("snapshot", {});
    await assert.rejects(p, /timed out after 30ms/);
    ws.frame({ id: (ws.sent.at(-1) as { id: string }).id, ok: true, result: 1 });   // no throw, no effect
  });

  test("prefers the named browser; a missing one is refused rather than substituted", async () => {
    const { b, connect } = bridge();
    const a = connect("browser-A"); const c = connect("browser-B");
    void b.send("x", {}, "browser-A").catch(() => {});
    assert.equal(a.sent.length, 1); assert.equal(c.sent.length, 0);
    await assert.rejects(b.send("x", {}, "browser-Z"), /not connected/);
    assert.equal(c.sent.length, 0, "not sent to the other browser");
  });

  test("no preference: the newest connection is used", async () => {
    const { b, connect } = bridge();
    const a = connect("browser-A");
    await new Promise((r) => setTimeout(r, 3));
    const c = connect("browser-B");
    void b.send("x", {}).catch(() => {});
    assert.equal(c.sent.length, 1); assert.equal(a.sent.length, 0);
  });

  test("unsolicited events reach onEvent with the instance; pong, garbage and unknown ids are ignored", () => {
    const { connect, events } = bridge();
    const ws = connect("browser-A");
    ws.frame({ type: "watch_fired", watchId: "w1", detail: "changed" });
    ws.frame({ type: "pong" });
    ws.frame("{{{");
    ws.frame({ id: "never-sent", ok: true });
    ws.frame({ nothing: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].instance, "browser-A");
    assert.equal(events[0].msg.watchId, "w1");
    assert.equal(ws.readyState, 1);
  });
});

describe("BrowserBridge.activeTab", () => {
  test("null without a browser, null on error, null when slow, the tab when it answers", async () => {
    const { b, connect } = bridge(1000);
    assert.equal(await b.activeTab(), null);
    const ws = connect("browser-A");
    const slow = b.activeTab(undefined, 20);
    assert.equal(await slow, null);
    const err = b.activeTab();
    ws.frame({ id: (ws.sent.at(-1) as { id: string }).id, ok: false, error: "restricted" });
    assert.equal(await err, null);
    const ok = b.activeTab();
    ws.frame({ id: (ws.sent.at(-1) as { id: string }).id, ok: true, result: { title: "T", url: "https://t.example" } });
    assert.deepEqual(await ok, { title: "T", url: "https://t.example" });
    assert.equal(await b.activeTab("browser-Z"), null, "a missing preferred browser is null, not a throw");
  });
});
