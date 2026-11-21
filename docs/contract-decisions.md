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
as untrusted evidence against the trusted task; outcomes use the risk thresholds
in decision 7.3. This is a best-effort semantic safeguard, not a guarantee that
all prompt injection is detected.

### 7.1 Periodic reasoning reviews check task alignment

**Decision:** With semantic monitoring enabled, review the first completed
thinking summary or visible pre-tool intent plan and then every third completed
item. A deterministic intent warning triggers an immediate review between
checkpoints. Review the bounded recent trajectory against the trusted task, not
only the current wording. A task conflict at risk 0.60 or higher may steer the
agent back on task; model-reported confidence is audit information only.
Reasoning alone does not block an action. Every command not proven read-only,
and every proposed file change, receives semantic review before execution.
This action review is required even when Claude emitted no reasoning or plan.

**Why:** Agents can drift from the user's goal without using obviously
suspicious language. Claude may omit thinking summaries, so visible intent is
useful evidence but not an enforcement prerequisite. The pre-action review
covers effectful commands and file changes when that evidence is missing or
incomplete.

### 7.2 A failed reasoning review raises scrutiny on the next action

**Decision:** Reasoning review remains advisory: it may steer the agent, but does
not block execution by itself. A detected conflict raises scrutiny on the next
effectful action, which must pass the normal action thresholds before it runs.
If semantic review of a reasoning checkpoint is unavailable, the next proposed
action must receive semantic review even if it would not normally qualify; if
that review is also unavailable, require human approval. Redacted
semantic-review input is capped at 48,000 characters; an oversized review is
treated as unavailable and follows the same approval path.

**Why:** Reasoning is evidence about intent, not an action to authorize. But a
failed or concerning review should not silently make the next action less
scrutinized. The action remains the point where enforcement blocks or waits for
approval.

### 7.3 Risk-based semantic action outcomes

**Decision:** For semantic action reviews, a task conflict with risk 0.50–0.74
requires human review. A task conflict with risk 0.75 or higher is declined.
Below 0.50, the semantic assessment alone allows the action. Model-reported
confidence remains in assessment evidence but does not affect steering, review,
or decline decisions. Deterministic findings and policy gates retain their
precedence.

The monitor prompt separates likely impact if an action is followed
(`riskScore`) from confidence in its assessment (`confidence`). It treats
actionable scope expansion as a conflict even when passed as a recommendation
or handoff, and scores a handoff as if its recipient follows it.

**Why:** A live handoff evaluation identified scope expansion and security
weakening as conflicts, but assigned scores below the prior review threshold.
The assessment's self-reported confidence did not make those scores more
reliable. Risk and conflict now determine the action outcome, with a human-review
band below the automatic-decline threshold.

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
| Files that actually changed. `fileChanges` holds what was proposed at the gate. It cannot show whether a change landed, or what an allowed command edited. | `fileChanges.allowedCommands`, and `allow` documented as not proof | New table `execution_changed_files` (`execution_id`, `run_id`, `path`, `kind`), written when an execution ends by comparing the working copy with its starting state, holding bounded and redacted paths without contents. |
| File lists on decisions saved before this change, unless the action went to a person. | `fileChanges.entriesWithoutFileList` | None; these rows age out of view. |
| Strict order within one millisecond. `audit_events` has no creation sequence. | Not visible to clients | `ALTER TABLE audit_events ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY`, as migration 002 did for tasks, executions, findings and approvals. |

P3 owns migrations, so none of these were added here.

