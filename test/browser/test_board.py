"""The board page (public/board.html + board.js) in a real browser.

The server side is covered by test/board.test.ts and test/tmux-board.test.ts;
this is the client: what it draws from a /board payload, the filter, adding a
task, assigning by drop, answering a question. /board and the write routes are
intercepted, so the page sees the same sessions on any machine (the fixture
server would otherwise list this box's own tmux sessions) and every request it
makes can be read back.
"""
import json, time
from conftest import SHORT, LONG, wait

NOW = int(time.time() * 1000)
ROOT_BK = "/srv/projects/bestekortingen"
ROOT_CT = "/srv/projects/codeTerminal"
ROOT_GEN = "/srv/projects/general"


def tmux(name, state="idle", **kw):
    return {"kind": "tmux", "name": name, "path": ROOT_BK, "state": state, "since": NOW - 60_000, "attached": 1, **kw}


def chat(cid, title, state="idle", **kw):
    return {"kind": "chat", "id": cid, "title": title, "state": state, "since": NOW - 60_000, "steps": None, **kw}


def item(iid, text, status="queued", **kw):
    return {"id": iid, "text": text, "for": "claude", "status": status, "addedAt": NOW - 3_600_000, "addedBy": "owner", **kw}


class Board:
    """A mutable payload, served at /board; the write routes record what the page sent."""
    def __init__(self):
        self.sent = []
        self.keeper = {"paused": False, "calls": 3, "date": "2026-10-10"}
        self.history = []
        self.projects = [
            {"id": "bestekortingen", "name": "bestekortingen", "root": ROOT_BK,
             "sessions": [tmux("todo"), tmux("2e", "working", summary="Making the shop choice a popup on first visit",
                                              task={"title": "Make shop choice a popup", "status": "working"}, activity="Frosting… 2m 3s")],
             "queue": [item("a1f3c9d2-0000-0000-0000-000000000000", "Koopwijzer badge on airfryer tiles"),
                       item("d0d0d0d0-0000-0000-0000-000000000000", "Fix the deploy check", "done", claimedBy="tmux:todo", result="Deploy check pushed", doneAt=NOW - 600_000)],
             "asks": [], "auto": False, "counts": {"queued": 1, "claimed": 0, "forYou": 0}},
            {"id": "codeTerminal", "name": "codeTerminal", "root": ROOT_CT,
             "sessions": [tmux("modchanger", "working", path=ROOT_CT, task={"title": "Board: sessions", "status": "working"})],
             "queue": [], "asks": [], "counts": {"queued": 0, "claimed": 0, "forYou": 0}},
            {"id": "general", "name": "General", "root": ROOT_GEN,
             "sessions": [chat("c1", "Wend puzzle")], "queue": [], "asks": [], "counts": {"queued": 0, "claimed": 0, "forYou": 0}},
        ]

    def payload(self):
        return {"at": int(time.time() * 1000), "forYou": [], "projects": self.projects, "keeper": self.keeper,
                "allProjects": [{"id": p["id"], "name": p["name"]} for p in self.projects if p["id"] != "general"]}

    def project(self, name):
        return next(p for p in self.projects if p["name"] == name)


