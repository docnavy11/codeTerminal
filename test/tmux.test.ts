import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxAvailable, listSessions, createSession, renameSession, killSession, hasSession, capture, validName } from "../src/tmux.js";

const run = promisify(execFile);
const HAVE = await tmuxAvailable();
/* Real tmux, on the machine's own socket — these sessions sit beside whatever
   else is running there (tty's, yours), which is the point of the feature.
   Everything this test makes is prefixed and killed again. */
const NAME = `cttest-${process.pid}`;
const mine = async () => (await listSessions()).filter((s) => s.name.startsWith("cttest-"));

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "ct-tmux-")); });
after(async () => { for (const s of await mine().catch(() => [])) await killSession(s.name).catch(() => {}); await rm(dir, { recursive: true, force: true }); });

describe("session names", () => {
  test("what tmux may be handed on a command line", () => {
    for (const ok of ["a", "dev", "Build_2", "web.api", "a-b", "x".repeat(64)]) assert.ok(validName(ok), ok);
    for (const bad of ["", "-rf", ".hidden", "a b", "a;b", "a$(id)", "a:b", "../x", "x".repeat(65)]) assert.ok(!validName(bad), bad);
  });
});

describe("tmux sessions", { skip: !HAVE && "tmux is not installed" }, () => {
  test("create, list with its directory and command, rename, capture, kill", async () => {
    await createSession(NAME, dir);
    assert.equal(await hasSession(NAME), true);

    const listed = (await listSessions()).find((s) => s.name === NAME);
    assert.ok(listed, "the new session is listed");
    assert.equal(listed.path, dir, "its working directory is where it was created");
    assert.equal(listed.attached, 0, "nobody is attached to it");
    assert.ok(listed.createdAt > Date.now() - 60_000 && listed.createdAt <= Date.now() + 1000, "created just now");
    assert.ok(listed.command.length > 0, "the pane reports what it is running");

    // Something it printed is readable with nobody attached — the whole point.
    await run("tmux", ["send-keys", "-t", `=${NAME}:`, "echo ct-marker-42", "Enter"]);
    const t0 = Date.now();
    let out = "";
    while (Date.now() - t0 < 10_000 && !out.includes("ct-marker-42")) { out = await capture(NAME, 50); await new Promise((r) => setTimeout(r, 100)); }
    assert.match(out, /ct-marker-42/, "capture-pane reads an unattached session");

    const renamed = `${NAME}-2`;
    await renameSession(NAME, renamed);
    assert.equal(await hasSession(NAME), false);
    assert.equal(await hasSession(renamed), true);
    assert.match(await capture(renamed, 50), /ct-marker-42/, "renaming keeps the session, scrollback and all");

    await killSession(renamed);
    assert.equal(await hasSession(renamed), false);
  });

  test("the machine's other sessions are listed too, newest activity first", async () => {
    const all = await listSessions();
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].activityAt >= all[i].activityAt, "sorted by last activity");
    // Nothing here namespaces the list: a session made by another front door
    // (tty's wt_*) is as visible as one of ours, by design.
    await createSession(`${NAME}-x`, dir);
    assert.ok((await listSessions()).some((s) => s.name === `${NAME}-x`));
    await killSession(`${NAME}-x`);
  });

  test("a name that is not a name is refused before tmux sees it", async () => {
    await assert.rejects(createSession("a b", dir), /letters, digits/);
    await assert.rejects(renameSession(NAME, "-rf"), /letters, digits/);
    await assert.rejects(killSession("a;id"), /no such session/);
    await assert.rejects(capture("../x"), /no such session/);
    assert.equal(await hasSession("a b"), false);
  });

  test("no session, no output: capture says so rather than throwing a shell error", async () => {
    await assert.rejects(capture(`${NAME}-nope`), /failed|not found|can't find|no such/i);
  });
});
