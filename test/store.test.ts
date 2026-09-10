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
