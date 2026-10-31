import { z } from "zod";
import { RUN_SUMMARY_PROMPT_LENGTH } from "@launchpad/shared";
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

export function summaryPrompt(prompt: string): string {
  return prompt.length <= RUN_SUMMARY_PROMPT_LENGTH ? prompt : prompt.slice(0, RUN_SUMMARY_PROMPT_LENGTH - 1) + "…";
}
