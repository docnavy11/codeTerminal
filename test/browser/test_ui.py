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
    assert page.text_content(".card.site h4") == "Let Claude read bank.example?"
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
    row = "#browser .row:has(.title:text-is('*.corp.example'))"
    assert "read only" in page.text_content(row + " .meta")
    page.click(row + " button:has-text('allow acting')")
    wait(page, "() => { const r = [...document.querySelectorAll('#browser .row')].find(r => r.querySelector('.title')?.textContent === '*.corp.example'); return !!r && r.querySelector('.meta').textContent.includes('read + act'); }", what="raised to act")
    page.click("#browser .row:has(.title:text-is('*.corp.example')) button.danger")
    wait(page, "() => ![...document.querySelectorAll('#browser .row .title')].some(t => t.textContent === '*.corp.example')", what="removed")


PAGE = """
<nav><a href="/skip">Nav link</a></nav>
<main>
  <h1>Invoices</h1>
  <p>Open <a href="/inv/39">PUR1/2026/01/0039</a> and <code>check</code> it.</p>
  <ul><li>one</li><li>two <a href="https://x.example/t">deep</a></li></ul>
  <table><caption>Totals</caption><tr><th>Ref</th><th>Amount</th></tr><tr><td>0039</td><td>1 250,00</td></tr><tr><td>0040</td><td>80,00</td></tr></table>
  <pre>raw\n  text</pre>
  <form action="/search" method="get">
    <label for="q">Query</label><input id="q" name="q" value="inv">
    <select name="year"><option>2025</option><option selected>2026</option></select>
    <input type="checkbox" name="paid" checked> <input type="password" name="pw" value="s3cret">
    <input type="hidden" name="csrf" value="x"><button type="submit">Go</button>
  </form>
  <p style="display:none">hidden text</p>
</main>
<footer><a href="/privacy">Privacy</a></footer>
"""


def test_page_read_modes(page, server):
    page.set_content(PAGE)
    page.add_script_tag(path=os.path.join(os.path.dirname(__file__), "..", "..", "extension", "page-read.js"))
    md = page.evaluate("() => ctReadPage('markdown', 20000)")
    assert md["mode"] == "markdown"
    assert md["text"].startswith("# Invoices\n\nOpen [PUR1/2026/01/0039](") and "`check`" in md["text"], md["text"]
    assert "- one\n- two [deep](https://x.example/t)" in md["text"], md["text"]
    assert "**Totals**\n| Ref | Amount |\n| --- | --- |\n| 0039 | 1 250,00 |" in md["text"], md["text"]
    assert "```\nraw\n  text\n```" in md["text"], md["text"]
    assert "Nav link" not in md["text"] and "Privacy" not in md["text"] and "hidden text" not in md["text"], "nav, footer and hidden content are dropped"
    assert "Query" not in md["text"] and "2025" not in md["text"], "form controls are not prose"
    links = page.evaluate("() => ctReadPage('links')")
    hrefs = [l["href"] for l in links["links"]]
    assert links["count"] == 4 and hrefs[0].endswith("/skip") and "https://x.example/t" in hrefs, links
    tables = page.evaluate("() => ctReadPage('tables')")
    assert tables["count"] == 1 and tables["tables"][0] == {"caption": "Totals", "headers": ["Ref", "Amount"], "rows": [["0039", "1 250,00"], ["0040", "80,00"]]}, tables
    forms = page.evaluate("() => ctReadPage('forms')")
    f = forms["forms"][0]
    assert forms["count"] == 1 and f["action"].endswith("/search") and f["method"] == "get" and f["submit"]["text"] == "Go", forms
    names = [x["name"] for x in f["fields"]]
    assert names == ["q", "year", "paid", "pw"], names                       # hidden and submit inputs are not fields
    q = f["fields"][0]; assert q["label"] == "Query" and q["value"] == "inv" and q["ref"].startswith("f")
    assert f["fields"][1]["options"] == ["2025", "2026"] and f["fields"][1]["value"] == "2026"
    assert f["fields"][2]["checked"] is True and f["fields"][3]["value"] == "•••", "passwords are never read back"
    assert page.evaluate("(r) => document.querySelector('[data-ct-ref=\"' + r + '\"]').name", q["ref"]) == "q", "the ref addresses the field, so fill can use it"
    text = page.evaluate("() => ctReadPage('text', 12)")
    assert text["text"].endswith("…[truncated]") and text["chars"] > 12


