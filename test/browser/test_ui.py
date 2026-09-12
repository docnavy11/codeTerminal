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
    assert os.path.isdir(os.path.join(server.root, "ws", "made here"))
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


def test_extension_connects_once_its_address_is_set(server, playwright):
    """The real extension in Chromium: it starts with no address (badge 'set'),
    and connecting must begin the moment the address is stored — not on the
    next worker restart."""
    import json, urllib.request, tempfile
    ext = os.path.join(os.path.dirname(__file__), "..", "..", "extension")
    prof = tempfile.mkdtemp(prefix="ct-ext-prof-")
    connected = lambda: json.load(urllib.request.urlopen(server.base + "/setup"))["extension"]["connected"]
    ctx = playwright.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        time.sleep(1.0)
        assert connected() == [], "nothing should connect before an address is set"
        assert sw.evaluate("() => chrome.action.getBadgeText({})") == "set"
        sw.evaluate("(url) => chrome.storage.local.set({ serverUrl: url })", f"ws://127.0.0.1:{server.port}/ext")
        t0 = time.time()
        while time.time() - t0 < 10 and not connected(): time.sleep(0.2)
        assert len(connected()) == 1, "the extension must connect as soon as the address is set"
        assert sw.evaluate("() => chrome.action.getBadgeText({})") == "on"
    finally:
        ctx.close()


def test_a_silent_socket_is_dropped_and_redialled(page, server):
    """After a network drop the browser keeps calling the socket open. The
    client watches the server's beat and, past STALE_MS of silence, drops the
    socket and dials again — without duplicating the transcript."""
    open_ui(page, server)
    send(page, "before the drop"); wait_reply(page, "You said: before the drop")
    count = page.evaluate("() => document.querySelectorAll('.msg.user').length")
    first = page.evaluate("() => { window.__first = ws; return !!ws; }")
    assert first
    # nothing has been silent for 75s; the check must be a no-op
    assert page.evaluate("() => checkLiveness()") is False
    # pretend 100s passed with no frame
    assert page.evaluate("() => checkLiveness(Date.now() + 100000)") is True
    wait(page, "() => ws && ws !== window.__first && ws.readyState === 1 && document.querySelector('#dot').classList.contains('on')", what="redialled")
    time.sleep(0.5)
    assert page.evaluate("() => document.querySelectorAll('.msg.user').length") == count
    assert page.evaluate("() => window.__first.readyState >= 2"), "the stale socket was closed"
    send(page, "after the drop"); wait_reply(page, "You said: after the drop")
    assert page.errors == []


def test_cost_line_sums_turns_not_running_totals(page, server):
    """The SDK reports a running total per result; the fixture mirrors that
    (0.001, 0.002, …). Two turns must show $0.0020, not $0.0030."""
    open_ui(page, server)
    send(page, "one"); wait_reply(page, "You said: one")
    wait(page, "() => document.querySelectorAll('#log .end').length === 1", what="first end")
    send(page, "two"); wait_reply(page, "You said: two")
    wait(page, "() => document.querySelectorAll('#log .end').length === 2", what="second end")
    ends = page.evaluate("() => [...document.querySelectorAll('#log .end')].map(e => e.textContent)")
    assert "$0.0010" in ends[0] and "$0.0020" in ends[1], ends


def test_stop_reason_and_context_meter(page, server):
    open_ui(page, server)
    send(page, "one"); wait_reply(page, "You said: one")
    wait(page, "() => (document.querySelector('#ctx')?.textContent || '') === 'ctx 20%'", what="context meter after one turn")
    send(page, "stop-me")
    wait(page, "() => [...document.querySelectorAll('#log .end')].some(e => e.classList.contains('stopped') && e.textContent.includes('stopped: reached the turn limit (40 turns)'))", what="stop reason on the end line")
    assert page.text_content("#ctx") == "ctx 40%"
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect")
    wait(page, "() => (document.querySelector('#ctx')?.textContent || '') === 'ctx 40%'", what="meter restored from the replay")


