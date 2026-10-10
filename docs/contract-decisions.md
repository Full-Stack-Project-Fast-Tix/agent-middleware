# Contract decisions

Settled 30 September 2026. These decisions close the open questions left when
the shared contracts were first drafted
([packages/shared](../packages/shared/README.md)). Each proposal was reviewed
from three points of view against the existing code: P1 (security
middleware), P2 (orchestration) and P3 (data and platform). The contracts,
the server and the integration harness now follow these decisions.

To change one, open a PR that edits this file and the contract together, and
ask the owners named in the decision to review it.

## 1. The security interface is stateful, one guard per execution

**Decision:** Replace the stateless `SecurityEvaluator.evaluate({context, action})`
with `SecurityMiddleware.openExecution(context) → ExecutionGuard`. The guard has
four methods:

- `evaluate(action)`
- `observe(record)`, called for every raw trace record
- `recordApprovalOutcome(actionId, outcome)`
- `close()`

These interfaces are server-internal
([apps/server/src/security-middleware.ts](../apps/server/src/security-middleware.ts)),
because they take raw `TraceRecord`s. The data they exchange (context, action,
decision) is in `@launchpad/shared`.

**Why:** The existing guards cannot run from one action plus a summary:

- Checks read the whole raw trace (`checks.ts`).
- Secret-value egress matches values printed by earlier commands
  (`check-sensitive-egress.ts`).
- Semantic risk builds up over a turn (`intent-controller.ts`).
- The rule that a second blocked action stops the turn, and the memory of
  denied actions, are per-turn state (`run-turn.ts:141-147, 297-302`).

The runtime calls the guard for commands and file changes. The orchestrator
calls it for delegations and context handoffs.

## 2. SecurityContext carries identifiers only

**Decision:** `SecurityContext` is `{workspaceId, runId, taskId, executionId,
agentId}`. The middleware loads the trusted facts itself:

- `Run.userPrompt`
- the task and its delegation chain
- `Agent.instructions`
- the effective policy

It works out the recent trajectory and the untrusted sources from the records
it observes. `originalUserGoal`, `taskObjective`, `delegator`,
`recentTrajectory` and `recentSources` are gone from the contract.

**Why:** This is the same reason the middleware resolves policy itself. If
the orchestrator passes the "trusted" goal, text a README-steered supervisor
wrote can arrive as the goal the semantic guard checks against. Deciding which
sources are untrusted is security logic, and it belongs with P1.

## 3. Effective policy: resolved by P1, used by P2, snapshotted, cited

**Decision:**

- `SecurityMiddleware.resolvePolicy(workspaceId, agentId)` returns
  `{capabilities, appliedPolicies, runtime}`.
- For middleware-managed multi-agent executions, `runtime` always uses the
  read-only sandbox and `untrusted` approval policy. Every consequential action
  therefore reaches the guard before execution; capabilities determine whether
  the guard allows it, not whether the gate is enabled.
- P2 calls it once per execution. It configures the runtime from `runtime`,
  serialises work on `capabilities.write`, and stores `capabilities` on the
  new `AgentExecution.capabilities` field.
- Every `SecurityDecision` records `appliedPolicies: {policyId, version}[]`.
- `EffectivePolicy` (without `runtime`) is in shared for the Policies UI.

**Why:**

- The scheduler must know which work writes (plan 3.2). Having P2 compute that
  itself would duplicate P1's layering rules.
- The sandbox mode decides whether gates fire at all: `workspace-write`
  applies mutations without any approval request
  (`turn-security-policy.ts:29-30`). The orchestrator must not be the one
  choosing it.
- Audit has to explain an old decision after the policy has been edited.

**Not adopted:** a capability snapshot on every decision. The one on the
execution is enough, now that profiles carry a `version`.

## 4. Capabilities: `write`, `shell`, `network`, `delegate`, `maxDelegationDepth`

**Decision:**

