import { z } from "zod";
import { RUN_SUMMARY_PROMPT_LENGTH } from "@launchpad/shared";
import { redactText } from "./redaction/index.js";
import { HttpError } from "./errors.js";

// What both run stores share for GET /api/workspaces/:workspaceId/runs. The
// cursor is a position in the created_at DESC, id DESC order; opaque to clients.

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.guid() });
export type RunCursor = z.infer<typeof cursorSchema>;

export function encodeRunCursor(run: RunCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: run.createdAt, id: run.id })).toString("base64url");
}

export function decodeRunCursor(cursor: string): RunCursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(400, "Unknown cursor");
  }
}

/** How much of a prompt to load for a summary: enough that a secret crossing the cut still matches its pattern. */
export const RUN_SUMMARY_PROMPT_READ_LENGTH = RUN_SUMMARY_PROMPT_LENGTH + 512;

/** Redacts first: cutting first could shorten a secret until its pattern no longer matches. */
export function summaryPrompt(prompt: string): string {
  const { text } = redactText(prompt);
  return text.length <= RUN_SUMMARY_PROMPT_LENGTH ? text : text.slice(0, RUN_SUMMARY_PROMPT_LENGTH - 1) + "…";
}