def test_offered_file_has_a_download_button(page, server):
    open_ui(page, server)
    send(page, "offer-me"); wait_reply(page, "Here it is.")
    page.wait_for_selector("#log .filecard", timeout=5000)
    assert page.text_content("#log .filecard .fn") == "notes.txt"
    assert "your export" in page.text_content("#log .filecard .fm") and "ws/notes.txt" in page.text_content("#log .filecard .fm")
    with page.expect_download(timeout=10000) as dl:
        page.click("#log .filecard button:has-text('Download')")
    assert dl.value.suggested_filename == "notes.txt"
    with page.context.expect_page(timeout=10000) as newp:
        page.click("#log .filecard button:has-text('Open in tab')")
    tab = newp.value; tab.wait_for_load_state()
    assert "inline=1" in tab.url and tab.url.endswith("path=ws%2Fnotes.txt&inline=1"), tab.url
    assert "one" in tab.content(), "the text file renders as plain text in its own tab"
    tab.close()
    page.click("#log .filecard button:has-text('Show in files')")
    page.wait_for_selector("#flist .row:has(.n:text-is('notes.txt'))", timeout=5000)
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); time.sleep(0.5)
    assert page.locator("#log .filecard").count() == 1, "the offer is part of the transcript"


def test_find_and_scroll_in_the_page(page, server):
    filler = "".join(f"<p>paragraph {i}</p>" for i in range(150))
    page.set_content(f"<h1>Top</h1>{filler}<p id=deep>The invoice PUR1/2026/01/0039 is <b>overdue</b>.</p><button aria-label='Pay now'>Pay</button><a href='/x'>Privacy policy</a>{filler}")
    page.add_script_tag(path=os.path.join(os.path.dirname(__file__), "..", "..", "extension", "page-read.js"))
    f = page.evaluate("() => ctFind({ text: 'pur1/2026' })")
    assert f["count"] == 1 and f["matches"][0]["match"] == "PUR1/2026" and "overdue" not in f["matches"][0]["text"] or "0039" in f["matches"][0]["text"], f
    m = f["matches"][0]
    assert m["ref"].startswith("f") and m["inViewport"] is False and m["tag"] == "p", m
    r = page.evaluate("() => ctFind({ regex: 'paragraph 1[0-9]$', limit: 5 })")
    assert r["count"] == 5 and r["matches"][0]["match"] == "paragraph 10", r
    b = page.evaluate("() => ctFind({ role: 'button', name: 'pay' })")
    assert b["count"] == 1 and b["matches"][0]["name"] == "Pay now" and b["matches"][0]["role"] == "button", b
    l = page.evaluate("() => ctFind({ role: 'link' })")
    assert l["count"] == 1 and l["matches"][0]["name"] == "Privacy policy", l
    assert page.evaluate("() => ctFind({})")["error"]
    s0 = page.evaluate("() => ctScroll({ pages: 1 })")
    assert s0["scrollY"] > 0 and s0["atTop"] is False and 0 < s0["percent"] < 100, s0
    s1 = page.evaluate("(ref) => ctScroll({ ref })", m["ref"])
    assert -50 <= s1["rect"]["y"] <= page.viewport_size["height"], s1
    assert page.evaluate("(ref) => ctFind({ text: 'overdue' }).matches[0].inViewport", m["ref"]) is True
    assert page.evaluate("() => ctScroll({ to: 'bottom' })")["atBottom"] is True
    assert page.evaluate("() => ctScroll({ to: 'top' })")["atTop"] is True
    assert page.evaluate("() => ctScroll({ selector: '#deep' }).rect.h") > 0
    assert page.evaluate("() => ctScroll({ ref: 'nope' })")["error"].startswith("no element")


def test_wait_probe_reports_each_condition(page, server):
    page.set_content("<h1>Loading…</h1><div id=spinner>please wait</div><button hidden id=done>Done</button>")
    page.add_script_tag(path=os.path.join(os.path.dirname(__file__), "..", "..", "extension", "page-read.js"))
    r = page.evaluate("() => ctWaitProbe({ text: ['ready', 'done'], gone: 'please wait', selector: '#done', load: 'complete' })")
    assert r["text"] is None and r["gone"] is False and r["selector"] is False and r["load"] is True and r["readyState"] == "complete", r
    page.evaluate("() => { document.querySelector('#spinner').remove(); document.querySelector('#done').hidden = false; document.querySelector('h1').textContent = 'All DONE'; }")
    r = page.evaluate("() => ctWaitProbe({ text: ['ready', 'done'], gone: 'please wait', selector: '#done' })")
    assert r["text"] == "done" and r["gone"] is True and r["selector"] is True, r
    assert page.evaluate("() => ctWaitProbe({ selector: '#done' })")["selector"] is True
    assert page.evaluate("() => ctWaitProbe({ selector: ':::bad' })")["selectorError"] == "bad selector"
    assert isinstance(page.evaluate("() => ctWaitProbe({}).resources"), int)


