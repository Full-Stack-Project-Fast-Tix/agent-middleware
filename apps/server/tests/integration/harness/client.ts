import { z } from "zod";
import {
  apiErrorSchema,
  apiPaths,
  approvalResponseSchema,
  followRunEvents,
  runResponseSchema,
  runSnapshotResponseSchema,
  type Approval,
  type ApprovalDecision,
  type CreateRunRequest,
  type Run,
  type RunEvent,
  type RunSnapshot,
} from "@launchpad/shared";
import { applyEvent, emptyView, type RunView } from "./view.js";

/** A running AgentGuard API the harness drives: the stand-in today, the real server later. */
export interface HarnessTarget {
  baseUrl: string;
  headers: Record<string, string>;
  workspaceId: string;
  close(): Promise<void>;
}

export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

/**
 * HTTP client for the Run API. Every response is checked against the shared
 * contract, error bodies included, so a scenario fails on the first shape a
 * frontend would trip over.
 */
export class HarnessClient {
  constructor(private readonly target: HarnessTarget) {}

  async createRun(body: CreateRunRequest): Promise<Run> {
    const path = apiPaths.runs(this.target.workspaceId);
    return (await this.call("POST", path, runResponseSchema, 201, body)).run;
  }

  async getSnapshot(runId: string): Promise<RunSnapshot> {
    return (await this.call("GET", apiPaths.runSnapshot(runId), runSnapshotResponseSchema, 200)).snapshot;
  }

  /** Idempotent; the run reaches `cancelled` asynchronously. */
  async cancelRun(runId: string): Promise<Run> {
    return (await this.call("POST", apiPaths.cancelRun(runId), runResponseSchema, 202)).run;
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    const path = apiPaths.resolveApproval(approvalId);
    return (await this.call("POST", path, approvalResponseSchema, 200, { decision })).approval;
  }

  /** Start following a Run's events from seq 1. */
  record(runId: string): RunRecorder {
    return new RunRecorder(this.target, runId);
  }

  private async call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    expectedStatus: number,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(this.target.baseUrl + path, {
      method,
      headers: { ...this.target.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);

    if (response.status !== expectedStatus) {
      const error = apiErrorSchema.safeParse(payload);
      const detail = error.success ? error.data.error : `error body breaks the contract: ${JSON.stringify(payload)}`;
      throw new ApiCallError(`${method} ${path} returned ${response.status}: ${detail}`, response.status, payload);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`${method} ${path} response breaks the contract:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }
}

/**
 * Follows one Run's event stream with the shared client and keeps the
 * complete event log plus the view a UI would build from it.
 */
export class RunRecorder {
  readonly events: RunEvent[] = [];
  readonly view: RunView = emptyView();
  private readonly controller = new AbortController();
  private readonly waiters = new Set<() => void>();
  private readonly following: Promise<void>;
  private failure: unknown = null;

  constructor(target: HarnessTarget, runId: string) {
    this.following = followRunEvents({
      url: target.baseUrl + apiPaths.runEvents(runId),
      afterSeq: 0,
      headers: target.headers,
      retryMs: 50,
      signal: this.controller.signal,
      onEvent: (event) => {
        this.events.push(event);
        applyEvent(this.view, event);
        this.notify();
      },
      onResync: async () => {
        throw new Error("Server asked for a resync: the recorder's log would have a gap");
      },
    }).catch((error: unknown) => {
      this.failure = error;
      this.notify();
    });
  }

  /**
   * Resolve with the first truthy result of `select`, re-checked after every
   * event. Rejects if the stream fails or nothing matches within `timeoutMs`.
   */
  waitFor<T>(select: (view: RunView) => T | null | undefined | false, timeoutMs = 5_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        settle();
      };
      const check = () => {
        if (this.failure) return finish(() => reject(this.failure));
        const value = select(this.view);
        if (value) finish(() => resolve(value));
      };
      const timer = setTimeout(() => {
        const last = this.events.at(-1);
        finish(() =>
          reject(new Error(`Timed out after ${timeoutMs}ms; last event was ${last ? `${last.seq} ${last.type}` : "none"}`)),
        );
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  /** Disconnect. Throws if the stream failed while recording. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.following;
    if (this.failure) throw this.failure;
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
