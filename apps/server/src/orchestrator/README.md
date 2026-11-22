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
| `orchestrator.ts` | `Orchestrator`: `createRun`, `resolveApproval`, `expireApproval`, `cancel`, `whenSettled`. Runs planning, scheduling, executions, approvals and cancellation, and enforces `lifecycle.ts` on every status change. After the last execution stops it runs the final review of the actual diff outside the Run's lock (a cancel aborts it) and saves the outcome on `Run.finalReview` for every terminal path (contract decision 35). |
| `plan.ts` | The supervisor plan schema and `validatePlan`: registered and enabled agents only, never the supervisor itself, no cycles, within `maxTasks`. Pure. |
| `scheduler.ts` | `tasksToMarkReady`, `tasksToSkip`, `pickLaunches`: dependency order, skipping downstream of a failure, `maxParallel`, one writer at a time. Pure. |
| `planner.ts` | `ModelPlanner`: one tool-less model call returning the plan as JSON. It sees the request and the agent catalogue, never workspace content. |
| `task-prompt.ts` | What a specialist is told: its objective, earlier results fenced with a per-prompt nonce and marked as data, and the required final disposition report. |
| `task-disposition.ts` | Strictly validates whether a specialist reports its Task complete or incomplete. |
| `ports.ts` | The interfaces the orchestrator depends on: `RunStore`, `AgentDirectory`, `ExecutionRuntime`, `WorkingCopies`, `RunDiffReviewer` and `ActionGate`. |
| `in-memory-run-store.ts` | `RunStore` in memory, publishing RunEvents with per-run seqs. Used by tests and by the in-memory `dev:demo`; real Runs use `PostgresRunStore`. |
| `claude-execution-runtime.ts` | `ClaudeExecutionRuntime`, an agent loop on this host over the Messages API, with tools in one disposable container per execution. Writes JSON-RPC-shaped trace records. |
| `working-copies.ts` | `DirectoryWorkingCopies`: copies the configured source for the first Run and the latest successful Run's copy for each follow-up to `<root>/<runId>/workspace`. Skips dependencies, local tool/credential stores (`credential-names.ts`), environment secrets, and common private-key files; keeps example environment templates and copies other symlinks as links. Takes the bounded baseline (`workspace-snapshot.ts`) only when it creates the copy, and serves the Run's diff artifact (`run-diff.ts`) once execution has stopped. |

Outside this folder: `../claude-tool-sandbox.ts` is Claude's container and
`../claude-editor.ts` turns its file edits into the diffs the gate evaluates.
`../run-routes.ts` holds the HTTP routes.

## What goes through the middleware

| Action | Evaluated on | By |
| --- | --- | --- |
| `delegation` | the supervisor's execution, before the Task is created | orchestrator |
| `context_handoff` | the receiving execution, before its prompt is built | orchestrator |
| `command`, `file_change` | the acting execution, before the action runs | runtime, through `ActionGate.decide`. On Claude, the editor's `view` counts as a `command`: the read it is equivalent to. |

A blocked or denied delegation creates no Task, and nothing that depends on it
is created either. A blocked handoff withholds that result from the prompt.

## Rules worth knowing

- **Retries.** An attempt that crashes is retried as a new AgentExecution, up
  to `maxAttempts`. It is never retried after the middleware stopped it, or
  after any action in it was blocked, denied or timed out. A retry must not
  become a way around the middleware.
- **Failures.** When a Task fails, its dependents are skipped. Running work
  finishes, nothing new starts, and the Run fails.
- **Completion reports.** An agent turn ending successfully completes its
  AgentExecution. Its Task completes only when the final response is the strict
  JSON disposition requested by `task-prompt.ts` with status `complete`.
  `incomplete`, missing and malformed reports fail the Task without retrying.
- **Approvals.** `Run.waiting_approval` is held while any approval is pending,
  and the Run returns to the phase it left. Approval bookkeeping is serialised
  per Run, so parallel executions cannot leave the Run status out of step with
  the pending approvals.
- **Policy.** It is resolved once per execution and snapshotted on
  `AgentExecution.capabilities`. The scheduler serialises on
  `capabilities.write`. The runtime settings come from the middleware, never
  from here. When the resolved policy denies network, the tool container gets no
  network.
