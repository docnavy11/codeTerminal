import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, loadEnvFile, statePath, statePaths, STATE_SLOTS } from "../src/config.js";

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "ct-config-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

describe("parseEnvFile", () => {
  test("the shapes a .env actually has", () => {
    assert.deepEqual(parseEnvFile([
      "# a comment",
      "",
      "CODETERM_HOST=127.0.0.1",
      "  CODETERM_PORT = 8123  ",
      "export CODETERM_ORIGINS=https://a.example,https://b.example",
      'CODETERM_QUOTED="a value # with a hash"',
      "CODETERM_SINGLE='single quoted'",
      "CODETERM_TRAILING=value   # explained here",
      "CODETERM_EMPTY=",
      "not a line at all",
      "lower_case=ignored?",
    ].join("\n")), {
      CODETERM_HOST: "127.0.0.1",
      CODETERM_PORT: "8123",
      CODETERM_ORIGINS: "https://a.example,https://b.example",
      CODETERM_QUOTED: "a value # with a hash",
      CODETERM_SINGLE: "single quoted",
      CODETERM_TRAILING: "value",
      CODETERM_EMPTY: "",
      lower_case: "ignored?",
    });
  });
  test("a proxy URL with a password keeps every character", () => {
    assert.equal(parseEnvFile("CODETERM_NOTIFY_WEBHOOK=https://u:p@ntfy.example/t?x=1#frag").CODETERM_NOTIFY_WEBHOOK,
      "https://u:p@ntfy.example/t?x=1#frag");
  });
});

describe("loadEnvFile", () => {
  test("fills what is unset, never overrides the environment, and says what it added", async () => {
    const dir = join(root, "load"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".env"), "CODETERM_PORT=9000\nCODETERM_HOST=10.0.0.1\n");
    const env: NodeJS.ProcessEnv = { CODETERM_HOST: "127.0.0.1" };
    assert.deepEqual(loadEnvFile(dir, env), ["CODETERM_PORT"]);
    assert.equal(env.CODETERM_PORT, "9000");
    assert.equal(env.CODETERM_HOST, "127.0.0.1", "systemd or the shell wins over the file");
  });
  test("no file, or an unreadable one, is not an error", async () => {
    assert.deepEqual(loadEnvFile(join(root, "nothing-here"), {}), []);
  });
});

describe("statePath", () => {
  test("the repo root by default", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(statePath("chats", "/srv/ct", env), "/srv/ct/chats");
    assert.equal(statePath("prompts", "/srv/ct", env), "/srv/ct/prompts.json");
    assert.equal(statePath("serverBrowserProfile", "/srv/ct", env), "/srv/ct/server-browser/profile");
  });
  test("CODETERM_STATE moves all of it to one directory", () => {
    const env: NodeJS.ProcessEnv = { CODETERM_STATE: "/var/lib/ct" };
    const p = statePaths("/srv/ct", env);
    assert.equal(p.chats, "/var/lib/ct/chats");
    assert.equal(p.workspace, "/var/lib/ct/workspace");
    assert.equal(p.schedules, "/var/lib/ct/schedules.json");
    assert.equal(p.browserAllow, "/var/lib/ct/browser-allow.json");
    assert.equal(p.serverBrowserProfile, "/var/lib/ct/server-browser/profile");
  });
  test("a slot's own variable beats the state directory", () => {
    const env: NodeJS.ProcessEnv = { CODETERM_STATE: "/var/lib/ct", CODETERM_CHATS: "/mnt/big/chats" };
    assert.equal(statePath("chats", "/srv/ct", env), "/mnt/big/chats");
    assert.equal(statePath("usage", "/srv/ct", env), "/var/lib/ct/usage.json");
  });
  test("setting the state directory does not strand an install that already has the file at the root", async () => {
    const repo = join(root, "repo"); const state = join(root, "state");
    await mkdir(repo, { recursive: true }); await mkdir(state, { recursive: true });
    await writeFile(join(repo, "prompts.json"), "[]");                   // the old install's
    const env: NodeJS.ProcessEnv = { CODETERM_STATE: state };
    assert.equal(statePath("prompts", repo, env), join(repo, "prompts.json"), "the existing file keeps being used");
    assert.equal(statePath("usage", repo, env), join(state, "usage.json"), "one that does not exist yet goes to the new place");
    await writeFile(join(state, "prompts.json"), "[]");                  // once moved, the new place wins
    assert.equal(statePath("prompts", repo, env), join(state, "prompts.json"));
  });
  test("every slot has a distinct name, so one directory can hold them all", () => {
    const names = Object.values(STATE_SLOTS).map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });
});
