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
- For middleware-managed multi-agent executions, `runtime` uses the
  `workspace-write` sandbox and `untrusted` approval policy. The writable root
  is limited to the isolated run workspace, and file-change proposals must
  reach the guard before application. When network is denied, the runtime also
  disables Codex's service-side `web_search` tool for that execution;
  capabilities determine whether the guard allows a proposal, not whether the
  gate is enabled.
- P2 calls it once per execution. It configures the runtime from `runtime`,
  serialises work on `capabilities.write`, and stores `capabilities` on the
  new `AgentExecution.capabilities` field.
- Every `SecurityDecision` records `appliedPolicies: {policyId, version}[]`.
- `EffectivePolicy` (without `runtime`) is in shared for the Policies UI.

**Why:**

- The scheduler must know which work writes (plan 3.2). Having P2 compute that
  itself would duplicate P1's layering rules.
- `read-only` prevents Codex 0.111 from exposing its file-change tool, so no
  edit proposal can reach middleware. `workspace-write` exposes the tool while
  limiting filesystem writes to the isolated run workspace; `untrusted` keeps
  mutations behind the approval request. Codex web search runs through a
  service-side tool outside the workspace network sandbox, so the app-server
  also receives a per-execution `web_search="disabled"` override when the
  resolved policy denies network. The orchestrator must not choose these
  settings.
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

### 7.1 Periodic reasoning reviews check task alignment

**Decision:** With semantic monitoring enabled, review the first completed
reasoning item and then every third completed item. A deterministic intent
warning triggers an immediate review between checkpoints. Review the bounded
recent trajectory against the trusted task, not only the current wording. A
moderate-confidence task conflict may steer the agent back on task; reasoning
alone does not block an action.

**Why:** Agents can drift from the user's goal without using obviously
suspicious language. Periodic review catches this while limiting model calls;
consequential actions and handoffs still have their own pre-action checks.

### 7.2 A failed reasoning review raises scrutiny on the next action

**Decision:** Reasoning review remains advisory: it may steer the agent, but does
not block execution by itself. If semantic review of a reasoning checkpoint is
unavailable, the next proposed action must receive semantic review even if it
would not normally qualify; if that review is also unavailable, require human
approval. Redacted semantic-review input is capped at 48,000 characters; an
oversized review is treated as unavailable and follows the same approval path.

**Why:** Reasoning is evidence about intent, not an action to authorize. But a
failed review should not silently make the next action less scrutinized. The
action remains the point where enforcement blocks or waits for approval.

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

## 12. Run taint is process-local while interrupted runs are terminal

**Decision (18 October 2026):** Keep credential taint scoped to the
middleware process and the `(workspaceId, runId)` key; do not persist it across
server restarts. The orchestrator's recovery contract fails an interrupted Run
or cancels it when cancellation was requested, closes its open work, and never
resumes its executions. Therefore no post-restart execution may continue that
Run and depend on taint held by the previous process.

If restart recovery later supports resuming a Run, that feature must first
define how trusted taint is reconstructed. It must not assume the rolling raw
trace is complete evidence, and it must fail closed for egress and handoffs if
taint cannot be reconstructed. Revisit this decision alongside the recovery
contract before implementing resumable runs.

**Why:** Persisting raw credential values would expand sensitive data at rest
without serving the current recovery behavior. Failing/cancelling interrupted
runs prevents a new middleware process from continuing them with an empty taint
state.

## 13. Listing a workspace's runs

**Decision (31 October 2026):** Add
`GET /api/workspaces/:workspaceId/runs`, for any role in the workspace. A
workspace the caller cannot see answers 404, as its neighbours do.

- **Query:** optional `cursor`, `limit` (default 50, maximum 200) and `status`.
- **Response:** `{ runs: RunSummary[], nextCursor, pendingApprovalCount }`,
  newest first. Paging uses the position `(created_at, id)`, so runs that share
  a timestamp are neither repeated nor skipped.
- **`RunSummary`:** run identity, status and timestamps, a `userPrompt` cut to
  280 characters, and `taskCount`, `pendingApprovalCount` and `findingCount`.
  It leaves out `finalOutput`, `error` and `evaluation`.
- **`pendingApprovalCount` at the top level:** counts the whole workspace,
  whatever the page or filter, so the app shell can read it with `limit=1`
  instead of needing another route.
