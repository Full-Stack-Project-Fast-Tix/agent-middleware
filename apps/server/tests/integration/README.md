# Integration harness

End-to-end checks for the Run → Task → AgentExecution model. They go only
through the public API: create a Run over HTTP, follow its events over SSE with
the shared client, resolve approvals, and compare the event stream with the
stored snapshot.

| File | Purpose |
| --- | --- |
| `harness/client.ts` | `HarnessClient` validates every response (error bodies too) against `@launchpad/shared`. `RunRecorder` keeps the full event log and the view a UI would build from it. |
| `harness/invariants.ts` | `checkRunInvariants`: rules every Run must satisfy, whatever produced it. |
| `harness/stand-in.ts` | Temporary stand-ins for persistence (P3), orchestration (P2) and the security evaluator (P1), on top of the real HTTP app and `RunEventHub`. |
| `secure-run.test.ts` | Gate 1 scenarios: approve path, deny path, error shapes. |
| `invariants.test.ts` | Proves each invariant catches the violation it names. |

## What the invariants check

- **Stream:** seq starts at 1 with no gaps, and every event belongs to the Run.
- **Lifecycle:** status changes follow `lifecycle.ts`, and identifying fields
  never change after creation.
- **Scheduling:** a task becomes ready or running only after its dependencies
  have completed.
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

- **P3 persistence:** swap `StandInStore` for the repositories, and point the
  snapshot route and `canReadRun` at them.
- **P2 orchestrator:** register the real Run routes and orchestrator in place
  of `ScriptedOrchestrator`.
- **P1 middleware:** pass the real `SecurityEvaluator`. To keep the scenario
  deterministic, give it a workspace policy that requires approval for file
  changes.

The scenarios and invariants should not need to change. If one does, that is
a contract change and needs the team's agreement.
