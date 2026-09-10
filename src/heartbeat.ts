import type { WebSocket } from "ws";

/**
 * Protocol-level heartbeat for one socket: ping every `intervalMs`, and
 * terminate a socket that did not answer the previous ping.
 *
 * A half-open TCP connection — a slept laptop, dropped wifi — otherwise leaves
 * the server holding a socket the client will never speak on again. On /ws that
 * pins a `claude` subprocess against the MAX_LIVE ceiling; on /pty it pins a
 * shell. The kernel reaps such connections only after a long delay. Browsers
 * answer ping frames automatically, so no client change is needed.
 *
 * Returns a stop function; it is also wired to the socket's own close/error.
 */
export function heartbeat(ws: WebSocket, intervalMs = 30_000): () => void {
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }   // 'close' fires and stops the timer
    alive = false;
    try { ws.ping(); } catch { /* already closing */ }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  ws.on("close", stop);
  ws.on("error", stop);
  return stop;
}