def test_reply_tables_have_lines(page, server):
    open_ui(page, server)
    page.evaluate("() => handle({ kind: 'text', text: '| txn | € |\\n|---|---|\\n| T1052 | 171,24 |\\n| T1095 | 53,84 |' })")
    page.wait_for_selector("#log .msg.md table td", timeout=5000)
    cs = page.evaluate("() => { const td = document.querySelector('#log .msg.md tbody td'); const th = document.querySelector('#log .msg.md th'); const s = getComputedStyle(td), h = getComputedStyle(th);"
                       " return { border: s.borderTopWidth, pad: s.paddingLeft, headRule: h.borderBottomWidth, collapse: getComputedStyle(document.querySelector('#log .msg.md table')).borderCollapse }; }")
    assert cs["border"] == "1px" and cs["pad"] == "8px" and cs["headRule"] == "2px" and cs["collapse"] == "collapse", cs


def test_viewer_renders_markdown_csv_json(page, server):
    import os
    os.makedirs(os.path.join(server.root, "files"), exist_ok=True)
    with open(os.path.join(server.root, "files", "report.md"), "w") as f:
        f.write("# Report\n\n| txn | amount |\n|---|---|\n| T1 | 1,00 |\n\n[site](https://example.com) <script>alert(1)</script>\n")
    with open(os.path.join(server.root, "files", "data.csv"), "w") as f:
        f.write('id,name\n1,"Doe, Jane"\n2,"say ""hi"""\n')
    with open(os.path.join(server.root, "files", "d.json"), "w") as f:
        f.write('{"a":[1,2],"b":{"c":true}}')
    page.goto(server.base + "/view.html?path=files/report.md")
    page.wait_for_selector("#main .md table td", timeout=5000)
    assert page.text_content("#main .md h1").strip() == "Report"
    assert page.evaluate("() => getComputedStyle(document.querySelector('#main .md td')).borderTopWidth") == "1px"
    assert page.evaluate("() => document.querySelector('#main .md a').target") == "_blank"
    assert page.evaluate("() => document.querySelectorAll('#main script').length") == 0
    assert page.title().startswith("report.md")
    page.click("#raw")
    assert "| txn | amount |" in page.text_content("#main pre")
    page.goto(server.base + "/view.html?path=files/data.csv")
    page.wait_for_selector("#main table.grid tbody tr", timeout=5000)
    cells = page.evaluate("() => [...document.querySelectorAll('#main table.grid tbody tr')].map(r => [...r.cells].map(c => c.textContent))")
    assert cells == [["1", "1", "Doe, Jane"], ["2", "2", 'say "hi"']], cells
    assert page.text_content("#main .note").strip() == "2 rows"
    page.goto(server.base + "/view.html?path=files/d.json")
    page.wait_for_selector("#main pre", timeout=5000)
    assert page.text_content("#main pre") == '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": true\n  }\n}'
    page.goto(server.base + "/view.html?path=files/nope.md")
    page.wait_for_selector("#main .err", timeout=5000)
    assert "Cannot open nope.md" in page.text_content("#main .err")


def test_open_in_tab_routes_markdown_to_viewer(page, server):
    open_ui(page, server)
    assert page.evaluate("() => ownViewer('a/b.md') && ownViewer('x.CSV') && ownViewer('d.json') && !ownViewer('p.pdf') && !ownViewer('t.txt')")


def test_each_tab_keeps_its_own_chat(page, server):
    open_ui(page, server)
    page.click("#newchat")
    page.wait_for_function("() => ACTIVE && sessionStorage.getItem('ct.chat') === ACTIVE", timeout=5000)
    mine = page.evaluate("() => ACTIVE")
    send(page, "mine"); wait_reply(page, "You said: mine")     # used, so "New chat" elsewhere makes a different one
    other = page.context.new_page()
    other.goto(server.base + "/m.html")
    other.wait_for_function("() => ACTIVE", timeout=5000)
    assert other.evaluate("() => ACTIVE") == mine          # a fresh tab still lands on the newest
    other.click("#newchat")
    other.wait_for_function("(m) => ACTIVE && ACTIVE !== m", arg=mine, timeout=5000)
    theirs = other.evaluate("() => ACTIVE")
    page.reload()
    page.wait_for_function("() => ACTIVE", timeout=5000)
    assert page.evaluate("() => ACTIVE") == mine, "reload must reattach to this tab's chat, not the other tab's newer one"
    assert other.evaluate("() => ACTIVE") == theirs
    other.close()


