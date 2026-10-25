# Team handover: next steps

**Prepared:** 26 October 2026

**Repository state reviewed:** `feat/security`, including the P1 runtime commits and merged PR #8. This is a working handoff, not a claim that the project is production-ready.

## Current state

- The multi-agent path is implemented and is wired into password-auth mode with PostgreSQL, the real security middleware, the supervisor planner, and container-backed Codex executions. See [`apps/server/src/index.ts`](apps/server/src/index.ts), [`apps/server/src/postgres-runs.ts`](apps/server/src/postgres-runs.ts), and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- P1 fixed the gated runtime so file edits reach the approval gate, then disabled Codex `web_search` for executions whose resolved policy denies network. The pinned-runtime probe verifies that declining an edit leaves the file absent. The relevant commits are `31d0988`, `adf7f96`, and `b5e95b3`.
- The working-copy follow-up now omits environment secrets and common credential stores/files by default, while retaining environment example templates. The prior test that expected `.env` in the agent workspace has been changed to assert the safer behavior.
- PR #8's standard-agent descriptions route test-running work to the Developer. That assignment change is already merged; it is not an outstanding P2 task.
- PostgreSQL persistence, password sign-in, workspace roles, run APIs, and the Run/Task UI foundations are present. The integration harness still uses stand-ins for several subsystems by design; it is not a full production-stack test.
- Some checked-out docs are inconsistent with the code. `README_AgentGuard.md` still describes multi-agent and password-auth support as planned. `docs/architecture-direction.md` says trusted adapters and orchestration wiring remain to be done, while `index.ts` now wires them in. P4 should reconcile these status docs; P1 has corrected the canonical sandbox rule in `CLAUDE.md`.

## Decisions for the next phase

These are the recommended defaults so work can move without waiting for another planning meeting.

1. **Do not put project secrets in an agent-visible working copy by default.** `DirectoryWorkingCopies` currently excludes only `node_modules` and `.codex`; it copies `.env`, and [`working-copies.test.ts`](apps/server/tests/orchestrator/working-copies.test.ts) asserts that behavior. A `.gitignore` entry does not affect this copy operation. Exclude `.env` and `.env.*` by default, while retaining obvious templates such as `.env.example`; add common private-key/credential files to a narrow, documented default denylist. Do not treat this as complete secret detection. If an agent needs a credential for a task, pass a narrowly scoped, short-lived value through a separate approved mechanism rather than copying the project's secret file.
2. **Separate “the Codex turn ended” from “the task was completed.”** Keep the existing `AgentExecution` status for whether the turn ran successfully. Require a validated final task disposition (`complete` or `incomplete`); map `incomplete`, missing, or invalid disposition to the existing `Task.failed` status with a useful error/result. Do not infer completion by searching free-form prose, and do not retry a task just because the agent reported it could not do the work. Treat the disposition as an agent report, not proof that code is correct. Prefer the existing status and fields over adding a new shared `TaskStatus` unless the UI demonstrates a real need.
3. **Keep nested delegation disabled for the first integrated milestone.** The current orchestrator README says specialists cannot delegate, so effective depth is 1. That is a reasonable initial boundary. Do not expose a higher effective depth until P1 and P2 have tested parent/child identity, depth enforcement, and middleware evaluation at every delegation.
4. **Set a 30-day default retention for terminal-run workspaces and raw traces.** Never clean up queued, running, or approval-waiting runs. Retain audit rows and bounded status/findings after artifacts expire, and show that an artifact is expired instead of presenting a broken path as available evidence. P2 owns the policy and P3 owns the cleanup job/storage behavior. This is a POC default; a real deployment should make retention configurable and disclose it.
5. **Do not call the current shared-host deployment production-grade tenant isolation.** Keep the current workspace-role checks for the capstone. Before accepting untrusted tenants on a shared host, require a separate isolation review and a stronger runtime/data boundary; do not expand this into a broad infrastructure rewrite as part of the current milestone.

## Next steps by owner

### P1 — Security

**Now**

- **Done in this follow-up:** corrected the canonical security invariant in [`CLAUDE.md`](CLAUDE.md). Middleware-managed executions use `workspace-write` confined to the per-run workspace with `untrusted` approvals; capabilities decide which proposals are allowed, not whether the approval gate exists.
- Review the working-copy exclusion defaults with P2 before extending them. Keep the limitation explicit: a filename denylist is not a general secret scanner. The defaults and focused test expectation are now in the current branch.
- Keep the file-change approval and network-denial probe in the runtime upgrade checklist. The actual Codex behavior is version-sensitive; rerun the probe whenever the pinned image changes.

**Later / joint work**

- Review host-level egress options with P3 if the project needs stronger guarantees than Codex's sandbox. The container currently has a bridge network and must reach the model provider; simply changing it to `--network none` would also stop model requests. Any stronger design needs an explicit provider-only egress path.
- Keep arbitrary `SecurityPolicy.rules` unsupported until a concrete rule schema and enforcement behavior are agreed. The resolver currently fails closed on non-empty or unknown-version rules; that is safer than silently ignoring them.

### P2 — Orchestration

**Now**

