import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ChatRecord } from "../src/store.js";

let root: string;
let store: Store;

const ID = "11111111-2222-3333-4444-555555555555";

function rec(id: string, title: string): ChatRecord {
  return {
    id, title, createdAt: 1, updatedAt: 2, sdkSessionId: null, cwd: null,
    events: [{ kind: "text", text: "irreplaceable" } as never],
    granted: [], mode: "default",
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-store-"));
  store = new Store(join(root, "chats"));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

describe("Store.remove", () => {
  // Two chats were destroyed by the old unlinkSync with nothing in the log to
  // say what happened. A delete must leave the transcript recoverable.
  test("archives the record instead of destroying it", async () => {
    store.write(rec(ID, "precious"));
    assert.equal(store.read(ID)?.title, "precious");

    store.remove(ID);

    assert.equal(store.read(ID), null, "chat is gone from the live dir");
    assert.deepEqual(store.list().map((c) => c.id), [], "and out of the picker");

    const archived = (await readdir(join(root, "chats-archive")))
      .filter((n) => n.startsWith(ID));
    assert.equal(archived.length, 1, "exactly one archived copy");

    const back = JSON.parse(
      await readFile(join(root, "chats-archive", archived[0]), "utf8"),
    ) as ChatRecord;
    assert.equal(back.title, "precious");
    assert.equal(back.events.length, 1, "transcript survived the delete");
  });

  test("deleting a chat that is already gone is a no-op", () => {
    assert.doesNotThrow(() => store.remove(ID));
  });

  test("a bad id never reaches the filesystem", () => {
    assert.throws(() => store.remove("../../etc/passwd"), /bad chat id/);
  });
});

describe("Store.list caching (L1)", () => {
  test("reflects writes and removes without a disk re-read", async () => {
    const s = new Store(join(root, "cache"));
    for (let i = 0; i < 3; i++) {
      s.write({ id: `00000000-0000-4000-8000-00000000000${i}`, title: "c" + i,
        createdAt: i, updatedAt: i, sdkSessionId: null, cwd: null,
        events: [{ kind: "user", text: "hi" } as never], granted: [], mode: "default" });
    }
    assert.equal(s.list().length, 3);
    assert.equal(s.list()[0].title, "c2", "newest (highest updatedAt) first");
    s.remove("00000000-0000-4000-8000-000000000001");
    assert.equal(s.list().length, 2);
    assert.ok(!s.list().some((c) => c.id.endsWith("000001")), "removed chat is gone from the list");
  });

  test("a fresh Store boot-scans what is already on disk", async () => {
    const d = join(root, "boot");
    const a = new Store(d);
    a.write({ id: "00000000-0000-4000-8000-0000000000aa", title: "ondisk",
      createdAt: 1, updatedAt: 1, sdkSessionId: null, cwd: null,
      events: [{ kind: "user", text: "x" } as never], granted: [], mode: "default" });
    const b = new Store(d);   // separate instance, must scan the file a wrote
    assert.equal(b.list().length, 1);
    assert.equal(b.list()[0].title, "ondisk");
  });
});

describe("touch semantics: re-writing a chat makes it newest", () => {
  test("list()[0] follows the most recent write", () => {
    const s = new Store(join(root, "touch"));
    const mk = (id: string, t: number) => ({ id, title: id.slice(-2), createdAt: t, updatedAt: t,
      sdkSessionId: null, cwd: null, events: [{ kind: "user", text: "x" } as never], granted: [], mode: "default" as const });
    s.write(mk("00000000-0000-4000-8000-0000000000a1", 1));
    s.write(mk("00000000-0000-4000-8000-0000000000b2", 2));
    assert.equal(s.list()[0].id.slice(-2), "b2");
    s.write(mk("00000000-0000-4000-8000-0000000000a1", 3));   // touched
    assert.equal(s.list()[0].id.slice(-2), "a1", "the touched chat is now where a fresh attach lands");
  });
});

describe("Store.write failure", () => {
  // A full disk used to lose the record with nothing in the journal.
  test("returns false and logs instead of failing silently", async () => {
    const s = new Store(join(root, "ro"));
    const { chmod } = await import("node:fs/promises");
    await chmod(join(root, "ro"), 0o500);
    const logged: string[] = [];
    const orig = console.error; console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      assert.equal(s.write(rec(ID, "unsaved")), false);
    } finally { console.error = orig; await chmod(join(root, "ro"), 0o700); }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[store\] write failed/);
    assert.equal(s.write(rec(ID, "saved")), true);
  });
});
