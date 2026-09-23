/**
 * Claude Code skills on this machine, as files: list, read, install or
 * update, and remove. A skill is a directory holding a SKILL.md (frontmatter
 * name + description) and whatever files it uses, one level under a skills
 * root — `~/.claude/skills` for every chat, `<project>/.claude/skills` for one
 * project. That one level is what the CLI loads; anything deeper (a cloned
 * repo of skills) is not a skill until it is copied up.
 *
 * Nothing here deletes: an update moves the old version aside first, and a
 * removal is a move, both into `skills-archive/` beside the root, so either
 * is undone with one `mv`. Exposed over /mcp without an approval gate, by the
 * owner's choice (single user, tailnet only) — see docs/running.md.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, chmod, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SKILL_MD = 100 * 1024;
export const MAX_FILE = 512 * 1024;
export const MAX_TOTAL = 2 * 1024 * 1024;
export const MAX_FILES = 50;

export type SkillInfo = { name: string; description: string; dir: string };
export type SkillFile = { path: string; content: string; executable?: boolean };

/** name and description from SKILL.md's frontmatter; null when it has none. */
export function frontmatter(md: string): { name?: string; description?: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return out;
}

export async function listSkills(root: string): Promise<SkillInfo[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const out: SkillInfo[] = [];
  for (const n of names.sort()) {
    const dir = join(root, n);
    try {
      const md = await readFile(join(dir, "SKILL.md"), "utf8");
      const fm = frontmatter(md) ?? {};
      out.push({ name: fm.name || n, description: fm.description ?? "", dir });
    } catch { /* not a skill: no SKILL.md one level down */ }
  }
  return out;
}

/** The skill's directory under root, refusing a name that is not one. */
function skillDir(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a skill name: lower-case letters, digits, . _ -, up to 64.`);
  return join(root, name);
}

export async function readSkill(root: string, name: string): Promise<{ name: string; dir: string; skillMd: string; files: { path: string; bytes: number }[] }> {
  const dir = skillDir(root, name);
  let skillMd: string;
  try { skillMd = await readFile(join(dir, "SKILL.md"), "utf8"); } catch { throw new Error(`No skill "${name}" in ${root}.`); }
  const files: { path: string; bytes: number }[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) { if (files.length < 500) await walk(abs); }
      else if (e.isFile()) files.push({ path: relative(dir, abs).split(sep).join("/"), bytes: (await stat(abs)).size });
    }
  };
  await walk(dir);
  return { name, dir, skillMd, files: files.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** A relative path that stays inside the skill directory, or an error. */
function inside(dir: string, p: string): string {
  if (!p || isAbsolute(p) || p.split(/[\\/]/).some((s) => s === ".." || s === "")) throw new Error(`"${p}" is not a relative path inside the skill.`);
  const abs = resolve(dir, p);
  if (!abs.startsWith(dir + sep)) throw new Error(`"${p}" is not a relative path inside the skill.`);
  return abs;
}

/**
 * Write a skill. A new one needs no flag; an existing one needs `overwrite`,
 * and its old directory is moved to the archive first. The new version is
 * built in a temporary directory beside the root and renamed into place, so
 * a failure halfway leaves the old skill, or nothing, never half of each.
 */
export async function installSkill(root: string, archive: string, input: { name: string; skillMd: string; files?: SkillFile[]; overwrite?: boolean }): Promise<{ dir: string; replaced: string | null; files: number }> {
  const dir = skillDir(root, input.name);
  const fm = frontmatter(input.skillMd);
  if (!fm?.description) throw new Error("SKILL.md needs frontmatter with at least a description (--- name: … / description: … ---); it is what the model reads to decide when to use the skill.");
  if (fm.name && fm.name !== input.name) throw new Error(`SKILL.md's name is "${fm.name}" but the skill is being installed as "${input.name}"; make them the same.`);
  if (Buffer.byteLength(input.skillMd) > MAX_SKILL_MD) throw new Error(`SKILL.md is over ${MAX_SKILL_MD / 1024} KB.`);
  const files = input.files ?? [];
  if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files besides SKILL.md.`);
  let total = Buffer.byteLength(input.skillMd);
  const seen = new Set<string>(["SKILL.md"]);
  for (const f of files) {
    inside(dir, f.path);
    if (seen.has(f.path)) throw new Error(`"${f.path}" is given twice${f.path === "SKILL.md" ? " (SKILL.md is its own argument)" : ""}.`);
    seen.add(f.path);
    const n = Buffer.byteLength(f.content);
    if (n > MAX_FILE) throw new Error(`"${f.path}" is over ${MAX_FILE / 1024} KB.`);
    total += n;
  }
  if (total > MAX_TOTAL) throw new Error(`The skill is over ${MAX_TOTAL / 1024 / 1024} MB in all.`);

  let exists = false;
  try { await lstat(dir); exists = true; } catch { /* new */ }
  if (exists && !input.overwrite) throw new Error(`A skill "${input.name}" already exists; pass overwrite to replace it (the old one is archived, not deleted).`);

  await mkdir(root, { recursive: true });
  // Beside the root, not in it: the CLI would find a SKILL.md in a half-built
  // directory inside it. Same filesystem, so the rename below is atomic.
  const tmp = join(dirname(root), `.skill-install-${input.name}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(tmp);
    await writeFile(join(tmp, "SKILL.md"), input.skillMd, "utf8");
    for (const f of files) {
      const abs = inside(tmp, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
      if (f.executable) await chmod(abs, 0o755);
    }
    let replaced: string | null = null;
    if (exists) replaced = await moveToArchive(dir, archive, input.name);
    await rename(tmp, dir);
    return { dir, replaced, files: files.length + 1 };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Move a skill out of the root into the archive. Returns where it went. */
export async function removeSkill(root: string, archive: string, name: string): Promise<string> {
  const dir = skillDir(root, name);
  try { await lstat(dir); } catch { throw new Error(`No skill "${name}" in ${root}.`); }
  return moveToArchive(dir, archive, name);
}

async function moveToArchive(dir: string, archive: string, name: string): Promise<string> {
  await mkdir(archive, { recursive: true });
  const dest = join(archive, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await rename(dir, dest);
  return dest;
}
