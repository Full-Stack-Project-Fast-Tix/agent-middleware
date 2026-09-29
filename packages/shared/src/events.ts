import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";
import { agentExecutionSchema, runSchema, taskDependencySchema, taskSchema } from "./runs.js";
import { approvalSchema, securityFindingSchema } from "./security.js";

// Live Run updates, delivered over Server-Sent Events.
//
// Every event carries a full snapshot of the entity it concerns, so a client
// applies it by upserting on id: no per-transition reducer logic, and a
// missed intermediate event cannot leave the UI in an impossible state.
//
// Loading a Run Detail page:
//   1. GET the RunSnapshot; note lastEventSeq.
//   2. Open the event stream; apply only events with seq > lastEventSeq.
//   3. On reconnect, EventSource sends Last-Event-ID (= seq) so the server
//      can replay what was missed.

const envelope = {
  id: idSchema,
  runId: idSchema,
  /** Per-Run, strictly increasing from 1. Used as the SSE event id. */
  seq: z.number().int().positive(),
  timestamp: timestampSchema,
};

export const runUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal("run.updated"),
  payload: z.object({ run: runSchema }),
});

export const taskCreatedEventSchema = z.object({
  ...envelope,
  type: z.literal("task.created"),
  payload: z.object({ task: taskSchema, dependsOnTaskIds: z.array(idSchema) }),
});

export const taskUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal("task.updated"),
  payload: z.object({ task: taskSchema }),
});

export const executionUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal("execution.updated"),
  payload: z.object({ execution: agentExecutionSchema }),
});

export const findingCreatedEventSchema = z.object({
  ...envelope,
  type: z.literal("finding.created"),
  payload: z.object({ finding: securityFindingSchema }),
});

export const approvalRequestedEventSchema = z.object({
  ...envelope,
  type: z.literal("approval.requested"),
  payload: z.object({ approval: approvalSchema }),
});

export const approvalResolvedEventSchema = z.object({
  ...envelope,
  type: z.literal("approval.resolved"),
  payload: z.object({ approval: approvalSchema }),
});

export const runEventSchema = z.discriminatedUnion("type", [
  runUpdatedEventSchema,
  taskCreatedEventSchema,
  taskUpdatedEventSchema,
  executionUpdatedEventSchema,
  findingCreatedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

/** A RunEvent as the orchestrator publishes it; the server stamps id, seq and timestamp. */
export type RunEventDraft = {
  [T in RunEventType]: Omit<RunEventOf<T>, "id" | "seq" | "timestamp">;
}[RunEventType];

export const RUN_EVENT_TYPES = runEventSchema.options.map(
  (option) => option.shape.type.value,
) as readonly RunEventType[];

/** Everything the Run Detail page needs before it starts applying events. */
export const runSnapshotSchema = z.object({
  run: runSchema,
  tasks: z.array(taskSchema),
  dependencies: z.array(taskDependencySchema),
  executions: z.array(agentExecutionSchema),
  findings: z.array(securityFindingSchema),
  approvals: z.array(approvalSchema),
  /** Highest event seq already reflected in this snapshot; 0 if none. */
  lastEventSeq: z.number().int().nonnegative(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

/**
 * Wire format for one event. Events use the default SSE "message" type so a
 * client needs a single `onmessage` handler; the discriminator is in the data.
 */
export function encodeRunEventFrame(event: RunEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Sent instead of events when the server cannot replay from the client's
 * position: it restarted, or the replay buffer has moved past it. The client
 * reloads the RunSnapshot and reconnects from its lastEventSeq.
 */
export const RUN_STREAM_RESYNC_EVENT = "resync";

export function encodeResyncFrame(): string {
  return `event: ${RUN_STREAM_RESYNC_EVENT}\ndata: {}\n\n`;
}