def test_search_jumps_to_the_message_in_another_chat(page, server):
    open_ui(page, server)
    for i in range(3): send(page, f"filler message {i}"); wait_reply(page, f"You said: filler message {i}")
    send(page, "the platypus is a monotreme"); wait_reply(page, "You said: the platypus")
    page.click("#newchat"); wait(page, "() => document.querySelectorAll('.msg.user').length === 0", what="new chat")
    page.click("#chatsbtn"); page.wait_for_selector("#clist .cfind input", timeout=5000)
    page.fill("#clist .cfind input", "platypus")
    page.wait_for_selector("#clist .c.hit", timeout=5000)
    assert "platypus" in page.text_content("#clist .c.hit .cs")
    page.click("#clist .c.hit")
    wait(page, "() => !!document.querySelector('#log .flash') && document.querySelector('#log .flash').textContent.includes('platypus')", what="jumped and flashed the hit")
    assert page.evaluate("() => document.querySelector('#log .flash').dataset.i") is not None


def test_export_downloads_markdown(page, server):
    open_ui(page, server)
    send(page, "export me please"); wait_reply(page, "You said: export me please")
    page.click("#more")
    with page.expect_download(timeout=10000) as dl:
        page.click("#export")
    d = dl.value; path = os.path.join(server.root, "export.md"); d.save_as(path)
    md = open(path).read()
    assert d.suggested_filename == "export-me-please.md"
    assert md.startswith("# export me please") and "You said: export me please" in md


def test_tool_results_in_the_transcript(page, server):
    open_ui(page, server)
    send(page, "tools-me"); wait_reply(page, "Two files changed")
    rows = page.evaluate("""() => [...document.querySelectorAll('#log .tool')].map(t => ({
        name: t.querySelector('b').textContent, res: t.querySelector('.tr').textContent, cls: t.querySelector('.tr').className,
        open: t.classList.contains('open'), body: !!t.querySelector('.tb pre') }))""")
    assert [r["name"] for r in rows] == ["Bash", "Read", "Bash"], rows
    assert rows[0]["res"] == "M src/a.ts" and rows[0]["cls"] == "tr ok" and not rows[0]["open"]
    assert rows[1]["res"] == "3 lines" and not rows[1]["open"]
    assert rows[2]["res"].startswith("✗ grep: missing.txt") and rows[2]["cls"] == "tr err" and rows[2]["open"], "errors open themselves"
    assert all(r["body"] for r in rows)
    page.click("#log .tool >> nth=0 >> .tl")
    assert page.evaluate("() => document.querySelectorAll('#log .tool')[0].classList.contains('open')")
    assert "notes.txt" in page.text_content("#log .tool >> nth=0 >> .tb pre")
    assert page.locator("#log .tool >> nth=0 >> .tb .copy").count() == 1
    page.click("#log .tool >> nth=0 >> .tl")   # the body swallows clicks (so text can be selected); the line toggles
    assert not page.evaluate("() => document.querySelectorAll('#log .tool')[0].classList.contains('open')")
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); time.sleep(0.5)
    again = page.evaluate("() => [...document.querySelectorAll('#log .tool .tr')].map(t => t.textContent)")
    assert again[:2] == ["M src/a.ts", "3 lines"], "results survive the replay"
    assert page.errors == []


def test_turn_rollup_in_the_status_bar(page, server):
    open_ui(page, server)
    page.evaluate("""() => { handle({kind:'user', text:'x'}); applyStatus({kind:'status', state:'thinking', detail:'', tokens:0});
        for (let i = 0; i < 4; i++) handle({kind:'tool', id:'s'+i, name:'mcp__browser__screenshot', input:{}});
        handle({kind:'tool', id:'r', name:'Read', input:{file_path:'/x'}});
        applyStatus({kind:'status', state:'thinking', detail:'', tokens:0}); }""")
    assert page.text_content("#statustext") == "thinking · 5 tools · 4 screenshots"
    page.evaluate("() => applyStatus({kind:'status', state:'tool', detail:'Read', tokens:0})")
    assert page.text_content("#statustext") == "running Read · 5 tools · 4 screenshots"


def test_edit_approval_shows_a_diff(page, server):
    open_ui(page, server)
    send(page, "edit-me")
    page.wait_for_selector(".card[data-tool=Edit] .diff", timeout=10000)
    d = page.evaluate("""() => { const c = document.querySelector('.card[data-tool=Edit] .diff'); return {
        path: c.querySelector('.dp').textContent, kind: c.querySelector('.dk').textContent, counts: c.querySelector('.dc').textContent,
        lines: [...c.querySelectorAll('.l')].map(l => l.className.replace('l ', '') + ':' + l.textContent.trim()) }; }""")
    assert d["path"] == "notes.txt" and d["kind"] == "edit" and d["counts"] == "+2 −1", d
    assert "del:- two" in d["lines"] and "add:+ TWO" in d["lines"] and "add:+ and a half" in d["lines"] and "ctx:one" in d["lines"], d
    assert page.locator(".card[data-tool=Edit] pre:not(.dl)").count() == 0, "no raw JSON when there is a diff"
    page.click(".card[data-tool=Edit] button[data-decision=allow]")
    wait_reply(page, "decision: allow")


