/**
 * Labelled thread tails for the board keeper (src/insight.ts assessWithHaiku).
 * Each is what the keeper is handed — a chat's last entries ("user:",
 * "assistant:", "tool:", "note:") or a tmux pane's transcript — and what a
 * person reading the same tail would call it. The labels are the author's
 * (Claude, 2026-10-10, with the owner's complaints in mind: a pause filed as
 * done, a step such as "commit" titled as the task); they are judgement
 * calls, so the score is a regression meter for the prompt, not ground truth.
 * Add real tails from the live board whenever the keeper gets one wrong.
 */
export type Case = {
  name: string;
  tail: string;
  /** The statuses a reader would accept. */
  status: ("working" | "done" | "needs_you" | "idle")[];
  /** The title must read as this task... */
  titleLike?: RegExp;
  /** ...and must not be the step being taken for it. */
  titleNot?: RegExp;
};

const RULE = "─".repeat(100);

export const CASES: Case[] = [
  { name: "progress report is a pause, not a finish",
    tail: "user: fix the flaky upgrade test in server.test.ts\nassistant: Looking at the test now; the port is picked before the server listens, so the upgrade can race it.",
    status: ["working"], titleLike: /flaky|upgrade|test/i },
  { name: "reports the whole task finished",
    tail: "user: fix the flaky upgrade test in server.test.ts\nassistant: Fixed by waiting for listen before the upgrade. All 691 tests pass, three runs in a row.",
    status: ["done"], titleLike: /flaky|upgrade|test/i },
  { name: "asks the owner a decision",
    tail: "user: set up the prod bot\nassistant: The dev bot token works for both. Should I reuse it for prod, or create a second bot?",
    status: ["needs_you"] },
  { name: "asks in Dutch",
    tail: "user: voeg de koopwijzer-banner toe\nassistant: De banner staat op de lijstpagina's. Wil je dat ik hem ook op de winkelpagina's toon, of laat ik het zoals het is?",
    status: ["needs_you"] },
  { name: "small talk is idle",
    tail: "user: ok thanks\nassistant: You're welcome.",
    status: ["idle", "done"] },
  { name: "a fresh chat with only a note is idle",
    tail: "note: Working directory is now /home/dev/projects/codeTerminal",
    status: ["idle"] },
  { name: "a closing question is not a decision needed",
    tail: "user: make the footer sticky on mobile\nassistant: Done. The footer is sticky below 700px and the page no longer scrolls under it. Anything else you want changed?",
    status: ["done"], titleLike: /footer/i },
  { name: "answers a question: done",
    tail: "user: what port does the dev server use?\nassistant: It listens on 8123, bound to the tailnet address.",
    status: ["done"] },
  { name: "tools running, no words yet",
    tail: "user: add a dark theme to the settings page\ntool: Read\ntool: Edit\ntool: Edit\ntool: Bash",
    status: ["working"], titleLike: /dark|theme|settings/i },
  { name: "waiting on an approval",
    tail: "user: clean up the build output\nassistant: I need to run `rm -rf build/` to continue, and I am waiting for your approval before touching it.",
    status: ["needs_you", "working"] },
  { name: "committing is a step of the task, not the task",
    tail: "user: make the done lane one column per session\nassistant: The done board now has a column per session.\nuser: commit this on a new branch\nassistant: Committed on branch board: 26 files, 2785 insertions.",
    status: ["working", "done"], titleLike: /done|column|session|board/i, titleNot: /commit|branch/i },
  { name: "pushing is a step of the task, not the task",
    tail: "user: the reply to a tmux session never arrives, fix it\nassistant: Fixed: the answer is typed into an idle session and the hook now reads it.\nuser: push it\nassistant: Pushed. main is at 2b4bc8c and the pre-push suites are green.",
    status: ["working", "done"], titleLike: /reply|answer|tmux|session/i, titleNot: /\bpush/i },
  { name: "restarting and rendering are steps of the task",
    tail: "user: put the session name on the needs-you cards\nassistant: Edited the card builder. Restarting the service and rendering the board to check it.\ntool: Bash\ntool: Bash",
    status: ["working"], titleLike: /session|needs|card|name/i, titleNot: /restart|render/i },
  // ---- harder: only steps are visible, or a new task follows a finished one ----
  { name: "only shipping steps visible: still not a task named after a step",
    tail: "user: commit board reply fix on new branch\nassistant: Committed 9818c4c on branch board, 26 files.\nuser: push it\nassistant: Pushed board; the pre-push hooks are green.\nuser: just merge\nassistant: Merged into main and pushed 163795a.",
    status: ["done", "working"], titleLike: /reply|fix|board|ship|release/i, titleNot: /^(commit|push|merge)/i },
  { name: "running the suite is a step of the fix",
    tail: "user: replying to a question does not reach the tmux session\nassistant: The hook fetches only open items, so an answered question never reaches it. Fixing both ends.\nuser: fix them all now\nassistant: Running the full suite now to confirm the fixes.\ntool: Bash",
    status: ["working"], titleLike: /reply|answer|tmux|hook|question/i, titleNot: /suite|^run/i },
  { name: "writing docs is a step of the feature",
    tail: "user: add a keeper that reads each thread with haiku and moves the cards\nassistant: The keeper code is in and its tests pass. Writing the docs and the journal entry now.\ntool: Edit\ntool: Edit",
    status: ["working"], titleLike: /keeper|haiku|thread|card/i, titleNot: /docs|journal/i },
  { name: "a correction keeps the task, it is not the task",
    tail: "user: put sessions as columns\nassistant: Done: one column per session with its done lane.\nuser: that is not what I wanted, keep the kanban and make in progress hold the sessions\nassistant: Understood. I will restore the kanban and put every session inside In progress.",
    status: ["working"], titleLike: /kanban|session|progress|board/i, titleNot: /not what|wanted|correct/i },
  { name: "a new task follows a finished one: the title moves on",
    tail: "user: fix the footer on mobile\nassistant: Fixed, the footer is sticky below 700px.\nuser: now add a dark theme to the settings page\nassistant: Starting with the theme tokens, then the toggle.",
    status: ["working"], titleLike: /dark|theme/i, titleNot: /footer/i },
  { name: "tmux pane: working with a spinner",
    tail: `● Reading the router.\n\n● Bash(npm test)\n  ⎿ Running… (45s)\n\n✽ Frosting… (1m 2s · ↓ 4.1k tokens)\n${RULE}\n❯ \n${RULE}`,
    status: ["working"] },
  { name: "tmux pane: finished and idle",
    tail: `❯ deploy the five data stories to staging\n\n● All five data stories are deployed to staging and verified: pages load, the sitemap lists them, the analytics tag fires.\n\n✻ Baked for 3m 10s · done 10:42 AM\n${RULE}\n❯ \n${RULE}`,
    status: ["done"], titleLike: /data stor|staging|deploy/i },
  { name: "tmux pane: asking the owner",
    tail: `❯ should the header use the old logo?\n\n● I found two logo files. Which one should the header use: the 2024 wordmark or the new monogram?\n\n✻ Brewed for 8s\n${RULE}\n❯ \n${RULE}`,
    status: ["needs_you"] },
];
