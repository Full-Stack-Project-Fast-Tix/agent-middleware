# Team handover: current state and next steps

**Updated:** 31 October 2026

**Repository state reviewed:** `main` after the P1/P2 closure work. This is a
proof of concept and does not claim production-grade tenant isolation.

## What is complete

### P1 — Security

- Middleware-managed Codex executions use `workspace-write` within the isolated
  Run copy and `untrusted` approvals, so file changes reach the gate. The pinned
  runtime probe verifies that declining a change leaves the file absent.
- A network-denied policy also disables Codex's service-side web search.
- Run copies exclude known environment secrets, credential stores and selected
  private-key/state files while retaining example templates. The marker parity
  test keeps the copy exclusions aligned with the egress guard. This remains a
  filename filter, not general secret detection.
- Password mode now rejects the global legacy Agent, admin, system, workspace
  file and single-agent Run APIs. Those routes use a shared JSON store with no
  workspace identity and remain available only in token mode.
- Raw execution traces are restricted to `developer` and `security_admin`.
  Auditors use the bounded, redacted Run timeline and snapshots.
- Command text is not copied into permanent audit rows or a new `gate_actions`
  table for this milestone. The timeline explicitly reports unsaved proposals.
- Arbitrary `SecurityPolicy.rules` remain unsupported and fail closed. A future
  rules feature requires a versioned schema and enforcement semantics.

### P2 — Orchestration

- A completed Codex turn no longer automatically completes its Task. Every
  specialist must return a strict JSON disposition with `complete` or
  `incomplete` and a bounded summary. Missing, malformed and incomplete reports
  leave the execution completed, fail the Task without retrying, skip its
  dependants and fail the Run.
- Test-running work stays with the write-capable Developer; the Reviewer remains
  read-only.
- Nested specialist delegation remains deliberately disabled. The current flow
  is supervisor to specialist, one level deep.
- Terminal Run working copies and raw traces have a settled 30-day retention
  policy. Active and approval-waiting artifacts must never be removed; durable
  audit/status/finding/result data survives artifact expiry.

### Platform and product already present

- Password sign-in, in-process sign-in throttling, PostgreSQL persistence,
  workspace roles, member management APIs, Run APIs, SSE updates and backup
  tooling are implemented.
- The web console has the shared shell, Dashboard, Runs list and detail, task
  graph, gate timeline, approvals, member management and the redesigned UI.

## Deliberate POC boundaries

- The container uses a bridge network so Codex can reach the model provider.
  Agent command networking is denied by the Codex sandbox and web search is
  disabled by policy, but there is no host-enforced provider-only egress path.
  Building one requires a P1/P3 threat model and deployment design.
- Shared-host workspace roles are not hardened isolation for mutually untrusted
  tenants. A production tenant boundary needs its own security review.
- Nested delegation will be considered only after trusted parent/child lineage,
  depth enforcement, cross-workspace rejection and middleware evaluation are
  tested at every hop.
- Raw traces may contain sensitive values missed by pattern redaction and are
  incomplete when rolled. They are debugging artifacts, not the audit record.
- The concrete middleware has a focused multi-agent integration scenario, and
  the existing live security benchmark measures the legacy single-agent runtime.
  There is no live-model, container-backed multi-agent efficacy/false-intervention
  benchmark yet. It is evaluation work, not a missing enforcement boundary for
  the current milestone.

## Work remaining by owner

### P1

No independent P1 implementation is blocking the current milestone. P1 should:

- rerun the file-change approval and network-denial probes whenever the pinned
  Codex image changes;
- review any future rule schema, nested delegation, provider-only egress, or
  production tenant-isolation proposal before it is enabled;
- maintain the secret-copy marker parity test as sensitive markers change.
- extend the live security benchmark to the Run/Task path before making measured
  claims about multi-agent attack containment or false-intervention rates.

### P2

No independent P2 correctness fix remains from the false-completion incident.
P2 should:

- preserve the disposition contract and failure semantics as runtimes evolve;
- review P3's artifact cleanup against the 30-day lifecycle rules;
- join P1 if nested delegation is proposed later.

### P3

- Implement terminal artifact cleanup at 30 days. Keep artifacts for every
  non-terminal or approval-waiting Run, retain durable evidence, and distinguish
  an expired artifact from an unexpected missing file.
- Decide whether sign-in throttling must move from process memory to a shared
  store before deploying multiple replicas.
- Continue admin workflows for creating users and workspaces; these currently
  use `db:admin`.
- Lead any stronger tenant-isolation or provider-only egress design with P1.

### P4

- Build the remaining Agents, Policies, Audit and Benchmarks views listed in
  `docs/ARCHITECTURE.md`.
- If artifact expiry is displayed, use P3's explicit expired state rather than
  presenting a broken trace link.
- Keep UI wording clear that `complete` is the specialist's report, while tests
  and review are separate evidence.

## Dependencies

| Work | Dependency |
| --- | --- |
| P3 artifact cleanup | The P2 policy is settled; implementation can start now. P2 reviews lifecycle behavior. |
| P4 artifact-expiry UI | Waits for P3's API/storage representation of expiry. |
| Nested delegation | Waits for joint P1/P2 design and security regression coverage. It is outside the current milestone. |
| Provider-only egress | Waits for a joint P1/P3 threat model and deployment design. |
| Production tenant isolation | Waits for a separately scoped P1/P3 architecture and threat-model review. |
| Remaining P4 views | Can proceed now against existing workspace and Run contracts; policy-management APIs may need P3 work. |

## Settled references

The authoritative choices are in `docs/contract-decisions.md`, especially
decisions 14 (timeline and command storage), 16 (raw trace access), 17 (task
disposition) and 18 (artifact retention). Current implementation status is in
`docs/ARCHITECTURE.md`.