def open_board(page, server, board):
    def on_board(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(board.payload()))

    def on_todos(route):
        req = route.request
        body = json.loads(req.post_data or "{}")
        board.sent.append((req.method, req.url.replace(server.base, ""), body))
        if req.method == "POST":
            p = next((p for p in board.projects if p["id"] == body.get("project") or p["root"] == body.get("root")), None)
            new = item("f%07d-0000-0000-0000-000000000000" % len(board.sent), body["text"], addedBy="owner")
            if p: p["queue"].append(new)
            route.fulfill(status=200, content_type="application/json", body=json.dumps(new))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"status": "done", "replied": False}))

    def record(route):
        req = route.request
        board.sent.append((req.method, req.url.replace(server.base, ""), json.loads(req.post_data or "{}")))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "item": {"status": "claimed"}}))

    page.route("**/board", on_board)
    page.route("**/todos", on_todos)
    page.route("**/todos/*", on_todos)
    page.route("**/todos/*/send", record)
    page.route("**/board/decide", record)
    page.route("**/board/keeper", record)
    page.route("**/board/auto", record)
    page.route("**/board/misread", record)

    def on_attach(route):
        board.sent.append(("POST", "/todos/attach", {"type": route.request.headers.get("content-type")}))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"path": "/w/.todo-attachments/task-1-abc123.png", "bytes": 8}))

    def on_history(route):
        board.sent.append(("GET", route.request.url.replace(server.base, ""), {}))
        q = (route.request.url.split("q=")[1] if "q=" in route.request.url else "").lower()
        items = [i for i in board.history if q in (i["text"] + " " + i.get("result", "")).lower()]
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"root": "x", "items": items}))

    page.route("**/todos/attach", on_attach)
    page.route("**/todos/history**", on_history)
    page.route("**/todos/attachment**", lambda r: r.fulfill(status=200, content_type="image/png", body=bytes.fromhex("89504e470d0a1a0a")))
    board.page = page
    page.goto(server.base + "/board.html")
    page.wait_for_selector(".board .col.queue", timeout=SHORT)


texts = lambda page, sel: page.eval_on_selector_all(sel, "els => els.map(e => e.textContent.trim())")


def sbox(page, name):
    return page.locator(".col.progress .sbox", has=page.locator(".sboxhd .name", has_text=name))


def test_draws_the_queue_the_sessions_as_containers_and_a_done_board_per_session(page, server):
    board = Board(); open_board(page, server, board)
    # Three columns on top.
    assert texts(page, ".cols > .col > .hd span:first-child") == ["Queue", "In progress", "Needs you"]
    assert any("Koopwijzer badge" in t for t in texts(page, ".col.queue .card.q .text"))
    # Every session is a container in In progress: a task card when busy, an empty slot when idle.
    names = texts(page, ".col.progress .sboxhd .name")
    assert set(names) == {"todo", "2e", "modchanger", "Wend puzzle"}
    assert "Make shop choice a popup" in sbox(page, "2e").inner_text()
    assert "Frosting… 2m 3s" in sbox(page, "2e").inner_text()
    assert sbox(page, "todo").locator(".slot").count() == 1 and "Idle" in sbox(page, "todo").locator(".slot").inner_text()
    assert sbox(page, "2e").locator(".slot").count() == 0
    # A second board below: Done, one column per session; the finished item sits under the session that did it.
    assert set(texts(page, ".doneboard .dcol .hd.sess .name")) == {"todo", "2e", "modchanger", "Wend puzzle"}
    todo_done = page.locator(".doneboard .dcol", has=page.locator(".hd.sess .name", has_text="todo"))
    assert "Fix the deploy check" in todo_done.inner_text() and "Deploy check pushed" in todo_done.inner_text()
    assert "Fix the deploy check" not in page.locator(".doneboard .dcol", has=page.locator(".hd.sess .name", has_text="2e")).inner_text()
    assert page.errors == []


def test_boxes_keep_their_order_when_a_session_changes_state_and_lead_with_the_project(page, server):
    board = Board(); open_board(page, server, board)
    before = texts(page, ".col.progress .sboxhd")
    order = texts(page, ".col.progress .sboxhd .name")
    assert order == ["2e", "todo", "modchanger", "Wend puzzle"], order   # project (bestekortingen, codeTerminal, General), then name
    assert [x.split("\n")[0] for x in texts(page, ".col.progress .sboxhd .proj")] == ["bestekortingen", "bestekortingen", "codeTerminal", "General"]
    # The idle one goes busy, the busy one idle: same order after the next poll.
    board.project("bestekortingen")["sessions"][0]["state"] = "working"
    board.project("bestekortingen")["sessions"][1]["state"] = "working"
    board.project("codeTerminal")["sessions"][0]["state"] = "idle"
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    wait(page, "() => document.querySelectorAll('.col.progress .sbox.idle').length >= 2", what="states changed")
    assert texts(page, ".col.progress .sboxhd .name") == order


