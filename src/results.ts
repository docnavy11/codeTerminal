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
export type Summarised = { ok: boolean; summary: string; text: string; bytes: number; truncated: boolean; interrupted: boolean };

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
  return { ok, summary: clip(summary, LINE_CAP), text: truncated ? text.slice(0, RESULT_TEXT_CAP) : text, bytes, truncated, interrupted };
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
    case "Agent": case "Task": return /launched successfully/i.test(text) ? "running in the background" : firstLine(text);
    case "mcp__terminal__read": { const m = text.match(/^Last (\d+) lines/); return m ? `${m[1]} lines` : firstLine(text); }
    case "mcp__browser__read_page": { const j = json(text) as { title?: string; text?: string; kind?: string; pages?: number } | null; return j ? `${clip(j.title || "(untitled)", 60)} · ${j.kind === "pdf" ? `PDF · ${j.pages} page${j.pages === 1 ? "" : "s"} · ` : ""}${(j.text ?? "").length.toLocaleString()} chars` : firstLine(text); }
    case "mcp__browser__screenshot": { const j = json(text) as { width?: number; height?: number; bytes?: number } | null; return j ? `image${j.width ? ` · ${j.width}×${j.height}` : ""}${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ""}` : firstLine(text); }
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
