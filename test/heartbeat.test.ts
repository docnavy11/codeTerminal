import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { heartbeat } from "../src/heartbeat.js";
import type { WebSocket } from "ws";

/** A stand-in for a ws socket: records ping/terminate, replays pong on demand. */
class FakeWs extends EventEmitter {
  pings = 0;
  terminated = false;
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.emit("close"); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("heartbeat", () => {
  // A socket that keeps answering pongs is never terminated.
  test("a responsive socket is left alone", async () => {
    const ws = new FakeWs();
    const stop = heartbeat(ws as unknown as WebSocket, 20);
    for (let i = 0; i < 4; i++) { await tick(22); ws.emit("pong"); }
    assert.equal(ws.terminated, false, "must not terminate a live socket");
    assert.ok(ws.pings >= 3, `should have pinged, got ${ws.pings}`);
    stop();
  });

  // A half-open socket (no pong) is reaped on the next cycle.
  test("a silent socket is terminated", async () => {
    const ws = new FakeWs();
    heartbeat(ws as unknown as WebSocket, 20);
    await tick(22);              // first cycle: marks not-alive, pings
    assert.equal(ws.terminated, false, "one missed ping is not yet fatal");
    await tick(22);              // second cycle: still no pong -> terminate
    assert.equal(ws.terminated, true, "a socket that never pongs is terminated");
  });

  // Closing the socket stops the timer (no ping after close).
  test("close stops the heartbeat", async () => {
    const ws = new FakeWs();
    heartbeat(ws as unknown as WebSocket, 20);
    ws.emit("close");
    const before = ws.pings;
    await tick(50);
    assert.equal(ws.pings, before, "no pings after close");
  });
});