- Fix the original false-completion issue. In [`orchestrator.ts`](apps/server/src/orchestrator/orchestrator.ts), `runTask` marks a Task completed whenever `ExecutionRuntime.execute()` returns. [`ExecutionOutcome`](apps/server/src/orchestrator/ports.ts) currently contains only the final message and runtime metadata. Add a validated task disposition to the runtime result and prompt contract. If the agent reports it could not complete the task—or the disposition is absent/invalid—record the execution as a completed turn but mark the Task failed with the explanation. Existing lifecycle rules then fail the Run and skip dependents. Add regression coverage for explicit inability, malformed disposition, and successful completion. Do not use fragile phrase matching or let an incomplete result flow to dependent tasks as a successful result.
- Coordinate the disposition contract with P4 before changing shared API/event schemas. The recommended first implementation uses existing `Task.failed` and `Task.error`, avoiding a new status enum.
- Review the new working-copy exclusions and run the targeted tests when verification is scheduled. The old assertion that `.env` is copied has been replaced; `.env.example` remains available.
- PR #8's developer/test assignment is already done. Keep test tasks assigned to an agent that can run them; preserve reviewer read-only permissions.

**After the core flow is reliable**

- Add nested delegation only with P1's trusted lineage/depth checks and regression tests at each delegation boundary. Until then, keep effective depth at 1 and say so in product surfaces.
- Apply the 30-day terminal-run artifact retention decision with P3. Do not delete artifacts for active or approval-waiting runs.

### P3 — Platform

**Now**

- Add sign-in throttling before password authentication is exposed beyond the POC. [`auth-routes.ts`](apps/server/src/auth-routes.ts) explicitly notes there is currently no attempt limit. Use bounded per-account and per-source throttling without revealing whether an account exists; test lockout/reset behavior.
- Keep the PostgreSQL-backed path covered by the existing `TEST_DATABASE_URL` suites. CI already provisions PostgreSQL in [`.github/workflows/ci.yml`](.github/workflows/ci.yml); ensure the persistence, identity, migrations, event-sequence, and approval-race suites remain enabled there.
- Build the admin operations needed to manage users, workspaces, and memberships, with P4 supplying the app shell and shared UI patterns. The current bootstrap path is the `db:admin` CLI.
- Implement artifact cleanup after P2 confirms retention semantics. Preserve audit and bounded evidence when workspace/trace files expire.

**Deployment boundary**

- Keep the shared-host multi-workspace deployment marked as a POC limitation. A production tenant-isolation target needs a separately scoped threat model and review before external tenants are invited; it is not a prerequisite for finishing the current capstone UI.

### P4 — Contracts & Integration

**Now**

- Continue the app shell, Dashboard, and full Run Detail composition listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Run creation, task graph, task drill-down, approvals, and SSE foundations already exist; build on them rather than replacing the working API/event contract.
- Reconcile stale project-status documentation: `README_AgentGuard.md`, `docs/architecture-direction.md`, and the inaccurate statements in `docs/ARCHITECTURE.md`. Record what is implemented, what remains P3/P4 work, and what is only design direction. Update the orchestrator README where it still says PostgreSQL stores are waiting to land.
- Review any shared-contract changes required by P2's task disposition with P2 first. If the UI needs to distinguish an agent-reported completion from verified completion, represent that distinction explicitly rather than implying that a completed Codex turn proves the requested code is correct.

## Who waits on whom

| Work | Can start now? | Dependency / handoff |
| --- | --- | --- |
| P1 canonical security-guide correction | Yes | Independent. |
| P1/P2 secret exclusion from working copies | Yes | P1 defines/reviews the denylist; P2 changes copy behavior and tests it. Neither needs to wait for P3/P4. |
| P2 task-completion semantics | Yes | P2 can use existing `Task.failed`/`error`; ask P4 to review only if a shared schema or event changes. |
| P3 sign-in throttling and DB test coverage | Yes | Independent of P2/P4 UI work. |
| P4 app shell and Dashboard | Yes | Can proceed against the existing routes/contracts. |
| P3 admin UI | In parallel, in pieces | P3 defines the management behavior/API; P4 provides shell/components. Integrate once both are ready. |
| 30-day artifact cleanup | After policy agreement | P2 owns the retention decision; P3 implements storage cleanup. P4 only needs involvement if users configure retention or see artifact-expiry UI. |
| Nested delegation | Defer | Requires P2 orchestration plus P1 lineage/depth enforcement and joint security tests. |
| Stronger tenant isolation / provider-only egress | Defer to a scoped review | P1 and P3 must agree on threat model and runtime/network boundary; not a quick parallel task. |

## Suggested order

1. P1 and P2 review the secret-copy exclusions and close the false-completion path; P1 has updated the canonical sandbox guidance.
2. P3 adds sign-in throttling and keeps PostgreSQL CI coverage active while P4 builds the shell and Dashboard in parallel.
3. P2 and P3 implement terminal-artifact retention after the 30-day rule is accepted in code/docs.
4. P4 reconciles stale docs and integrates P3's admin workflows.
5. Revisit nested delegation and production isolation only after the single-level flow, completion reporting, persistence, and operator UI work end to end.
