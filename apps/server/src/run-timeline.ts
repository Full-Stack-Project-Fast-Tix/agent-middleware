import { z } from "zod";
import {
  actionTypeSchema,
  findingSeveritySchema,
  fileChangeSchema,
  RUN_TIMELINE_MAX_ENTRIES,
  RUN_TIMELINE_MAX_FILE_CHANGES,
  securityDecisionOutcomeSchema,
  type Approval,
  type AuditEvent,
  type JsonObject,
  type RunTimeline,
  type RunTimelineEntry,
  type TimelineProposal,
} from "@launchpad/shared";
import { redactSensitiveText } from "./redaction/index.js";

// GET /api/runs/:runId/timeline, built only from saved rows: `security.decision`
// and `delegation.requested` audit events, and approvals. Never from raw traces
// or the SSE replay buffer. The rows are already redacted and bounded when
// written; this applies both again, so an older or malformed row cannot widen
// what the API returns.

const decisionMetadataSchema = z.object({
  source: z.enum(["evaluate", "observe"]),
  actionType: actionTypeSchema.optional(),
  actionId: z.string().optional(),
  outcome: securityDecisionOutcomeSchema,
  severity: findingSeveritySchema,
  reason: z.string().min(1),
  stop: z.enum(["action", "execution"]).optional(),
  findingCodes: z.array(z.string()).default([]),
  proposed: z.unknown().optional(),
});

const savedDetailsSchemas = {
  command: z.object({ command: z.string().min(1), cwd: z.string().nullable().default(null) }),
  file_change: z.object({
    files: z.array(
      z.object({ path: z.string().min(1), kind: fileChangeSchema.shape.kind, movePath: z.string().nullable().default(null) }),
    ),
    filesTotal: z.number().int().nonnegative().optional(),
  }),
  delegation: z.object({ targetAgentId: z.guid(), title: z.string().min(1), objective: z.string().min(1) }),
  context_handoff: z.object({ fromTaskId: z.guid(), toTaskId: z.guid(), characters: z.number().int().nonnegative() }),
};

function safe(text: string, maximum: number): string {
  const redacted = redactSensitiveText(text);
  return redacted.length <= maximum ? redacted : redacted.slice(0, maximum - 1) + "…";
}

/** The saved details of one action as a proposal, or null when they are absent or malformed. */
function proposalFrom(type: RunTimelineEntry["actionType"], details: unknown): TimelineProposal | null {
  if (type === null || details === null || details === undefined) return null;
  switch (type) {
    case "command": {
      const parsed = savedDetailsSchemas.command.safeParse(details);
      if (!parsed.success) return null;
      return { type, command: safe(parsed.data.command, 500), cwd: parsed.data.cwd === null ? null : safe(parsed.data.cwd, 300) };
    }
    case "file_change": {
      const parsed = savedDetailsSchemas.file_change.safeParse(details);
      if (!parsed.success) return null;
      const files = parsed.data.files.slice(0, 50).map((file) => ({
        path: safe(file.path, 300),
        kind: file.kind,
        movePath: file.movePath === null ? null : safe(file.movePath, 300),
      }));
      return { type, files, filesTotal: Math.max(parsed.data.filesTotal ?? 0, parsed.data.files.length) };
    }
    case "delegation": {
      const parsed = savedDetailsSchemas.delegation.safeParse(details);
      if (!parsed.success) return null;
      return { type, targetAgentId: parsed.data.targetAgentId, title: safe(parsed.data.title, 120), objective: safe(parsed.data.objective, 1_000) };
    }
    case "context_handoff": {
      const parsed = savedDetailsSchemas.context_handoff.safeParse(details);
      return parsed.success ? { type, ...parsed.data } : null;
    }
  }
}

const actionKey = (executionId: string | null, actionId: string | null): string | null =>
  executionId === null || actionId === null ? null : `${executionId}:${actionId}`;

function approvalFacts(approval: Approval): NonNullable<RunTimelineEntry["approval"]> {
  return {
    id: approval.id,
    status: approval.status,
    reason: approval.reason,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    resolvedAt: approval.resolvedAt,
    resolvedByUserId: approval.resolvedByUserId,
  };
}

