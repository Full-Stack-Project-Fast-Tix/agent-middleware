import path from "node:path";
import { z } from "zod";

// What the Anthropic-defined tools ask for, and how an edit becomes the file
// change the gate evaluates. Pure: no container, no model. The model-supplied
// input is untrusted, so it is validated here before anything can act on it.

export const BASH_TOOL_NAME = "bash";
export const EDITOR_TOOL_NAME = "str_replace_based_edit_tool";

export const bashInputSchema = z.union([
  z.strictObject({ restart: z.literal(true) }),
  z.strictObject({ command: z.string().min(1) }),
]);

export const editorInputSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("view"),
    path: z.string().min(1),
    view_range: z.tuple([z.number().int().min(1), z.number().int().min(-1)]).optional(),
  }),
  z.strictObject({ command: z.literal("create"), path: z.string().min(1), file_text: z.string() }),
  z.strictObject({
    command: z.literal("str_replace"),
    path: z.string().min(1),
    old_str: z.string().min(1),
    new_str: z.string().optional(),
  }),
  z.strictObject({
    command: z.literal("insert"),
    path: z.string().min(1),
    insert_line: z.number().int().min(0),
    insert_text: z.string(),
  }),
]);
export type EditorInput = z.infer<typeof editorInputSchema>;

/**
 * The absolute container path for a model-supplied one, or null if it leaves
 * /workspace. Any `..` is refused outright rather than resolved, because a
 * lexical answer can differ from what a symlink makes of the same path. The
 * container checks the path again before touching it.
 */
export function resolveWorkspacePath(raw: string): string | null {
  if (raw.includes("\0") || raw.trim() === "") return null;
  if (raw.split("/").includes("..")) return null;
  const absolute = raw.startsWith("/") ? raw : `/workspace/${raw}`;
  const normalized = path.posix.normalize(absolute).replace(/\/+$/, "");
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) return null;
  return normalized;
}

/** Text as UTF-8, or null for a file an editor should not treat as text. */
export function decodeText(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

export interface PlannedEdit {
  next: string;
  /** Unified-diff hunks, as the gate and the trace have always seen them. */
  diff: string;
}

/** One hunk replacing whole lines, starting at 1-based `startLine`. */
function hunk(startLine: number, before: string[], after: string[]): string {
  return [
    `@@ -${startLine},${before.length} +${startLine},${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function planOverwrite(current: string, next: string): PlannedEdit {
  return { next, diff: hunk(1, current.split("\n"), next.split("\n")) };
}

export function planStrReplace(current: string, oldStr: string, newStr: string): PlannedEdit | { error: string } {
  const first = current.indexOf(oldStr);
  if (first < 0) return { error: "No match for old_str. Nothing was changed." };
  if (current.indexOf(oldStr, first + oldStr.length) >= 0) {
    return { error: "old_str matches more than one place. Include more context so it matches exactly one. Nothing was changed." };
  }
  const next = current.slice(0, first) + newStr + current.slice(first + oldStr.length);
  // Widen to whole lines, so the hunk reads like any other diff.
  const lineStart = current.lastIndexOf("\n", first - 1) + 1;
  const lineEndAt = current.indexOf("\n", first + oldStr.length);
  const lineEnd = lineEndAt < 0 ? current.length : lineEndAt;
  const before = current.slice(lineStart, lineEnd).split("\n");
  const after = next.slice(lineStart, lineEnd + newStr.length - oldStr.length).split("\n");
  const startLine = current.slice(0, lineStart).split("\n").length;
  return { next, diff: hunk(startLine, before, after) };
}

export function planInsert(current: string, afterLine: number, text: string): PlannedEdit | { error: string } {
  const lines = current.split("\n");
  // A final newline leaves an empty last element that is not a line of the file.
  const lineCount = current.endsWith("\n") || current === "" ? lines.length - 1 : lines.length;
  if (afterLine > lineCount) {
    return { error: `insert_line ${afterLine} is past the end of the file (${lineCount} lines). Nothing was changed.` };
  }
  const inserted = text.replace(/\n$/, "").split("\n");
  lines.splice(afterLine, 0, ...inserted);
  return { next: lines.join("\n"), diff: hunk(afterLine + 1, [], inserted) };
}

/** A file's text with line numbers, as the view command returns it. */
export function formatFileView(text: string, range?: readonly [number, number]): string | { error: string } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = range?.[0] ?? 1;
  const end = range === undefined || range[1] === -1 ? lines.length : range[1];
  if (range !== undefined && (start > Math.max(lines.length, 1) || end < start)) {
    return { error: `view_range [${range[0]}, ${range[1]}] is outside the file (${lines.length} lines).` };
  }
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}\t${line}`)
    .join("\n");
}

/**
 * The read expressed as the command the gate and the checks already understand,
 * so `view .env` counts as reading .env exactly as `cat .env` does. Written to
 * stay inside the middleware's read-only command set.
 */
export function viewCommandText(target: string, range?: readonly [number, number]): string {
  const quoted = shellQuote(target);
  if (range === undefined) return `cat ${quoted}`;
  if (range[1] === -1) return `tail -n +${range[0]} ${quoted}`;
  return `sed -n '${range[0]},${range[1]}p' ${quoted}`;
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Keep the start and end of text within a byte budget. */
export function boundToolText(text: string, maxBytes: number): string {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  const half = Math.floor(maxBytes / 2);
  const head = buffer.subarray(0, half).toString("utf8");
  const tail = buffer.subarray(buffer.byteLength - half).toString("utf8");
  return `${head}\n[... ${size - half * 2} bytes omitted by AgentGuard ...]\n${tail}`;
}