def test_filter_selects_several_sessions_and_projects_and_remembers(page, server):
    board = Board(); open_board(page, server, board)
    pill = lambda name: page.locator("#sessions .pill", has=page.locator(".name", has_text=name)).first
    pill("todo").click(); pill("2e").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 2", what="two sessions shown")
    assert set(texts(page, ".col.progress .sboxhd .name")) == {"todo", "2e"}
    assert set(texts(page, ".doneboard .dcol .hd.sess .name")) == {"todo", "2e"}
    # Add a whole project by its tag on a card.
    page.locator(".col.progress .sbox", has=page.locator(".sboxhd .name", has_text="2e")).locator("button.tag").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 2", what="same two (project already shown)")
    page.locator("#sessions .pill", has_text="✕ clear filter").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 4", what="all four back")
    # Remembered across a reload.
    pill("modchanger").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 1", what="one session")
    page.reload(); page.wait_for_selector(".col.progress .sbox", timeout=SHORT)
    assert texts(page, ".col.progress .sboxhd .name") == ["modchanger"]


def test_tmux_only_hides_every_chat(page, server):
    board = Board(); open_board(page, server, board)
    page.locator("#sessions .pill", has_text="tmux only").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 3", what="three tmux sessions")
    assert "Wend puzzle" not in texts(page, ".col.progress .sboxhd .name")
    assert "Wend puzzle" not in texts(page, ".doneboard .dcol .hd.sess .name")


def test_a_task_added_under_tmux_only_is_visible_and_a_hidden_one_is_counted(page, server):
    """The bug: 'added' toast, nothing on the board. The queue card for a project whose tmux
    session is shown must appear under 'tmux only'; one hidden by the filter must be counted."""
    board = Board(); open_board(page, server, board)
    page.locator("#sessions .pill", has_text="tmux only").click()
    wait(page, "() => document.querySelectorAll('.col.progress .sbox').length === 3", what="tmux only on")
    page.select_option("#gproject", "bestekortingen")
    page.fill("#gtext", "Make the shop choice a popup"); page.click("#gadd")
    wait(page, "() => [...document.querySelectorAll('.col.queue .card.q .text')].some(e => e.textContent.includes('shop choice a popup'))", what="the added task in the queue")
    assert board.sent[-1][0] == "POST" and board.sent[-1][2]["project"] == "bestekortingen"
    # General has only a chat: under 'tmux only' its task is hidden, and the column says so instead of 'nothing queued'.
    page.select_option("#gproject", "codeTerminal")  # codeTerminal has a tmux session shown: visible
    board.project("General")["queue"].append(item("b0b0b0b0-0000-0000-0000-000000000000", "A chat-only project task"))
    page.fill("#gtext", "ping"); page.click("#gadd")
    wait(page, "() => document.querySelector('.col.queue').textContent.includes('1 queued task hidden by the filter')", what="the hidden count")
    assert "Nothing queued" not in page.locator(".col.queue").inner_text()
    page.locator(".col.queue a", has_text="clear").click()
    wait(page, "() => [...document.querySelectorAll('.col.queue .card.q .text')].some(e => e.textContent.includes('chat-only'))", what="the task after clearing")


