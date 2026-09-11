"""Renders the README screenshots against the fixture server. Not a test:
    python3 test/browser/screenshots.py
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from conftest import Server, open_ui, send, wait, wait_reply
from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO, "docs")
os.makedirs(OUT, exist_ok=True)

srv = Server(); srv.start()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        # desktop: a conversation with an approval card pending
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        pg = ctx.new_page(); open_ui(pg, srv)
        send(pg, "summarise what this repo does"); wait_reply(pg, "You said: summarise")
        wait(pg, "() => document.querySelectorAll('#log .end').length === 1", what="turn end")
        send(pg, "approve-me"); pg.wait_for_selector(".card[data-tool=Bash]", timeout=10000); time.sleep(0.6)
        pg.screenshot(path=os.path.join(OUT, "desktop.png"))
        ctx.close()
        # mobile
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); open_ui(pg, srv, "/m")
        send(pg, "what changed in the last deploy?"); wait_reply(pg, "You said: what changed"); time.sleep(0.4)
        pg.screenshot(path=os.path.join(OUT, "mobile.png"))
        ctx.close()
        b.close()
        # side panel: the extension's own page, loaded as an unpacked extension
        ext = os.path.join(REPO, "extension")
        ctx = pw.chromium.launch_persistent_context("/tmp/claude-1000/pw-ext-shots", headless=True, channel="chromium",
                                                    args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"],
                                                    viewport={"width": 400, "height": 760}, device_scale_factor=2)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        sw.evaluate("(url) => chrome.storage.local.set({ serverUrl: url })", f"ws://127.0.0.1:{srv.port}/ext")
        ext_id = sw.url.split("/")[2]
        pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/sidepanel.html")
        wait(pg, "() => document.querySelector('#dot').classList.contains('on')", 15, "panel connected")
        pg.click("#newchat"); time.sleep(0.3)
        send(pg, "read the open tab and tell me the total"); wait_reply(pg, "You said: read the open tab"); time.sleep(0.4)
        pg.screenshot(path=os.path.join(OUT, "panel.png"))
        ctx.close()
finally:
    srv.stop()
print("wrote", sorted(os.listdir(OUT)))