def test_thinking_streams_collapsed_then_persists(page, server):
    open_ui(page, server)
    send(page, "think-me")
    page.wait_for_selector("#log .think", timeout=10000)
    wait(page, "() => (document.querySelector('#log .think .first')?.textContent || '').includes('narrowed')", what="first line while streaming")
    wait_reply(page, "Verified: it is the second one.")
    assert page.text_content("#log .think .first") == "I've narrowed it to two candidates."
    assert not page.evaluate("() => document.querySelector('#log .think').classList.contains('open')"), "collapsed by default"
    assert page.evaluate("() => document.querySelectorAll('#log .think').length") == 1, "the finished block replaces the streamed one"
    page.click("#log .think")
    assert "Now verifying each against the repo." in page.text_content("#log .think .tt")
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); time.sleep(0.5)
    assert page.evaluate("() => document.querySelectorAll('#log .think').length") == 1, "persisted and replayed"
    assert page.errors == []


def test_images_pasted_and_picked_go_with_the_prompt(page, server):
    open_ui(page, server)
    # paste: a synthetic clipboard event carrying a generated PNG
    page.evaluate("""async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 300, 200);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
        document.getElementById('box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }""")
    wait(page, "() => document.querySelectorAll('#attach-strip .att').length === 1", what="pasted image in the strip")
    # pick: the 📎 button's file input
    big = os.path.join(server.root, "big.jpg")
    page.evaluate("""async (path) => {}""", big)
    import base64, io, struct, zlib
    def png_bytes(w, h):
        raw = b"".join(b"\x00" + b"\x10\x80\x30" * w for _ in range(h))
        def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    p2 = os.path.join(server.root, "wide.png"); open(p2, "wb").write(png_bytes(2000, 400))
    page.set_input_files("#attachpick", p2)
    wait(page, "() => document.querySelectorAll('#attach-strip .att').length === 2", what="picked image in the strip")
    # the wide one was downscaled to the 1568px long side
    dims = page.evaluate("""() => new Promise(r => { const a = attachments[1]; const i = new Image(); i.onload = () => r([i.width, i.height, a.media_type]); i.src = 'data:' + a.media_type + ';base64,' + a.data; })""")
    assert dims[0] == 1568 and dims[1] == 314 and dims[2] == "image/png", dims
    page.click("#attach-strip .att >> nth=0 >> .x")
    assert page.evaluate("() => attachments.length") == 1
    send(page, "what is in this picture?")
    wait_reply(page, "You said: what is in this picture? (+1 image)")
    assert page.evaluate("() => document.querySelectorAll('#attach-strip .att').length") == 0, "strip cleared after send"
    assert page.locator("#log .msg.user .imgs img").count() == 1, "thumbnail under the message"
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); time.sleep(0.5)
    assert page.locator("#log .msg.user .imgs img").count() == 1, "thumbnail survives the replay"
    assert page.errors == []


def test_plan_card_renders_the_plan_and_switches_mode(page, server):
    open_ui(page, server)
    send(page, "plan-me")
    page.wait_for_selector(".card.plan", timeout=10000)
    assert page.locator(".card.plan .planbody h1").text_content() == "Rename the widget"
    assert page.locator(".card.plan .planbody li").count() == 3
    assert page.locator(".card.plan pre").count() == 0, "the plan is rendered, not dumped as JSON"
    labels = page.evaluate("() => [...document.querySelectorAll('.card.plan .row button')].map(b => b.textContent)")
    assert labels == ["Build it", "Build, auto-accept edits", "Keep planning"], labels
    page.click(".card.plan button[data-mode=acceptEdits]")
    wait_reply(page, "decision: allow · mode acceptEdits")
    wait(page, "() => document.querySelector('#mode').value === 'acceptEdits'", what="mode menu follows")
    page.select_option("#mode", "default"); time.sleep(0.3)