def test_assign_by_drop_and_by_button_go_to_the_right_session(page, server):
    board = Board(); open_board(page, server, board)
    card = page.locator(".col.queue .card.q", has_text="Koopwijzer badge")
    slot = sbox(page, "todo").locator(".slot")
    card.drag_to(slot)
    wait(page, "() => true", what="drop settled")
    deadline = time.time() + 5
    while time.time() < deadline and not any(s[1].endswith("/send") for s in board.sent): time.sleep(0.1)
    sends = [s for s in board.sent if s[1].endswith("/send")]
    assert sends, "the drop sent nothing"
    method, url, body = sends[-1]
    assert url == "/todos/a1f3c9d2-0000-0000-0000-000000000000/send" and body == {"root": ROOT_BK, "tmux": "todo"}
    # The button does the same for the top item; a chat is addressed by chatId.
    board.sent.clear()
    board.project("General")["queue"].append(item("c1c1c1c1-0000-0000-0000-000000000000", "Chat task"))
    page.reload(); page.wait_for_selector(".col.progress .sbox", timeout=SHORT)
    sbox(page, "Wend puzzle").locator("button", has_text="Assign next").click()
    deadline = time.time() + 5
    while time.time() < deadline and not any(s[1].endswith("/send") for s in board.sent): time.sleep(0.1)
    assert [s[2] for s in board.sent if s[1].endswith("/send")] == [{"root": ROOT_GEN, "chatId": "c1"}]
    # A busy session offers no slot to drop on.
    assert sbox(page, "2e").locator("button", has_text="Assign next").count() == 0


def test_needs_you_names_the_asking_session_and_reply_sends_the_answer(page, server):
    board = Board()
    board.project("bestekortingen")["asks"] = [
        {"id": "e1e1e1e1-0000-0000-0000-000000000000", "text": "Should I continue the header fix?", "for": "owner", "status": "queued", "addedAt": NOW - 240_000, "addedBy": "tmux:todo"},
        {"id": "e2e2e2e2-0000-0000-0000-000000000000", "text": "Which colour for the badge?", "for": "owner", "status": "queued", "addedAt": NOW - 120_000, "addedBy": "tmux:2e"}]
    open_board(page, server, board)
    asks = page.locator(".col.needs .card.needs")
    assert asks.count() == 2
    askers = texts(page, ".col.needs .card.needs .top .who.asker")
    assert any(a.startswith("2e") for a in askers) and any(a.startswith("todo") for a in askers), askers
    card = asks.filter(has_text="Which colour")
    assert "2e" in card.locator(".top .who.asker").inner_text()
    # An empty answer is refused on the page; a real one is sent to that item.
    card.locator("button", has_text="Reply").click()
    assert not [s for s in board.sent if s[2].get("action") == "answer"]
    card.locator("input").fill("green"); card.locator("button", has_text="Reply").click()
    deadline = time.time() + 5
    while time.time() < deadline and not [s for s in board.sent if s[2].get("action") == "answer"]: time.sleep(0.1)
    answers = [s for s in board.sent if s[2].get("action") == "answer"]
    assert answers and answers[-1][1] == "/todos/e2e2e2e2-0000-0000-0000-000000000000" and answers[-1][2]["result"] == "green" and answers[-1][2]["root"] == ROOT_BK


def test_a_chat_stopped_on_a_card_shows_the_card_with_allow_and_deny(page, server):
    board = Board()
    board.project("General")["sessions"] = [chat("c9", "Deploy chat", "waiting", pending=[{"id": "p1", "kind": "approval", "tool": "Bash", "summary": "Bash: npm test"},
                                                                                       {"id": "p2", "kind": "question", "tool": "AskUserQuestion", "summary": "Which colour?"}])]
    open_board(page, server, board)
    card = page.locator(".col.needs .card.needs").first
    assert "Bash: npm test" in card.inner_text() and "Deploy chat" in card.locator(".top .who.asker").inner_text()
    assert card.locator("button", has_text="Allow").count() == 1 and card.locator("button", has_text="Deny").count() == 1
    assert "Open the chat to answer" in card.inner_text(), "a question needs the chat, not a yes/no"
    card.locator("button", has_text="Deny").click()
    deadline = time.time() + 5
    while time.time() < deadline and not [s for s in board.sent if s[1] == "/board/decide"]: time.sleep(0.1)
    assert [s[2] for s in board.sent if s[1] == "/board/decide"] == [{"chatId": "c9", "id": "p1", "decision": "deny"}]


