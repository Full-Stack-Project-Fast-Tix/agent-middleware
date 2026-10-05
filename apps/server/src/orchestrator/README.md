# Orchestrator

Runs one user request (a Run) as Tasks executed by Agents. Owned by P2.

- **`single`**: one Task for the named Agent.
- **`auto`**: the supervisor plans. Each planned Task is a delegation the
  security middleware evaluates before the Task exists. The scheduler then
  runs the Tasks in dependency order.

The orchestrator decides what happens next. Whether an action may happen is
always the middleware's decision
([contract decisions](../../../../docs/contract-decisions.md)).

## Files

| File | What it does |
| --- | --- |
| `orchestrator.ts` | `Orchestrator`: `createRun`, `resolveApproval`, `expireApproval`, `cancel`, `whenSettled`. Runs planning, scheduling, executions, approvals and cancellation, and enforces `lifecycle.ts` on every status change. |
| `plan.ts` | The supervisor plan schema and `validatePlan`: registered and enabled agents only, never the supervisor itself, no cycles, within `maxTasks`. Pure. |
| `scheduler.ts` | `tasksToMarkReady`, `tasksToSkip`, `pickLaunches`: dependency order, skipping downstream of a failure, `maxParallel`, one writer at a time. Pure. |
| `planner.ts` | `ModelPlanner`: one tool-less model call returning the plan as JSON. It sees the request and the agent catalogue, never workspace content. |
| `task-prompt.ts` | What a specialist is told: its objective, plus earlier results fenced with a per-prompt nonce and marked as data. |
| `ports.ts` | The interfaces the orchestrator depends on: `RunStore`, `AgentDirectory`, `ExecutionRuntime` and `ActionGate`. |
| `in-memory-run-store.ts` | `RunStore` in memory, publishing RunEvents with per-run seqs. Used until the PostgreSQL repositories land. |

## What goes through the middleware

| Action | Evaluated on | By |
| --- | --- | --- |
| `delegation` | the supervisor's execution, before the Task is created | orchestrator |
| `context_handoff` | the receiving execution, before its prompt is built | orchestrator |
| `command`, `file_change` | the acting execution, before the action runs | runtime, through `ActionGate.decide` |

A blocked or denied delegation creates no Task, and nothing that depends on it
is created either. A blocked handoff withholds that result from the prompt.

## Rules worth knowing

- **Retries.** An attempt that crashes is retried as a new AgentExecution, up
  to `maxAttempts`. It is never retried after the middleware stopped it, or
  after any action in it was blocked, denied or timed out. A retry must not
  become a way around the middleware.
- **Failures.** When a Task fails, its dependents are skipped. Running work
  finishes, nothing new starts, and the Run fails.
- **Approvals.** `Run.waiting_approval` is held while any approval is pending,
  and the Run returns to the phase it left. Approval bookkeeping is serialised
  per Run, so parallel executions cannot leave the Run status out of step with
  the pending approvals.
- **Policy.** It is resolved once per execution and snapshotted on
  `AgentExecution.capabilities`. The scheduler serialises on
  `capabilities.write`. The runtime settings come from the middleware, never
  from here.

## Not yet wired (Week 9)

- **HTTP routes.** Register `POST /api/workspaces/:id/runs`, `cancel` and
  `approvals/:id/resolve` against `Orchestrator`, then swap it in for
  `ScriptedOrchestrator` in `tests/integration/harness/stand-in.ts`.
- **Codex runtime adapter.** An `ExecutionRuntime` over `ContainerCodexRunner`
  that feeds trace records to `ActionGate.observe` and calls
  `ActionGate.decide` at each approval request (`run-turn.ts`).
- **Per-run working copy.** `runs/<runId>/workspace`, prepared before the first
  execution.
- **Approval timeout sweep.** Calls `expireApproval` once `expiresAt` passes
  (contract decision: a database sweep, not in-process timers).
- **Restart recovery** for Runs that were active when the server stopped.

## Tests

`apps/server/tests/orchestrator/`. The end-to-end scenarios use the
integration harness's `ScriptedMiddleware` and check every Run with
`checkRunInvariants`, so they hold the orchestrator to the same rules as the
Gate 1 scenarios.
