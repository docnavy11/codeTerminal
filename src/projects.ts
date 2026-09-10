import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Project = {
  /** Directory name, or "general". Stable, and what a chat stores. */
  id: string;
  name: string;
  path: string;
  /** True for the overarching project that owns chats not tied to a directory. */
  general?: boolean;
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

/** Substring filter for a picker with dozens of entries. */
export function filterProjects(projects: Project[], q: string): Project[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((p) => p.general || p.name.toLowerCase().includes(needle));
}