def test_theme_button_cycles_and_is_shared_with_the_app(page, server):
    board = Board(); open_board(page, server, board)
    root = lambda: page.evaluate("() => document.documentElement.getAttribute('data-theme')")
    btn = page.locator("#themebtn")
    seen = []
    for _ in range(3):
        btn.click(); seen.append((root(), page.evaluate("() => localStorage.getItem('ct.theme')")))
    assert seen == [("dark", "dark"), ("light", "light"), (None, "auto")]


def wait_sent(board, pred, what, timeout=5):
    """Poll what the page sent. Waits through Playwright (page.wait_for_timeout), not time.sleep:
    in the sync API a route handler only runs while a Playwright call is in flight."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        hit = [x for x in board.sent if pred(x)]
        if hit: return hit
        board.page.wait_for_timeout(50)
    raise AssertionError(f"timed out waiting for {what}; sent: {board.sent}")


def test_a_blocked_card_says_what_it_waits_for_and_assign_next_skips_it(page, server):
    board = Board()
    q = board.project("bestekortingen")["queue"]
    q.insert(0, item("b1b1b1b1-0000-0000-0000-000000000000", "Announce the redesign", waitingOn=[{"id": "a1f3c9d2-0000-0000-0000-000000000000", "text": "Koopwijzer badge on airfryer tiles"}]))
    open_board(page, server, board)
    blocked = page.locator(".col.queue .card.q", has_text="Announce the redesign")
    assert "waits for “Koopwijzer badge on airfryer tiles”" in blocked.inner_text()
    sbox(page, "todo").locator("button", has_text="Assign next").click()
    sent = wait_sent(board, lambda x: x[1].endswith("/send"), "a send")
    assert sent[-1][1] == "/todos/a1f3c9d2-0000-0000-0000-000000000000/send", "the free task goes, not the blocked one"


def test_details_panel_saves_notes_images_and_blockers(page, server):
    board = Board(); open_board(page, server, board)
    card = page.locator(".col.queue .card.q", has_text="Koopwijzer badge")
    card.locator("button", has_text="details").click()
    panel = page.locator(".col.queue .card.q .panel")
    panel.wait_for(timeout=SHORT)
    panel.locator("textarea").fill("Use the existing tag component.\nKeep it small.")
    # Attach an image through the file input; it is uploaded and kept as a path.
    panel.locator("input[type=file]").set_input_files({"name": "shot.png", "mimeType": "image/png", "buffer": bytes.fromhex("89504e470d0a1a0a")})
    wait_sent(board, lambda x: x[1] == "/todos/attach" and x[2]["type"] == "image/png", "the upload")
    wait(page, "() => document.querySelectorAll('.col.queue .panel .thumb').length === 1", what="the thumbnail")
    page.locator(".col.queue .panel button", has_text="Save").click()
    patched = wait_sent(board, lambda x: x[2].get("action") == "annotate", "annotate")[-1]
    assert patched[1] == "/todos/a1f3c9d2-0000-0000-0000-000000000000"
    assert patched[2]["notes"] == "Use the existing tag component.\nKeep it small."
    assert patched[2]["images"] == ["/w/.todo-attachments/task-1-abc123.png"] and patched[2]["blockedBy"] == []


def test_details_panel_offers_the_other_open_tasks_as_blockers(page, server):
    board = Board()
    board.project("bestekortingen")["queue"].append(item("c2c2c2c2-0000-0000-0000-000000000000", "Ship the guide"))
    open_board(page, server, board)
    page.locator(".col.queue .card.q", has_text="Ship the guide").locator("button", has_text="details").click()
    panel = page.locator(".col.queue .panel")
    assert "Koopwijzer badge on airfryer tiles" in panel.locator(".waits").inner_text()
    assert "Ship the guide" not in panel.locator(".waits").inner_text(), "not itself"
    panel.locator(".waits label", has_text="Koopwijzer").locator("input").check()
    panel.locator("button", has_text="Save").click()
    sent = wait_sent(board, lambda x: x[2].get("action") == "annotate", "annotate")[-1]
    assert sent[2]["blockedBy"] == ["a1f3c9d2-0000-0000-0000-000000000000"]


def test_a_claim_whose_session_is_gone_is_still_visible_and_releasable(page, server):
    board = Board()
    board.project("bestekortingen")["queue"].append(item("d3d3d3d3-0000-0000-0000-000000000000", "Held by an exited session", "claimed", claimedBy="tmux:ghost", claimedAt=NOW - 3_600_000, stale="gone"))
    open_board(page, server, board)
    held = page.locator(".col.progress .obox .card.orphan", has_text="Held by an exited session")
    assert held.count() == 1 and "its session is not running" in held.inner_text() and "held by ghost" in held.inner_text()
    assert len(texts(page, ".col.progress .sbox")) == 4, "the orphan is not mistaken for a session box"
    held.locator("button", has_text="Release").click()
    assert wait_sent(board, lambda x: x[2].get("action") == "release", "release")[-1][1] == "/todos/d3d3d3d3-0000-0000-0000-000000000000"


def test_a_stale_claim_on_a_live_idle_session_is_flagged_in_its_box(page, server):
    board = Board()
    board.project("bestekortingen")["queue"].append(item("d4d4d4d4-0000-0000-0000-000000000000", "Held and forgotten", "claimed", claimedBy="tmux:todo", claimedAt=NOW - 3_600_000, stale="idle"))
    open_board(page, server, board)
    held = sbox(page, "todo").locator(".card.held", has_text="Held and forgotten")
    assert "its session has been idle a while" in held.inner_text()
    held.locator("button", has_text="Release").click()
    assert wait_sent(board, lambda x: x[2].get("action") == "release", "release")[-1][1] == "/todos/d4d4d4d4-0000-0000-0000-000000000000"


def test_done_cards_link_to_the_chat_and_commit_and_can_be_reopened_or_reported(page, server):
    board = Board()
    bk = board.project("bestekortingen")
    bk["queue"].append(item("e4e4e4e4-0000-0000-0000-000000000000", "Ship the widget", "done", claimedBy="tmux:todo", addedBy="tmux:todo", result="committed as abc1234 on main", doneAt=NOW - 60_000,
                            links={"chatId": "c1", "commit": {"hash": "abc1234", "url": "https://github.com/acme/widgets/commit/abc1234def"}}))
    open_board(page, server, board)
    card = page.locator(".doneboard .card.done", has_text="Ship the widget")
    assert card.locator("a", has_text="abc1234").get_attribute("href") == "https://github.com/acme/widgets/commit/abc1234def"
    assert card.locator("a", has_text="open chat").count() == 1
    card.locator("button[title='Back to the queue']").click()
    assert wait_sent(board, lambda x: x[2].get("action") == "reopen", "reopen")[-1][1] == "/todos/e4e4e4e4-0000-0000-0000-000000000000"
    # Reports: only on a card a session signed as both adder and doer. Tooltips say what they do.
    card.locator("button", has_text="not a task").click()
    mis = wait_sent(board, lambda x: x[1] == "/board/misread", "misread")[-1][2]
    assert mis == {"root": ROOT_BK, "id": "e4e4e4e4-0000-0000-0000-000000000000", "wanted": "not_done"}
    card.locator("button", has_text="wrong title").click()
    editing = page.locator(".doneboard .card.done", has_text="committed as abc1234")   # the title is an input now: find the card by its result
    editing.locator("input").fill("Ship the widget page"); editing.locator("input").press("Enter")
    mis2 = wait_sent(board, lambda x: x[1] == "/board/misread" and x[2].get("wanted") == "title", "title misread")[-1][2]
    assert mis2["title"] == "Ship the widget page"
    # A card the owner finished by hand has no report buttons.
    own = page.locator(".doneboard .card.done", has_text="Fix the deploy check")
    assert own.locator("button", has_text="not a task").count() == 0


def test_history_searches_finished_work_and_reopens_from_it(page, server):
    board = Board()
    board.history = [{"id": "f5f5f5f5-0000-0000-0000-000000000000", "text": "Fix the footer on mobile", "result": "sticky below 700px", "doneAt": NOW - 40 * 86400_000, "addedAt": NOW - 41 * 86400_000},
                     {"id": "f6f6f6f6-0000-0000-0000-000000000000", "text": "Dark theme", "result": "tokens and a toggle", "doneAt": NOW - 3 * 86400_000, "addedAt": NOW - 4 * 86400_000}]
    open_board(page, server, board)
    page.locator("#histbtn").click()
    page.wait_for_selector("#history .hrow", timeout=SHORT)
    assert len(texts(page, "#history .hrow")) == 2
    page.locator("#history input").fill("footer")
    wait(page, "() => document.querySelectorAll('#history .hrow').length === 1", what="filtered")
    assert "sticky below 700px" in page.locator("#history .hrow").inner_text()
    assert any(x[0] == "GET" and "q=footer" in x[1] for x in board.sent)
    page.locator("#history .hrow button").click()
    assert wait_sent(board, lambda x: x[2].get("action") == "reopen", "reopen")[-1][1] == "/todos/f5f5f5f5-0000-0000-0000-000000000000"
    page.locator("#history input").fill("nothing like this")
    wait(page, "() => document.querySelector('#history .histlist').textContent.includes('Nothing matches')", what="empty state")


def test_keeper_counter_and_pause_switch(page, server):
    board = Board(); open_board(page, server, board)
    assert "keeper · 3 reads today" in page.locator("#keeper").inner_text()
    page.locator("#keeper button", has_text="pause").click()
    assert wait_sent(board, lambda x: x[1] == "/board/keeper", "pause")[-1][2] == {"paused": True}
    board.keeper = {"paused": True, "calls": 3, "date": "2026-10-10"}
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    wait(page, "() => document.querySelector('#keeper').textContent.includes('paused')", what="paused shown")
    assert page.locator("#keeper button").inner_text() == "resume"


def test_auto_dispatch_toggle_per_project(page, server):
    board = Board(); open_board(page, server, board)
    chips = texts(page, ".autorow .autochip")
    assert chips == ["○ bestekortingen", "○ codeTerminal", "○ General"], chips
    page.locator(".autorow .autochip", has_text="bestekortingen").click()
    assert wait_sent(board, lambda x: x[1] == "/board/auto", "toggle")[-1][2] == {"root": ROOT_BK, "on": True}
    assert "only while nothing there is busy" in page.locator(".autorow .autochip").first.get_attribute("title")


def test_pasting_an_image_into_the_add_box_attaches_it_to_the_new_task(page, server):
    board = Board(); open_board(page, server, board)
    page.select_option("#gproject", "codeTerminal"); page.fill("#gtext", "Restyle the header like this")
    page.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'p.png', {type: 'image/png'}));
        document.querySelector('#gtext').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""")
    wait_sent(board, lambda x: x[1] == "/todos/attach", "the upload")
    wait(page, "() => document.querySelectorAll('#gimgs .thumb').length === 1", what="the pending thumbnail")
    page.click("#gadd")
    add = wait_sent(board, lambda x: x[0] == "POST" and x[1] == "/todos", "the add")[-1][2]
    assert add["text"] == "Restyle the header like this" and add["images"] == ["/w/.todo-attachments/task-1-abc123.png"]
    wait(page, "() => document.querySelectorAll('#gimgs .thumb').length === 0", what="pending cleared")