def test_subagent_progress_nests_under_the_agent_call(page, server):
    open_ui(page, server)
    send(page, "agent-me")
    wait(page, "() => !!document.querySelector('#log .tool .task.running')", what="task line while running")
    wait(page, "() => (document.querySelector('#log .task .ts')?.textContent || '').includes('tool uses')", what="progress on the line")
    wait_reply(page, "The subagent found three links.")
    t = page.evaluate("""() => { const row = [...document.querySelectorAll('#log .tool')].find(r => r.querySelector('b').textContent === 'Agent');
        return { status: row.querySelector('.task .ts').textContent, text: row.querySelector('.task .tx').textContent, cls: row.querySelector('.task').className,
                 steps: row.querySelector('.grp .gh .n').textContent, open: row.querySelector('.grp').classList.contains('open'),
                 nested: row.querySelectorAll('.grp .gb .tool').length, subText: row.querySelectorAll('.grp .gb .msg.sub').length,
                 topLevelTools: [...document.querySelectorAll('#log > .tool')].map(r => r.querySelector('b').textContent) }; }""")
    assert t["cls"] == "task completed has" and t["status"] == "completed · 3 tool uses · 4s" and t["text"] == "Three invoice links found.", t
    assert t["steps"] == "4 steps" and not t["open"] and t["nested"] == 3 and t["subText"] == 1, t
    assert t["topLevelTools"] == ["Agent"], "the subagent's steps are not top-level rows"
    page.click("#log .tool .grp .gh")
    assert page.evaluate("() => document.querySelector('#log .tool .grp').classList.contains('open')")
    page.click("#log .task.has")
    assert "- c" in page.text_content("#log .task .tsum")
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); time.sleep(0.5)
    assert page.evaluate("() => document.querySelector('#log .task')?.className") == "task completed has", "replayed from start+end events"


def test_todo_list_updates_in_place(page, server):
    open_ui(page, server)
    send(page, "todo-me"); wait_reply(page, "Two of three done.")
    t = page.evaluate("""() => ({ boxes: document.querySelectorAll('#log .todos').length, head: document.querySelector('#log .todos .th').textContent,
        items: [...document.querySelectorAll('#log .todos .ti')].map(i => i.className.replace('ti ', '') + ':' + i.textContent),
        toolRows: [...document.querySelectorAll('#log .tool b')].map(b => b.textContent) })""")
    assert t["boxes"] == 1 and t["head"] == "tasks · 2/3 done", t
    assert t["items"] == ["completed:✓ Read the config", "completed:✓ Patch the loader", "in_progress:▸ Running tests"], t
    assert "TodoWrite" not in t["toolRows"], "the list replaces the tool rows"


def test_at_file_completion_inserts_a_path(page, server):
    open_ui(page, server)
    page.fill("#box", "explain @load")
    page.wait_for_selector("#menu.open .item", timeout=5000)
    names = page.evaluate("() => [...document.querySelectorAll('#menu .item .n')].map(n => n.textContent)")
    assert names[0] == "@src/lib/loader.ts", names
    assert not any("node_modules" in n for n in names)
    page.press("#box", "Enter")
    assert page.input_value("#box") == "explain @src/lib/loader.ts "
    assert not page.evaluate("() => document.getElementById('menu').classList.contains('open')")
    # a directory keeps the menu open to go deeper
    page.fill("#box", "look at @sr"); page.wait_for_selector("#menu.open .item", timeout=5000)
    page.press("#box", "Enter")
    assert page.input_value("#box") == "look at @src/"
    page.wait_for_selector("#menu.open .item", timeout=5000)
    deeper = page.evaluate("() => [...document.querySelectorAll('#menu .item .n')].map(n => n.textContent)")
    assert "@src/index.ts" in deeper and "@src/lib/" in deeper, deeper
    page.press("#box", "Escape")
    page.fill("#box", "mail me at x@example.com")
    time.sleep(0.4)
    assert not page.evaluate("() => document.getElementById('menu').classList.contains('open')"), "an email address is not a mention"


def test_model_picker_lists_the_clis_models_and_sticks_per_chat(page, server):
    open_ui(page, server)
    wait(page, "() => document.querySelectorAll('#model option').length === 3", what="models from the CLI")
    labels = page.evaluate("() => [...document.querySelectorAll('#model option')].map(o => o.textContent + '=' + o.value)")
    assert labels == ["default=", "Opus 5=claude-opus-5", "Sonnet 5=claude-sonnet-5"], labels
    page.select_option("#model", "claude-sonnet-5"); time.sleep(0.4)
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect")
    wait(page, "() => document.querySelector('#model').value === 'claude-sonnet-5'", what="model restated on attach")
    send(page, "on sonnet"); wait_reply(page, "You said: on sonnet")
    page.click("#newchat"); wait(page, "() => document.querySelectorAll('.msg.user').length === 0", what="new chat")
    wait(page, "() => document.querySelector('#model').value === 'claude-sonnet-5'", what="a new chat inherits the model, like cwd and mode")
    page.select_option("#model", ""); time.sleep(0.3)
    assert page.errors == []


