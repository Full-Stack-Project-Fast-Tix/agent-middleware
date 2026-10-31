# Team handover: current state and next steps

**Updated:** 1 November 2026

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

- **Settled P1/P3:** agents have no general network capability. Provider-only
  egress is not implemented or claimed; the deploy script now fails closed if
  the Codex workspace-write sandbox cannot be verified (decision 25).
- **Settled P1/P3:** PostgreSQL workspace roles and run-scoped working copies
  provide logical separation, not hardened isolation between production
  tenants. Runtime containers now receive an execution-specific Codex home;
  stronger OS, database and network isolation needs separate review (decision 26).
- **Settled P1/P2:** specialist delegation stays one layer deep for this POC.
  Recursive delegation needs a separate lineage, lifecycle, scheduling and
  security design (decision 24).
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

- Terminal artifact cleanup is implemented (`run-retention.ts`); P2 reviews it
  against the lifecycle rules.
- Run `scripts/deploy-multi-agent.sh` on a real ECS host. Its systemd steps have
  not been exercised yet; verify its fail-closed sandbox check and network
  behavior on the target host.
- Decide whether sign-in throttling must move from process memory to a shared
  store before deploying multiple replicas.
- Continue admin workflows for creating users and workspaces; these currently
  use `db:admin`.
- Lead any future stronger tenant-isolation or provider-only egress design with
  P1; current POC boundaries are settled in decisions 25–26.

### P4

- The Agents, Policies, Approvals, Security and Benchmarks views exist; review them
  and refine as needed.
- Keep Benchmarks clear that saved reports are committed evidence, not live
  workspace measurements or a live-model efficacy claim. Multi-agent load
  numbers use simulated agents.
- An expired trace answers 410, which the trace view shows as its error.
- Keep UI wording clear that `complete` is the specialist's report, while tests
  and review are separate evidence.

## Dependencies

| Work | Dependency |
| --- | --- |
| P3 artifact cleanup | Implemented. P2 reviews lifecycle behavior. |
| Nested delegation | Settled: disabled beyond the supervisor's one planning layer for this POC (decision 24). Revisit only with a separately reviewed design. |
| Provider-only egress | Settled: not claimed or implemented; agents remain network-denied. A host-enforced route needs live deployment design and validation (decision 25). |
| Production tenant isolation | Settled: current separation is logical only. The per-execution Codex home is implemented; stronger isolation requires a separate design (decision 26). |

## Settled references

The authoritative choices are in `docs/contract-decisions.md`, especially
decisions 14 (timeline and command storage), 16 (raw trace access), 17 (task
disposition), 18 (artifact retention), 19 (who answers an approval), 20 (what always
asks a person) and 21 (editing configuration). Current implementation status is in
`docs/ARCHITECTURE.md`.
