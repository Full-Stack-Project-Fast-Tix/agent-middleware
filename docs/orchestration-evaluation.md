# Orchestration evaluation (P2, Week 12)

What was measured about the multi-agent orchestrator, how, and what the
numbers do and do not show. Everything here can be rerun from the repository.

## 1. Correctness under randomised runs

`apps/server/tests/orchestrator/fuzz.test.ts` (`npm run test:fuzz -w @launchpad/server`)
plays seeded random Runs end to end through the real `Orchestrator`, the store
and the event hub. Every seed runs on `InMemoryRunStore`; with
`TEST_DATABASE_URL` set, every seed also runs on `PostgresRunStore` in a fresh
schema. Each seed draws:

- a plan of 1–6 tasks with random dependencies, split between a read-only and a
  write-capable agent, or a single-agent run;
- 0–3 actions per task: allowed, steered, refused, refused-and-stopped,
  stopped by an observation, or needing approval;
- crashes on some attempts, before or after acting;
- results that the middleware withholds from the next task;
- `maxParallel` 1–3 and `maxAttempts` 1–3;
- an approver who is *prompt* (answers at a random rate, 60 s timeout),
  *absent* (never answers, so every approval times out through the sweep), or
  *racing* (answers at random against a 1 ms timeout);
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
- **End state means what it says:** a completed run has no failed or skipped
  task, a cancelled run had a cancel requested, a failed run has an error, and
  every run settles (none hangs).
- **Audit is complete:** every event is schema-valid, and there is
  `execution.started` for every started execution and `execution.finished`
  for every finished one.

### Results

Measured on 31 October 2026 with the fixes below, on both stores in one
command (PostgreSQL 16 in Docker, Node 24.10.0, Apple M1 Pro).

| Store | Seeds | Passed | Completed / failed / cancelled runs | Approved / denied / timed out / cancelled approvals | Stopped executions | Retries | Runs with parallel work | Skipped tasks | Withheld handoffs |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| In memory | 2,000 | 2,000 | 487 / 1,221 / 292 | 733 / 421 / 190 / 127 | 517 | 868 | 512 | 1,423 | 70 |
| PostgreSQL | 2,000 | 2,000 | 441 / 1,109 / 450 | 691 / 384 / 185 / 91 | 480 | 776 | 387 | 1,280 | 60 |

The default 250 seeds on both stores took about 43 s; 2,000 took about 335 s,
nearly all of it on PostgreSQL.

A seed fixes what happens, not when: pauses, answers and the timeout sweep
run on real timers, so counts vary slightly between runs and machines. An
earlier version made timeouts depend on whether the simulated person answered
before a 1 ms deadline. That race came out differently on a faster CI machine
(2 timeouts in 250 seeds), so the coverage check failed there. Approvers are
now *prompt*, *absent* (never answers, so every approval times out) or
*racing* (the race, kept for its own sake), and the coverage check counts only
situations a scenario forces.

Reproduce with `TEST_DATABASE_URL=<url> FUZZ_RUNS=2000 FUZZ_REPORT=coverage.json npm run test:fuzz -w @launchpad/server`.
A single failing seed reruns with `FUZZ_SEED=<n>`, though on PostgreSQL a race
may not recur on the same seed.

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

### What PostgreSQL found that the in-memory store could not

Before these fixes, 4 of 2,000 seeds failed on PostgreSQL and none in memory.
Real round trips let other work land between a read and the write that depends
on it. All of these were orchestrator defects, fixed in `orchestrator.ts` and
each pinned by a deterministic regression test in `orchestrator.test.ts`:

| Seen as | Cause | Effect before the fix |
| --- | --- | --- |
| "`cancelRequestedAt` changed after it was set" (2 seeds) | Two cancels both read the run before either wrote | The timestamp changed and the audit trail recorded two cancels |
| "approvals requested after the cancel" (1 seed) | The cancel was committed before the in-process flag was set | A person could be asked to approve an action in a run they had just cancelled, until the cancel closed it |
| "run is failed but task is running" (1 seed) | A cancel during the scheduler's last pass left an aborted task open, and the scheduler then finished the run as usual | A cancelled run could end `failed` or `completed` with work still marked running |
| Found by reading the code while tracing the row above | The scheduler left its loop when nothing was in flight, even if a task had ended since its last read | A dependent task could be skipped, or a retry dropped, and the run could still report `completed` |

The last row produced no fuzz failure, because no property covered it. The fuzz
test now also requires that a completed run has no skipped task. The regression
test fails on the old code with the task `skipped`.

The first 2,000-seed run failed only 4 seeds, so a clean rerun is good evidence
but not proof that no such race remains.

## 2. Load and concurrency

`apps/server/scripts/measure-orchestration.ts`
(`npm run measure:orchestration -w @launchpad/server -- --runs 1,10,50,100 --pause 0 [--store postgres]`)
boots the real HTTP app and run routes in-process, starts N runs at once
through `POST /api/workspaces/:id/runs`, follows each over the real SSE stream
with the shared client, and approves each approval through the real route as
soon as it arrives.

