import os, socket, subprocess, tempfile, time, shutil, sys, select
import pytest
from playwright.sync_api import sync_playwright

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
def browser():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
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


def wait(pg, js, timeout=10, what="condition"):
    """Poll a JS predicate (the CSP forbids string eval in wait_for_function)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pg.evaluate(js): return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


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


def wait_reply(pg, contains, timeout=10):
    wait(pg, f"() => [...document.querySelectorAll('#log .msg.md')].some(m => m.textContent.includes({contains!r}))", timeout, f"reply containing {contains!r}")
