import type { WebSocket } from "ws";

/**
 * Heartbeat for one socket: a protocol-level ping every `intervalMs`, and
 * terminate a socket that did not answer the previous one. Optionally `beat`
 * — an application-level frame sent on the same schedule.
 *
 * The protocol ping keeps the *server* honest. Browsers cannot see ping
 * frames, so it does nothing for the *client*: after a network drop the
 * browser's socket stays "open" until the kernel gives up (measured: the
 * extension sat on a dead socket for 1h42m until it was reloaded). The beat
 * is a message the client can watch for — no beat for ~2.5 intervals means
 * the connection is gone and it must dial again.
 *
 * A half-open TCP connection — a slept laptop, dropped wifi — otherwise leaves
 * the server holding a socket the client will never speak on again. On /ws that
 * pins a `claude` subprocess against the MAX_LIVE ceiling; on /pty it pins a
 * shell. The kernel reaps such connections only after a long delay. Browsers
 * answer ping frames automatically, so no client change is needed.
 *
 * Returns a stop function; it is also wired to the socket's own close/error.
 */
export function heartbeat(ws: WebSocket, intervalMs = 30_000, beat?: string): () => void {
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }   // 'close' fires and stops the timer
    alive = false;
    try { ws.ping(); if (beat && ws.readyState === ws.OPEN) ws.send(beat); } catch { /* already closing */ }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  ws.on("close", stop);
  ws.on("error", stop);
  return stop;
}