- **`status=waiting_approval`:** finds runs waiting on a person even when they
  are too old for the first page.

**Why:** The recent-runs list was browser `localStorage`, so it showed one
browser's history rather than the workspace's. Postgres computes the counts in
one statement per page, using existing indexes, so no migration is needed.

**Review:** P3 (query and store), P2 (`RunReads` beside the `RunStore` port).

## 14. The Run timeline comes from saved rows

**Decision (31 October 2026):** Add `GET /api/runs/:runId/timeline`, for any
role in the workspace, returning `{ timeline }` with `entries`, `omittedEntries`
and `fileChanges`. It is built from `security.decision` and
`delegation.requested` audit events plus approvals. It never reads raw traces
or the SSE replay buffer, which can lose older events.

- **Bounds:** the newest 500 entries, 50 files per action and 300 listed file
  changes, with text limits matching `safeDetailsOf`. Saved text is redacted
  and bounded again on read, so an older row cannot widen the response.
- **Authorship:** `proposed` is agent-authored. Everything else in an entry
  comes from the middleware or a person, and the UI must keep them apart.
- **Status:** `decision` is the final decision. `require_approval` means none
  was recorded: held while the approval is `pending`, and otherwise the run
  ended before an answer took effect.
- **Not pushed:** an action allowed without a person publishes no RunEvent, so
  clients refetch on any Run event and every few seconds while the Run is active.

Two small writes make this possible, neither a schema change:

- `security.decision` metadata gains `proposed` for `file_change` (paths and
  kinds) and `context_handoff` (task ids and a character count).
- `safeDetailsOf` now redacts and bounds file paths, keeps a rename's `movePath`,
  and records `filesTotal` when an action names more than 50 files.

**What saved data cannot support:**

| Gap | How the contract says so | Schema change that would close it |
| --- | --- | --- |
| The text of a command that went to no person. Audit events deliberately hold no command text. | `proposed: null` on that entry | New table `gate_actions` (`run_id`, `task_id`, `execution_id`, `action_id`, `action_type`, `safe_details jsonb`, `created_at`), written before evaluation with the same redacted, bounded details as `approvals.safe_details`. A separate table keeps commands out of the append-only audit trail, where a redaction miss could never be removed, and lets the 30-day artifact retention expire them. |
| Files that actually changed. `fileChanges` holds what was proposed at the gate. It cannot show whether a change landed, or what an allowed command edited. | `fileChanges.allowedCommands`, and `allow` documented as not proof | New table `execution_changed_files` (`execution_id`, `run_id`, `path`, `kind`), written when an execution ends by comparing the working copy with its starting state, holding bounded and redacted paths without contents. |
| File lists on decisions saved before this change, unless the action went to a person. | `fileChanges.entriesWithoutFileList` | None; these rows age out of view. |
| Strict order within one millisecond. `audit_events` has no creation sequence. | Not visible to clients | `ALTER TABLE audit_events ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY`, as migration 002 did for tasks, executions, findings and approvals. |

P3 owns migrations, so none of these were added here. P1 decided that command
text will not be added to permanent audit rows or a `gate_actions` table for
the current milestone. Commands can contain credentials and arbitrary source
text, and a redaction miss in durable rows is harder to remove than a retained
artifact. The timeline therefore keeps `proposed: null` for commands that did
not require human approval. A future command-history feature needs a new P1
review, bounded and erasable storage, and the artifact-retention rules below.

**Why:** The gate-line view needs what was proposed and what was decided, from
evidence that survives a restart. Saying "not saved" is more accurate than
filling the gap from raw traces, which may hold sensitive material.

**Review:** P1 (paths in audit metadata, redaction on read, whether command text
may be stored), P2 (`orchestrator.ts` audit metadata and `safeDetailsOf`), P3
(`runAudit` query and the table proposals).

## 15. Who may change workspace members

**Decision (31 October 2026):** A `security_admin` manages the members of their
own workspace over the API: adding an existing account, changing a role and
removing a member. Any member may read the list. Creating users and workspaces
stays with the `db:admin` command line, because `platformRole` has no way to be
granted yet and no rule says who may hold it. A platform-admin rule would be its
own decision.

