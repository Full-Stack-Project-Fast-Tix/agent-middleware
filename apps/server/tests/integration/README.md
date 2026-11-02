# Integration harness

End-to-end checks for the Run → Task → AgentExecution model. They go only
through the public API: create a Run over HTTP, follow its events over SSE with
the shared client, resolve approvals, and compare the event stream with the
stored snapshot.

| File | Purpose |
| --- | --- |
| `harness/client.ts` | `HarnessClient` validates every response (error bodies too) against `@launchpad/shared`. `RunRecorder` keeps the full event log and the view a UI would build from it. |
| `harness/invariants.ts` | `checkRunInvariants`: rules every Run must satisfy, whatever produced it. |
| `harness/stand-in.ts` | The real HTTP app, run routes, `RunEventHub` and `Orchestrator`, with temporary stand-ins for persistence (P3), middleware by default, the supervisor's model call and the Claude runtime. |
| `secure-run.test.ts` | Gate 1 scenarios, including a concrete `DefaultSecurityMiddleware` scenario routing delegation, handoff, command and file actions through one instance. |
| `invariants.test.ts` | Proves each invariant catches the violation it names. |

## What the invariants check

- **Stream:** seq starts at 1 with no gaps, and every event belongs to the Run.
- **Lifecycle:** status changes follow `lifecycle.ts`, and identifying fields
  never change after creation. A run waits for approval only while one is
  pending, and resumes the phase it left. A cancel request is never
  withdrawn.
- **Scheduling:**
  - A task becomes ready or running only after its dependencies have
    completed.
  - Two write-capable executions never run at once.
- **References:** executions, findings and approvals only point at tasks and
  executions that were already announced.
- **End state:**
  - A finished run has no open tasks, executions or approvals.
  - Completed or failed work has `completedAt`.
  - Failed work has an `error`.
- **Persistence vs events:** the snapshot equals the state rebuilt from the
  events, and `lastEventSeq` equals the last seq in the stream.

## Replacing the stand-ins

As each subsystem lands, have `startStandIn` use the real piece instead:

- **P3 persistence:** swap `InMemoryRunStore` for the repositories, and point
  the run routes' `snapshot`/`approval` and `canReadRun` at them. The
  repositories assign event seqs in the write's transaction, as
  `InMemoryRunStore` does.
- **P2 orchestrator:** done. The real `Orchestrator` and run routes
  (`src/run-routes.ts`) are in use. Only its planner and runtime are
  stand-ins, so the scenarios stay deterministic and need no model or Docker.
- **P1 middleware:** the concrete middleware is exercised by a focused
  orchestrator integration scenario; broader scenarios still use
  `ScriptedMiddleware` for deterministic approval outcomes. Password-authenticated
  container startup is composed with the concrete middleware, PostgreSQL and
  Claude runtime. This harness still replaces the model planner, container runtime
  and usually persistence, so it is not proof of a full deployed run.

The scenarios and invariants should not need to change. If one does, that is
a contract change: record it in
[docs/contract-decisions.md](../../../../docs/contract-decisions.md) and get
the team's agreement.
