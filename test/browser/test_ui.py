"""The shared client in a real browser against the fixture server: the paths
that only exist in the DOM — reconnects, streaming, cards, downloads, layout."""
import os, time
import pytest
from conftest import SHORT, LONG, serve_html, wait_stable, open_ui, send, wait, wait_reply, last_reply


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
        wait(page, "() => document.querySelector('#dot').classList.contains('on')", 30, "reconnect")
        # The replay arrives over the new socket a message at a time; a fixed
        # sleep counted a half-drawn transcript on a slow runner (CI, 1 of 1).
        wait(page, f"() => document.querySelectorAll('#log > *').length === {before['n']}", 30, "transcript replayed")
        time.sleep(0.3)
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
    page.wait_for_selector(".card[data-tool=Bash]", timeout=LONG)
    assert "rm -rf build" in page.text_content(".card[data-tool=Bash] pre")
    page.click(".card[data-tool=Bash] button[data-decision=deny]")
    wait(page, "() => [...document.querySelectorAll('.card[data-tool=Bash] button')].every(b => b.disabled)", what="card disabled")
    wait_reply(page, "decision: deny")


def test_question_card_round_trip(page, server):
    open_ui(page, server)
    send(page, "ask-me")
    page.wait_for_selector(".q[data-tool=question]", timeout=LONG)
    page.click(".q .opt:has-text('Blue')")
    page.click(".q button.allow:has-text('Answer')")
    wait_reply(page, '"Which colour?":"Blue"')


def test_new_chat_and_switching_back(page, server):
    open_ui(page, server)
    send(page, "remember me"); wait_reply(page, "You said: remember me")
    page.click("#newchat")
    wait(page, "() => document.querySelectorAll('.msg.user').length === 0", what="cleared")
    page.click("#chatsbtn")
    page.wait_for_selector("#clist .c", timeout=SHORT)
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
    page.wait_for_selector("#flist .row", timeout=SHORT)
    with page.expect_download(timeout=LONG) as dl:
        page.click("#flist .row:has(.n:text-is('blob.txt')) .dl")
    d = dl.value; path = os.path.join(server.root, "dl.txt"); d.save_as(path)
    assert d.suggested_filename == "blob.txt" and os.path.getsize(path) == 300_000
    page.click("#flist .row:has(.n:text-is('hello.txt')) .ck"); page.click("#flist .row:has(.n:text-is('note.txt')) .ck")
    with page.expect_download(timeout=LONG) as dl2:
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
    page.wait_for_selector("#flist .row", timeout=SHORT)
    page.click("#fmkdir")
    page.fill("#flist .row.newdir input", "made here")
    page.press("#flist .row.newdir input", "Enter")
    wait(page, "() => document.querySelector('#fpath').textContent.includes('made here')", what="navigated into the new folder")
    assert os.path.isdir(os.path.join(server.root, "ws", "made here"))
    page.click("#fup")
    page.wait_for_selector("#flist .row.dir:has(.n:text-is('made here/'))", timeout=SHORT)
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
    page.wait_for_selector("#flist .row", timeout=SHORT)
    page.click("#flist .row:has(.n:text-is('huge.bin')) .ck")
    page.click("#fsel button:text-is('zip')")
    wait(page, "() => (document.querySelector('#flist .ferr')?.textContent || '').includes('too large')", what="zip refusal inline")
    big = os.path.join(server.root, "toolarge.bin"); open(big, "wb").write(b"\0" * (2 * 1024 * 1024))
    page.set_input_files("#fpick", big)
    wait(page, "() => (document.querySelector('#flist .ferr')?.textContent || '').includes('upload failed')", what="upload refusal inline")
    assert page.errors == []


def test_setup_page_renders_live_checks(page, server):
    page.goto(server.base + "/setup.html")
    page.wait_for_selector(".check", timeout=LONG)
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


@pytest.mark.xdist_group("chromium")
def test_extension_connects_once_its_address_is_set(server, playwright):
    ext = os.path.join(os.path.dirname(__file__), "..", "..", "extension")
    """The real extension in Chromium: it starts with no address (badge 'set'),
    and connecting must begin the moment the address is stored — not on the
    next worker restart."""
    import json, urllib.request, tempfile
    prof = tempfile.mkdtemp(prefix="ct-ext-prof-")
    connected = lambda: json.load(urllib.request.urlopen(server.base + "/setup"))["extension"]["connected"]
    ctx = playwright.chromium.launch_persistent_context(prof, headless=True, channel="chromium",
                                                        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=LONG)
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
    page.click("#chatsbtn"); page.wait_for_selector("#clist .cfind input", timeout=SHORT)
    page.fill("#clist .cfind input", "platypus")
    page.wait_for_selector("#clist .c.hit", timeout=SHORT)
    assert "platypus" in page.text_content("#clist .c.hit .cs")
    page.click("#clist .c.hit")
    wait(page, "() => !!document.querySelector('#log .flash') && document.querySelector('#log .flash').textContent.includes('platypus')", what="jumped and flashed the hit")
    assert page.evaluate("() => document.querySelector('#log .flash').dataset.i") is not None


def test_export_downloads_markdown(page, server):
    open_ui(page, server)
    send(page, "export me please"); wait_reply(page, "You said: export me please")
    page.click("#more")
    with page.expect_download(timeout=LONG) as dl:
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
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); wait_stable(page)
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
    page.wait_for_selector(".card[data-tool=Edit] .diff", timeout=LONG)
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
    page.wait_for_selector("#log .think", timeout=LONG)
    wait(page, "() => (document.querySelector('#log .think .first')?.textContent || '').includes('narrowed')", what="first line while streaming")
    wait_reply(page, "Verified: it is the second one.")
    assert page.text_content("#log .think .first") == "I've narrowed it to two candidates."
    assert not page.evaluate("() => document.querySelector('#log .think').classList.contains('open')"), "collapsed by default"
    assert page.evaluate("() => document.querySelectorAll('#log .think').length") == 1, "the finished block replaces the streamed one"
    page.click("#log .think")
    assert "Now verifying each against the repo." in page.text_content("#log .think .tt")
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); wait_stable(page)
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
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); wait_stable(page)
    assert page.locator("#log .msg.user .imgs img").count() == 1, "thumbnail survives the replay"
    assert page.errors == []