A workspace keeps at least one `security_admin`; the API answers 409 rather than
leave it unmanaged. Each change takes a lock on the workspace and reads the
actor's role inside that transaction, so the role check cannot be outdated by a
concurrent demotion. This is why the check is in `db/admin.ts` and not in the
route, unlike `run-routes.ts`.

Each change writes `member.added`, `member.role_changed` or `member.removed` in
the same transaction. Metadata holds ids and roles, not emails, because audit rows
are never deleted. The command line writes the same events as actor `system`,
plus `user.created` and `workspace.created`, with no migration: `event_type` is
text validated by the shared schema.

Adding a member lets a `security_admin` learn whether an email has an account.
That is accepted: it needs an admin role, and the alternative is inviting by
email, which does not exist.

## 16. An attempt's trace is read through a run route

**Decision (amended 31 October 2026):** Add `GET /api/runs/:runId/executions/:executionId/trace`
(`apiPaths.executionTrace`). A `developer` or `security_admin` in the Run's workspace may read it, and a
Run in a workspace the caller cannot access answers 404 like the other run
routes. It serves the bounded raw trace as `application/x-ndjson`, read whole so
the outbound redaction hook applies, and reports what it changed in
`x-redactions`. The execution must belong to the named Run. The file path comes
from that execution's stored id, never from the request or `tracePath`.
An execution with no trace file, including every demo execution, answers 404.

**Why:** The task drill-down showed a host file path that nobody using the
browser could open. Reading through the Run keeps workspace access in one place.

**Limit:** Pattern redaction does not make a raw trace safe in general: it can
still hold sensitive material the patterns miss, and a rolling trace is not a
complete audit history. An `auditor` uses the bounded, redacted timeline and
snapshot rather than this raw artifact. The narrower rule prevents a read-only
role intended for durable audit evidence from gaining access to a more
sensitive and incomplete debugging artifact.

## 17. A completed turn must report whether its Task is complete

**Decision (31 October 2026):** Every specialist's final response is exactly a
strict JSON object with `status: "complete" | "incomplete"` and a non-empty,
bounded `summary`. Markdown fences, surrounding prose, extra fields, a missing
report and an invalid report do not satisfy the contract.

The runtime validates the report. The `AgentExecution` is `completed` when the
Codex turn itself ended successfully. The Task becomes `completed` only for a
valid `complete` report. An `incomplete`, missing or invalid report stores the
available output, marks the Task `failed`, skips its dependants and fails the
Run. It is not retried: repeating a successfully ended turn is neither evidence
of a transient runtime fault nor a safe way to obtain a different answer.

This is an agent report, not independent proof that the work is correct. Tests,
review and the security middleware remain separate evidence. The existing Task
status and error fields express the result; no new shared lifecycle status is
needed.

## 18. Terminal execution artifacts expire after 30 days

**Decision (31 October 2026):** Run working copies and raw execution traces are
retained for 30 days after a Run reaches a terminal state. Cleanup must never
remove artifacts for a queued, planning, running or approval-waiting Run. Audit
rows, statuses, bounded findings and saved task results remain after artifact
expiry. A missing expired artifact is reported as expired rather than as proof
that no execution occurred.

P2 owns these lifecycle semantics. P3 owns the cleanup job, storage operations
and any schema needed to distinguish expiry from an unexpected missing file.
The 30-day value is the POC default. `apps/server/src/run-retention.ts` does the
cleanup, `RUN_ARTIFACT_RETENTION_DAYS` overrides the value, and no schema was needed:
a missing trace of a Run past retention answers 410, and any other answers 404.

## 19. Who may answer an approval

**Decision (31 October 2026):** The work plan's section 3.8 default is now
enforced. A `policy_required` approval needs a `security_admin` of the workspace.
Every other reason needs the `developer` or `security_admin` who started the Run,
and a `security_admin` who did not start it gets a 403 too. An `auditor` never
answers one. `mayAnswerApproval` in the shared package holds the rule; the route
enforces it and the web app uses it only to hide buttons the server would refuse.

If that person is away, the approval times out and declines only that action,
which is the safe outcome. The plan calls this a proposed default for the team to
confirm, so changing it means changing `mayAnswerApproval` and this entry.

## 20. What always asks a person

**Decision (31 October 2026):** Two things produce a `require_approval` in
multi-agent runs:

