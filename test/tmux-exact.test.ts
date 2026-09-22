import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Kill and rename must name one session exactly. Run on a private tmux
   server (its own TMUX_TMPDIR, and no inherited $TMUX), so nothing here can
   reach the machine's real sessions — which is exactly what the bug did:
   `kill-session -t dev` took out "dev-server". */
const run = promisify(execFile);
let dir: string;
let tmux: typeof import("../src/tmux.js");
let HAVE = false;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-tmuxx-"));
  process.env.TMUX_TMPDIR = dir;
  delete process.env.TMUX;
  tmux = await import("../src/tmux.js");
  HAVE = await tmux.tmuxAvailable();
});
after(async () => {
  // by its socket path, never the default: this must not be able to stop the real server
  await run("tmux", ["-S", join(dir, `tmux-${process.getuid!()}`, "default"), "kill-server"]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("tmux targets are exact", () => {
  test("kill and rename leave a session whose name only starts with the target alone", async (t) => {
    if (!HAVE) { t.skip("tmux is not installed"); return; }
    await tmux.createSession("dev-server", dir);
    assert.equal((await tmux.listSessions()).length, 1, "a private server: only ours");

    await assert.rejects(tmux.killSession("dev"), "no session is called exactly dev");
    assert.equal(await tmux.hasSession("dev-server"), true, "kill dev did not kill dev-server");

    await assert.rejects(tmux.renameSession("dev", "other"));
    assert.equal(await tmux.hasSession("dev-server"), true, "rename dev did not rename dev-server");
    assert.equal(await tmux.hasSession("other"), false);

    await tmux.killSession("dev-server");
    assert.equal(await tmux.hasSession("dev-server"), false);
  });
});