def test_plan_card_renders_the_plan_and_switches_mode(page, server):
    open_ui(page, server)
    send(page, "plan-me")
    page.wait_for_selector(".card.plan", timeout=LONG)
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
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); wait_stable(page)
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
    page.wait_for_selector("#menu.open .item", timeout=SHORT)
    names = page.evaluate("() => [...document.querySelectorAll('#menu .item .n')].map(n => n.textContent)")
    assert names[0] == "@src/lib/loader.ts", names
    assert not any("node_modules" in n for n in names)
    page.press("#box", "Enter")
    assert page.input_value("#box") == "explain @src/lib/loader.ts "
    assert not page.evaluate("() => document.getElementById('menu').classList.contains('open')")
    # a directory keeps the menu open to go deeper
    page.fill("#box", "look at @sr"); page.wait_for_selector("#menu.open .item", timeout=SHORT)
    page.press("#box", "Enter")
    assert page.input_value("#box") == "look at @src/"
    page.wait_for_selector("#menu.open .item", timeout=SHORT)
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
    page.wait_for_selector("#log .msg.user .rwcard", timeout=SHORT)
    what = page.text_content("#log .msg.user .rwcard .what")
    assert "Restore 2 files" in what and "src/a.ts, src/b.ts" in what and "(+3 −10 lines)" in what, what
    page.click("#log .msg.user .rwcard button:has-text('Cancel')")
    assert page.locator("#log .msg.user .rwcard").count() == 0
    page.hover("#log .msg.user"); page.click("#log .msg.user .rw")
    page.wait_for_selector("#log .msg.user .rwcard", timeout=SHORT)
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
    page.click("#chatsbtn"); page.wait_for_selector("#clist .cfind input", timeout=SHORT)
    page.fill("#clist .cfind input", "please echo")                          # the title is the first message
    page.wait_for_selector("#clist .c:has(.ct:text-matches('please echo'))", timeout=SHORT)
    page.click("#clist .c:has(.ct:text-matches('please echo'))")
    wait(page, "() => [...document.querySelectorAll('#log .msg.md')].some(m => m.textContent.includes('You said: please echo') && m.textContent.includes('w49'))", what="the full answer, finished while away")
    assert page.locator("#log .end").count() == 1, "turn ended in the background"
    assert page.text_content("#statustext") == "ready"


def test_site_and_eval_cards(page, server):
    open_ui(page, server)
    send(page, "site-me")
    page.wait_for_selector(".card.site", timeout=LONG)
    assert page.text_content(".card.site h4") == "Let Claude read bank.example?"
    labels = page.evaluate("() => [...document.querySelectorAll('.card.site .row button')].map(b => b.textContent)")
    assert labels == ["Allow (this chat)", "Always (this site)", "Deny"], labels
    assert page.text_content("#statustext") == "waiting for you — a site"
    page.click(".card.site button[data-decision=deny]"); wait_reply(page, "site: deny")
    send(page, "eval-me")
    page.wait_for_selector(".card.site:not(.done)", timeout=LONG)   # not the denied one still on screen
    cards = page.locator(".card.site:not(.done)"); last = cards.nth(cards.count() - 1)
    assert last.locator("h4").text_content() == "Run JavaScript on bank.example?"
    assert last.locator("pre").text_content() == "document.title"
    assert last.locator(".row button").all_text_contents() == ["Allow once", "Allow on this site (this chat)", "Deny"]
    last.locator("button[data-decision=allow]").click(); wait_reply(page, "eval: allow")


def test_manage_page_browser_sites(page, server):
    page.goto(server.base + "/manage.html"); page.click("nav button[data-tab=browser]")
    page.wait_for_selector("#browser .bar input", timeout=SHORT)
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
    page.wait_for_selector("#log .filecard", timeout=SHORT)
    assert page.text_content("#log .filecard .fn") == "notes.txt"
    assert "your export" in page.text_content("#log .filecard .fm") and "ws/notes.txt" in page.text_content("#log .filecard .fm")
    with page.expect_download(timeout=LONG) as dl:
        page.click("#log .filecard button:has-text('Download')")
    assert dl.value.suggested_filename == "notes.txt"
    with page.context.expect_page(timeout=LONG) as newp:
        page.click("#log .filecard button:has-text('Open in tab')")
    tab = newp.value; tab.wait_for_load_state()
    assert "inline=1" in tab.url and tab.url.endswith("path=ws%2Fnotes.txt&inline=1"), tab.url
    assert "one" in tab.content(), "the text file renders as plain text in its own tab"
    tab.close()
    page.click("#log .filecard button:has-text('Show in files')")
    page.wait_for_selector("#flist .row:has(.n:text-is('notes.txt'))", timeout=SHORT)
    page.reload(); wait(page, "() => document.querySelector('#dot').classList.contains('on')", what="reconnect"); wait_stable(page)
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
    page.wait_for_selector("#log .msg.md table td", timeout=SHORT)
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
    page.wait_for_selector("#main .md table td", timeout=SHORT)
    assert page.text_content("#main .md h1").strip() == "Report"
    assert page.evaluate("() => getComputedStyle(document.querySelector('#main .md td')).borderTopWidth") == "1px"
    assert page.evaluate("() => document.querySelector('#main .md a').target") == "_blank"
    assert page.evaluate("() => document.querySelectorAll('#main script').length") == 0
    assert page.title().startswith("report.md")
    page.click("#raw")
    assert "| txn | amount |" in page.text_content("#main pre")
    page.goto(server.base + "/view.html?path=files/data.csv")
    page.wait_for_selector("#main table.grid tbody tr", timeout=SHORT)
    cells = page.evaluate("() => [...document.querySelectorAll('#main table.grid tbody tr')].map(r => [...r.cells].map(c => c.textContent))")
    assert cells == [["1", "1", "Doe, Jane"], ["2", "2", 'say "hi"']], cells
    assert page.text_content("#main .note").strip() == "2 rows"
    page.goto(server.base + "/view.html?path=files/d.json")
    page.wait_for_selector("#main pre", timeout=SHORT)
    assert page.text_content("#main pre") == '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": true\n  }\n}'
    page.goto(server.base + "/view.html?path=files/nope.md")
    page.wait_for_selector("#main .err", timeout=SHORT)
    assert "Cannot open nope.md" in page.text_content("#main .err")


def test_open_in_tab_routes_markdown_to_viewer(page, server):
    open_ui(page, server)
    assert page.evaluate("() => ownViewer('a/b.md') && ownViewer('x.CSV') && ownViewer('d.json') && !ownViewer('p.pdf') && !ownViewer('t.txt')")


def test_each_tab_keeps_its_own_chat(page, server):
    open_ui(page, server)
    page.click("#newchat")
    page.wait_for_function("() => ACTIVE && sessionStorage.getItem('ct.chat') === ACTIVE", timeout=SHORT)
    mine = page.evaluate("() => ACTIVE")
    send(page, "mine"); wait_reply(page, "You said: mine")     # used, so "New chat" elsewhere makes a different one
    other = page.context.new_page()
    other.goto(server.base + "/m.html")
    other.wait_for_function("() => ACTIVE", timeout=SHORT)
    assert other.evaluate("() => ACTIVE") == mine          # a fresh tab still lands on the newest
    other.click("#newchat")
    other.wait_for_function("(m) => ACTIVE && ACTIVE !== m", arg=mine, timeout=SHORT)
    theirs = other.evaluate("() => ACTIVE")
    page.reload()
    page.wait_for_function("() => ACTIVE", timeout=SHORT)
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
    page.wait_for_selector("#log .tool .where", timeout=SHORT)
    assert page.text_content("#log .tool .where") == "bank.example · Transfer"
    assert page.evaluate("() => document.querySelectorAll('#log .tool .where').length") == 1