1. A command that `isHighConsequenceCommand` matches, such as a deploy, gives
   `high_consequence`. The single-agent path already did this. `git push` and
   other network commands match too, but the platform baseline denies network, so
   they are refused rather than asked: Codex's sandbox would deny the network even
   after a yes, so there is nothing a person could usefully approve.
2. The semantic monitor being unsure or unavailable gives `semantic_uncertainty`
   or `semantic_unavailable`, as before.

An ordinary edit does **not** ask by default. Holding every edit would interrupt
most benign runs, against the plan's target of at most 1 in 10, and an unanswered
approval declines the action. Blocks run first, so a capability refusal or a
violation never turns into a question.

Nothing produces `policy_required` yet. A rule such as "every edit asks" would need
a rules schema, and P1 reviews any such schema before it is enabled, so
`policyRulesSchema` accepts no rules and anything else still fails closed.

Delegations now get the semantic review too, on every delegation, against the
trusted user prompt. That closes the "steered supervisor" row of the threat model
at the semantic layer; the capability, depth and target checks still run first.

## 21. Editing agents, profiles and policies

**Decision (31 October 2026):** The routes are in `packages/shared/src/api.ts`.
Any role reads. Developers and Security Admins add and edit agents, because the
plan has developers configure the specialist team, but only a Security Admin may
give an existing agent another profile, or change profiles and policies. Platform
and locked policies are read-only over the API; nothing can grant `platform_admin`
yet (decision 15).

Each change takes the workspace lock, reads the role inside the transaction,
checks `expectedVersion` (a stale one is a 409), and writes its audit row in the
same transaction. Profile and policy events record capabilities, ceilings and
rules before and after. Agent events record which fields changed but not the
instruction text, which can hold anything. DELETE archives.

`POST` and `PATCH` validate rules with `policyRulesSchema`, so a rule the resolver
would refuse is a 400 and cannot stop every run in the workspace (decision 20). A second enabled
agent that may delegate is a 409, because `auto` runs need exactly one.

## 22. Paging cursors stay plain text

**Decision (31 October 2026):** A cursor is `<milliseconds>_<id>`, still opaque to
clients. The earlier base64 JSON was replaced by the outbound redactor as a
possible secret, so every second page over HTTP answered 400 "Unknown cursor". A
cursor must not look like a credential.

## 23. Token-mode records are not migrated to PostgreSQL

**Decision (31 October 2026):** The plan's JSON-to-Postgres migration is dropped.
Token mode remains a working path on its own JSON store, as `CLAUDE.md` requires,
and its demo records have no users or workspaces to map to, so a migration would
invent ownership for them. A deployment that needs old single-agent records keeps
them in token mode. This can be revisited if real single-agent data ever has to
move.

## 24. Specialist delegation stays one layer deep

**Decision (1 November 2026, P1/P2):** The supervisor may delegate the
validated plan's tasks to specialists, but a specialist cannot create another
task or invoke another agent. The current orchestrator has one planning phase;
recursive delegation would require a trusted lineage model, lifecycle and
scheduling rules, and security checks at each hop. `maxDelegationDepth` remains
a middleware-enforced ceiling, not a promise that recursive orchestration is
implemented. Revisit this only with a separately reviewed design and tests
covering every parent/child hop.

## 25. Agent network access remains denied in the POC

**Decision (1 November 2026, P1/P3):** Agent executions receive no general
network capability. Provider traffic is runtime service traffic and is not an
agent-granted network capability. This POC does not provide a host-enforced
provider-only egress route, so it must not claim that provider calls are the
only traffic reachable from a runtime container. The multi-agent deploy script
fails closed when the configured Codex workspace-write sandbox cannot be
verified; it must never silently substitute `danger-full-access`. A true
provider-only network path requires a separate host/network design and live
deployment validation.

## 26. Tenant separation remains logical; runtime state is per execution

**Decision (1 November 2026, P1/P3):** Workspace authorization and run-scoped
working copies provide logical tenant separation in this POC. They do not
establish a hardened tenant boundary: workspaces share the control-plane host
and database. Each container execution must mount a private Codex home that
contains only generated provider configuration, never the host's shared
credentials or session state. Stronger OS, database, and network isolation
requires a separate threat model and deployment design before production
multi-tenant claims.

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