- `read` is dropped.
- `maxDelegationDepth` is added.
- Layers combine by AND for booleans and minimum for numbers.
- `SecurityPolicy` gains a typed `capabilityCeiling` (a partial capability
  set) outside the untyped `rules`, so platform and workspace layers really do
  cap the profile.
- New flags are added with `.default(false)`.

**Why:**

- `read` cannot be enforced. Codex auto-approves known-safe read-only
  commands without a gate (`codex-protocol.ts:12-13`), so the UI would promise
  something nothing checks.
- Without a typed ceiling, only the profile is a boolean layer, and "AND
  across layers" means nothing.

**Not adopted:** also intersecting with the delegator's capabilities. The
plan's main flow is a supervisor that cannot write delegating to a developer
agent that can. Intersection would make that impossible. Delegation is
controlled instead in three ways:

- `delegate` is set only on supervisor profiles.
- `maxDelegationDepth` bounds the depth.
- Every delegation is evaluated against the original user goal.

## 5. Outcomes keep their names; `steer` proceeds, `block` has a scope

**Decision:**

- `steer`: the action proceeds, and the correction is sent to the agent.
- `block`: the action is refused, with `stop: "action" | "execution"` and an
  optional `steer`.
- "Warn" (plan Pillar C) is a finding with `intervened: false`.

**Why:**

- In the existing runtime, steer never blocks. The correction is sent and the
  action runs (`run-turn.ts:383-389`).
- Stopping the whole execution is a separate existing outcome: the second
  distinct block interrupts the turn (`run-turn.ts:297-302`). Without `stop`,
  P2 would have to reimplement that rule.

## 6. Severity: five ordered levels, fixed mapping from the guards

**Decision:**

- `info < low < medium < high < critical`, compared with `severityRank` or
  `highestSeverity`, never as text. The database uses a Postgres enum or a
  rank column.
- The existing guards keep their three levels internally, so benchmark
  replays stay identical. They are converted on the way out by
  `sharedSeverityOf`:
  - `info` → `info`
  - `warn` → `medium`
  - `violation` → `high`
  - `ungated-*` → `critical`
- Enforcement branches on the decision's outcome, never on severity.
- Migrated findings keep `legacySeverity` in `evidence`.

**Why:** The legacy `violation` meant "blocked", not a risk grade
(`run-turn.ts:189`). Mapping `warn` to `medium` leaves reflection
eligibility unchanged.

## 7. Context passing is an evaluated action

**Decision:** Add `context_handoff` (`fromTaskId`, `toTaskId`, `content`) to
`ProposedAction` and `ActionType`.

**Why:** Plan Pillar A requires context passing "without bypassing the
external middleware", and no action covered it. Results can carry secrets or
injected instructions from one agent to the next. The middleware validates
same-run/workspace task identity and blocks detected sensitive values before
handoff. When the semantic monitor is configured, it also reviews each handoff
as untrusted evidence against the trusted task; a high-confidence conflict is
declined and an uncertain conflict requires human approval. This is a best-effort
semantic safeguard, not a guarantee that all prompt injection is detected.

## 8. Lifecycle rules

**Decision:** Two Run edges were added: `planning → waiting_approval` and
`waiting_approval → planning`. The rules the tables can't express are written
in `lifecycle.ts` and checked by the harness:

- `waiting_approval` means at least one approval is pending. Independent work
  may continue underneath it.
- A run enters `waiting_approval` after the approval is requested, and
  returns to the phase it left.
- A denied or timed-out approval declines only that action. The execution
  continues, and it is not a failure.
- An execution stopped by the middleware fails and is not retried. Neither
  is an action after a block, deny or timeout.
- A failed task's dependents are skipped.
- A blocked or denied delegation creates no task, and its dependents in the
  plan are not created either. The finding stays on the planning task.
- Cancelling sets `Run.cancelRequestedAt` at once. It is exposed as
  `POST /api/runs/:runId/cancel` → 202, and repeating it is harmless. Only
  completed or failed runs answer 409.