Each demo run is planned into three tasks, makes 10 security decisions
(3 delegations, 2 handoffs, 5 agent actions) and one approval. Agents,
planner and middleware are the demo's simulated ones, so **nothing here
includes model or container time**.

Measured on 31 October 2026 on an Apple M1 Pro (8 cores, 16 GB) with Node
24.10.0, in one process, with PostgreSQL 16 in Docker on the same machine and a
pool of 10 connections, the size `index.ts` gets by default. Other work was
running on the machine throughout (load average 6 to 10), so treat these as
rough figures: compare the two stores' shapes, not single numbers. Times in ms.

Event lag runs from an event's timestamp to its arrival. The timestamp is set
when the event is published, which on PostgreSQL is after the COMMIT, so lag
does not include the time the write itself took. Run duration does.

### Orchestration cost alone (`--pause 0`)

| Store | Runs at once | Completed | Create p50 / p95 | Approve p50 / p95 | Snapshot p95 | Event lag p95 / max | Run p50 / p95 | Runs/s | Events/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| In memory | 1 | 1/1 | 4.2 / 4.2 | 1.5 / 1.5 | 1.3 | 3 / 4 | 17 / 17 | 53.9 | 2,265 |
| In memory | 10 | 10/10 | 13 / 45 | 11 / 23 | 14 | 48 / 51 | 74 / 86 | 112.6 | 4,730 |
| In memory | 50 | 50/50 | 100 / 198 | 10 / 150 | 114 | 185 / 207 | 242 / 316 | 147.7 | 6,202 |
| In memory | 100 | 100/100 | 184 / 384 | 11 / 548 | 471 | 500 / 557 | 418 / 794 | 121.7 | 5,110 |
| PostgreSQL | 1 | 1/1 | 7.1 / 7.1 | 17 / 17 | 5.3 | 1 / 3 | 215 / 215 | 4.5 | 190 |
| PostgreSQL | 10 | 10/10 | 27 / 30 | 51 / 64 | 16 | 1 / 8 | 438 / 445 | 21.9 | 919 |
| PostgreSQL | 50 | 50/50 | 34 / 54 | 206 / 230 | 40 | 1 / 42 | 1,940 / 2,003 | 24.8 | 1,041 |
| PostgreSQL | 100 | 100/100 | 50 / 83 | 388 / 398 | 65 | 1 / 66 | 3,505 / 3,625 | 27.4 | 1,151 |

### At the demo's simulated pace (`--pause 1`, about 7 s of agent work per run)

| Store | Runs at once | Completed | Create p50 / p95 | Approve p50 / p95 | Event lag p95 | Run p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| In memory | 1 | 1/1 | 4.4 / 4.4 | 3.9 / 3.9 | 5 | 7,043 / 7,043 |
| In memory | 50 | 50/50 | 57 / 78 | 36 / 50 | 8 | 7,143 / 7,161 |
| PostgreSQL | 1 | 1/1 | 9.8 / 9.8 | 28 / 28 | 2 | 7,425 / 7,425 |
| PostgreSQL | 50 | 50/50 | 68 / 94 | 335 / 406 | 3 | 9,671 / 9,735 |

### What this shows

- **Every run completed at every level on both stores:** 161 runs at
  `--pause 0` and 51 at `--pause 1` per store, 424 in all.
- **PostgreSQL is now the limit.** Throughput levels off near 25 to 27 runs/s,
  about a fifth of the in-memory store's 120 to 150 runs/s, with one local
  database and 10 connections. Latency grows with concurrency, most likely from
  writes queueing for those connections; this was not profiled.
- **Approvals feel it most.** At 50 runs at once on PostgreSQL an approval takes
  206 ms at p50 with no pauses and 335 ms at the demo's pace, against 17 to 28 ms
  for one run alone. These are round trips under a burst of simultaneous runs.
- **With agent time included, the database cost is visible but not dominant.**
  At the demo's pace, one run takes 7.43 s on PostgreSQL against 7.04 s in
  memory. Fifty at once take 9.67 s against 7.14 s, about 35% more. The burst
  is worst-case: every run in it reaches its steps at the same moment.

### What it does not show

- **Real agents and real security.** No Codex, containers, model calls or
  real security middleware. Those dominate real runs and are measured by the
  security benchmark (`docs/BENCHMARK.md`), not here.
- **A production database.** PostgreSQL ran in Docker on the same busy machine,
  with no tuning, no network between it and the server, and a store that started
  empty. The numbers do not predict a deployed system.
- **A clean baseline against the earlier in-memory figures.** Those came from a
  different machine (a Windows laptop with Node 22.19.0), so they were replaced
  rather than compared.
- **Network and multiple servers.** One machine and one process, over
  loopback. Several server instances would also need a shared event bus
  (`run-events.ts`).
