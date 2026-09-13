import { basename } from "node:path";
import { stripAnsi } from "./shell.js";

/**
 * A tool result as one line, plus the body behind it. The line is what the
 * collapsed transcript shows — it has to answer "and?" for that tool without
 * opening anything. Rules per tool; the text block is the fallback.
 *
 * Inputs are what the SDK's user message carries: the tool_result block
 * (text or content blocks, is_error) and, when present, the tool's structured
 * output (`tool_use_result`), whose shape is per tool.
 */
export const RESULT_TEXT_CAP = 8 * 1024;
const LINE_CAP = 120;

export type ResultBlock = { tool_use_id: string; content?: unknown; is_error?: boolean };
export type Summarised = { ok: boolean; summary: string; text: string; bytes: number; truncated: boolean; interrupted: boolean; where?: string };

/** Where a browser tool acted — "host · title" from the `at` stamp on its result. */
export function whereOf(name: string, text: string): string | undefined {
  if (!name.startsWith("mcp__browser__")) return undefined;
  const j = json(text) as { at?: { host?: string; title?: string } } | null;
  const at = j?.at;
  if (!at || typeof at.host !== "string" || !at.host) return undefined;
  return at.title ? `${at.host} · ${clip(at.title, 50)}` : at.host;
}

export function summariseResult(name: string, block: ResultBlock, structured: unknown): Summarised {
  const s = (structured && typeof structured === "object" ? structured : {}) as Record<string, unknown>;
  const { text: rawText, images } = flatten(block.content);
  const text = /^Bash$|^mcp__terminal__/.test(name) ? stripAnsi(rawText) : rawText;
  const ok = !block.is_error;
  const interrupted = s.interrupted === true;
  let summary: string;

  if (!ok) summary = "✗ " + firstLine(text || "failed");
  else if (interrupted) summary = "interrupted";
  else summary = describe(name, text, s, images);

  const bytes = Buffer.byteLength(text, "utf8");
  const truncated = text.length > RESULT_TEXT_CAP;
  const where = whereOf(name, text);
  return { ok, summary: clip(summary, LINE_CAP), text: truncated ? text.slice(0, RESULT_TEXT_CAP) : text, bytes, truncated, interrupted, ...(where ? { where } : {}) };
}