**Changed (1 November 2026, at Wai's request):** `security.decision` metadata now
also holds `proposed` for commands, using the same redaction and 200,000-character limit as `approvals.safe_details`, so
the timeline shows each whole command. P1 had kept command text out
of durable rows because a redaction miss in the append-only audit trail cannot be
removed. That risk is accepted for this proof of concept, and P1 should review it
before any deployment. A `gate_actions` table the 30-day retention can expire is the
safer design if it matters. Commands saved before this change still show as not saved.

**Why:** The gate-line view needs what was proposed and what was decided, from
evidence that survives a restart. Saying "not saved" is more accurate than
filling the gap from raw traces, which may hold sensitive material.

**Review:** P1 (paths in audit metadata, redaction on read, whether command text
may be stored), P2 (`orchestrator.ts` audit metadata and `safeDetailsOf`), P3
(`runAudit` query and the table proposals).

## 15. Who may change workspace members

**Decision (31 October 2026):** A `security_admin` manages the members of their
own workspace over the API: adding an existing account, changing a role and
removing a member. Any member may read the list. A workspace security admin may
also create an account and attach it to that workspace in one transaction, and
may create a new empty workspace as its first security admin. The new account's
initial password must be delivered to that person through a secure channel.
Host project paths and first-account bootstrap remain operator-only through
`db:admin` (amended by decision 32): browser users must not point the server at arbitrary host paths, and
there is no global platform-admin role yet.

A workspace keeps at least one `security_admin`; the API answers 409 rather than
leave it unmanaged. Each change takes a lock on the workspace and reads the
actor's role inside that transaction, so the role check cannot be outdated by a
concurrent demotion. This is why the check is in `db/admin.ts` and not in the
route, unlike `run-routes.ts`.

Each change writes `member.added`, `member.role_changed` or `member.removed` in
the same transaction. Account creation writes `user.created` and `member.added`
together, without recording the email or password in audit metadata. Workspace
creation is attributed to its creating security admin. Metadata holds ids and
roles, not emails, because audit rows are never deleted. The operator command
line writes creation events as actor `system`, with no migration: `event_type`
is text validated by the shared schema.

The operator CLI also lists users and workspaces, creates accounts with
passwords read from stdin, and registers host project paths. `add-workspace ...
- ...` creates an empty workspace without accepting a server filesystem path.

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

## 21. Follow-up prompts continue a workspace through new Runs

**Decision (1 November 2026):** Every submitted prompt creates a new Run, with
its own task graph, executions, security context and audit trail. A Run records
`parentRunId`, the most recent successfully completed Run in the same
workspace, or null for the first Run. PostgreSQL selects that parent and
creates the Run while holding a workspace advisory lock and rejects creation
while another Run is active. The orchestrator also serializes Runs in process,
which covers the in-memory demo and gives a quick local refusal; the database
lock coordinates separately running service processes.

The first Run copies the configured workspace source. A later Run copies its
parent's working copy into a fresh isolated directory. Only `completed` Runs
become parents: failed and cancelled Runs remain in history, while the next
prompt starts from the most recent successful copy. The latest successful copy
is exempt from working-copy retention so the workspace can continue after an
idle period. Other Run artifacts still follow normal retention.

The supervisor and specialists may receive at most 8,000 characters of recent
successful Run prompts and reports across up to three ancestors. This context
is explicitly untrusted; the current prompt and task remain authoritative, and
no prior approval or policy decision carries over. The middleware continues to
load the current Run's prompt as its trusted goal. The UI offers a follow-up
composer on a finished Run page; submitting it creates a new Run in the same
workspace and preserves chronological history in the Runs list.

**Why:** Users expect a later prompt such as “add tests for that” to see the
files produced by the prior request. Reopening a completed Run would mix two
requests and obscure their audit boundaries. Copy-forward keeps the project
continuous while keeping each request independently inspectable.

**Limit:** The workspace is serialized, including Runs that could otherwise be
read-only, to give a simple ordering for which successful file state is the
starting point. A failed Run's partial files are deliberately not promoted;
there is no recovery-from-partial-output control yet.

## 18. Terminal execution artifacts expire after 30 days

**Decision (31 October 2026):** Run working copies and raw execution traces are
retained for 30 days after a Run reaches a terminal state. Cleanup must never
remove artifacts for a queued, planning, running or approval-waiting Run. The
latest successfully completed working copy in each workspace is retained as
the starting point for follow-up Runs; that Run's raw traces still expire on
schedule. Audit rows, statuses, bounded findings and saved task results remain
after artifact expiry. A missing expired artifact is reported as expired
rather than as proof that no execution occurred.

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

`rm -rf "$dir"` does not ask when `dir` was set once from `mktemp` in the same command
and nothing else follows on that `rm` (1 November 2026, at Wai's request). Agents clean
up their own temp folders constantly, and an unanswered approval cost a real run minutes.

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

The network capability treats an inline script as network use only when it names
a network token, or after a sensitive source was read in this Run. It used to assume
a read as soon as a trace existed, which refused harmless `node -e` checks and stopped
real runs. An inline script that hides its network use is not caught by this check,
as a script written to a file never was.

Run taint ignores base64 output chunks, whose text arrives in the clear in another
event, and git hashes on a diff's `index` lines. It tracks up to 1,024 values, and
past that still fails closed on handoffs. A blocked handoff does not count towards
stopping the receiving agent, because the orchestrator proposed it, not the agent.

A read-only agent may run chains of known read-only commands, including Codex's
`bash -lc` wrapper, which the earlier single-command rule could never match
(`read-only-command.ts`). `|`, `||`, `&&`, `;` and `2>&1` or `2>/dev/null` are the only
shell syntax accepted. Writing or executing flags are refused, as are `awk` and any
`sed` that does more than print a line range. No git command counts as a read (changed
21 November 2026): repo config and `.gitattributes` can make `git status`, `diff`, `log`
or `show` run a program (`core.fsmonitor`, `diff.external`, textconv, clean filters),
and a Run's copy never includes `.git`, so any repository there was made by an agent.

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
would refuse is a 400 and cannot stop every run in the workspace (decision 20). A workspace
may have several agents that delegate (changed 21 November 2026; it used to be a 409). With
exactly one, an `auto` Run that names no supervisor uses it; with several, the request must
name one, and the console asks for it.

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

## 27. Password sign-in throttles failures in one process

**Decision (3 November 2026):** Password sign-in permits five failed attempts
per normalized account and 30 per client address in a 15-minute fixed window.
The account and client counters are independent; either can throttle a request.
The server returns `429` with `Retry-After` and a retry time, while invalid
credentials keep the same generic response for unknown accounts and wrong
passwords. A successful sign-in clears that account and client's counters.

Counters are bounded, expire in memory, and use SHA-256 digests of account and
client keys. Passwords are never included. This is a single-instance control:
restarts reset it, and replicas do not share counters. Keep deployment
single-instance until a shared limiter is designed and reviewed.

## 28. Multi-agent reflections reuse the deterministic memory contract

**Decision (1 November 2026, P1):** The multi-agent execution guard loads an
Agent's bounded reflections from PostgreSQL before building deterministic
checks, then folds that execution's structured findings and trace with the
existing `learnFrom` rules after the turn. Raw trace text, model narration and
semantic findings do not author reflection facts. Failed persistence is logged
and does not retry a completed execution. Reflections are guard parameters,
never prompt instructions.

## 29. Cross-instance Run streams resync from the durable cursor

**Decision (1 November 2026, P3):** Open Run event streams poll the durable
PostgreSQL event cursor. If it advances beyond the instance's local hub, that
stream closes with a resync frame so the client reloads the authorized
snapshot. This avoids storing event payloads in a second durable event log.
It does not make the application multi-instance-ready: orchestration waiters,
cancellation, approval coordination and run-scoped taint remain process-local.
Keep deployment single-instance until those lifecycle boundaries are shared.

## 30. Claude runs through an agent loop AgentGuard owns

**Decision (31 October 2026):** With `MODEL_PROVIDER=anthropic`, a new
`ClaudeExecutionRuntime` implements the existing `ExecutionRuntime` port on the Claude
Messages API, and replaces Codex on the multi-agent path. The agent loop and the API
key stay on the host, and tools run in one disposable container per execution. The
supervisor planner and the semantic monitor call Claude under the same provider. No
migration, shared enum or scheduling change was needed. Codex's code stays until a
real Claude Run has proven this path.

- **The gate.** Every command and file change goes through `ActionGate.decide` before
  it runs, with the shapes `gated-turn.ts` uses, and the same stop semantics.
  `assertGatedPolicy` runs before a container starts. The model has no other way to
  act, so this does not depend on an agent honouring an approval protocol.
- **Reads count.** The editor's `view` is gated as the read command it is equivalent
  to, so `view .env` counts as a sensitive read exactly as `cat .env` does.
- **Network.** A policy that denies network gives the container `--network none`.
  Nothing in the container reaches the model, so this closes, for this path, the gap
  [handover.md](../handover.md) records. A policy that allows network keeps a bridge,
  which can reach the host.
- **Trace.** Records use the Codex app-server shapes, ordering and the `declined`
  item, taken from real traces in `benchmark-results/`. No check was forked or
  weakened. `threadId` is null, because there is no server-side thread.
- **Usage.** `inputTokens` includes cache reads and writes, and `cachedInputTokens` is
  the reads, matching how Codex totals its input. Successful attempts save usage on
  their execution. If an attempt fails after receiving a model response, its usage is
  available in the trace but is not copied to the execution because `ExecutionOutcome`
  is not returned. A failure before the first response has no token count.
- **The legacy path** is unchanged and needs Codex. The message route answers 503 with
  the reason. The web app reads `modelProvider` from `/api/system`, a field the server
  already returned, so this is no contract change. Only `apps/web`'s local type gained
  the field.

**The read-only command set narrowed.** `isKnownSafeRead` in the middleware used to
see Codex commands wrapped in `bash -lc`, which it never matched. Claude's commands
reach it as the model wrote them, so it would have passed `find -exec`, `find
-delete`, `sed -i`, `awk`, `rg --pre` and `file -C` as reads for agents that may not
write. It now refuses those, and allows `sed` only as `sed -n 'A,Bp'`. A read-only
execution's workspace is also mounted read-only.

**One exception to "pass the response back unchanged".** The API requires that after a
mid-output fallback, thinking and `tool_use` blocks before the last `fallback` block
are left out of the echoed turn. Those tool calls come from the declined attempt, can
be cut off mid-input, and never run.

**Why:** The client asked to replace Codex with Claude, and AgentGuard's value is that
enforcement sits outside the agent. The Claude Agent SDK and Managed Agents were
rejected for this because the loop must stay ours: with Managed Agents the loop and
the tools run elsewhere, and with the Agent SDK the gate would again depend on a
harness calling back.

**Not verified:** nothing here has run against the real API. The structured-output
schemas, the `fallbacks` opt-in, the thinking summaries, the semantic monitor's latency
within its 15-second timeout, and real token use are all unproven until a first real
Run. Steps and costs are in the README, under
[Run on Claude](../README.md#run-on-claude).

**Review:** P1 (the gate, the narrowed read-only set, what reaches the model), P2 (the
runtime port, retries after a limit, `threadId` null), P3 (the container, the image,
deployment).

## 31. Claude is the only runtime

BytePlus ModelArk and Codex are removed: the Ark proxy, the Codex runners and
JSON-RPC client, `MODEL_PROVIDER`, `RUNTIME_PROVIDER`, the single-agent Playground
and its JSON store, which only ever ran on Codex, and the Volcengine deployment that
only ran it. Earlier decisions that describe Codex are history; where they disagree
with this one, this one holds. Saved traces in `benchmark-results/` keep their
Codex-era shape, and the checks still read that format, because Claude's trace records
use it too.

`.codex` stays on the working-copy denylist: it can hold a credential in a user's
repository whichever agent runs.

## 32. Security admins may pick a folder inside operator-allowed roots

**Decision (2 November 2026):** This amends decision 15. When the operator sets
`WORKSPACE_SOURCE_ROOTS` (comma-separated folders on the server), a
`security_admin` may give a new workspace a project folder from the Members view,
as long as it is inside one of those roots. The server resolves symlinks on both
the folder and the roots before comparing, so a link cannot lead outside, and
stores the resolved path. The role is checked before the folder, so other roles
cannot probe which paths exist. `workspace.created` records the path. With the
setting empty, which is the default, nothing changes from decision 15: only
`db:admin` sets folders. Changing an existing workspace's folder stays
operator-only.

## 33. Action review itemizes every part of a proposal

**Decision (18 November 2026):** Semantic action review splits a proposal into
effects without clipping or merging: each top-level shell clause (with its
separator, and with any heredoc body kept in the clause that reads it), each
changed file, a handoff's content, or a delegation's title and objective.
Text longer than 2,000 characters becomes several effects (`C3.P2`, `F1.P4`)
split at line ends. The full text travels once, in the effects; the proposed
action points to them. A proposal that needs more than 24 effects is held for
a person (`semantic_unavailable`, finding `semantic-review-incomplete`) with no
model call, and the 48,000-character input cap of decision 7.2 still applies.
An itemized result must assess every effect exactly once or the review counts
as unavailable; the worst conflicting effect sets the outcome. Thresholds
(0.50 review, 0.75 decline) and the role of confidence are unchanged.

**Why:** Each clause or file excerpt used to be cut at 1,200 characters and
clauses past the 23rd merged into one clipped summary, so a late effect could
sit in a part no assessment covered.

## 34. One bounded scan for both sides of the Run diff

**Decision (18 November 2026):** The baseline (captured once, right after the
copy is made) and the final scan (after execution stops) are the same walk in
`workspace-snapshot.ts`, with the limits and exclusions in `SNAPSHOT_LIMITS`
and `SNAPSHOT_EXCLUDED_DIRECTORIES` of `packages/shared/src/review.ts`. The
excluded folders (`node_modules`, `.git`, `.codex`, at any depth) are exactly
the ones the copy never carries forward, so the review's blind spot cannot
seed a follow-up Run; build output is carried forward and therefore scanned.
The Run ZIP still omits build output, and says so. A scan
that stops says why (`file_limit`, `depth_limit`, `traversal_limit`,
`hash_budget`, `directory_unreadable`); reaching a limit exactly is not a stop.
Links are recorded by target and never followed. Credential-named paths
(`credential-names.ts`, shared with the copy's exclusions) are hashed so a
change shows, but their contents are never captured. A present file too large
or unreadable to hash is changed when its size differs and `uncertain`
otherwise; absence is claimed only from a complete scan or the filesystem
reporting the path itself absent (an unreadable parent is `uncertain`). An
approval of the runtime's `/workspace/...` editor path matches the
copy-relative diff path. The diff is a line diff with positions; past its work bound it shows the
changed region as one replacement, which is coarser but never hides a line.
The artifact (`RUN_DIFF_VERSION` 2) is written atomically next to the copy,
outside it, once execution has stopped, and served unchanged afterwards. The
route answers 409 while a Run is active. A missing, corrupt or older baseline
gives an unavailable comparison with an unknown count; nothing ever captures a
replacement baseline. An older cached artifact is shown as legacy and claims no
coverage.

**Why:** The previous diff compared the first 200 lines as sets, walked a
different file set on each side, and listed a present file over 2 MB as deleted.

## 35. The final review concludes only from complete evidence, and is saved

**Decision (18 November 2026):** The final review returns `incomplete`, before
any model call, unless the diff is version 2 with an available baseline, a
complete inventory, no uncertain entry, complete content for every change, an
untruncated list, at most 36 changed files, a complete action ledger (48
entries) and at most 8 approvals, and its effects fit 8 calls of 60,000
characters. Every changed hunk becomes one or more effects (`F2.H1`,
`F2.H1.P3`) with ids that never collide across batches; each batch must assess
each of its effects exactly once. A conflict found in any batch stands. The
outcome is saved on `Run.finalReview` (migration 007) for every terminal path:
`aligned`, `no_changes` and `disabled` complete the Run; `conflict` (0.50 or
more), `incomplete` and `unavailable` fail it with a finding and keep it from
seeding follow-up work; a Run that ends first gets `not_run`. The review's own
model usage is recorded there, separate from agent execution usage. It runs
outside the Run's lock with an abort signal, so a cancel stops it and the Run
ends cancelled, never completed. Nothing is rolled back.

**Why:** Each file's diff was cut at 1,200 characters and only the last 32 of
48 actions were sent, with no marker, so "aligned" could mean "not shown".
Recording only failures made a missing finding look like a pass.

## 36. An approval covers exactly its proposal

**Decision (18 November 2026):** Approvals save redacted, bounded proposal
details (command text, file diffs up to 4,000 characters each and 12,000 in
total, handoff content, delegation objective) with `complete: true` only when
nothing was cut. Approving an approval with no saved details is refused (409);
deny and timeout remain. The final review sees approvals loaded by the server,
never agent claims. An approved proposal covers a conflicting change only if it
is complete, names that path (file changes), the reviewer cites it as an exact
match, and the risk is below 0.75; anything else stays a conflict and records
`approval_unmatched`. Denied, timed-out and cancelled approvals grant nothing.
Deterministic restrictions still run first and no approval overrides them. The
gated-action ledger records which approval an action ran under.

### 18 November follow-up: practical review limits

Action review now batches at most four calls, each with up to 24 effects and
48,000 input characters; it holds only when complete evidence exceeds that
budget. All batches must pass before the proposal may execute. Final review
includes full saved approval evidence relevant to each batch's paths, without
the old 1,600-character summary cap. Commands remain indivisible approval
evidence; an oversized context returns incomplete rather than clipping.
Saved file-approval evidence is bounded at 32,000 characters per file and
128,000 total; incomplete saved proposals cannot authorize scope expansion.

Snapshots now hash up to 64 MB per file using 64 KB buffers, bounded by 128 MB
per scan and a five-second per-file deadline checked between reads. Unchanged
large assets can be established as unchanged; changed undisplayable content
still fails final review closed. Eight concurrent reads preserve deterministic
budget allocation and file ordering. ZIP exclusions remain dependencies, VCS,
build output, credentials and links; the archive is not the full reviewed tree.

All production model clients share a per-Run admission ledger, reserving input
UTF-8 bytes plus a 16,000-token protocol/schema allowance and maximum output.
Unknown usage retains the reservation. Ordinary calls cannot consume the final
20% reserve (capped at 128,000); final-review calls can. Provider-reported usage
settles successful calls, including cache tokens. This bounds admission
conservatively, not actual billing; unexpected provider usage can exceed an
estimate, after which subsequent calls are refused. Test adapters may omit the
optional ledger. `Run.finalReview.modelBudget` records its terminal snapshot.

## 37. Run evidence in the console

**Decision (18 November 2026):** The per-file download is a redacted text
preview of at most 256 KB and is labelled so; the ZIP is the full-byte path
within its limits and reports, by response header, how many excluded folders,
credential-named entries and links it left out. A follow-up Run keeps the agent
(single) or supervisor (auto) the finished Run used when it is still eligible,
and otherwise asks; it never switches silently to the workspace default. The
form names the latest completed Run the follow-up starts from, which may not be
the Run on the page. Supervisors offered by the forms are agents whose
effective policy can delegate. One active Run per workspace (409) is unchanged.

## 38. Workspaces have their own page, and admins may change a folder

**Decision (21 November 2026):** This amends decision 32. Creating a workspace
moves from the Members view to a Workspaces page, where a person picks or
creates a workspace and goes straight to Start a run in it. A `security_admin`
may also change an existing workspace's folder there
(`PUT /api/workspaces/:id/source`), under the same `WORKSPACE_SOURCE_ROOTS`
rule, role checked first, and audited as `workspace.source_changed` with the
old and new paths. Any member may read the folder (`GET`). Runs already started
keep their copy. The next Run starts fresh from the new folder instead of continuing
from earlier Runs' files: a Run's parent must have been created after the
workspace's folder last changed. A ZIP
upload is still only for a new workspace with no Runs.

**Why:** Changing a folder needed a database edit, and creating a workspace sat
among member settings, away from starting a run.

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

## 14. Local vault grants are explicit per Run (superseded by decision 15)

**Decision (2 November 2026):** The first local credential broker reads values
from the server's private `.env` using the `AGENTGUARD_VAULT_<NAME>` prefix.
The API returns names only. A developer selects names when starting a Run;
selected values are held in active Run memory and passed to each execution via
a short-lived host env file that is removed after container startup. Values are
not copied to the workspace, prompt, audit metadata, or persisted raw trace.
Exact selected values seed run-scoped taint; literal appearances in outbound
commands, handoffs, and proposed file changes are refused. Every detected
outbound command during a vault-granted Run requires a person to approve it.

Network access remains denied unless the operator sets
`AGENT_NETWORK_ACCESS=true`, and a vault grant never enables it. This is a
single-local-operator convenience, not encrypted OS-keychain storage or a
multi-tenant vault. If deployment changes, storage, unlock, user/workspace
ownership, and restart behavior must be decided before exposing this to remote
users.

## 15. Workspace vault entries stay behind a constrained host broker

**Decision (2 November 2026):** Replace decision 14's environment-backed
delivery. Credentials are entered for a workspace and stored in an
AES-256-GCM-encrypted file under `APP_DATA_DIR/vault`, encrypted with the
operator-configured `AGENTGUARD_VAULT_MASTER_KEY`. The key is not stored in the
vault directory. Vault API responses expose metadata only.

A Run grant names both a secret and the specific agent IDs allowed to use it.
The trusted route resolves values from the Run's workspace and the execution
receives only its own grants. Values are never copied into the container,
workspace, prompt, audit metadata, or persisted trace. Exact-value taint still
protects handoffs, proposed file changes, and other outbound commands.

An agent can ask the host broker to make an HTTPS GET or POST using one granted
secret. The broker accepts only exact preconfigured DNS hostnames, HTTPS port
443, pinned public IPv4 DNS results, no redirects, bounded JSON request bodies,
and bounded responses. It attaches the secret only in its configured auth
header. Direct agent egress remains subject to the ordinary network capability
and approval gate; a vault grant does not change container networking.

**Amended (21 November 2026):** an approved host is trusted with its own
secret, not with others the Run has seen. A broker request whose command or
decoded body carries a credential value observed earlier in the Run is refused
(`vault-request-run-taint`), and so is any body once the Run's taint record is
incomplete. A broker request with a body sent after a sensitive file was read
goes to a person, since a secret that is not credential-shaped leaves no taint
value to match.

This remains a local proof-of-concept vault. It has no OS keychain integration,
external secret manager, shared-host tenant hardening, or automatic `.env`
import. The operator must protect and back up the master key separately; loss
of that key makes the encrypted entries unrecoverable.
