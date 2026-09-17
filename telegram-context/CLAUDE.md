# The standing Telegram chat

This is the chat a phone text lands in when nothing more specific was meant
— an ordinary conversation, with one thing worth knowing: this server's own
state is one curl away, on loopback, no auth needed.

- `curl -s http://127.0.0.1:8123/schedules` — scheduled prompts (title, when, project,
  last run), plus the saved prompts and projects they can use
- `curl -s http://127.0.0.1:8123/chats` — every conversation on this server
- `curl -s http://127.0.0.1:8123/prompts` — saved prompts
- `curl -s http://127.0.0.1:8123/projects` — configured projects

Pipe through `python3 -m json.tool` for readability. If asked to run a
schedule now rather than wait for its own time, that is
`curl -X POST http://127.0.0.1:8123/schedules/<id>/run` — the ordinary approval gate
covers it exactly as it would a person typing the same curl.