def test_viewer_tables_sort_filter_resize(page, server):
    import os
    os.makedirs(os.path.join(server.root, "files"), exist_ok=True)
    with open(os.path.join(server.root, "files", "t.md"), "w") as f:
        f.write("# T\n\n| name | amount |\n|---|---|\n| pear | 10,50 |\n| apple | -331.33 |\n| fig | 2 |\n| kiwi | |\n")
    page.goto(server.base + "/view.html?path=files/t.md")
    page.wait_for_selector("#main .tw table th.sortable", timeout=SHORT)
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


@pytest.mark.xdist_group("chromium")
def test_extension_detects_and_answers_dialogs(ext_pages):
    """The real extension in Chromium: a confirm/prompt/alert raised by the
    agent's own click is reported with its message, blocks other calls at
    once instead of hanging, and is answered through the debugger session the
    worker attached before acting. After `release`, a dialog the page raises
    itself is still detected but reported as not answerable."""
    html = (b"<button id=b onclick=\"window.r = confirm('Delete everything?')\">go</button>"
            b"<button id=pr onclick=\"window.p = prompt('Name?', 'anon')\">p</button>"
            b"<button id=al onclick=\"alert('Saved!'); window.a = 1\">a</button><p>hello page</p>")
    srv = serve_html(html); port = srv.port
    ctx = ext_pages
    call = lambda sw, action, params, ms=6000: sw.evaluate(
        "([a, p, ms]) => Promise.race([ctHandle(a, p).then(r => ({ok:true, r}), e => ({ok:false, e:String(e && e.message || e)})),"
        " new Promise(res => setTimeout(() => res({timeout:true}), ms))])", [action, params, ms])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        leftovers = []; page.on("dialog", lambda d: leftovers.append(d))   # Playwright must leave dialogs alone
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
        assert call(sw, "handle_dialog", {"tabId": tab, "accept": True, "text": "Alex"})["r"]["handled"] is True
        time.sleep(0.3); assert page.evaluate("() => window.p") == "Alex"
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
        for d in leftovers:
            try: d.dismiss()
            except Exception: pass
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_eval_awaits_promises(ext_pages):
    """eval returns the settled value of a promise, runs top-level await as an
    async body, reports a rejection as the error, and does not hang on a
    promise that never settles (measured with a 30 s cap lowered here by
    racing the call itself)."""
    srv = serve_html(lambda path: (200, "text/html", b"<p id=t>hello page</p>") if path == "/" else (200, "application/json", b'{"n": 42}')); port = srv.port
    ctx = ext_pages
    call = lambda sw, code, ms=8000: sw.evaluate(
        "([code, ms]) => Promise.race([ctHandle('eval', {code}).then(r => ({ok:true, r: r.result}), e => ({ok:false, e:String(e && e.message || e)})),"
        " new Promise(res => setTimeout(() => res({timeout:true}), ms))])", [code, ms])
    try:
        sw = ctx.sw
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
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_manages_tabs(ext_pages):
    """The real extension: open a tab (returns its id, listed), focus another,
    back/forward/reload report the URL landed on, close removes it."""
    srv = serve_html(lambda path: f"<title>page {path}</title><a id=n href='/two'>two</a>".encode()); port = srv.port; base = srv.base
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p)", [action, params])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(base + "/one"); time.sleep(0.2)
        first = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        opened = call(sw, "open_tab", {"url": base + "/three", "active": False}); time.sleep(0.4)
        ids = [t["id"] for t in call(sw, "list_tabs", {})]
        assert opened["tabId"] in ids and opened["url"].endswith("/three")
        assert [t for t in call(sw, "list_tabs", {}) if t["id"] == first][0]["active"] is True, "active:false leaves the first tab in front"
        assert call(sw, "focus_tab", {"tabId": opened["tabId"]})["focused"] is True; time.sleep(0.2)
        assert [t for t in call(sw, "list_tabs", {}) if t["id"] == opened["tabId"]][0]["active"] is True
        call(sw, "navigate", {"tabId": first, "url": base + "/two"}); time.sleep(0.5)
        assert call(sw, "back", {"tabId": first})["url"].endswith("/one")
        assert call(sw, "forward", {"tabId": first})["url"].endswith("/two")
        r = call(sw, "reload", {"tabId": first, "hard": True}); assert r["url"].endswith("/two") and r.get("title") == "page /two"
        closed = call(sw, "close_tab", {"tabId": opened["tabId"]}); assert closed["closed"] is True and closed["url"].endswith("/three")
        time.sleep(0.2); assert opened["tabId"] not in [t["id"] for t in call(sw, "list_tabs", {})]
    finally:
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_fills_forms(ext_pages):
    """The real extension: read_page forms gives refs; fill_form sets text,
    textarea, select (by text), checkbox and radio in one call, fires the
    events a framework listens to, reports a missing ref and a select with no
    matching option without stopping, and does not submit."""
    html = b"""<form id=f action="/submitted"><label>Name <input name=name></label>
      <label>Notes <textarea name=notes></textarea></label>
      <label>Country <select name=country><option value="">--</option><option value=be>Belgium</option><option value=nl>Netherlands</option></select></label>
      <label><input type=checkbox name=gift> Gift</label>
      <label><input type=radio name=ship value=std checked> Standard</label><label><input type=radio name=ship value=exp> Express</label>
      <button type=submit>Order</button></form>
      <script>window.ev = []; for (const el of document.querySelectorAll('input,select,textarea')) { el.addEventListener('input', e => ev.push('i:' + el.name)); el.addEventListener('change', e => ev.push('c:' + el.name)); }
      document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); window.submitted = true; });</script>"""
    srv = serve_html(html); port = srv.port
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p)", [action, params])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        forms = call(sw, "read_page", {"tabId": tab, "mode": "forms"})["forms"]
        ref = {f["name"]: f["ref"] for f in forms[0]["fields"]}
        assert forms[0]["submit"]["text"] == "Order" and set(ref) >= {"name", "notes", "country", "gift", "ship"}
        r = call(sw, "fill_form", {"tabId": tab, "fields": [
            {"ref": ref["name"], "value": "Alex"}, {"ref": ref["notes"], "value": "two\nlines"},
            {"ref": ref["country"], "value": "netherlands"}, {"ref": ref["gift"], "value": True},
            {"ref": ref["ship"], "value": "Express"}, {"ref": "nope", "value": "x"}, {"selector": "select[name=country]", "value": "Mars"}]})
        assert (r["filled"], r["total"]) == (5, 7), r
        by = {x["field"]: x for x in r["results"]}
        assert by["nope"]["error"] == "element not found"
        assert by["select[name=country]"]["error"] == 'no option matches "Mars"' and by["select[name=country]"]["options"] == ["--", "Belgium", "Netherlands"]
        assert by[ref["country"]]["set"] == "Netherlands" and by[ref["gift"]]["set"] is True and by[ref["ship"]]["set"] == "exp"
        state = page.evaluate("() => ({ name: f.name.value, notes: f.notes.value, country: f.country.value, gift: f.gift.checked, ship: f.ship.value, ev: window.ev, submitted: !!window.submitted })")
        assert state["name"] == "Alex" and state["notes"] == "two\nlines" and state["country"] == "nl" and state["gift"] is True and state["ship"] == "exp", state
        assert "i:name" in state["ev"] and "c:country" in state["ev"] and "c:gift" in state["ev"] and "c:ship" in state["ev"], state["ev"]
        assert state["submitted"] is False, "fill_form must not submit"
        # single fill understands the same controls
        assert call(sw, "fill", {"tabId": tab, "selector": "select[name=country]", "value": "be"})["set"] == "Belgium"
        assert call(sw, "fill", {"tabId": tab, "selector": "input[name=gift]", "value": "off"})["set"] is False
        assert page.evaluate("() => [f.country.value, f.gift.checked]") == ["be", False]
    finally:
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_uploads_files(ext_pages):
    """The real extension: bytes sent to the worker become a File in the
    page's <input type=file>; the change handler sees name, size, type and
    content; append keeps earlier files on a multiple input; a non-file
    input is refused."""
    import base64
    html = b"""<input type=file id=one accept=".pdf"><input type=file id=many multiple><input type=text id=txt>
      <script>window.seen = []; for (const id of ['one','many']) document.getElementById(id).addEventListener('change', async (e) => {
        for (const f of e.target.files) seen.push({ id, name: f.name, size: f.size, type: f.type, head: await f.slice(0, 8).text() }); });</script>"""
    srv = serve_html(html); port = srv.port
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p).then(r => ({ok:true, r}), e => ({ok:false, e:String(e && e.message || e)}))", [action, params])
    b64 = lambda b: base64.b64encode(b).decode()
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        r = call(sw, "upload", {"tabId": tab, "selector": "#one", "name": "inv.pdf", "mime": "application/pdf", "data": b64(b"%PDF-1.4 fake")})
        assert r["ok"] and r["r"]["uploaded"] == "inv.pdf" and r["r"]["bytes"] == 13 and r["r"]["accept"] == ".pdf", r
        r = call(sw, "upload", {"tabId": tab, "selector": "#many", "name": "a.png", "mime": "image/png", "data": b64(b"\x89PNG\r\n\x1a\n1234")})
        r = call(sw, "upload", {"tabId": tab, "selector": "#many", "name": "b.png", "mime": "image/png", "data": b64(b"\x89PNG\r\n\x1a\n5678"), "append": True})
        assert r["r"]["files"] == ["a.png", "b.png"] and r["r"]["multiple"] is True, r
        r = call(sw, "upload", {"tabId": tab, "selector": "#many", "name": "c.png", "mime": "image/png", "data": b64(b"x")})
        assert r["r"]["files"] == ["c.png"], "without append the choice is replaced"
        time.sleep(0.3)
        seen = page.evaluate("() => window.seen")
        assert seen[0] == {"id": "one", "name": "inv.pdf", "size": 13, "type": "application/pdf", "head": "%PDF-1.4"}, seen
        assert [s["name"] for s in seen if s["id"] == "many"] == ["a.png", "a.png", "b.png", "c.png"], seen
        assert page.evaluate("() => document.getElementById('one').files[0].name") == "inv.pdf"
        r = call(sw, "upload", {"tabId": tab, "selector": "#txt", "name": "x", "mime": "text/plain", "data": b64(b"x")})
        assert r["ok"] is False and "not a file input: input[type=text]" in r["e"], r
        r = call(sw, "click", {"tabId": tab, "selector": "#nothing-here"})
        assert r["ok"] is False and "element not found: #nothing-here" in r["e"], "a page-side miss is an error, not a null result"
    finally:
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_reads_console_and_network(ext_pages):
    """The real extension: the document_start hook records console output,
    uncaught errors and rejections, fetch/XHR with status, and resource loads;
    filters and clear work; the page's own console/fetch keep working."""
    html = b"""<img src="/pic.png"><script>
      console.log('hello', {a: 1}); console.warn('careful'); console.error('bad', new Error('boom'));
      setTimeout(() => { nosuch(); }, 10);
      Promise.reject(new Error('rejected!'));
      window.results = [];
      fetch('/api/ok').then(r => results.push(['fetch', r.status]));
      fetch('/api/missing', {method: 'POST'}).then(r => results.push(['fetch', r.status]));
      const x = new XMLHttpRequest(); x.open('PUT', '/api/xhr'); x.onloadend = () => results.push(['xhr', x.status]); x.send();
    </script>"""
    srv = serve_html(lambda path: (200, "text/html", html) if path == "/" else (200 if path in ("/api/ok", "/pic.png") else 404, "application/octet-stream", b"x" * 10)); port = srv.port
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p).then(r => ({ok:true, r}), e => ({ok:false, e:String(e && e.message || e)}))", [action, params])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.6)
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        c = call(sw, "console_read", {"tabId": tab})["r"]
        texts = [(e["level"], e["text"].split("\n")[0]) for e in c["entries"]]
        assert ("log", 'hello {"a":1}') in texts and ("warn", "careful") in texts, texts
        assert any(l == "error" and t.startswith("bad Error: boom") for l, t in texts), texts
        unc = [e for e in c["entries"] if e.get("uncaught")]
        assert any(e["text"] == "Uncaught ReferenceError: nosuch is not defined" and ":3:" in e.get("source", "") for e in unc), unc
        assert any(e["text"].startswith("Unhandled rejection: Error: rejected!") for e in unc), unc
        assert c["counts"]["error"] == 3 and c["counts"]["warn"] == 1, c["counts"]
        errs = call(sw, "console_read", {"tabId": tab, "level": "error"})["r"]
        assert errs["total"] == 3 and all(e["level"] == "error" for e in errs["entries"])
        n = call(sw, "network_read", {"tabId": tab})["r"]
        by = {(e["type"], e["method"], e["url"].split(port.__str__())[-1]): e for e in n["entries"]}
        assert by[("fetch", "GET", "/api/ok")]["status"] == 200 and by[("fetch", "GET", "/api/ok")]["ok"] is True
        assert by[("fetch", "POST", "/api/missing")]["status"] == 404 and by[("fetch", "POST", "/api/missing")]["ok"] is False
        assert by[("xhr", "PUT", "/api/xhr")]["status"] == 500
        assert by[("img", "GET", "/pic.png")]["status"] is None and by[("img", "GET", "/pic.png")]["ms"] >= 0
        assert n["failed"] == 2, n
        f = call(sw, "network_read", {"tabId": tab, "failed": True})["r"]
        assert sorted(e["status"] for e in f["entries"]) == [404, 500]
        f2 = call(sw, "network_read", {"tabId": tab, "filter": "/api/", "resources": False, "clear": True})["r"]
        assert f2["total"] == 3
        assert call(sw, "network_read", {"tabId": tab, "resources": False})["r"]["total"] == 0, "clear emptied the buffer"
        assert page.evaluate("() => window.results.length") == 3, "the page's own fetch/xhr still completed"
        c2 = call(sw, "console_read", {"tabId": tab, "clear": True})["r"]; assert c2["total"] >= 5
        assert call(sw, "console_read", {"tabId": tab})["r"]["total"] == 0
    finally:
        srv.shutdown()


