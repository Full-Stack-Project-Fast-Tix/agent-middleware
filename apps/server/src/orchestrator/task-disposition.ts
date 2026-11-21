import { z } from "zod";

/**
 * The specialist's final message is a machine-readable report, not evidence
 * that the requested work is correct. The orchestrator uses only this narrow
 * contract to decide whether dependent tasks may start.
 */
export const taskDispositionSchema = z.strictObject({
  status: z.enum(["complete", "incomplete"]),
  summary: z.string().trim().min(1).max(50_000),
});

export type TaskDisposition = z.infer<typeof taskDispositionSchema>;

/**
 * Accept JSON only. Markdown fences and surrounding prose are invalid. A Markdown
 * summary often arrives with raw line breaks inside the string, so those are escaped.
 */
export function parseTaskDisposition(output: string): TaskDisposition | null {
  try {
    return taskDispositionSchema.parse(JSON.parse(escapeRawBreaksInStrings(output)));
  } catch {
    return null;
  }
}

function escapeRawBreaksInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString && !escaped && (char === "\n" || char === "\r" || char === "\t")) {
      out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t";
      continue;
    }
    if (inString && !escaped && char === '"') inString = false;
    else if (!inString && char === '"') inString = true;
    escaped = inString && !escaped && char === "\\";
    out += char;
  }
  return out;
}
