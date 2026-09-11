"""The shared client in a real browser against the fixture server: the paths
that only exist in the DOM — reconnects, streaming, cards, downloads, layout."""
import os, time
from conftest import open_ui, send, wait, wait_reply, last_reply


def test_prompt_round_trip(page, server):
    open_ui(page, server)
    send(page, "hello there")
    wait(page, "() => document.querySelectorAll('.msg.user').length === 1", what="user turn")
    wait_reply(page, "You said: hello there")
    wait(page, "() => !!document.querySelector('#log .end')", what="turn end")
    assert page.input_value("#box") == ""
    assert page.errors == []


def test_reconnect_does_not_duplicate_the_transcript(page, server):
    open_ui(page, server)
    send(page, "first"); wait_reply(page, "You said: first")
    count = lambda: page.evaluate("() => ({u: document.querySelectorAll('.msg.user').length, n: document.querySelectorAll('#log > *').length})")
    before = count()
    for _ in range(2):
        server.restart()
        wait(page, "() => document.querySelector('#dot').classList.contains('on')", 20, "reconnect")
        time.sleep(1)
        assert count() == before
    assert page.errors == []


def test_pty_pane_reconnects_after_a_restart(page, server):
    open_ui(page, server)
    wait(page, "() => ptyWs && ptyWs.readyState === 1", what="pty open")
    server.restart()
    wait(page, "() => ptyWs && ptyWs.readyState === 1", 20, "pty reopen")
    wait(page, "() => (document.querySelector('#term .xterm-rows')?.textContent || '').includes('reconnected')", 10, "reconnected banner")


def test_prompt_typed_while_offline_is_queued_then_sent(page, server):
    open_ui(page, server)
    server.stop()
    wait(page, "() => !document.querySelector('#dot').classList.contains('on')", what="disconnect noticed")
    send(page, "queued one")
    assert page.input_value("#box") == ""
    assert "queued" in page.text_content("#meta")
    server.start()
    wait_reply(page, "You said: queued one", 20)


def test_streaming_renders_once_per_frame(page, server):
    open_ui(page, server)
    r = page.evaluate("""() => {
      const word = 'lorem ipsum **dolor** sit `amet` \\n'; const N = 700;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) handle({ kind: 'delta', text: word });
      const sync = performance.now() - t0;
      return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector('#log .msg.md:last-child');
        res({ mainThreadMs: sync, rendered: !!el && el.textContent.includes('amet') && el.textContent.length > 15000 });
      })));
    }""")
    assert r["rendered"]
    assert r["mainThreadMs"] < 300, r   # 6092 ms before the per-frame render
    page.evaluate("() => handle({ kind: 'text', text: 'done' })")


def test_approval_card_round_trip(page, server):
    open_ui(page, server)
    send(page, "approve-me")
    page.wait_for_selector(".card[data-tool=Bash]", timeout=10000)
    assert "rm -rf build" in page.text_content(".card[data-tool=Bash] pre")
    page.click(".card[data-tool=Bash] button[data-decision=deny]")
    wait(page, "() => [...document.querySelectorAll('.card[data-tool=Bash] button')].every(b => b.disabled)", what="card disabled")
    wait_reply(page, "decision: deny")


def test_question_card_round_trip(page, server):
    open_ui(page, server)
    send(page, "ask-me")
    page.wait_for_selector(".q[data-tool=question]", timeout=10000)
    page.click(".q .opt:has-text('Blue')")
    page.click(".q button.allow:has-text('Answer')")
    wait_reply(page, '"Which colour?":"Blue"')


def test_new_chat_and_switching_back(page, server):
    open_ui(page, server)
    send(page, "remember me"); wait_reply(page, "You said: remember me")
    page.click("#newchat")
    wait(page, "() => document.querySelectorAll('.msg.user').length === 0", what="cleared")
    page.click("#chatsbtn")
    page.wait_for_selector("#clist .c", timeout=5000)
    assert page.locator("#clist .c").count() >= 2
    page.click("#clist .c:has(.ct:text-is('remember me'))")
    wait(page, "() => [...document.querySelectorAll('.msg.user')].some(m => m.textContent.includes('remember me'))", what="old transcript")