def test_browser_tool_rows_say_where(page, server):
    open_ui(page, server)
    page.evaluate("""() => {
        handle({kind:'tool', id:'w1', name:'mcp__browser__click', input:{tabId: 3, selector: 'button.pay'}});
        handle({kind:'tool_result', id:'w1', name:'mcp__browser__click', ok:true, summary:'clicked', text:'{}', bytes:2, truncated:false, where:'bank.example · Transfer'});
        handle({kind:'tool', id:'w2', name:'Read', input:{file_path:'/tmp/x'}});
        handle({kind:'tool_result', id:'w2', name:'Read', ok:true, summary:'3 lines', text:'a', bytes:1, truncated:false}); }""")
    page.wait_for_selector("#log .tool .where", timeout=5000)
    assert page.text_content("#log .tool .where") == "bank.example · Transfer"
    assert page.evaluate("() => document.querySelectorAll('#log .tool .where').length") == 1


def test_viewer_tables_sort_filter_resize(page, server):
    import os
    os.makedirs(os.path.join(server.root, "files"), exist_ok=True)
    with open(os.path.join(server.root, "files", "t.md"), "w") as f:
        f.write("# T\n\n| name | amount |\n|---|---|\n| pear | 10,50 |\n| apple | -331.33 |\n| fig | 2 |\n| kiwi | |\n")
    page.goto(server.base + "/view.html?path=files/t.md")
    page.wait_for_selector("#main .tw table th.sortable", timeout=5000)
    col = lambda i: page.evaluate("(i) => [...document.querySelectorAll('#main tbody tr:not([hidden])')].map(r => r.cells[i].textContent.trim())", i)
    page.click("#main th.sortable >> nth=0")                    # name asc
    assert col(0) == ["apple", "fig", "kiwi", "pear"]
    page.click("#main th.sortable >> nth=0")                    # desc
    assert col(0) == ["pear", "kiwi", "fig", "apple"]
    page.click("#main th.sortable >> nth=0")                    # file order again
    assert col(0) == ["pear", "apple", "fig", "kiwi"]
    page.click("#main th.sortable >> nth=1")                    # numeric: 10,50 > 2 > -331.33; blank last
    assert col(1) == ["-331.33", "2", "10,50", ""], col(1)
    assert not page.is_hidden("#q")
    page.fill("#q", "PE")
    assert col(0) == ["pear"]
    assert page.text_content("#main .cnt").strip() == "1 of 4 rows"
    page.fill("#q", "")
    assert len(col(0)) == 4 and page.is_hidden("#main .cnt")
    th = page.locator("#main th.sortable >> nth=0")
    w0 = th.evaluate("e => e.getBoundingClientRect().width")
    box = th.locator(".rz").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); page.mouse.down(); page.mouse.move(box["x"] + 120, box["y"] + 5, steps=4); page.mouse.up()
    w1 = th.evaluate("e => e.getBoundingClientRect().width")
    assert w1 > w0 + 80, (w0, w1)
    assert col(0) == ["apple", "fig", "pear", "kiwi"], "a drag on the handle must not change the (amount-sorted) order"


