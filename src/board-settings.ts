import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * What the owner has switched on or off on the board, kept across restarts in
 * one small file: the keeper's pause (its reads draw on the subscription),
 * which projects auto-dispatch (docs/design-todos.md §19), and the tasks the
 * owner told the keeper were never tasks, so it does not record them again.
 */
export type Suppressed = { key: string; title: string };

export class BoardSettings {
  #path: string;
  keeperPaused = false;
  #auto = new Set<string>();
  #suppressed: Suppressed[] = [];

  constructor(path: string) {
    this.#path = path;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { keeperPaused?: boolean; auto?: string[]; suppressed?: Suppressed[] };
      this.keeperPaused = raw.keeperPaused === true;
      this.#auto = new Set((raw.auto ?? []).filter((x) => typeof x === "string"));
      this.#suppressed = (raw.suppressed ?? []).filter((s) => s && typeof s.key === "string" && typeof s.title === "string");
    } catch { /* a bad settings file is the defaults */ }
  }

  #save(): void {
    try {
      writeFileSync(`${this.#path}.tmp`, JSON.stringify({ keeperPaused: this.keeperPaused, auto: [...this.#auto], suppressed: this.#suppressed }, null, 2));
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch { /* losing a setting is not worth failing a request */ }
  }

  setPaused(on: boolean): void { this.keeperPaused = on; this.#save(); }
  auto(root: string): boolean { return this.#auto.has(root); }
  autoRoots(): string[] { return [...this.#auto]; }
  setAuto(root: string, on: boolean): void { if (on) this.#auto.add(root); else this.#auto.delete(root); this.#save(); }
  suppress(key: string, title: string): void {
    if (this.isSuppressed(key, title)) return;
    this.#suppressed.push({ key, title }); if (this.#suppressed.length > 200) this.#suppressed.shift(); this.#save();
  }
  isSuppressed(key: string, title: string): boolean { return this.#suppressed.some((s) => s.key === key && s.title === title); }
}
