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
        self.projects = [
            {"id": "bestekortingen", "name": "bestekortingen", "root": ROOT_BK,
             "sessions": [tmux("todo"), tmux("2e", "working", summary="Making the shop choice a popup on first visit",
                                              task={"title": "Make shop choice a popup", "status": "working"}, activity="Frosting… 2m 3s")],
             "queue": [item("a1f3c9d2-0000-0000-0000-000000000000", "Koopwijzer badge on airfryer tiles"),
                       item("d0d0d0d0-0000-0000-0000-000000000000", "Fix the deploy check", "done", claimedBy="tmux:todo", result="Deploy check pushed", doneAt=NOW - 600_000)],
             "asks": [], "counts": {"queued": 1, "claimed": 0, "forYou": 0}},
            {"id": "codeTerminal", "name": "codeTerminal", "root": ROOT_CT,
             "sessions": [tmux("modchanger", "working", path=ROOT_CT, task={"title": "Board: sessions", "status": "working"})],
             "queue": [], "asks": [], "counts": {"queued": 0, "claimed": 0, "forYou": 0}},
            {"id": "general", "name": "General", "root": ROOT_GEN,
             "sessions": [chat("c1", "Wend puzzle")], "queue": [], "asks": [], "counts": {"queued": 0, "claimed": 0, "forYou": 0}},
        ]

    def payload(self):
        return {"at": int(time.time() * 1000), "forYou": [], "projects": self.projects,
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
