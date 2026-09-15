import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { ServerBrowser, findChromium, SERVER_BROWSER_ID } from "../src/server-browser.js";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { FakeWs } from "./fakes/ws.js";

const CHROMIUM = findChromium();
const ROOT = join(import.meta.dirname, "..");
/* A CI runner is slower than a laptop and Chromium there has no GPU: the
   waits are generous so a timeout means something is broken, not busy
   (measured: "back to one tab" timed out at 5 s on GitHub's runner). */
const PATIENT = Number(process.env.CT_CHROMIUM_WAIT ?? 20_000);
const SLOW = PATIENT * 2;

describe("server browser: presenting as an ordinary Chrome", () => {
  test("the UA is built from the binary's version without 'Headless'", { skip: !CHROMIUM }, async () => {
    const { userAgentFor } = await import("../src/server-browser.js");
    const ua = userAgentFor(CHROMIUM!);
    assert.match(ua, /^Mozilla\/5\.0 \(X11; Linux x86_64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    assert.doesNotMatch(ua, /Headless/);
  });
});

describe("server browser", { skip: !CHROMIUM && "no Chromium on this machine (Playwright's cache or CODETERM_CHROMIUM)" }, () => {
  let s: TestServer; let profile: string; let sb: ServerBrowser;
  before(async () => {
    s = await startTestServer();
    profile = await mkdtemp(join(tmpdir(), "ct-sb-profile-"));
    sb = new ServerBrowser({ profileDir: profile, extensionDir: join(ROOT, "extension"), serverWsUrl: `ws://127.0.0.1:${s.port}/ext`, timezone: "Europe/Brussels" });
  });
  after(async () => { await sb?.stop(); await s?.stop(); await rm(profile, { recursive: true, force: true }); });

  const setup = async () => (await (await fetch(`${s.base}/setup`, { headers: { Origin: s.base } })).json()) as { extension: { connected: string[] } };
  const until = async (pred: () => Promise<boolean> | boolean, ms: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); };

  test("starts Chromium with the extension, which dials this server as the server browser", async () => {
    assert.equal((await sb.status()).running, false);
    await sb.start();
    const st = await sb.status();
    assert.equal(st.running, true); assert.ok(st.pid); assert.ok(st.extensionId, "extension id known"); assert.equal(st.tabs?.length, 1);
    await until(async () => (await setup()).extension.connected.includes(SERVER_BROWSER_ID), SLOW, "the server browser's extension connects to /ext");
    await sb.start();   // idempotent
    assert.equal((await sb.status()).pid, st.pid);
  });

  test("what a site sees: an ordinary Chrome UA, no webdriver flag, a screen matching the window, the configured time zone", async () => {
    await sb.navigate(`${s.base}/setup.html`);
    await until(async () => /setup/i.test(String(await sb.evaluate("document.title"))), SLOW, "a page to evaluate in");
    const seen = await sb.evaluate("({ ua: navigator.userAgent, webdriver: navigator.webdriver, screen: [screen.width, screen.height], tz: Intl.DateTimeFormat().resolvedOptions().timeZone })") as { ua: string; webdriver: boolean; screen: number[]; tz: string };
    assert.doesNotMatch(seen.ua, /Headless/); assert.equal(seen.webdriver, false); assert.deepEqual(seen.screen, [1280, 800]); assert.equal(seen.tz, "Europe/Brussels");
  });

  test("navigate and evaluate work on the tab", async () => {
    await sb.navigate(`${s.base}/setup.html`);
    await until(async () => /setup/i.test(String(await sb.evaluate("document.title"))), SLOW, "the setup page loads");
  });

  test("a viewer gets frames, the tab list and its url; mouse and keys drive the page", async () => {
    await sb.navigate(`${s.base}/m.html`);
    await until(async () => (await sb.evaluate("!!document.getElementById('box')")) === true, SLOW, "the mobile page loads");
    const v = new FakeWs();
    sb.attachViewer(v as unknown as WebSocket);
    await until(() => v.kind("frame").length > 0 && v.kind("tabs").length > 0 && v.kind("viewing").length > 0, SLOW, "first frame, tabs and viewing");
    const frame = v.last("frame") as { data: string; meta: { deviceWidth: number; deviceHeight: number } };
    assert.ok(frame.data.length > 1000, "a real jpeg"); assert.equal(Buffer.from(frame.data, "base64").subarray(0, 2).toString("hex"), "ffd8", "jpeg magic");
    assert.equal(frame.meta.deviceWidth, 1280);
    const tabs = v.last("tabs") as { tabs: { url: string }[]; current: string }; assert.ok(tabs.tabs.some((t) => t.url.endsWith("/m.html"))); assert.ok(tabs.current);
    // click the prompt box, type into it
    const r = await sb.evaluate("(() => { const b = document.getElementById('box').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()") as { x: number; y: number };
    v.frame({ type: "mouse", kind: "mousePressed", x: r.x, y: r.y, button: "left", buttons: 1, clickCount: 1 });
    v.frame({ type: "mouse", kind: "mouseReleased", x: r.x, y: r.y, button: "left", buttons: 0, clickCount: 1 });
    await until(async () => (await sb.evaluate("document.activeElement && document.activeElement.id")) === "box", PATIENT, "the click focused the box");
    for (const ch of "hi") { v.frame({ type: "key", kind: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, text: ch, vk: ch.toUpperCase().charCodeAt(0) }); v.frame({ type: "key", kind: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) }); }
    v.frame({ type: "text", text: " there" });
    await until(async () => (await sb.evaluate("document.getElementById('box').value")) === "hi there", PATIENT, "keys and text arrived");
    // navigate from the viewer; url event follows
    v.frame({ type: "navigate", url: `${s.base}/setup.html` });
    await until(() => (v.kind("url") as { url: string }[]).some((u) => u.url.endsWith("/setup.html")), SLOW, "url event after navigate");
    // new tab, list, close it
    v.frame({ type: "newtab", url: "about:blank" });
    await until(() => (v.last("tabs") as { tabs: unknown[] })?.tabs.length === 2, PATIENT, "two tabs");
    const cur = (v.last("viewing") as { id: string }).id;
    v.frame({ type: "closetab", id: cur });
    await until(() => (v.last("tabs") as { tabs: unknown[] })?.tabs.length === 1, PATIENT, "back to one tab");
    v.close();
    await until(async () => (await sb.status()).viewers === 0, PATIENT, "viewer detached");
  });

  test("stop ends the process and the extension drops off; a viewer on a stopped browser is told", async () => {
    await sb.stop();
    assert.equal((await sb.status()).running, false);
    await until(async () => !(await setup()).extension.connected.includes(SERVER_BROWSER_ID), SLOW, "extension gone");
    const v = new FakeWs(); sb.attachViewer(v as unknown as WebSocket);
    assert.equal((v.last("gone") as { reason: string }).reason, "the server browser is not running");
  });
});