def test_submit_card(page, server):
    open_ui(page, server)
    send(page, "submit-me")
    page.wait_for_selector(".card.submit", timeout=LONG)
    assert page.text_content(".card.submit h4") == "Submit this form on shop.example?"
    assert page.text_content(".card.submit pre") == 'POST /checkout?step=2 · button "Place order"\nname: Alex\ncard: •••'
    assert page.evaluate("() => [...document.querySelectorAll('.card.submit .row button')].map(b => b.textContent)") == ["Submit", "Stop"]
    assert page.text_content("#statustext") == "waiting for you — a form submit"
    page.click(".card.submit button[data-decision=deny]"); wait_reply(page, "submit: deny")
    send(page, "submit-me"); page.wait_for_selector(".card.submit:not(:has(button[disabled]))", timeout=LONG)
    cards = page.locator(".card.submit"); cards.nth(cards.count() - 1).locator("button[data-decision=allow]").click(); wait_reply(page, "submit: allow")


@pytest.mark.xdist_group("chromium")
def test_extension_probes_submits(ext_pages):
    """The real extension: the probe says what a click/Enter would submit
    (fields, masked password, button, method), says no for a plain button,
    a search box with nothing typed, or another key; and press Enter in a
    form field now really submits (a synthetic key alone never did)."""
    html = b"""<form id=login method=post action="/login"><input name=user value=alex><input name=pw type=password value=secret>
        <label><input type=checkbox name=remember checked> remember</label><button>Sign in</button></form>
      <form id=search action="/s"><input name=q></form>
      <form id=js method=post action="/js"><input name=a value=1><button type=button id=plain>Not a submit</button><button type=submit id=go>Go</button></form>
      <script>window.subs = []; for (const f of document.querySelectorAll('form')) f.addEventListener('submit', e => { e.preventDefault(); subs.push(f.id); });</script>"""
    srv = serve_html(html); port = srv.port
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p)", [action, params])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{port}/"); time.sleep(0.3)
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        r = call(sw, "submit_probe", {"tabId": tab, "selector": "#login button"})
        assert r["submit"] is True and r["via"] == "click" and r["form"]["method"] == "post" and r["form"]["action"].endswith("/login") and r["form"]["button"] == "Sign in", r
        assert r["form"]["fields"] == [{"name": "user", "value": "alex"}, {"name": "pw", "value": "•••"}, {"name": "remember", "value": "checked"}], r["form"]
        assert call(sw, "submit_probe", {"tabId": tab, "selector": "#plain"})["submit"] is False, "a type=button is not a submit"
        assert call(sw, "submit_probe", {"tabId": tab, "selector": "#go"})["submit"] is True
        page.focus("#search input")
        assert call(sw, "submit_probe", {"tabId": tab, "key": "Enter"})["submit"] is False, "GET with nothing typed: no card"
        page.fill("#search input", "jobs")
        r = call(sw, "submit_probe", {"tabId": tab, "key": "Enter"}); assert r["submit"] is True and r["via"] == "enter" and r["form"]["fields"] == [{"name": "q", "value": "jobs"}], r
        assert call(sw, "submit_probe", {"tabId": tab, "key": "Tab"})["submit"] is False
        r = call(sw, "press", {"tabId": tab, "key": "Enter"}); assert r.get("trusted") is True or r.get("submitted") is True, r   # a real key: the browser submits
        page.focus("#login input[name=user]")
        r = call(sw, "press", {"tabId": tab, "key": "Enter"}); assert r.get("trusted") is True or r.get("submitted") is True, r
        assert call(sw, "click", {"tabId": tab, "selector": "#go"})["clicked"] == "button"
        assert page.evaluate("() => window.subs") == ["search", "login", "js"]
    finally:
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_extension_trusted_input_and_csp_eval(ext_pages):
    """The real extension: type/press produce trusted events (an editor that
    ignores untrusted input gets the text), modifiers and Enter work, eval
    runs on a page whose CSP forbids eval (executeScript's eval cannot), with
    top-level await and exceptions reported."""
    html = b"""<div id=ed contenteditable=true></div><input id=plain><textarea id=ta></textarea>
      <form id=f action="/go"><input id=q name=q><button>go</button></form>
      <script>
        window.ev = [];
        // an editor that only reacts to trusted keyboard input, like Monaco
        const ed = document.getElementById('ed');
        ed.addEventListener('beforeinput', e => { if (!e.isTrusted) e.preventDefault(); });
        ed.addEventListener('keydown', e => ev.push(['keydown', e.key, e.isTrusted, e.ctrlKey, e.shiftKey]));
        document.getElementById('plain').addEventListener('input', e => ev.push(['input', e.isTrusted, e.target.value]));
        document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); ev.push(['submit', document.getElementById('q').value]); });
        // evaluated by the page itself at load: a call from Runtime.evaluate would be allowed eval by DevTools
        try { window.direct = eval('1+1'); } catch (e) { window.direct = 'page eval blocked: ' + e.name; }
      </script>"""
    # the CSP: inline scripts allowed for the fixture, no unsafe-eval — like TradingView
    srv = serve_html(lambda path: (200, "text/html", html, {"Content-Security-Policy": "script-src 'unsafe-inline'; object-src 'none'"}) if path == "/" else (200, "text/plain", b"x"))
    ctx = ext_pages
    call = lambda sw, action, params: sw.evaluate("([a, p]) => ctHandle(a, p).then(r => ({ok:true, r}), e => ({ok:false, e:String(e && e.message || e)}))", [action, params])
    try:
        sw = ctx.sw
        page = ctx.new_page(); page.goto(srv.base + "/"); time.sleep(0.3)
        tab = sw.evaluate("() => chrome.tabs.query({}).then(t => t.filter(x => x.url.startsWith('http'))[0].id)")
        assert page.evaluate("() => window.direct") == "page eval blocked: EvalError", "the fixture page must actually forbid eval"
        # 1. an editor that ignores untrusted input: fill does nothing, type works
        call(sw, "fill", {"tabId": tab, "selector": "#ed", "value": "via fill"})
        assert page.evaluate("() => document.getElementById('ed').textContent") in ("", "via fill"), "fill on a contenteditable sets textContent directly (allowed); the trusted check is on typing"
        page.evaluate("() => { document.getElementById('ed').textContent = ''; window.ev = []; }")
        r = call(sw, "type", {"tabId": tab, "selector": "#ed", "text": "let x = 1\nplot(x)"})
        assert r["ok"] and r["r"]["trusted"] is True and r["r"]["typed"] == 17, r
        assert page.evaluate("() => document.getElementById('ed').innerText.replace(/\\n+$/, '')") == "let x = 1\nplot(x)"
        assert ["keydown", "Enter", True, False, False] in page.evaluate("() => window.ev")
        # 2. modifiers and keys are trusted with the right flags
        page.evaluate("() => { window.ev = []; document.getElementById('ed').focus(); }")
        r = call(sw, "press", {"tabId": tab, "key": "Ctrl+A"}); assert r["ok"] and r["r"]["trusted"] is True, r
        call(sw, "press", {"tabId": tab, "key": "Shift+Enter"})
        assert page.evaluate("() => window.ev") == [["keydown", "a", True, True, False], ["keydown", "Enter", True, False, True]]
        r = call(sw, "press", {"tabId": tab, "key": "Hyper+Q"}); assert r["ok"] is False and "unknown modifier" in r["e"]
        # 3. a plain input sees trusted input events with the value; Enter submits the form
        r = call(sw, "type", {"tabId": tab, "selector": "#plain", "text": "hello"}); assert r["r"]["value"] == "hello"
        assert ["input", True, "hello"] in page.evaluate("() => window.ev")
        call(sw, "type", {"tabId": tab, "selector": "#q", "text": "jobs"}); call(sw, "press", {"tabId": tab, "key": "Enter"}); time.sleep(0.2)
        assert ["submit", "jobs"] in page.evaluate("() => window.ev"), "a real Enter submits the form"
        # 4. eval through the debugger on a no-unsafe-eval page
        assert call(sw, "eval", {"tabId": tab, "code": "1 + 1"}) == {"ok": True, "r": {"tabId": tab, "result": 2}}
        assert call(sw, "eval", {"tabId": tab, "code": "const r = await fetch('/x'); await r.text()"})["r"]["result"] == "x"
        assert call(sw, "eval", {"tabId": tab, "code": "document.getElementById('plain').value"})["r"]["result"] == "hello"
        r = call(sw, "eval", {"tabId": tab, "code": "nosuch()"}); assert r["ok"] is False and "nosuch is not defined" in r["e"], r
        r = call(sw, "eval", {"tabId": tab, "code": "Promise.reject(new Error('nope'))"}); assert r["ok"] is False and "nope" in r["e"], r
        assert call(sw, "eval", {"tabId": tab, "code": "undefined"})["r"]["result"] is None
        assert call(sw, "eval", {"tabId": tab, "code": "({a: [1, {b: 2}]})"})["r"]["result"] == {"a": [1, {"b": 2}]}
        # the executeScript path is what the CSP blocks (measured here, so the fallback's limit is known)
        r = call(sw, "eval", {"tabId": tab, "code": "1 + 1", "synthetic": True}); assert r["ok"] is False and "unsafe-eval" in r["e"], r
    finally:
        srv.shutdown()


