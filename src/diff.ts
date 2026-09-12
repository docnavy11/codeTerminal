import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

/**
 * What an Edit/Write would do to a file, computed *before* the user approves
 * it: the approval card used to print the tool's JSON input, which for an
 * Edit is two blobs of text with no indication of where in the file they sit.
 *
 * Edit: old_string is located in the current file and the change is shown in
 * place with context. Write: a line diff against the current content, or the
 * whole new file when it does not exist yet. Read failures degrade to a note
 * — never to a blocked approval.
 */
export type DiffLine = { t: " " | "+" | "-" | "@"; s: string };
export type Diff = {
  path: string;            // relative to cwd when under it
  kind: "edit" | "write" | "create";
  lines: DiffLine[];
  adds: number;
  dels: number;
  truncated: boolean;
  note?: string;           // why there is no (full) diff
};

export const DIFF_MAX_LINES = 400;      // shown; beyond this the diff is cut with a note
const LCS_MAX = 1500;                   // per side; the DP is n*m
const CONTEXT = 3;

export async function previewDiff(tool: string, input: Record<string, unknown>, cwd: string, read = readFile): Promise<Diff | null> {
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return null;
  const fp = typeof input.file_path === "string" ? input.file_path : null;
  if (!fp) return null;
  const abs = resolve(cwd, fp);
  const rel = relative(cwd, abs);
  const path = rel && !rel.startsWith("..") ? rel : abs;

  let current: string | null;
  try { current = (await read(abs, "utf8")) as string; }
  catch (e) { current = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined as unknown as null; if (current === undefined) return { path, kind: tool === "Write" ? "write" : "edit", lines: [], adds: 0, dels: 0, truncated: false, note: `could not read the file (${(e as Error).message})` }; }

  if (tool === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    if (current === null) return finish(path, "create", splitLines(content).map((s) => ({ t: "+", s })));
    if (current === content) return { path, kind: "write", lines: [], adds: 0, dels: 0, truncated: false, note: "identical to the current file" };
    const a = splitLines(current), b = splitLines(content);
    if (a.length > LCS_MAX || b.length > LCS_MAX) return { path, kind: "write", lines: [], adds: b.length, dels: a.length, truncated: true, note: `rewrites the whole file (${a.length} → ${b.length} lines); too large to diff here` };
    return finish(path, "write", lineDiff(a, b));
  }

  // Edit / MultiEdit: apply in memory, then diff old vs new — exact, no LCS
  // needed for a single edit, and it shows where in the file the change sits.
  if (current === null) return { path, kind: "edit", lines: [], adds: 0, dels: 0, truncated: false, note: "the file does not exist" };
  const edits = tool === "MultiEdit"
    ? (Array.isArray(input.edits) ? input.edits as { old_string?: unknown; new_string?: unknown; replace_all?: unknown }[] : [])
    : [input];
  let next = current;
  for (const e of edits) {
    const oldS = typeof e.old_string === "string" ? e.old_string : "", newS = typeof e.new_string === "string" ? e.new_string : "";
    if (oldS === "") continue;
    if (!next.includes(oldS)) return { path, kind: "edit", lines: [], adds: 0, dels: 0, truncated: false, note: "old_string was not found in the file — the edit would fail" };
    next = e.replace_all === true ? next.split(oldS).join(newS) : next.replace(oldS, () => newS);
  }
  const a = splitLines(current), b = splitLines(next);
  if (a.length > LCS_MAX || b.length > LCS_MAX) {
    // Big file: diff only the window around the change — find the first and last differing lines.
    let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const wa = a.slice(Math.max(0, head - CONTEXT), a.length - tail + CONTEXT), wb = b.slice(Math.max(0, head - CONTEXT), b.length - tail + CONTEXT);
    if (wa.length > LCS_MAX || wb.length > LCS_MAX) return { path, kind: "edit", lines: [], adds: b.length - a.length, dels: 0, truncated: true, note: "change too large to diff here" };
    const lines = lineDiff(wa, wb, Math.max(0, head - CONTEXT));
    return finish(path, "edit", lines);
  }
  return finish(path, "edit", lineDiff(a, b));
}

function finish(path: string, kind: Diff["kind"], lines: DiffLine[]): Diff {
  const adds = lines.filter((l) => l.t === "+").length, dels = lines.filter((l) => l.t === "-").length;
  const truncated = lines.length > DIFF_MAX_LINES;
  return { path, kind, lines: truncated ? lines.slice(0, DIFF_MAX_LINES) : lines, adds, dels, truncated };
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();   // a trailing newline is not an extra line
  return parts;
}

/** LCS line diff with `CONTEXT` lines around each change and @ markers between hunks. `offset` numbers the first line. */
export function lineDiff(a: string[], b: string[], offset = 0): DiffLine[] {
  const n = a.length, m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
  }
  const ops: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", s: a[i] }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { ops.push({ t: "-", s: a[i] }); i++; }
    else { ops.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: "-", s: a[i++] }); }
  while (j < m) { ops.push({ t: "+", s: b[j++] }); }
  // keep only context around changes
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== " ") for (let c = Math.max(0, k - CONTEXT); c <= Math.min(ops.length - 1, k + CONTEXT); c++) keep[c] = true; });
  const out: DiffLine[] = [];
  let lineNo = offset, lastKept = -2;
  ops.forEach((o, k) => {
    if (o.t !== "+") lineNo++;
    if (!keep[k]) return;
    if (k !== lastKept + 1) out.push({ t: "@", s: `line ${o.t === "+" ? lineNo + 1 : lineNo}` });
    out.push(o); lastKept = k;
  });
  return out;
}
