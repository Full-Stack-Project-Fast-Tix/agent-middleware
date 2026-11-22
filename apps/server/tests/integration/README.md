# Integration harness

End-to-end checks for the Run → Task → AgentExecution model. They go only
through the public API: create a Run over HTTP, follow its events over SSE with
the shared client, resolve approvals, and compare the event stream with the
stored snapshot.

| File | Purpose |
| --- | --- |
| `harness/client.ts` | `HarnessClient` validates every response (error bodies too) against `@launchpad/shared`. `RunRecorder` keeps the full event log and the view a UI would build from it. |
| `harness/invariants.ts` | `checkRunInvariants`: rules every Run must satisfy, whatever produced it. |
| `harness/stand-in.ts` | The real HTTP app, run routes, `RunEventHub` and `Orchestrator`, with controlled stand-ins for persistence, middleware by default, the supervisor's model call and the Claude runtime. |
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

## Scope of the evidence

The orchestrator, API routes and event transport are real. Most scenarios use `InMemoryRunStore`, a scripted planner/runtime and scripted middleware to make approval outcomes deterministic without model or Docker dependencies. A focused secure-run scenario uses the concrete security middleware.

PostgreSQL persistence and fuzz tests separately exercise the real stores. The opt-in Docker boundary check exercises the Claude loop against a mock model API and real containers. Live Claude evaluations are separate again; none of these controlled suites establishes model detection accuracy.

Keep invariant changes consistent with the shared lifecycle contracts and [contract decisions](../../../../docs/contract-decisions.md).