@pytest.mark.xdist_group("chromium")
def test_server_browser_live_view(page, server):
    """The server browser from the manage page: Start launches a headless
    Chromium with the extension (it appears as 'server-browser' on /setup and
    in the chat's browser menu); the live view shows frames, the URL bar
    navigates, clicks and keys reach the page; Stop ends it."""
    import json, urllib.request
    page.goto(server.base + "/manage.html"); page.click("nav button[data-tab=server]")
    page.wait_for_selector("#server button", timeout=SHORT)
    assert page.text_content("#server .pill") == "stopped"
    page.click("#server button:text-is('Start')")
    page.wait_for_selector("#server .pill.ok", timeout=30000)
    connected = lambda: json.load(urllib.request.urlopen(server.base + "/setup"))["extension"]["connected"]
    t0 = time.time()
    while time.time() - t0 < 15 and "server-browser" not in connected(): time.sleep(0.2)
    assert "server-browser" in connected(), connected()
    # the chat header offers it
    chat = page.context.new_page(); chat.goto(server.base + "/m.html")
    chat.wait_for_function("() => !document.getElementById('browser').hidden", timeout=LONG)
    assert chat.evaluate("() => [...document.getElementById('browser').options].map(o => o.textContent)") == ["auto", "server browser"]
    chat.close()
    # the live view
    view = page.context.new_page(); view.goto(server.base + "/browser.html")
    view.wait_for_function("() => document.getElementById('screen').naturalWidth > 100", timeout=LONG)
    assert view.text_content("#st") == "live"
    view.fill("#url", server.base + "/m.html"); view.press("#url", "Enter")
    view.wait_for_function("(b) => document.getElementById('url').value.startsWith(b) && document.getElementById('url').value.endsWith('/m.html')", arg=server.base, timeout=LONG)
    time.sleep(1.0)   # a frame of the loaded page
    # frame geometry: the viewport is what headless Chromium gives a 1280×800 window (measured 1280×657: window minus its bars)
    box = view.evaluate("() => { const img = document.getElementById('screen'); return { nw: img.naturalWidth, nh: img.naturalHeight }; }")
    assert box["nw"] == 1280 and 500 <= box["nh"] <= 800, box
    # the pointer and keys reach the tab: measured with exact coordinates in test/server-browser.test.ts; here only that the path is live
    view.mouse.click(300, 300); view.keyboard.type("x"); time.sleep(0.3)
    st = json.load(urllib.request.urlopen(server.base + "/browser/server"))
    assert st["running"] and st["viewers"] == 1 and any(t["url"].endswith("/m.html") for t in st["tabs"]), st
    view.close()
    page.click("#server button:text-is('Stop')")
    page.wait_for_selector("#server .pill.warn", timeout=LONG)
    t0 = time.time()
    while time.time() - t0 < 10 and "server-browser" in connected(): time.sleep(0.2)
    assert "server-browser" not in connected()