def test_mode_is_remembered_per_chat_across_reload(page, server):
    open_ui(page, server)
    page.select_option("#mode", "acceptEdits")
    time.sleep(0.5)
    page.reload()
    wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect")
    wait(page, "() => document.querySelector('#mode').value === 'acceptEdits'", what="mode restated")
    page.select_option("#mode", "default"); time.sleep(0.3)


def test_downloads_stream_without_a_blob(page, server):
    open_ui(page, server)
    page.click(".tabs .tab[data-view=files]")
    page.wait_for_selector("#flist .row", timeout=5000)
    with page.expect_download(timeout=10000) as dl:
        page.click("#flist .row:has(.n:text-is('blob.txt')) .dl")
    d = dl.value; path = os.path.join(server.root, "dl.txt"); d.save_as(path)
    assert d.suggested_filename == "blob.txt" and os.path.getsize(path) == 300_000
    page.click("#flist .row:has(.n:text-is('hello.txt')) .ck"); page.click("#flist .row:has(.n:text-is('note.txt')) .ck")
    with page.expect_download(timeout=10000) as dl2:
        page.click("#fsel button:text-is('zip')")
    z = os.path.join(server.root, "sel.zip"); dl2.value.save_as(z)
    assert dl2.value.suggested_filename == "selection.zip" and open(z, "rb").read(2) == b"PK"
    assert page.evaluate("() => performance.getEntriesByType('resource').filter(e => e.name.startsWith('blob:')).length") == 0


def test_client_survives_garbage_events(page, server):
    open_ui(page, server)
    page.evaluate("() => { handle({ kind: 'nonsense' }); handle({}); ws.onmessage({ data: '{bad json' }); handle({ kind: 'delta', text: 1 }); }")
    send(page, "still alive"); wait_reply(page, "You said: still alive")
    assert page.errors == []


def test_mobile_page_fits_the_viewport(browser, server):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    open_ui(pg, server, "/m")
    m = pg.evaluate("() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, header: document.querySelector('header').getBoundingClientRect().height })")
    assert m["sw"] <= m["cw"], m
    assert m["header"] < 120, m
    send(pg, "on a phone"); wait_reply(pg, "You said: on a phone")
    ctx.close()


def test_new_folder_inline(page, server):
    open_ui(page, server)
    page.click(".tabs .tab[data-view=files]")
    page.wait_for_selector("#flist .row", timeout=5000)
    page.click("#fmkdir")
    page.fill("#flist .row.newdir input", "made here")
    page.press("#flist .row.newdir input", "Enter")
    wait(page, "() => document.querySelector('#fpath').textContent.includes('made here')", what="navigated into the new folder")
    assert os.path.isdir(os.path.join(server.root, "files", "made here"))
    page.click("#fup")
    page.wait_for_selector("#flist .row.dir:has(.n:text-is('made here/'))", timeout=5000)
    # a duplicate is refused and the row stays editable
    page.click("#fmkdir"); page.fill("#flist .row.newdir input", "made here"); page.press("#flist .row.newdir input", "Enter")
    wait(page, "() => { const i = document.querySelector('#flist .row.newdir input'); return !!i && !i.disabled && i.validationMessage.includes('already exists'); }", what="refusal shown")
    page.press("#flist .row.newdir input", "Escape")
    assert page.locator("#flist .row.newdir").count() == 0
    assert page.errors == []


def test_welcome_card_on_a_fresh_chat_only(page, server):
    open_ui(page, server)
    assert page.locator("#log .welcome").count() == 1
    assert "approval" in page.text_content("#log .welcome")
    send(page, "first words"); wait_reply(page, "You said: first words")
    assert page.locator("#log .welcome").count() == 0
    page.reload()
    wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect")
    time.sleep(0.5)
    assert page.locator("#log .welcome").count() == 0, "a chat with history gets no card"
    page.click("#newchat")
    wait(page, "() => !!document.querySelector('#log .welcome')", what="card on the new chat")
    page.click("#log .welcome .dismiss")
    assert page.locator("#log .welcome").count() == 0


