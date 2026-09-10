import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * A four-word name for a conversation, from what the user asked.
 *
 * Naming from the first message *verbatim* is what produced "Reply with
 * exactly: sidepanel-ok" as the name of an eight-turn conversation. Asking a
 * model to name the subject fixes that without needing a reply to work from.
 *
 * Deliberately not waiting for the assistant's first reply: that reply is
 * usually a preamble ("I will look at the code first"), and waiting for
 * turn_end instead means a turn parked on an approval never gets titled at all.
 *
 * Runs on Haiku with no tools and no settings loaded: it is a one-shot naming
 * call, and giving it the full harness would cost more than the chat it names.
 */
export async function generateTitle(firstUser: string): Promise<string | null> {
  const prompt =
    `Name this conversation in three to five words, as a noun phrase describing ` +
    `the subject. No quotes, no trailing punctuation, no "chat about", do not ` +
    `answer the question. Reply with the title alone.\n\n` +
    `First message: ${firstUser.slice(0, 800)}`;

  try {
    let out = "";
    for await (const m of query({
      prompt,
      options: {
        model: "claude-haiku-4-5",
        settingSources: [],
        allowedTools: [],
        permissionPrompts: "none",
        maxTurns: 1,
      },
    })) {
      if (m.type === "assistant") {
        for (const b of m.message.content) if (b.type === "text") out += b.text;
      }
    }
    return clean(out);
  } catch {
    return null; // a missing title is not worth failing a turn over
  }
}

/** Models like to add quotes, trailing stops and helpful preambles. */
export function clean(raw: string): string | null {
  let t = raw.trim().split("\n")[0].trim();
  t = t.replace(/^["'`*]+|["'`*.]+$/g, "").trim();
  t = t.replace(/^(title|name)\s*[:\-–]\s*/i, "").trim();
  if (!t || t.length < 3) return null;
  const words = t.split(/\s+/);
  if (words.length > 8) t = words.slice(0, 8).join(" ");
  return t.length > 64 ? t.slice(0, 63).trimEnd() + "…" : t;
}