def test_schedules_tab_create_run_now(page, server):
    """The manage page's Schedules tab: the form previews the next times in
    words, Create lists the schedule, Run now runs it (the fixture SDK
    answers), and the row shows the outcome, cost and the reply's first
    line with a link to the run's chat; the chat's transcript can be opened."""
    page.goto(server.base + "/manage.html"); page.click("nav button[data-tab=schedules]")
    page.wait_for_selector("#schedules button:text-is('New schedule')", timeout=SHORT)
    page.click("#schedules button:text-is('New schedule')")
    page.fill("#sf-title", "Morning check"); page.fill("#sf-text", "hello scheduler")
    page.fill("#sf-when", "weekdays at 07:30"); page.fill("#sf-tz", "Europe/Brussels")
    page.wait_for_function("() => /weekdays at 07:30 — next:/.test(document.getElementById('sf-preview').textContent)", timeout=SHORT)
    page.fill("#sf-when", "nonsense")
    page.wait_for_function("() => document.getElementById('sf-preview').classList.contains('bad')", timeout=SHORT)
    page.fill("#sf-when", "every day at 08:00")
    page.select_option("#sf-browser", "auto")
    page.click("form.sched-form button[type=submit]")
    page.wait_for_selector(".sched", timeout=SHORT)
    assert page.text_content(".sched .top b") == "Morning check"
    when = page.text_content(".sched .when")
    assert "every day at 08:00" in when and "Europe/Brussels" in when, when
    page.click(".sched button:text-is('Run now')")
    page.wait_for_function("() => document.querySelector('.sched .last .o.done')", timeout=LONG)
    last = page.text_content(".sched .last")
    assert "You said: hello scheduler" in last and "$0.00" in last, last
    # the row's "open chat" link lands the web UI on the run's chat (a ?chat= link)
    href = page.get_attribute(".sched .last a", "href")
    chat = page.context.new_page(); chat.goto(server.base + href); chat.wait_for_selector("#log .msg.user", timeout=LONG)
    assert "hello scheduler" in chat.text_content("#log .msg.user")
    chat.close()
    page.click(".sched button:text-is('Pause')"); page.wait_for_selector(".sched.paused", timeout=SHORT)
    page.click(".sched button:text-is('Resume')"); page.wait_for_selector(".sched:not(.paused)", timeout=SHORT)


