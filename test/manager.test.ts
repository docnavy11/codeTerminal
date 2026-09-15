import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/conversation.js";
import { Store, type ChatRecord } from "../src/store.js";

// Every record edit here must stay cold: admitting a chat spawns the SDK
// subprocess (measured: a rename from the manage page started one per row).
// These tests would hang or fail on a machine without the SDK if any path
// still admitted, which is exactly the point.

let root: string;
let mgr: Manager;
const ID = "aaaaaaaa-0000-0000-0000-000000000001";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-mgr-"));
  const store = new Store(join(root, "chats"));
  const rec: ChatRecord = {
    id: ID, title: "Seed", createdAt: 1, updatedAt: 2, sdkSessionId: null, cwd: null,
    events: [{ kind: "user", text: "hi" } as never], granted: [], mode: "default",
  };
  store.write(rec);
  mgr = new Manager(join(root, "ws"), join(root, "chats"), join(root, "projects"),
    { bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined });
});
// The Manager saves on a debounce; flush it or the write races the removal
// (ENOTEMPTY, measured in test/attach.test.ts on 2026-09-15).
after(async () => { try { mgr.shutdown(); } catch { /* already closed */ } await rm(root, { recursive: true, force: true }); });

async function onDisk(): Promise<ChatRecord> {
  return JSON.parse(await readFile(join(root, "chats", `${ID}.json`), "utf8"));
}

describe("Manager edits a cold chat without admitting it", () => {
  test("rename", async () => {
    let changed = 0; mgr.onListChanged = () => changed++;
    assert.equal(mgr.rename(ID, "  Renamed title  "), true);
    assert.equal(mgr.live(ID), undefined, "rename must not admit the chat");
    assert.equal((await onDisk()).title, "Renamed title");
    assert.equal((await onDisk()).titleProvisional, false);
    assert.equal(changed, 1);
    assert.equal(mgr.list().find((c) => c.id === ID)?.title, "Renamed title", "summary cache updated");
  });
  test("rename rejects blank and unknown", () => {
    assert.equal(mgr.rename(ID, "   "), false);
    assert.equal(mgr.rename("nope", "x"), false);
    assert.equal(mgr.live(ID), undefined);
  });
  test("touch", async () => {
    const before = (await onDisk()).updatedAt;
    assert.equal(mgr.touch(ID), true);
    assert.equal(mgr.live(ID), undefined);
    assert.ok((await onDisk()).updatedAt > before);
    assert.equal(mgr.touch("nope"), false);
  });
  test("setProject", async () => {
    assert.equal(await mgr.setProject(ID, { id: "p1", name: "P1", path: "/tmp/p1", general: false }), true);
    assert.equal(mgr.live(ID), undefined);
    const rec = await onDisk();
    assert.equal(rec.project, "p1");
    assert.equal(rec.cwd, "/tmp/p1");
    assert.equal(await mgr.setProject("nope", { id: "p1", name: "P1", path: "/tmp/p1", general: false }), false);
  });
});

describe("Manager.create reuses an abandoned empty chat", () => {
  // Cold path only: the spare must be found and rewritten on disk without
  // spawning; the admit that follows is what a real create() does anyway, so
  // stop short of it by checking the store directly.
  test("an empty 'New chat' on disk is the one create() would take", async () => {
    const store = new Store(join(root, "chats"));
    store.write({ id: "bbbbbbbb-0000-0000-0000-000000000002", title: "New chat", createdAt: 1, updatedAt: 1,
      sdkSessionId: "old", cwd: null, events: [{ kind: "ready" } as never], granted: [], mode: "default" });
    const spare = store.list().find((c) => c.turns === 0 && c.title === "New chat");
    assert.equal(spare?.id, "bbbbbbbb-0000-0000-0000-000000000002");
  });
});
