# Orchestration evaluation (P2, Week 12)

What was measured about the multi-agent orchestrator, how, and what the
numbers do and do not show. Everything here can be rerun from the repository.

## 1. Correctness under randomised runs

`apps/server/tests/orchestrator/fuzz.test.ts` (`npm run test:fuzz -w @launchpad/server`)
plays seeded random Runs end to end through the real `Orchestrator`, the
in-memory store and the event hub. Each seed draws:

- a plan of 1–6 tasks with random dependencies, split between a read-only and a
  write-capable agent, or a single-agent run;
- 0–3 actions per task: allowed, steered, refused, refused-and-stopped,
  stopped by an observation, or needing approval;
- crashes on some attempts, before or after acting;
- results that the middleware withholds from the next task;
- `maxParallel` 1–3, `maxAttempts` 1–3, and approval timeouts of 1 ms or 60 s;
- a person who answers approvals at a random rate, approves or denies, and a
  timeout sweep;
- a cancel at a random moment, the moment an approval is pending, or while the
  middleware is still deciding that an action needs one.

Random pauses make parallel work interleave differently on every seed.

### Properties checked on every Run

- **Harness invariants:** the integration harness's `checkRunInvariants`:
  lifecycle transitions, dependency order, write-capable work never
  overlapping, references, end state, and events equal to the snapshot.
- **No refused action ran:** everything the runtime executed was finally
  allowed or steered by the middleware, including after approvals.
- **Stops are final:** a stopped execution proposes nothing more, and ends
  failed or cancelled.
- **No retry after a refusal:** an attempt with a refused action is always
  its task's last, and attempts never exceed `maxAttempts`.
- **Limits hold:** concurrency never exceeds `maxParallel`.
- **Cancels are clean:** no approval is requested after a cancel was
  requested.
- **End state means what it says:** a completed run has no failed task, a
  cancelled run had a cancel requested, a failed run has an error, and every
  run settles (none hangs).
- **Audit is complete:** every event is schema-valid, and there is
  `execution.started` for every started execution and `execution.finished`
  for every finished one.

### Results

| Seeds | Passed | Completed / failed / cancelled runs | Approved / denied / timed out / cancelled approvals | Stopped executions | Retries | Runs with parallel work | Skipped tasks | Withheld handoffs |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 250 (default) | 250 | 54 / 141 / 55 | 112 / 50 / 5 / 26 | 65 | 105 | 69 | 152 | 9 |
| 2,000 | 2,000 | 463 / 1,181 / 356 | 836 / 470 / 49 / 109 | 514 | 890 | 530 | 1,358 | 57 |

Reproduce with `FUZZ_RUNS=2000 FUZZ_REPORT=coverage.json npm run test:fuzz -w @launchpad/server`.
A single failing seed reruns with `FUZZ_SEED=<n>`.

The suite fails if any of these situations is reached fewer than 3 times, so a
change that stops the fuzzer exercising one cannot pass quietly. Many runs fail
on purpose: crashes and stops are drawn often, to exercise failure handling.

### Does it catch real defects? Mutation checks

| Change made to `orchestrator.ts` | Caught |
| --- | --- |
| Allow a retry after a refused action | Yes: 11 of 250 seeds fail "no retry after a refusal" |
| Open an approval even after a cancel was requested | At first **no**. Approvals opened after the cancel were answered or timed out, so every invariant still held. Adding the cancel-ordering property and a mode that cancels during evaluation now catches it: 14 of 250 seeds fail. |

The second row is the useful finding. The guard was correct, but nothing
tested it, and the plain invariants could not have, because the failure is
user-visible rather than structural: a person would be asked to approve an
action in a run they had already cancelled.

## 2. Load and concurrency

`apps/server/scripts/measure-orchestration.ts`
(`npm run measure:orchestration -w @launchpad/server -- --runs 1,10,50,100 --pause 0`)
boots the real HTTP app and run routes in-process, starts N runs at once
through `POST /api/workspaces/:id/runs`, follows each over the real SSE stream
with the shared client, and approves each approval through the real route as
soon as it arrives.

Each demo run is planned into three tasks, makes 10 security decisions
(3 delegations, 2 handoffs, 5 agent actions) and one approval. Agents,
planner and middleware are the demo's simulated ones, so **nothing here
includes model or container time**.

Measured on a Windows laptop with Node 22.19.0, in one process. Times in ms.

### Orchestration cost alone (`--pause 0`)

| Runs at once | Completed | Create p50 / p95 | Approve p50 / p95 | Snapshot p95 | Event lag p95 / max | Run p50 / p95 | Runs/s | Events/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 9.4 / 9.4 | 2.4 / 2.4 | 2.9 | 5 / 6 | 70 / 70 | 13.7 | 573 |
| 10 | 10/10 | 26 / 29 | 17 / 17 | 21 | 39 / 40 | 93 / 110 | 83.8 | 3,518 |
| 50 | 50/50 | 97 / 120 | 74 / 77 | 57 | 164 / 165 | 377 / 441 | 110.6 | 4,643 |
| 100 | 100/100 | 143 / 204 | 195 / 240 | 95 | 220 / 239 | 798 / 903 | 106.1 | 4,455 |

### At the demo's simulated pace (`--pause 1`, about 7 s of agent work per run)

| Runs at once | Completed | Create p50 / p95 | Approve p50 / p95 | Event lag p95 | Run p50 / p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 12 / 12 | 3.8 / 3.8 | 8 | 7,099 / 7,099 |
| 50 | 50/50 | 160 / 179 | 40 / 43 | 167 | 7,276 / 7,382 |

### What this shows

- **Every run completed at every level:** 400 runs at `--pause 0` and 51 at
  `--pause 1`.
- **Throughput levels off near 110 runs/s** (about 4,500 events/s) in one
  Node process. Beyond that, latency grows roughly linearly, as expected for
  a single event loop; nothing failed or reordered.
- **With realistic agent time, orchestration is a small share of a run:** 50
  concurrent runs take 7.28 s at p50 against 7.10 s for one run alone, about
  2.5% more. Live updates reach the browser within about 170 ms at p95.

### What it does not show

- **Real agents and real security.** No Codex, containers, model calls or
  real security middleware. Those dominate real runs and are measured by the
  security benchmark (`docs/BENCHMARK.md`), not here.
- **PostgreSQL.** The store is in memory, and P3's repositories will add
  database round trips to every write. The in-memory store also scans every
  run's entities on each list call, so it is a test double, not something to
  run a long-lived server on.
- **Network and multiple servers.** One machine and one process, over
  loopback. Several server instances would also need a shared event bus
  (`run-events.ts`).