def test_file_pane_errors_show_inline(page, server):
    open_ui(page, server)
    page.click(".tabs .tab[data-view=files]")
    page.wait_for_selector("#flist .row", timeout=5000)
    page.click("#flist .row:has(.n:text-is('huge.bin')) .ck")
    page.click("#fsel button:text-is('zip')")
    wait(page, "() => (document.querySelector('#flist .ferr')?.textContent || '').includes('too large')", what="zip refusal inline")
    big = os.path.join(server.root, "toolarge.bin"); open(big, "wb").write(b"\0" * (2 * 1024 * 1024))
    page.set_input_files("#fpick", big)
    wait(page, "() => (document.querySelector('#flist .ferr')?.textContent || '').includes('upload failed')", what="upload refusal inline")
    assert page.errors == []


def test_setup_page_renders_live_checks(page, server):
    page.goto(server.base + "/setup.html")
    page.wait_for_selector(".check", timeout=10000)
    checks = page.evaluate("() => [...document.querySelectorAll('.check')].map(c => c.className.replace('check ', '') + ':' + c.querySelector('.t').textContent)")
    assert any(c.startswith("bad:No Claude Code login") for c in checks), checks   # the fixture home has no login
    assert any("localhost mode" in c for c in checks), checks
    assert f"ws://127.0.0.1:{server.port}/ext" in page.text_content("#checks")
    assert "Something needs fixing" in page.text_content("#summary")
    assert page.errors == []
    # reachable from the welcome card and the menu
    open_ui(page, server)
    assert page.locator("#log .welcome button:has-text('setup')").count() == 1


def test_tool_rows_keep_their_height_when_the_log_overflows(browser, server):
    """A column flexbox gives overflow:hidden children min-height:0, so once the
    transcript was taller than the pane every one-line tool row shrank to 0px
    (measured: 80 of 80 rows at 0px). Nothing in the log may shrink."""
    ctx = browser.new_context(viewport={"width": 546, "height": 600}); pg = ctx.new_page()
    open_ui(pg, server, "/m")
    pg.evaluate("""() => { for (let i = 0; i < 40; i++) {
        handle({kind:'tool', id:'t'+i, name:'mcp__browser__screenshot', input:{tabId: i}});
        handle({kind:'tool', id:'r'+i, name:'Read', input:{file_path:'/tmp/shot-' + i + '.png'}}); } }""")
    m = pg.evaluate("""() => { const t = [...document.querySelectorAll('#log .tool')]; const lh = parseFloat(getComputedStyle(t[0]).lineHeight);
        return { rows: t.length, crushed: t.filter(x => x.getBoundingClientRect().height < lh - 0.5).length,
                 overflowing: document.getElementById('log').scrollHeight > document.getElementById('log').clientHeight }; }""")
    assert m["overflowing"], "the test must actually overflow the pane"
    assert m["rows"] == 80 and m["crushed"] == 0, m
    ctx.close()


def test_extension_connects_once_its_address_is_set(server):
    """The real extension in Chromium: it starts with no address (badge 'set'),
    and connecting must begin the moment the address is stored — not on the
    next worker restart."""
    import json, urllib.request, tempfile
    from playwright.sync_api import sync_playwright
    ext = os.path.join(os.path.dirname(__file__), "..", "..", "extension")
    prof = tempfile.mkdtemp(prefix="ct-ext-prof-")
    connected = lambda: json.load(urllib.request.urlopen(server.base + "/setup"))["extension"]["connected"]
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                    args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        time.sleep(1.0)
        assert connected() == [], "nothing should connect before an address is set"
        assert sw.evaluate("() => chrome.action.getBadgeText({})") == "set"
        sw.evaluate("(url) => chrome.storage.local.set({ serverUrl: url })", f"ws://127.0.0.1:{server.port}/ext")
        t0 = time.time()
        while time.time() - t0 < 10 and not connected(): time.sleep(0.2)
        assert len(connected()) == 1, "the extension must connect as soon as the address is set"
        assert sw.evaluate("() => chrome.action.getBadgeText({})") == "on"
        ctx.close()