**Why:**

- A delegation needing approval during planning had no legal transition.
- The first harness required a deny to fail the run, but the runtime declines
  and continues (`run-turn.ts:458-468`).
- Cancelling waits for work to stop (`agent-service.ts:389-401`). Parallel
  work needs a visible "cancel requested" state in the meantime.

## 9. Event seqs are durable

**Decision:**

- Persistence assigns each event's seq in the same transaction as the write
  it describes, using a per-run counter column.
- The event is published after commit.
- The snapshot and its `lastEventSeq` are read in one transaction.
- `RunEventHub` no longer counts. It rejects a seq that is not after the
  last one. On a skipped seq it tells its subscribers to resync.

**Why:** With in-memory seqs, a server that restarts and publishes enough new
events reuses numbers a client has already seen. The client resumes into the
new stream and silently misses events, and upserts cannot recover a missed
`task.created`.

## 10. Data model additions

| Change | Why |
| --- | --- |
| Kept: `startedAt`/`completedAt`, `Approval.expiresAt` | Legacy records have them; migration maps them one to one. |
| `Run.cancelRequestedAt` | Decision 8. |
| `Run.evaluation` | Keeps benchmark labels (legacy `RunEvaluation`) so scenarios still score whole runs. |
| `AgentExecution.capabilities`, `AgentExecution.traceTruncated` | Decision 3; legacy `RunTrace.truncated` has somewhere to go. |
| `TaskDependency.runId` | Lets a composite foreign key keep edges inside one run. |
| `version` on Agent and AgentProfile | Instructions and capabilities are security-relevant, so edits use `expectedVersion`. |
| `archivedAt` on Agent, AgentProfile and SecurityPolicy | Nothing that evidence references is deleted. Audit events `*.archived` replace `policy.deleted`. |
| `SecurityPolicy.rulesSchemaVersion` | `rules` is untyped until P1 publishes its schema; a format change must be able to find old rows. |
| `AuditEvent.workspaceId` nullable; `User.platformRole` | Changes to platform policy need an auditable home and a role that may make them. |
| `ReflectionSighting.runId` and `executionId` nullable | Only for rows migrated from the JSON store, which kept run ids and thread ids unpaired. |

## 11. Conventions

- **Ids:** validated with `z.guid()` (any 8-4-4-4-12 hex), not `z.uuid()`.
  Postgres validates the type, and the strict version check would reject seed
  ids such as `00000000-0000-0000-0000-000000000001`.
- **Timestamps:** stay UTC strings ending in `Z`, with millisecond precision.
- **Nullable columns:** `T | null` and always present, unchanged.

## Guidance for P3's schema

These points are implementation guidance, not part of the contract:

- **Timestamps:** use `timestamptz(3)` and one row mapper that converts with
  `toISOString()`. `to_json` output (`+00:00`) does not parse, and keyset
  cursors need exact equality.
- **Composite foreign keys:**
  - `(task_id, run_id)` for dependencies
  - `(supervisor_agent_id, workspace_id)` on runs
  - `(profile_id, workspace_id)` on agents

  These stop cross-run and cross-workspace references.
- **Policy scope:** add a `CHECK` that mirrors the scope/workspace refinement,
  and `UNIQUE (workspace_id, name) NULLS NOT DISTINCT`.
- **Capabilities:** store them as NOT NULL columns, not JSONB, so adding a
  flag is `ADD COLUMN … DEFAULT false`.
- **Status updates:** compare-and-set with `WHERE status = $from`, using the
  lifecycle tables. This also settles races between an approval and its
  timeout. Approval timeouts are a database sweep, not in-process timers.
- **Policy audit:** `policy.*` audit metadata carries the rules before and
  after the change.
- **Legacy migration:** seed a legacy user, one workspace per legacy agent,
  and one task plus one execution per legacy run.
