import { test, describe, mock } from "node:test";
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
// Fake timers: the heartbeat is pure setInterval, and real 20ms waits were
// the kind of test that fails on a loaded CI box.
const tick = async (ms: number) => { mock.timers.tick(ms); await Promise.resolve(); };

describe("heartbeat", () => {
  const useFake = () => mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  // A socket that keeps answering pongs is never terminated.
  test("a responsive socket is left alone", async () => {
    useFake();
    const ws = new FakeWs();
    const stop = heartbeat(ws as unknown as WebSocket, 20);
    for (let i = 0; i < 4; i++) { await tick(22); ws.emit("pong"); }
    assert.equal(ws.terminated, false, "must not terminate a live socket");
    assert.ok(ws.pings >= 3, `should have pinged, got ${ws.pings}`);
    stop();
    mock.timers.reset();
  });

  // A half-open socket (no pong) is reaped on the next cycle.
  test("a silent socket is terminated", async () => {
    useFake();
    const ws = new FakeWs();
    heartbeat(ws as unknown as WebSocket, 20);
    await tick(22);              // first cycle: marks not-alive, pings
    assert.equal(ws.terminated, false, "one missed ping is not yet fatal");
    await tick(22);              // second cycle: still no pong -> terminate
    assert.equal(ws.terminated, true, "a socket that never pongs is terminated");
    mock.timers.reset();
  });

  // The optional beat is an app-level frame on the same schedule, only while open.
  test("sends the beat alongside each ping while the socket is open", async () => {
    useFake();
    const ws = new FakeWs(); (ws as unknown as { readyState: number; OPEN: number; sent: string[]; send(d: string): void }).readyState = 1;
    const w = ws as unknown as { readyState: number; OPEN: number; sent: string[]; send(d: string): void };
    w.OPEN = 1; w.sent = []; w.send = (d: string) => { w.sent.push(d); };
    heartbeat(ws as unknown as WebSocket, 20, '{"kind":"ping"}');
    await tick(22); ws.emit("pong"); await tick(22); ws.emit("pong");
    assert.deepEqual(w.sent, ['{"kind":"ping"}', '{"kind":"ping"}']);
    w.readyState = 3; await tick(22);
    assert.equal(w.sent.length, 2, "nothing sent once closed");
    mock.timers.reset();
  });

  // Closing the socket stops the timer (no ping after close).
  test("close stops the heartbeat", async () => {
    useFake();
    const ws = new FakeWs();
    heartbeat(ws as unknown as WebSocket, 20);
    ws.emit("close");
    const before = ws.pings;
    await tick(50);
    assert.equal(ws.pings, before, "no pings after close");
    mock.timers.reset();
  });
});
