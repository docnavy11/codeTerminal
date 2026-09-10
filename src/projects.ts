import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Project = {
  /** Directory name, or "general". Stable, and what a chat stores. */
  id: string;
  name: string;
  path: string;
  /** True for the overarching project that owns chats not tied to a directory. */
  general?: boolean;
  /** When a chat in this project was last touched, if ever. */
  lastUsed?: number;
  /** How many chats belong to it. */
  chats?: number;
};

/** Reserved so a directory called "general" cannot shadow the catch-all. */
export const GENERAL_ID = "general";

const SKIP = new Set(["node_modules", "dist", "build", ".git"]);

/**
 * Projects are discovered, not created: every subdirectory of the projects
 * root is one. Nothing to set up, nothing to migrate, and a new checkout shows
 * up on its own.
 *
 * Plus one overarching "General" project for chats that are not about a
 * particular directory — browsing, email, scratch questions — which is most of
 * them.
 */
export function listProjects(root: string, generalPath: string): Project[] {
  const general: Project = { id: GENERAL_ID, name: "General", path: generalPath, general: true };

  let names: string[];
  try {
    names = readdirSync(resolve(root));
  } catch {
    return [general];
  }

  const found: Project[] = [];
  for (const name of names) {
    if (name.startsWith(".") || SKIP.has(name) || name === GENERAL_ID) continue;
    const path = join(resolve(root), name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue; // vanished or unreadable
    }
    found.push({ id: name, name, path });
  }

  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return [general, ...found];
}

/** The project a chat belongs to, falling back to General. */
export function resolveProject(projects: Project[], id: string | null | undefined): Project {
  return projects.find((p) => p.id === id) ?? projects.find((p) => p.general)!;
}

/**
 * Puts the projects you have actually been working in at the top.
 *
 * With 79 directories, alphabetical means scrolling past sixty things you have
 * never opened to reach the three you use. Ones with chats sort by how
 * recently they were touched; the rest keep their alphabetical order below,
 * because between two projects you have never opened there is nothing better
 * to say than "alphabetical".
 *
 * General takes part rather than being pinned — it is usually the most recent
 * anyway, and `filterProjects` keeps it reachable regardless.
 */
export function orderByRecency(
  projects: Project[],
  usage: Map<string, { lastUsed: number; chats: number }>,
): Project[] {
  const marked = projects.map((p) => {
    const u = usage.get(p.id);
    return { ...p, lastUsed: u?.lastUsed, chats: u?.chats ?? 0 };
  });
  return marked.sort((a, b) => {
    if (a.lastUsed && b.lastUsed) return b.lastUsed - a.lastUsed;
    if (a.lastUsed) return -1;
    if (b.lastUsed) return 1;
    return 0;   // both untouched: leave the alphabetical order listProjects gave
  });
}

/** Substring filter for a picker with dozens of entries. */
export function filterProjects(projects: Project[], q: string): Project[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((p) => p.general || p.name.toLowerCase().includes(needle));
}
