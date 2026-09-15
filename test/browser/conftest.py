import os, socket, subprocess, tempfile, time, shutil, sys, select
import pytest
from playwright.sync_api import sync_playwright

# Every wait in this suite goes through these. Under -n 4 the box runs four
# fixture servers, four page browsers and a real-extension Chromium at once,
# and the old 5 s selector waits were losing races that are not the thing
# being tested (two different tests failed on two consecutive runs, each
# passing alone). A timeout only costs time when something is actually broken,
# so they are generous; PW_TIMEOUT scales them on a slower machine.
SCALE = float(os.environ.get("CT_TIMEOUT_SCALE", "1"))
SHORT = int(15000 * SCALE)      # a selector that should already be there
LONG = int(30000 * SCALE)       # something that needs a turn, a launch or a restart

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Server:
    """The fixture server (real server, scripted SDK). Restartable, same state dir."""
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="ct-browser-")
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc = None
        self.log = open(os.path.join(self.root, "server.log"), "ab")

    def start(self, timeout=20):
        env = dict(os.environ, ROOT=self.root, PORT=str(self.port))
        # node directly, in its own process group: terminating an `npx` wrapper
        # leaves the real server alive and the port taken.
        self.proc = subprocess.Popen([shutil.which("node"), "--import", "tsx", "test/fixtures/fake-server.ts"], cwd=REPO, env=env,
                                     stdout=subprocess.PIPE, stderr=self.log, start_new_session=True)
        t0 = time.time(); buf = b""
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None: break
            r, _, _ = select.select([self.proc.stdout], [], [], 0.2)
            if r:
                buf += os.read(self.proc.stdout.fileno(), 4096)
                if b"READY" in buf: return
        self.log.flush()
        raise RuntimeError("fixture server did not start; log tail:\n" + open(self.log.name, "rb").read()[-2000:].decode(errors="replace"))

    def stop(self):
        if not self.proc: return
        import signal
        os.killpg(self.proc.pid, signal.SIGTERM)
        try: self.proc.wait(5)
        except subprocess.TimeoutExpired: os.killpg(self.proc.pid, signal.SIGKILL); self.proc.wait()
        try: self.proc.stdout.close()
        except Exception: pass
        self.proc = None
        # wait for the port to be free
        t0 = time.time()
        while time.time() - t0 < 5:
            s = socket.socket()
            try:
                s.connect(("127.0.0.1", self.port)); s.close(); time.sleep(0.1)
            except OSError:
                s.close(); return

    def restart(self):
        self.stop(); self.start()


@pytest.fixture(scope="session")
def server():
    s = Server(); s.start()
    yield s
    s.stop(); shutil.rmtree(s.root, ignore_errors=True)


@pytest.fixture(scope="session")
def playwright():
    """One sync Playwright per session: a second sync_playwright() in the same
    thread fails with 'Sync API inside the asyncio loop'."""
    with sync_playwright() as pw:
        yield pw


@pytest.fixture(scope="session")
def browser(playwright):
    b = playwright.chromium.launch()
    yield b
    b.close()


@pytest.fixture
def page(browser, server):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.errors = errors
    yield pg
    ctx.close()


def wait(pg, js, timeout=15, what="condition"):
    """Poll a JS predicate (the CSP forbids string eval in wait_for_function)."""
    timeout *= SCALE
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pg.evaluate(js): return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def wait_stable(pg, selector="#log > *", quiet=0.4, timeout=20 * SCALE):
    """Wait until a list stops growing. The server replays a transcript one
    message at a time over a new socket, so "reload, sleep, assert" counted a
    half-drawn log on a slow machine (CI, 2026-09-15). Polling for stillness
    is the same idea as the sleep, without guessing how long it needs."""
    t0 = time.time(); last = -1; since = time.time()
    while time.time() - t0 < timeout:
        n = pg.evaluate(f"() => document.querySelectorAll({selector!r}).length")
        if n != last: last, since = n, time.time()
        elif time.time() - since >= quiet: return n
        time.sleep(0.05)
    return last


def open_ui(pg, server, path="/"):
    """Connect, then start on a fresh chat so tests do not share a conversation
    (a card left pending by one test would make the next one's prompt 'busy')."""
    pg.goto(server.base + path)
    wait(pg, "() => document.querySelector('#dot').classList.contains('on')", what="connection")
    time.sleep(0.3)
    pg.click("#newchat")
    wait(pg, "() => document.querySelectorAll('.msg.user').length === 0 && document.querySelector('#dot').classList.contains('on')", what="fresh chat")
    time.sleep(0.2)


def send(pg, text):
    pg.fill("#box", text); pg.press("#box", "Enter")


def last_reply(pg):
    return pg.evaluate("() => { const m = [...document.querySelectorAll('#log .msg.md')]; return m.length ? m[m.length-1].textContent.trim() : null; }")


def wait_reply(pg, contains, timeout=20):
    wait(pg, f"() => [...document.querySelectorAll('#log .msg.md')].some(m => m.textContent.includes({contains!r}))", timeout, f"reply containing {contains!r}")


EXT = os.path.join(REPO, "extension")


@pytest.fixture(scope="session")
def ext_ctx(playwright):
    """One Chromium with the real extension for the whole session (a launch
    is ~1.5 s; seven tests used to launch seven). Tests open their own pages
    and close them; the worker's per-tab state goes with the tab."""
    prof = tempfile.mkdtemp(prefix="ct-ext-shared-")
    ctx = playwright.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
    ctx.sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    yield ctx
    ctx.close(); shutil.rmtree(prof, ignore_errors=True)


@pytest.fixture
def ext_pages(ext_ctx):
    """Pages opened during one test; closed after it so the next test's
    'first http tab' is its own."""
    before = set(id(p) for p in ext_ctx.pages)
    yield ext_ctx
    for p in list(ext_ctx.pages):
        if id(p) not in before:
            try: p.close()
            except Exception: pass


def serve_html(html):
    """A tiny http server for a page (the extension does not script data: URLs)."""
    import threading, http.server, socketserver
    body = html if callable(html) else (lambda path: html)
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            r = body(self.path)
            headers = {}
            if isinstance(r, tuple): code, ctype, data, *rest = r; headers = rest[0] if rest else {}
            else: code, ctype, data = 200, "text/html", r
            self.send_response(code); self.send_header("Content-Type", ctype)
            for k, v in headers.items(): self.send_header(k, v)
            self.end_headers(); self.wfile.write(data)
        do_POST = do_GET
        def do_PUT(self): self.send_response(500); self.end_headers()
        def log_message(self, *a): pass
    # Threading, with a read timeout: a plain TCPServer handles one connection
    # at a time, and Chrome's idle preconnect sockets (opened, never written)
    # parked serve_forever in readline() so shutdown() never returned — the
    # suite hung at the end of a test (measured: faulthandler at srv.shutdown()).
    H.timeout = 5
    class S(socketserver.ThreadingTCPServer): daemon_threads = True; allow_reuse_address = True
    srv = S(("127.0.0.1", 0), H); srv.port = srv.server_address[1]; srv.base = f"http://127.0.0.1:{srv.port}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def pytest_configure(config):
    """The tests that launch a real Chromium (the extension suite, the server
    browser) share one xdist group, so `-n 4 --dist loadgroup` runs them on a
    single worker instead of starting four browsers at once."""
    config.addinivalue_line("markers", "xdist_group(name): run these on one xdist worker")
