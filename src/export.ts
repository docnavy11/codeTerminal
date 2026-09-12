import type { ChatRecord } from "./store.js";
import type { ClientEvent } from "./protocol.js";

/**
 * A chat as a Markdown document: what was said, what the agent replied, and
 * the tool calls as one line each — the transcript as you would paste it into
 * a ticket or a notebook. Live-only events are not in the record anyway.
 */
export function toMarkdown(rec: ChatRecord, projectName?: string): string {
  const out: string[] = [];
  const when = new Date(rec.createdAt || rec.updatedAt || Date.now()).toISOString().slice(0, 16).replace("T", " ");
  const meta = [when, projectName ?? rec.project ?? "general", rec.cwd].filter(Boolean).join(" · ");
  out.push(`# ${rec.title}`, "", `_${meta}_`, "");
  let cost = 0;
  for (const e of rec.events as ClientEvent[]) {
    switch (e.kind) {
      case "user":
        out.push("**You**", "", e.text + (e.images?.length ? `\n\n_(${e.images.length} image${e.images.length === 1 ? "" : "s"} attached)_` : ""), "");
        if (e.context) out.push(`> ⌁ ${e.context.split("\n")[0]}`, "");
        break;
      case "text":
        out.push(e.text, "");
        break;
      case "thinking":
        out.push(`> 💭 ${e.text.replace(/\n/g, "\n> ")}`, "");
        break;
      case "tool":
        out.push(`- → \`${e.name}\` ${toolSummary(e.input)}`);
        break;
      case "task":
        if (e.state !== "running") out.push(`  - ↳ agent ${e.state}${e.toolUses ? ` · ${e.toolUses} tool uses` : ""}${e.summary ? ` — ${e.summary.split("\n")[0]}` : ""}`);
        break;
      case "tool_result":
        out.push(`  - ${e.ok ? "" : "✗ "}${e.summary.replace(/^✗ /, "")}`);
        break;
      case "local":
        out.push(`> ${e.text.replace(/\n/g, "\n> ")}`, "");
        break;
      case "watch":
        out.push(`> ⌁ watch fired — ${e.description}: ${e.detail}`, "");
        break;
      case "error":
        out.push(`> ⚠ ${e.message}`, "");
        break;
      case "turn_end": {
        if (typeof e.costUsd === "number") cost = "sessionCostUsd" in e ? cost + e.costUsd : Math.max(cost, e.costUsd);
        const tail = [e.stopped ? `stopped: ${e.stopped}` : "done", e.denials ? `${e.denials} denied` : null, `$${cost.toFixed(4)} est.`].filter(Boolean).join(" · ");
        out.push("", `_${tail}_`, "");
        break;
      }
      case "approval":
        if (e.tool === "ExitPlanMode" && typeof (e.input as { plan?: unknown })?.plan === "string") out.push("## Plan", "", (e.input as { plan: string }).plan, "");
        break;
      default: break;   // ready, commands, questions, cwd: session plumbing
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** One line for a tool call: the command, the path, or the JSON. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  const s = typeof pick === "string" ? pick : JSON.stringify(i);
  const one = s.replace(/\s+/g, " ").trim();
  return "`" + (one.length > 160 ? one.slice(0, 159) + "…" : one).replace(/`/g, "'") + "`";
}

/** A filesystem-safe name for the download. */
export function exportFilename(rec: ChatRecord): string {
  const stem = rec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
  return `${stem}.md`;
}