export function buildRunTimeline(saved: {
  /** `security.decision` events, oldest first, at most RUN_TIMELINE_MAX_ENTRIES. */
  decisions: readonly AuditEvent[];
  /** How many older decisions were left out of `decisions`. */
  omittedDecisions: number;
  /** `delegation.requested` events, the only saved text of a delegation that went to no person. */
  delegations: readonly AuditEvent[];
  approvals: readonly Approval[];
}): RunTimeline {
  const approvals = new Map<string, Approval>();
  for (const approval of saved.approvals) {
    const key = actionKey(approval.executionId, approval.actionId);
    if (key !== null) approvals.set(key, approval);
  }
  const delegations = new Map<string, JsonObject | null>();
  for (const event of saved.delegations) {
    const key = actionKey(event.executionId, typeof event.metadata?.actionId === "string" ? event.metadata.actionId : null);
    if (key !== null) delegations.set(key, event.metadata);
  }

  const entries: RunTimelineEntry[] = [];
  const decided = new Set<string>();
  let omitted = saved.omittedDecisions;

  for (const event of saved.decisions) {
    const metadata = decisionMetadataSchema.safeParse(event.metadata);
    if (!metadata.success) {
      // Evidence that cannot be read is reported as missing, never quietly dropped.
      omitted += 1;
      continue;
    }
    const { source, actionType = null, actionId = null, outcome, severity, reason, stop = null, findingCodes, proposed } = metadata.data;
    const key = actionKey(event.executionId, actionId);
    const approval = key === null ? undefined : approvals.get(key);
    if (key !== null) decided.add(key);
    entries.push({
      id: event.id,
      at: approval?.requestedAt ?? event.createdAt,
      taskId: event.taskId,
      executionId: event.executionId,
      agentId: event.actorType === "agent" ? event.actorId : null,
      source: source === "evaluate" ? "evaluated" : "observed",
      actionType,
      actionId,
      proposed:
        proposalFrom(actionType, proposed) ??
        proposalFrom(actionType, approval?.safeDetails) ??
        proposalFrom(actionType, key === null ? null : delegations.get(key)),
      decision: outcome,
      reason: safe(reason, 500),
      severity,
      stop,
      findingCodes: findingCodes.slice(0, 20).map((code) => safe(code, 120)),
      approval: approval === undefined ? null : approvalFacts(approval),
    });
  }

  // An approval with no final decision on record: still waiting, or ended by
  // cancellation or a restart before the decision was written.
  for (const [key, approval] of approvals) {
    if (decided.has(key)) continue;
    if (saved.omittedDecisions > 0 && approval.status !== "pending") {
      // Its decision may be among the omitted rows, already counted.
      continue;
    }
    entries.push({
      id: approval.id,
      at: approval.requestedAt,
      taskId: approval.taskId,
      executionId: approval.executionId,
      agentId: approval.agentId,
      source: "evaluated",
      actionType: approval.actionType,
      actionId: approval.actionId,
      proposed: proposalFrom(approval.actionType, approval.safeDetails),
      decision: "require_approval",
      reason: safe(approval.summary, 500),
      severity: null,
      stop: null,
      findingCodes: [],
      approval: approvalFacts(approval),
    });
  }

  entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
  const kept = entries.slice(-RUN_TIMELINE_MAX_ENTRIES);
  omitted += entries.length - kept.length;

  return { entries: kept, omittedEntries: omitted, fileChanges: fileChangesOf(kept) };
}

/** The latest gate decision for each file, newest last. A later allow replaces an earlier refusal. */
function fileChangesOf(entries: readonly RunTimelineEntry[]): RunTimeline["fileChanges"] {
  const items = new Map<string, RunTimeline["fileChanges"]["items"][number]>();
  let entriesWithoutFileList = 0;
  let unlistedFiles = false;
  let allowedCommands = 0;
  for (const entry of entries) {
    if (entry.actionType === "command" && (entry.decision === "allow" || entry.decision === "steer")) allowedCommands += 1;
    if (entry.actionType !== "file_change") continue;
    if (entry.proposed?.type !== "file_change") {
      entriesWithoutFileList += 1;
      continue;
    }
    if (entry.proposed.filesTotal > entry.proposed.files.length) unlistedFiles = true;
    for (const file of entry.proposed.files) {
      items.delete(file.path);
      items.set(file.path, {
        path: file.path,
        movePath: file.movePath,
        kind: file.kind,
        decision: entry.decision,
        entryId: entry.id,
        taskId: entry.taskId,
        at: entry.at,
      });
    }
  }
  const all = [...items.values()];
  return {
    items: all.slice(-RUN_TIMELINE_MAX_FILE_CHANGES),
    truncated: unlistedFiles || all.length > RUN_TIMELINE_MAX_FILE_CHANGES,
    entriesWithoutFileList,
    allowedCommands,
  };
}