def test_question_card_multi_select(page, server):
    """A card with two questions: choosing in one must not clear the other
    (the deselect used to search the whole card), a multiSelect question
    takes several answers, and Answer waits until every question has one."""
    open_ui(page, server)
    send(page, "multi-me")
    page.wait_for_selector(".q[data-tool=question]", timeout=LONG)
    groups = page.locator(".q .qgroup")
    assert groups.count() == 2
    assert "choose one" in page.text_content(".q .qgroup:nth-child(1) .qt")
    assert "choose any that apply" in page.text_content(".q .qgroup.multi .qt")
    answer = page.locator(".q button.allow:has-text('Answer')")
    assert answer.is_disabled(), "nothing answered yet"
    assert "0 of 2 answered" in page.text_content(".q .qleft")
    page.click(".q .qgroup:nth-child(1) .opt:has-text('B — Integration Engineer')")
    assert answer.is_disabled(), "one question still open"
    # several answers in the multi-select question, and the first answer survives
    page.click(".q .qgroup.multi .opt:has-text('LinkedIn')")
    page.click(".q .qgroup.multi .opt:has-text('VDAB')")
    assert page.locator(".q .qgroup.multi .opt.sel").count() == 2
    assert page.locator(".q .qgroup:nth-child(1) .opt.sel").count() == 1, "the first question kept its answer"
    assert "2 of 2 answered" in page.text_content(".q .qleft")
    # a single-select question still swaps rather than adds
    page.click(".q .qgroup:nth-child(1) .opt:has-text('A — Agent Development')")
    assert page.locator(".q .qgroup:nth-child(1) .opt.sel").count() == 1
    answer.click()
    wait_reply(page, '"Which sites should it cover?":"LinkedIn, VDAB"')
    assert '"Which title should the profile use?":"A — Agent Development"' in last_reply(page)


def test_right_pane_collapses_to_a_rail_and_is_remembered(page, server):
    """Collapse the right pane and the terminal gives its width to the
    conversation. It is narrowed rather than removed, so the shell keeps its
    scrollback across a collapse; the choice itself survives a reload."""
    open_ui(page, server)
    page.wait_for_selector("#term", timeout=SHORT)
    page.click("#term"); page.keyboard.type("echo COLLAPSE-$((6*7))\n")
    wait(page, "() => document.querySelector('#term').innerText.includes('COLLAPSE-42')", what="the shell ran it")
    wide = page.evaluate("() => document.getElementById('left').clientWidth")

    page.click("#rhide")
    wait(page, "() => document.getElementById('right').clientWidth < 40", what="the pane is a rail")
    assert page.evaluate("() => document.getElementById('left').clientWidth") > wide
    assert page.is_visible("#rshow"), "the rail offers a way back"
    assert page.text_content("#rlabel") == "terminal"

    page.click("#rshow")
    wait(page, "() => document.getElementById('right').clientWidth > 100", what="back to a pane")
    # narrowed, not removed: the same shell, with what it printed before
    assert "COLLAPSE-42" in page.inner_text("#term")
    wait(page, "() => { const t = document.querySelector('#term .xterm-screen'); return t && t.clientWidth > 100; }",
         what="the terminal refitted to the reopened pane")

    # the choice is a preference, so it is still collapsed on the next visit
    page.click("#rhide")
    wait(page, "() => document.getElementById('right').clientWidth < 40", what="collapsed again")
    page.reload()
    wait(page, "() => document.querySelector('#dot').classList.contains('on')", 30, "reconnect")
    wait(page, "() => document.getElementById('right').clientWidth < 40", what="still collapsed after a reload")
    page.click("#rshow")
    wait(page, "() => document.getElementById('right').clientWidth > 100", what="and can be opened again")
    assert page.errors == []


def test_header_shows_the_attached_session_directory(page, server):
    """The header says where the session is, not only what it is called — and
    it follows the session when it cds, because the directory is read back
    from tmux rather than remembered from when you attached."""
    import subprocess, uuid, os
    if subprocess.run(["tmux", "-V"], capture_output=True).returncode != 0:
        import pytest; pytest.skip("no tmux on this machine")
    name = "cttest-d-" + uuid.uuid4().hex[:8]
    try:
        open_ui(page, server)
        page.wait_for_selector('.pane-hd .tab[data-view="sessions"]:not([hidden])', timeout=SHORT)
        page.click('.pane-hd .tab[data-view="sessions"]')
        page.fill("#snew", name); page.click("#screate")
        page.wait_for_function("() => !document.getElementById('term').hidden", timeout=LONG)
        wait(page, "() => document.getElementById('rightnote').textContent.includes(' · ')",
             what="the header carries a directory beside the name")

        # cd inside the session, then come back to the terminal: the header follows
        page.click("#term"); page.keyboard.type("cd /tmp\n")
        page.click('.pane-hd .tab[data-view="sessions"]')
        page.click('.pane-hd .tab[data-view="shell"]')
        wait(page, "() => document.getElementById('rightnote').textContent.endsWith(' · /tmp')",
             what="the header followed the session to /tmp")
        assert page.errors == []
    finally:
        subprocess.run(["tmux", "kill-session", "-t", "=" + name], capture_output=True)


