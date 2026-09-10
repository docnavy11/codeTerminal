import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, resolveProject, filterProjects, GENERAL_ID } from "../src/projects.js";

let root: string;
const GENERAL_PATH = "/tmp/some-workspace";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-proj-"));
  for (const d of ["alpha", "Beta", "node_modules", ".hidden", "general"]) {
    await mkdir(join(root, d), { recursive: true });
  }
  await writeFile(join(root, "a-file.txt"), "not a project");
  await symlink(join(root, "alpha"), join(root, "linked"));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

describe("listProjects", () => {
  test("General always comes first, even with no root", () => {
    const p = listProjects("/does/not/exist", GENERAL_PATH);
    assert.equal(p.length, 1);
    assert.equal(p[0].id, GENERAL_ID);
    assert.equal(p[0].general, true);
  });

  test("finds subdirectories, sorted case-insensitively", () => {
    const names = listProjects(root, GENERAL_PATH).map((p) => p.name);
    assert.equal(names[0], "General");
    assert.deepEqual(names.slice(1), ["alpha", "Beta", "linked"]);
  });

  test("skips files, dotfiles and build directories", () => {
    const names = listProjects(root, GENERAL_PATH).map((p) => p.name);
    for (const skipped of ["a-file.txt", ".hidden", "node_modules"]) {
      assert.ok(!names.includes(skipped), `${skipped} should not be a project`);
    }
  });

  test("a directory named 'general' cannot shadow the catch-all", () => {
    const generals = listProjects(root, GENERAL_PATH).filter((p) => p.id === GENERAL_ID);
    assert.equal(generals.length, 1);
    assert.equal(generals[0].general, true);
  });

  test("a symlinked directory counts", () => {
    assert.ok(listProjects(root, GENERAL_PATH).some((p) => p.name === "linked"));
  });
});

// `root` is assigned in before(), which runs after a describe body is
// evaluated — so the list has to be built inside each test, not alongside it.
describe("resolveProject", () => {
  test("finds one by id", () =>
    assert.equal(resolveProject(listProjects(root, GENERAL_PATH), "alpha").name, "alpha"));
  test("unknown id falls back to General", () =>
    assert.equal(resolveProject(listProjects(root, GENERAL_PATH), "gone").id, GENERAL_ID));
  test("null falls back to General", () =>
    assert.equal(resolveProject(listProjects(root, GENERAL_PATH), null).id, GENERAL_ID));
});

describe("filterProjects", () => {
  test("filters by substring, case-insensitively", () => {
    assert.deepEqual(filterProjects(listProjects(root, GENERAL_PATH), "et").map((p) => p.name),
      ["General", "Beta"]);
  });
  test("General survives any filter, so you can always get back", () => {
    assert.ok(filterProjects(listProjects(root, GENERAL_PATH), "zzzz").every((p) => p.general));
  });
  test("an empty query returns everything", () => {
    const all = listProjects(root, GENERAL_PATH);
    assert.equal(filterProjects(all, "  ").length, all.length);
  });
});