function describe(name: string, text: string, s: Record<string, unknown>, images: number): string {
  const lines = countLines(text);
  switch (name) {
    case "Bash": {
      const out = typeof s.stdout === "string" ? stripAnsi(s.stdout) : text;
      const first = firstLine(out);
      return first || (s.noOutputExpected ? "(no output expected)" : "(no output)");
    }
    case "Read": {
      if (s.type === "image") return "image";
      const f = s.file as { numLines?: number; totalLines?: number; startLine?: number } | undefined;
      if (f?.numLines !== undefined) {
        const partial = f.totalLines !== undefined && f.totalLines > f.numLines;
        return `${f.numLines} lines${partial ? ` (of ${f.totalLines})` : ""}`;
      }
      return images ? "image" : `${lines} lines`;
    }
    case "Write": {
      const p = typeof s.filePath === "string" ? basename(s.filePath) : "";
      const n = typeof s.content === "string" ? countLines(s.content) : null;
      return `wrote ${p || "file"}${n !== null ? ` · ${n} lines` : ""}`;
    }
    case "Edit": case "MultiEdit": {
      const p = typeof s.filePath === "string" ? basename(s.filePath) : "";
      const patch = Array.isArray(s.structuredPatch) ? s.structuredPatch as { lines?: string[] }[] : [];
      let add = 0, del = 0;
      for (const h of patch) for (const l of h.lines ?? []) { if (l.startsWith("+")) add++; else if (l.startsWith("-")) del++; }
      return `edited ${p || "file"}${patch.length ? ` · +${add} −${del}` : ""}`;
    }
    case "Grep": {
      if (/^no matches/i.test(text.trim()) || text.trim() === "") return "no matches";
      const m = text.match(/^Found (\d+) (?:files?|matches?|lines?)/i);
      return m ? firstLine(text) : `${lines} lines`;
    }
    case "Glob": return text.trim() === "" || /^no files/i.test(text) ? "no files" : `${lines} files`;
    case "TodoWrite": return "list updated";
    case "mcp__files__offer": { const m = text.match(/^Offered (.+?) \(/); return m ? `offered ${m[1]}` : firstLine(text); }
    case "Agent": case "Task": return /launched successfully/i.test(text) ? "running in the background" : firstLine(text);
    case "mcp__terminal__read": { const m = text.match(/^Last (\d+) lines/); return m ? `${m[1]} lines` : firstLine(text); }
    case "mcp__browser__read_page": {
      const j = json(text) as { title?: string; text?: string; kind?: string; pages?: number; mode?: string; count?: number; forms?: { fields?: unknown[] }[] } | null;
      if (!j) return firstLine(text);
      const t = clip(j.title || "(untitled)", 60);
      if (j.mode === "links") return `${t} · ${j.count ?? 0} links`;
      if (j.mode === "tables") return `${t} · ${j.count ?? 0} table${j.count === 1 ? "" : "s"}`;
      if (j.mode === "forms") { const fields = (j.forms ?? []).reduce((n, f) => n + (f.fields?.length ?? 0), 0); return `${t} · ${j.count ?? 0} form${j.count === 1 ? "" : "s"} · ${fields} fields`; }
      return `${t} · ${j.kind === "pdf" ? `PDF · ${j.pages} page${j.pages === 1 ? "" : "s"} · ` : j.mode === "markdown" ? "markdown · " : ""}${(j.text ?? "").length.toLocaleString()} chars`;
    }
    case "mcp__browser__screenshot": { const j = json(text) as { width?: number; height?: number; bytes?: number } | null; return j ? `image${j.width ? ` · ${j.width}×${j.height}` : ""}${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ""}` : firstLine(text); }
    case "mcp__browser__upload": { const j = json(text) as { uploaded?: string; bytes?: number; files?: string[] } | null; return j?.uploaded ? `uploaded ${j.uploaded}${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ""}${j.files && j.files.length > 1 ? ` · ${j.files.length} files chosen` : ""}` : firstLine(text); }
    case "mcp__browser__download": { const j = json(text) as { name?: string; bytes?: number } | null; return j?.name ? `saved ${j.name}${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ""}` : firstLine(text); }
    case "mcp__browser__find": { const j = json(text) as { count?: number; matches?: { text?: string; name?: string }[]; error?: string } | null; if (!j) return firstLine(text); if (j.error) return j.error; const first = j.matches?.[0]; return `${j.count ?? 0} match${j.count === 1 ? "" : "es"}${first ? ` · ${clip(first.name || first.text || "", 60)}` : ""}`; }
    case "mcp__browser__handle_dialog": { const j = json(text) as { handled?: boolean; type?: string; message?: string; reason?: string } | null; if (!j) return firstLine(text); return j.handled ? `answered ${j.type ?? "dialog"}${j.message ? ` "${clip(j.message, 50)}"` : ""}` : `✗ ${j.reason ?? "not handled"}`; }
    case "mcp__browser__wait_for": { const j = json(text) as { ok?: boolean; elapsedMs?: number; text?: string; timeout?: boolean } | null; if (!j) return firstLine(text); const s = ((j.elapsedMs ?? 0) / 1000).toFixed(1); return j.ok ? `ready after ${s}s${j.text ? ` · "${clip(j.text, 40)}"` : ""}` : `✗ timed out after ${s}s`; }
    case "mcp__browser__scroll": { const j = json(text) as { percent?: number; atBottom?: boolean; atTop?: boolean } | null; return j && typeof j.percent === "number" ? `${j.atBottom ? "bottom" : j.atTop ? "top" : `${j.percent}%`}` : firstLine(text); }
    case "mcp__browser__browser_batch": { const j = json(text) as { steps?: number; failed?: number; results?: { tool?: string; ok?: boolean; skipped?: number }[] } | null; if (!j || typeof j.steps !== "number") return firstLine(text); const tools = (j.results ?? []).filter((r) => r.tool).map((r) => `${r.tool}${r.ok === false ? "✗" : ""}`); const skipped = (j.results ?? []).find((r) => typeof r.skipped === "number")?.skipped; return `${j.steps} step${j.steps === 1 ? "" : "s"}${j.failed ? ` · ${j.failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""} · ${clip(tools.join(" → "), 70)}`; }
    case "mcp__browser__fill_form": { const j = json(text) as { filled?: number; total?: number; results?: { ok: boolean; field: string; error?: string }[] } | null; if (!j || typeof j.filled !== "number") return firstLine(text); const missed = (j.results ?? []).filter((r) => !r.ok); return missed.length ? `filled ${j.filled} of ${j.total} · ${missed.map((r) => `${r.field}: ${r.error ?? "failed"}`).join("; ")}` : `filled ${j.filled} field${j.filled === 1 ? "" : "s"}`; }
    case "mcp__browser__open_tab": { const j = json(text) as { tabId?: number; url?: string } | null; return j?.tabId != null ? `opened tab ${j.tabId}${j.url ? ` · ${clip(j.url, 60)}` : ""}` : firstLine(text); }
    case "mcp__browser__close_tab": { const j = json(text) as { closed?: boolean; title?: string } | null; return j?.closed ? `closed${j.title ? ` · ${clip(j.title, 50)}` : ""}` : firstLine(text); }
    case "mcp__browser__focus_tab": { const j = json(text) as { focused?: boolean; title?: string } | null; return j?.focused ? `focused${j.title ? ` · ${clip(j.title, 50)}` : ""}` : firstLine(text); }
    case "mcp__browser__back": case "mcp__browser__forward": case "mcp__browser__reload": { const j = json(text) as { url?: string; loading?: boolean } | null; return j?.url ? `${j.loading ? "loading " : ""}${clip(j.url, 70)}` : firstLine(text); }
    case "mcp__browser__list_tabs": { const j = json(text); return Array.isArray(j) ? `${j.length} tabs` : firstLine(text); }
    case "mcp__browser__snapshot": { const j = json(text) as { elements?: unknown[] } | unknown[] | null; const n = Array.isArray(j) ? j.length : Array.isArray((j as { elements?: unknown[] })?.elements) ? (j as { elements: unknown[] }).elements.length : null; return n !== null ? `${n} elements` : firstLine(text); }
    default: return images && !text.trim() ? "image" : (firstLine(text) || "(empty)");
  }
}

/** Text out of a tool_result's content (string or blocks); how many images rode along. */
function flatten(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let images = 0; const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const t = (b as { type?: string; text?: string });
    if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
    else if (t.type === "image") images++;
  }
  return { text: parts.join("\n"), images };
}

function firstLine(t: string): string { return (t.split("\n").find((l) => l.trim() !== "") ?? "").trim(); }
function countLines(t: string): number { const s = t.replace(/\n+$/, ""); return s === "" ? 0 : s.split("\n").length; }
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function json(t: string): unknown { try { return JSON.parse(t); } catch { return null; } }
function fmtBytes(n: number): string { return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`; }