def test_renaming_the_attached_session_keeps_the_attachment(page, server):
    """Rename the session the pane is attached to, then reload. The attachment
    is remembered by name, so if the rename does not update what is
    remembered, the reload silently opens a plain shell instead."""
    import subprocess, uuid
    if subprocess.run(["tmux", "-V"], capture_output=True).returncode != 0:
        import pytest; pytest.skip("no tmux on this machine")
    tag = uuid.uuid4().hex[:8]
    name, renamed = "cttest-" + tag, "cttest-r-" + tag
    try:
        open_ui(page, server)
        page.wait_for_selector('.pane-hd .tab[data-view="sessions"]:not([hidden])', timeout=SHORT)
        page.click('.pane-hd .tab[data-view="sessions"]')
        page.fill("#snew", name); page.click("#screate")
        page.wait_for_function("() => !document.getElementById('term').hidden", timeout=LONG)
        page.click("#term"); page.keyboard.type("echo RENAME-$((6*7))\n")
        wait(page, "() => document.querySelector('#term').innerText.includes('RENAME-42')", what="the session ran it")

        page.click('.pane-hd .tab[data-view="sessions"]')
        wait(page, f"() => [...document.querySelectorAll('#slist .s .nm')].some(n => n.textContent === {name!r})", what="listed")
        page.once("dialog", lambda d: d.accept(renamed))
        page.click(f"#slist .s:has(.nm:text-is('{name}')) button:text-is('rename')")
        wait(page, f"() => [...document.querySelectorAll('#slist .s .nm')].some(n => n.textContent === {renamed!r})", what="renamed in the list")
        assert page.evaluate("() => sessionStorage.getItem('ct.session')") == renamed

        page.reload()
        wait(page, "() => document.querySelector('#dot').classList.contains('on')", 30, "reconnect")
        wait(page, f"() => document.getElementById('rightnote').textContent.startsWith('session: {renamed}')",
             what="came back to the renamed session, not a plain shell")
        wait(page, "() => document.querySelector('#term').innerText.includes('RENAME-42')",
             what="and it is the same session, with its scrollback")
        assert page.errors == []
    finally:
        for n in (renamed, name):
            subprocess.run(["tmux", "kill-session", "-t", "=" + n], capture_output=True)


def test_sessions_tab_attaches_and_survives_a_restart(page, server):
    """The chooser: tmux sessions on the machine, attach to one, and — the
    whole point — what is running in it is still there after the server
    restarts, which a plain shell pane does not survive."""
    import subprocess, uuid
    if subprocess.run(["tmux", "-V"], capture_output=True).returncode != 0:
        import pytest; pytest.skip("no tmux on this machine")
    name = "cttest-" + uuid.uuid4().hex[:8]
    try:
        open_ui(page, server)
        page.wait_for_selector('.pane-hd .tab[data-view="sessions"]:not([hidden])', timeout=SHORT)
        page.click('.pane-hd .tab[data-view="sessions"]')
        page.wait_for_selector("#slist", timeout=SHORT)
        # create → attaches, and the terminal view comes forward
        page.fill("#snew", name); page.click("#screate")
        page.wait_for_function("() => !document.getElementById('term').hidden", timeout=LONG)
        wait(page, f"() => document.getElementById('rightnote').textContent.startsWith('session: {name}')", what="header names the session")
        # something long-running, then leave the session entirely
        page.click("#term"); page.keyboard.type("echo MARKER-$((6*7))\n")
        wait(page, "() => document.querySelector('#term').innerText.includes('MARKER-42')", what="the session ran it")
        # the server restarting is what kills a plain shell; this must not kill this
        server.restart()
        wait(page, "() => document.querySelector('#dot').classList.contains('on')", 30, "reconnect")
        wait(page, "() => document.querySelector('#term').innerText.includes('MARKER-42')", 30,
             "the session and its scrollback came back after the restart")
        assert page.text_content("#rightnote").startswith(f"session: {name}")
        # it is listed as attached, and killing it returns the pane to a plain shell
        page.click('.pane-hd .tab[data-view="sessions"]')
        wait(page, f"() => [...document.querySelectorAll('#slist .s .nm')].some(n => n.textContent === {name!r})", what="listed")
        page.once("dialog", lambda d: d.accept())
        page.click(f"#slist .s:has(.nm:text-is('{name}')) button:text-is('kill')")
        wait(page, f"() => ![...document.querySelectorAll('#slist .s .nm')].some(n => n.textContent === {name!r})", what="gone from the list")
        wait(page, "() => document.getElementById('rightnote').textContent === 'no approval gate'", what="back to a plain shell")
        assert page.errors == []
    finally:
        subprocess.run(["tmux", "kill-session", "-t", "=" + name], capture_output=True)


def test_refresh_redraws_the_terminal_without_losing_the_session(page, server):
    """The header's ↻. Attached to a tmux session it redials, which is what
    makes tmux repaint the whole screen — the session and its scrollback have
    to come back, or the button trades a skewed pane for a lost one."""
    import subprocess, uuid
    if subprocess.run(["tmux", "-V"], capture_output=True).returncode != 0:
        pytest.skip("no tmux on this machine")
    name = "cttest-r-" + uuid.uuid4().hex[:8]
    try:
        open_ui(page, server)
        page.wait_for_selector('.pane-hd .tab[data-view="sessions"]:not([hidden])', timeout=SHORT)
        page.click('.pane-hd .tab[data-view="sessions"]')
        page.fill("#snew", name); page.click("#screate")
        page.wait_for_function("() => !document.getElementById('term').hidden", timeout=LONG)
        page.click("#term"); page.keyboard.type("echo REDRAW-$((6*7))\n")
        wait(page, "() => document.querySelector('#term').innerText.includes('REDRAW-42')", what="the session ran it")

        page.click("#rrefresh")
        wait(page, "() => ptyWs && ptyWs.readyState === 1", 20, "the pane redialled")
        wait(page, "() => document.querySelector('#term').innerText.includes('REDRAW-42')", 20,
             "tmux repainted the same session, scrollback and all")
        assert page.text_content("#rightnote").startswith(f"session: {name}")
        # One client, not two: a second one would size the session to the
        # smaller window and skew the very thing the button is here to fix.
        # The old client goes away when the server notices its socket closed,
        # which lands a moment after the new one is up — so poll rather than
        # read once and catch the overlap.
        count = lambda: len(subprocess.run(["tmux", "list-clients", "-t", "=" + name],
                                           capture_output=True, text=True).stdout.strip().splitlines())
        deadline = time.time() + 10
        while count() != 1 and time.time() < deadline:
            time.sleep(0.2)
        assert count() == 1
        assert page.errors == []
    finally:
        subprocess.run(["tmux", "kill-session", "-t", "=" + name], capture_output=True)


def test_refresh_button_is_only_offered_for_the_terminal(page, server):
    """It redraws the terminal, so it has no meaning over the file list."""
    open_ui(page, server)
    assert page.is_visible("#rrefresh")
    page.click('.pane-hd .tab[data-view="files"]')
    wait(page, "() => document.getElementById('rrefresh').hidden", what="hidden over the files view")
    page.click('.pane-hd .tab[data-view="shell"]')
    wait(page, "() => !document.getElementById('rrefresh').hidden", what="back for the terminal")
    assert page.errors == []