def test_rewind_previews_then_restores(page, server):
    open_ui(page, server)
    send(page, "touch the loader"); wait_reply(page, "You said: touch the loader")
    page.hover("#log .msg.user"); page.click("#log .msg.user .rw")
    page.wait_for_selector("#log .msg.user .rwcard", timeout=5000)
    what = page.text_content("#log .msg.user .rwcard .what")
    assert "Restore 2 files" in what and "src/a.ts, src/b.ts" in what and "(+3 −10 lines)" in what, what
    page.click("#log .msg.user .rwcard button:has-text('Cancel')")
    assert page.locator("#log .msg.user .rwcard").count() == 0
    page.hover("#log .msg.user"); page.click("#log .msg.user .rw")
    page.wait_for_selector("#log .msg.user .rwcard", timeout=5000)
    page.click("#log .msg.user .rwcard button:has-text('Restore')")
    wait(page, "() => [...document.querySelectorAll('#log .local')].some(l => l.textContent.includes('Rewound 2 files to before'))", what="the note")
    assert page.locator("#log .msg.user .rwcard").count() == 0
    assert page.errors == []


def test_a_chat_keeps_running_while_you_are_on_another_and_shows_the_answer_on_return(page, server):
    open_ui(page, server)
    long = "please echo " + " ".join(f"w{i}" for i in range(50))     # ~50 deltas at 30 ms each: a turn of ~1.5 s
    send(page, long)
    wait(page, "() => document.querySelectorAll('.msg.user').length === 1", what="sent")
    page.click("#newchat")                                              # switch away while it is still streaming
    wait(page, "() => document.querySelectorAll('.msg.user').length === 0", what="on the new chat")
    time.sleep(2.5)                                                      # the original finishes in the background
    page.click("#chatsbtn"); page.wait_for_selector("#clist .cfind input", timeout=5000)
    page.fill("#clist .cfind input", "please echo")                          # the title is the first message
    page.wait_for_selector("#clist .c:has(.ct:text-matches('please echo'))", timeout=5000)
    page.click("#clist .c:has(.ct:text-matches('please echo'))")
    wait(page, "() => [...document.querySelectorAll('#log .msg.md')].some(m => m.textContent.includes('You said: please echo') && m.textContent.includes('w49'))", what="the full answer, finished while away")
    assert page.locator("#log .end").count() == 1, "turn ended in the background"
    assert page.text_content("#statustext") == "ready"


def test_site_and_eval_cards(page, server):
    open_ui(page, server)
    send(page, "site-me")
    page.wait_for_selector(".card.site", timeout=10000)
    assert page.text_content(".card.site h4") == "Let Claude use bank.example?"
    labels = page.evaluate("() => [...document.querySelectorAll('.card.site .row button')].map(b => b.textContent)")
    assert labels == ["Allow (this chat)", "Always (this site)", "Deny"], labels
    assert page.text_content("#statustext") == "waiting for you — a site"
    page.click(".card.site button[data-decision=deny]"); wait_reply(page, "site: deny")
    send(page, "eval-me")
    page.wait_for_selector(".card.site", timeout=10000)
    cards = page.locator(".card.site"); last = cards.nth(cards.count() - 1)
    assert last.locator("h4").text_content() == "Run JavaScript on bank.example?"
    assert last.locator("pre").text_content() == "document.title"
    assert last.locator(".row button").all_text_contents() == ["Allow once", "Allow on this site (this chat)", "Deny"]
    last.locator("button[data-decision=allow]").click(); wait_reply(page, "eval: allow")


def test_manage_page_browser_sites(page, server):
    page.goto(server.base + "/manage.html"); page.click("nav button[data-tab=browser]")
    page.wait_for_selector("#browser .bar input", timeout=5000)
    page.fill("#browser .bar input", "*.corp.example"); page.press("#browser .bar input", "Enter")
    wait(page, "() => [...document.querySelectorAll('#browser .row .title')].some(t => t.textContent === '*.corp.example')", what="added")
    page.click("#browser .row:has(.title:text-is('*.corp.example')) button")
    wait(page, "() => ![...document.querySelectorAll('#browser .row .title')].some(t => t.textContent === '*.corp.example')", what="removed")
