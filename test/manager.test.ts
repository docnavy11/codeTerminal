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
after(async () => { await rm(root, { recursive: true, force: true }); });

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