- **The runtime fails closed.** The runtime refuses to start unless the policy
  is `workspace-write` sandbox with `untrusted` approvals, and a gate that throws
  declines the action and ends the turn. The
  model can only act by asking the loop, so no tool runs without a decision.
  A model refusal, a truncated response, an unknown stop reason or an exhausted
  limit fails the execution, and a tool call from such a turn never runs.
- **Claude's limits** are per execution: model turns, tokens per call, total input
  and output tokens, model and tool time, command time, and tool output size
  (`CLAUDE_*` in `.env.example`). Time waiting at the gate does not count. An
  execution that fails on a limit is retried like any other crash, up to
  `maxAttempts`, so a limit bounds an attempt, not a Task.
- **Fresh thread per execution.** Context moves between agents only through
  results the middleware has evaluated. An agent's configured instructions
  travel in its prompt, because a shared working copy has no per-agent
  `AGENTS.md`.
- **Approval timeouts.** `startApprovalSweep` runs `expireDueApprovals`
  periodically: one query for overdue approvals, not a timer per approval.

- **Final output.** The Run's result is what its final tasks produced: the
  ones no other task depends on. A plan that ends with a review task reports
  that review. No extra model call summarises, which would cost tokens and
  give agent output one more way to steer what the user is told.
- **Restart recovery.** `recoverInterruptedRuns()` at startup fails every Run
  a previous process left active, or cancels it if a cancel was requested,
  and closes its open work. Containers do not survive a restart, so nothing
  is resumed.

## Audit trail

Every event goes through `RunStore.appendAudit`, attributed to who caused it.

| Event | Actor | When |
| --- | --- | --- |
| `run.created` | user | `createRun` |
| `run.cancel_requested` | user (system if none) | first `cancel` |
| `run.status_changed` | system | every Run status change, with `from` and `to` |
| `task.created` | the delegating agent, or system | each Task |
| `task.status_changed` | system | every Task status change |
| `execution.started` | agent | launch, with attempt, capabilities and applied policies |
| `execution.finished` | agent | terminal status, with error and trace path |
| `delegation.requested` | supervisor | before the middleware evaluates it |
| `security.decision` | agent | every final decision from `evaluate`, and every non-null one from `observe` |
| `approval.requested` | agent | an approval is opened |
| `approval.resolved` | user, or system for timeouts and cancels | an approval is answered |

Metadata holds ids, statuses, finding codes and redacted, bounded text only.
Commands, diffs and results stay in the trace and the entities themselves.

## Contract surface (frozen at the end of Week 10)

Changing any of these is a contract change: record it in
`docs/contract-decisions.md`.

- **RunEvents** come only from `RunStore` writes. The orchestrator emits no
  event types beyond those in `packages/shared/src/events.ts`.
- **HTTP:** the routes in `../run-routes.ts`, exactly as in `api.ts`.
- **`RunStore`, `AgentDirectory`, `ExecutionRuntime`, `WorkingCopies`** in
  `ports.ts`. P3 implemented the first two against PostgreSQL.
- **Audit:** the table above.

## Wiring it into the server

`../postgres-runs.ts` builds the orchestrator with P3's PostgreSQL
repositories, P1's middleware, the model planner, the Claude runtime and per-Run working copies. `index.ts` uses it with `APP_AUTH_MODE=password`,
recovers interrupted Runs before it listens, and starts the approval sweep.

## Still to do

- **Nested delegation:** specialists cannot delegate yet, so the effective
  depth is deliberately 1 whatever `maxDelegationDepth` allows. Enabling it
  requires trusted parent/child lineage and middleware coverage at every hop.

## Tests

`apps/server/tests/orchestrator/`. The end-to-end scenarios use the
integration harness's `ScriptedMiddleware` and check every Run with
`checkRunInvariants`, so they hold the orchestrator to the same rules as the
Gate 1 scenarios.

`fuzz.test.ts` plays 250 seeded random Runs (random plans, decisions, crashes,
approval timing and cancels) against those invariants plus safety properties
such as "no refused action ran" and "no retry after a refusal". They run on the
in-memory store, and also on `PostgresRunStore` when `TEST_DATABASE_URL` is set,
which reaches races the in-memory store cannot. Results, load
measurements and mutation checks are in
[docs/orchestration-evaluation.md](../../../../docs/orchestration-evaluation.md).
