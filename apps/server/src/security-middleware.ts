import type {
  ApprovalStatus,
  EffectivePolicy,
  FindingSeverity,
  ProposedAction,
  SecurityContext,
  SecurityDecision,
} from "@launchpad/shared";
import type { Finding } from "./checks.js";
import type { TraceRecord } from "./trace.js";
import type { TurnSecurityPolicy } from "./turn-security-policy.js";

// The security middleware as the orchestrator (P2) and runtime see it. P1
// implements it around the existing guards; P2 calls it. The data shapes are in
// @launchpad/shared (middleware.ts); these interfaces stay server-side because
// they take raw trace records.
//
// Decisions behind this shape: docs/contract-decisions.md.

/** The effective policy plus the runtime settings that decide whether gates fire at all. */
export interface ResolvedPolicy extends EffectivePolicy {
  /**
   * Chosen by the middleware, never the orchestrator. For example a
   * workspace-write sandbox exposes file changes within the isolated run
   * workspace; `untrusted` approval ensures proposals reach evaluate() before
   * application. Capabilities decide whether a gated action is allowed, not
   * whether the gate fires.
   */
  runtime: TurnSecurityPolicy;
}

export interface SecurityMiddleware {
  /**
   * Called once per AgentExecution, before launch. The orchestrator configures
   * the runtime from `runtime`, schedules on `capabilities.write` (write-capable
   * work is serialised), and stores `capabilities` on the execution.
   */
  resolvePolicy(workspaceId: string, agentId: string): Promise<ResolvedPolicy>;

  /**
   * Start guarding one execution. The guard keeps what the existing checks
   * need across the whole execution (the raw trace, accumulated semantic risk,
   * strike counts, denied actions), and run-level state such as tainted values,
   * so a secret seen by one agent is still caught after it reaches another.
   */
  openExecution(context: SecurityContext): Promise<ExecutionGuard>;
}

export interface ExecutionGuard {
  /** Add explicitly granted vault values to run-scoped exact-value taint, without marking a workspace secret-file read. */
  seedSensitiveValues?(values: readonly string[]): void;
  /**
   * Before a gated action runs. The runtime calls this for commands and file
   * changes; the orchestrator calls it for delegation and context_handoff.
   */
  evaluate(action: ProposedAction): Promise<SecurityDecision>;

  /**
   * Every raw trace record, in order, as it arrives. Returns a decision when
   * the record itself warrants one: a steer on drifting reasoning, or a stop
   * after an effect that skipped the approval gate.
   */
  observe(record: TraceRecord): Promise<SecurityDecision | null>;

  /**
   * How a human answered a require_approval for `actionId`. Returns what
   * happens to the action now: allow when approved; otherwise a block with
   * stop "action" and a steer telling the agent not to retry it.
   */
  recordApprovalOutcome(actionId: string, outcome: Exclude<ApprovalStatus, "pending">): Promise<SecurityDecision>;

  /** Fold deterministic findings into the Agent's bounded, structured reflection memory. */
  complete?(threadId: string | null): Promise<void>;

  close(): Promise<void>;
}

/**
 * The existing guards' severity on the shared scale. Guards keep their own
 * three-level Severity (benchmark replays stay byte-identical); findings are
 * converted here on the way out. `violation` meant "blocked" rather than a
 * risk grade; the block itself is now the decision's outcome.
 */
export function sharedSeverityOf(finding: Pick<Finding, "severity" | "code">): FindingSeverity {
  // An effect that ran without the pre-execution gate being observed.
  if (finding.code.startsWith("ungated-")) return "critical";
  switch (finding.severity) {
    case "info":
      return "info";
    case "warn":
      return "medium";
    case "violation":
      return "high";
  }
}
