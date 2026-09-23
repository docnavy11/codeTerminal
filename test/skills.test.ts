import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, readSkill, installSkill, removeSkill, frontmatter } from "../src/skills.js";

let home: string; let root: string; let archive: string;
before(async () => { home = await mkdtemp(join(tmpdir(), "ct-skills-")); root = join(home, "skills"); archive = join(home, "skills-archive"); });
after(async () => { await rm(home, { recursive: true, force: true }); });

const md = (name: string, desc = "Does a thing. Use when asked to do the thing.") => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

describe("skills", () => {
  test("frontmatter: name and description, quotes stripped; none without the fences", () => {
    assert.deepEqual(frontmatter(`---\nname: x\ndescription: "a: b"\n---\nbody`), { name: "x", description: "a: b" });
    assert.equal(frontmatter("# no frontmatter"), null);
  });

  test("install, list, read: SKILL.md plus files, an executable kept executable", async () => {
    const r = await installSkill(root, archive, { name: "hello", skillMd: md("hello"), files: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n", executable: true }, { path: "ref.md", content: "notes" }] });
    assert.equal(r.replaced, null); assert.equal(r.files, 3);
    assert.equal(((await stat(join(root, "hello", "scripts", "run.sh"))).mode & 0o111) !== 0, true);
    const list = await listSkills(root);
    assert.deepEqual(list.map((s) => [s.name, s.description]), [["hello", "Does a thing. Use when asked to do the thing."]]);
    const read = await readSkill(root, "hello");
    assert.equal(read.skillMd, md("hello"));
    assert.deepEqual(read.files.map((f) => f.path), ["SKILL.md", "ref.md", "scripts/run.sh"]);
    assert.deepEqual((await readdir(home)).filter((n) => n.startsWith(".skill-install")), [], "no temporary directory left behind");
  });

  test("an existing skill is replaced only with overwrite, and the old one is archived, not deleted", async () => {
    await assert.rejects(() => installSkill(root, archive, { name: "hello", skillMd: md("hello", "v2") }), /already exists/);
    const r = await installSkill(root, archive, { name: "hello", skillMd: md("hello", "v2 of it"), overwrite: true });
    assert.ok(r.replaced && r.replaced.startsWith(archive));
    assert.match(await readFile(join(r.replaced!, "SKILL.md"), "utf8"), /Does a thing/);
    assert.match(await readFile(join(root, "hello", "SKILL.md"), "utf8"), /v2 of it/);
    await assert.rejects(() => stat(join(root, "hello", "ref.md")), "the new version is exactly what was sent");
  });

  test("remove moves the skill to the archive", async () => {
    const to = await removeSkill(root, archive, "hello");
    assert.ok(to.startsWith(archive));
    assert.equal((await readFile(join(to, "SKILL.md"), "utf8")).includes("v2 of it"), true);
    assert.deepEqual(await listSkills(root), []);
    await assert.rejects(() => removeSkill(root, archive, "hello"), /No skill/);
  });

  test("refusals: bad names, paths leaving the skill, missing or mismatched frontmatter, sizes", async () => {
    for (const name of ["../evil", "Upper", "a/b", "", ".hidden"]) await assert.rejects(() => installSkill(root, archive, { name, skillMd: md(name) }), /not a skill name/, name);
    for (const path of ["../x", "/etc/x", "a/../../b", "a//b", "..", "SKILL.md"]) {
      await assert.rejects(() => installSkill(root, archive, { name: "p", skillMd: md("p"), files: [{ path, content: "x" }] }), /relative path|given twice/, path);
    }
    await assert.rejects(() => installSkill(root, archive, { name: "p", skillMd: "# no frontmatter" }), /frontmatter/);
    await assert.rejects(() => installSkill(root, archive, { name: "p", skillMd: md("other") }), /make them the same/);
    await assert.rejects(() => installSkill(root, archive, { name: "p", skillMd: md("p"), files: [{ path: "big", content: "x".repeat(600 * 1024) }] }), /over 512 KB/);
    await assert.rejects(() => readSkill(root, "../../etc"), /not a skill name/);
    assert.deepEqual(await listSkills(root), [], "nothing was written by any refusal");
  });

  test("a directory without SKILL.md one level down is not listed", async () => {
    await mkdir(join(root, "repo", "skills", "deep"), { recursive: true });
    await writeFile(join(root, "repo", "skills", "deep", "SKILL.md"), md("deep"));
    assert.deepEqual((await listSkills(root)).map((s) => s.name), []);
  });
});