def test_extension_detects_and_answers_dialogs(playwright):
    """The real extension in Chromium: a confirm/prompt/alert raised by the
    agent's own click is reported with its message, blocks other calls at
    once instead of hanging, and is answered through the debugger session the
    worker attached before acting. After `release`, a dialog the page raises
    itself is still detected but reported as not answerable."""
    import tempfile, threading, http.server, socketserver
    ext = os.path.join(os.path.dirname(__file__), "..", "..", "extension")
    html = (b"<button id=b onclick=\"window.r = confirm('Delete everything?')\">go</button>"
            b"<button id=pr onclick=\"window.p = prompt('Name?', 'anon')\">p</button>"
            b"<button id=al onclick=\"alert('Saved!'); window.a = 1\">a</button><p>hello page</p>")
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self): self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(html)
        def log_message(self, *a): pass
    srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    prof = tempfile.mkdtemp(prefix="ct-dlg-prof-")
    ctx = playwright.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    call = lambda sw, action, params, ms=6000: sw.evaluate(
        "([a, p, ms]) => Promise.race([ctHandle(a, p).then(r => ({ok:true, r}), e => ({ok:false, e:String(e && e.message || e)})),"
        " new Promise(res => setTimeout(() => res({timeout:true}), ms))])", [action, params, ms])
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        page.on("dialog", lambda d: None)                      # Playwright must leave dialogs alone
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        assert call(sw, "dialog_state", {"tabId": tab})["r"]["open"] is False
        t0 = time.time(); r = call(sw, "click", {"tabId": tab, "selector": "#b"}, 12000)
        assert r["ok"] is False and 'confirm dialog: "Delete everything?"' in r["e"], r
        assert time.time() - t0 < 5, "the click must fail as soon as the dialog opens, not after the grace"
        st = call(sw, "dialog_state", {"tabId": tab})["r"]; assert (st["type"], st["message"]) == ("confirm", "Delete everything?")
        r = call(sw, "read_page", {"tabId": tab, "mode": "text"}); assert r["ok"] is False and "blocked" in r["e"]
        r = call(sw, "handle_dialog", {"tabId": tab, "accept": False})["r"]; assert r["handled"] is True, r
        time.sleep(0.3); assert page.evaluate("() => window.r") is False
        assert call(sw, "read_page", {"tabId": tab, "mode": "text"})["ok"] is True
        call(sw, "click", {"tabId": tab, "selector": "#pr"}, 12000); time.sleep(0.3)
        assert call(sw, "dialog_state", {"tabId": tab})["r"]["defaultValue"] == "anon"
        assert call(sw, "handle_dialog", {"tabId": tab, "accept": True, "text": "Yvan"})["r"]["handled"] is True
        time.sleep(0.3); assert page.evaluate("() => window.p") == "Yvan"
        call(sw, "click", {"tabId": tab, "selector": "#al"}, 12000); time.sleep(0.3)
        assert call(sw, "handle_dialog", {"tabId": tab, "accept": True})["r"]["handled"] is True
        time.sleep(0.3); assert page.evaluate("() => window.a") == 1
        assert call(sw, "handle_dialog", {"tabId": tab, "accept": True})["r"] == {"tabId": tab, "handled": False, "reason": "no dialog is open"}
        assert call(sw, "release", {})["r"] == {"released": 1}
        page.evaluate("() => setTimeout(() => { window.r2 = confirm('Leave?') }, 50)"); time.sleep(0.6)
        st = call(sw, "dialog_state", {"tabId": tab})["r"]; assert st["open"] and st["message"] == "Leave?"
        r = call(sw, "handle_dialog", {"tabId": tab, "accept": True})["r"]; assert r["handled"] is False and "ask the user" in r["reason"]
        flagged = [t for t in call(sw, "list_tabs", {})["r"] if t["id"] == tab][0]
        assert flagged["dialog"] == {"type": "confirm", "message": "Leave?"}
    finally:
        ctx.close(); srv.shutdown()


def test_extension_eval_awaits_promises(playwright):
    """eval returns the settled value of a promise, runs top-level await as an
    async body, reports a rejection as the error, and does not hang on a
    promise that never settles (measured with a 30 s cap lowered here by
    racing the call itself)."""
    import tempfile, threading, http.server, socketserver
    ext = os.path.join(os.path.dirname(__file__), "..", "..", "extension")
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "text/html" if self.path == "/" else "application/json"); self.end_headers()
            self.wfile.write(b"<p id=t>hello page</p>" if self.path == "/" else b'{"n": 42}')
        def log_message(self, *a): pass
    srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    prof = tempfile.mkdtemp(prefix="ct-eval-prof-")
    ctx = playwright.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    call = lambda sw, code, ms=8000: sw.evaluate(
        "([code, ms]) => Promise.race([ctHandle('eval', {code}).then(r => ({ok:true, r: r.result}), e => ({ok:false, e:String(e && e.message || e)})),"
        " new Promise(res => setTimeout(() => res({timeout:true}), ms))])", [code, ms])
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        assert call(sw, "1 + 1") == {"ok": True, "r": 2}
        assert call(sw, "document.getElementById('t').textContent") == {"ok": True, "r": "hello page"}
        assert call(sw, "fetch('/data.json').then(r => r.json())") == {"ok": True, "r": {"n": 42}}
        assert call(sw, "(async () => { const r = await fetch('/data.json'); return (await r.json()).n * 2; })()") == {"ok": True, "r": 84}
        assert call(sw, "const r = await fetch('/data.json'); return (await r.json()).n + 1;") == {"ok": True, "r": 43}
        r = call(sw, "Promise.reject(new Error('nope'))"); assert r["ok"] is False and "nope" in r["e"], r
        r = call(sw, "throw new SyntaxError('mine')"); assert r["ok"] is False and "mine" in r["e"], r
        r = call(sw, "new Promise(() => {})", 2000); assert r == {"timeout": True}, "a never-settling promise is capped at 30 s, beyond this test's patience — it must at least not break the worker"
        assert call(sw, "2 * 21") == {"ok": True, "r": 42}, "the worker still answers after a pending eval"
    finally:
        ctx.close(); srv.shutdown()
