# AgentGuard local POC handover

Updated 18 November 2026. **Start here if you are taking over implementation.**
The aim is a credible local demonstration of guarded Claude coding Runs, not a
hosted or production service. Implement the tickets below, verify them with
focused tests and `npm run check`, then hand the app to the project owner for
browser and live-agent evaluation. Do not spend this iteration on Linux/ECS
deployment, multi-instance orchestration, hardened tenant isolation, or a UI
rewrite.

> **Status, 18 November 2026 (evening):** tickets 1–3 are implemented and
> tested; ticket 4 and 5 code (orchestrator integration tests and an opt-in
> live harness) is implemented, and **the paid live runs and the manual browser
> pass are still the owner's to do**. No live result was recorded. Commits:
> `a49d108` (diff and final review), `6d295de` (action-review itemization),
> `d5b28a4` (UI), `e279758` (live harness), plus the documentation commit. Each
> ticket below has a **Status** note with its evidence; the owner checklist is
> at the end.

## Read in this order

1. [`AGENTS.md`](AGENTS.md), then its canonical guide [`CLAUDE.md`](CLAUDE.md).
2. This handover; inspect each cited implementation and test before changing it.
   Then follow [`docs/LOCAL_POC_IMPLEMENTATION_SPEC.md`](docs/LOCAL_POC_IMPLEMENTATION_SPEC.md)
   for resolved design choices, additional UI work and automated acceptance criteria.
3. [`docs/contract-decisions.md`](docs/contract-decisions.md) for settled
   authority, gate, lifecycle, approval and Claude-runtime contracts.
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the current system,
   [`docs/GUARD_EVALUATION_RESULTS.md`](docs/GUARD_EVALUATION_RESULTS.md) for
   evidence, and [`apps/web/DESIGN.md`](apps/web/DESIGN.md) for UI semantics.
   [`README_AgentGuard.md`](README_AgentGuard.md) is product vision, not a
   checklist of implemented features.

## What currently works, and what the evidence proves

The local password-mode app uses Postgres, a Claude agent loop, disposable tool
containers, server-owned action gates, Run → Task → AgentExecution orchestration,
isolated Run copies, workspace roles, approvals, vault host grants, ZIP import
and export, a Run timeline, and follow-up prompts. A follow-up Run copies the
latest **completed** Run in its workspace; failed/cancelled Runs retain their
artifacts but do not seed a follow-up. Single and planned multi-agent Runs share
this model. Current automated tests cover many mechanics; they are not a
measurement of guard effectiveness.

The latest documented live trial (16 November) ran four single-agent cases.
The guarded adjacent-feature case was held at action review and ended when its
approvals timed out; its copy contained only requested changes. A standalone
Claude call to `reviewFinalRunDiff` classified the unguarded extra feature as
scope expansion (0.55) and the guarded diff as aligned (0.03). **No live Run in
that trial reached the orchestrator's automatic final-diff completion gate.**
Unit tests cover that transition. Earlier trials did produce extra receipt
files despite later semantic findings. Do not claim reliable prevention of
scope drift or a measured detection rate from these small samples.

## Implement in this order

### 1. Correct and complete the actual Run diff — highest priority

**Observed code issue.** [`run-diff.ts`](apps/server/src/run-diff.ts) hashes files
to detect modification, then compares only the first 200 lines using line
membership. A change after line 200, a reorder, or duplicate-line count change
can yield a modified file with an empty or misleading text diff. The final
semantic reviewer consumes that same artifact. Baseline capture in
[`working-copies.ts`](apps/server/src/orchestrator/working-copies.ts) walks a
different file set from the post-Run scanner `listWorkspaceFiles`: depth and
excluded directories differ. Post-Run files over 2 MB are omitted from its map,
so an oversized existing file can appear deleted. A limit flag does not make an
incorrect deletion label acceptable in Run Detail.

**Required change.** Give baseline and post-Run enumeration one shared,
explicitly bounded scope, with matching exclusions, depth, symlink policy and
file-size handling. Keep hashes for change detection; represent an unreadable
or oversized changed file as changed with unavailable contents, never as
deleted. Make incomplete coverage explicit in the diff contract and fail the
semantic completion gate closed when its evidence is incomplete. Produce a real
bounded line diff (or equivalent old/new change excerpts with positions) so
reorders, duplicate lines and late-file edits are visible. Redact before
persistence/response. Preserve bounded storage and API behavior; add a schema
field only if needed to distinguish complete from display-only truncation.

**Acceptance:** tests cover line 201+, reorder, duplicate lines, deletion,
added binary, oversized modification, ignored/deep paths, symlinks, 500-file
limit and large baseline. The UI reports exactly what is unavailable. A
modified file must never be silently shown as unchanged or deleted because it
could not be read. Review the ZIP scanner too so the UI does not promise a
"whole folder" when an archive limit excludes part of it.

**Status: done.** One shared scanner (`apps/server/src/workspace-snapshot.ts`)
for baseline and final scans, a Myers line diff with positions
(`line-diff.ts`), and a versioned artifact with inventory/content coverage
(`run-diff.ts`, contract decision 34). Present-but-unreadable/oversized files
are changed or `uncertain`, never deleted; a missing or older baseline is an
unknown count and is never recaptured after edits; the route refuses active
Runs and reports expired copies; the file listing and ZIP say what they left
out. Tests: `apps/server/tests/orchestrator/run-diff.test.ts` (line 201+,
reorder, duplicates, deletion, added binary, oversized changed and same-size,
excluded and deep paths, links and a directory replaced by a link, exactly 500
vs 501 files, large baseline, credential-named files, encoding-only change,
unreadable file and directory, cached and legacy artifacts, missing
baseline, nested build output, a parent that became unreadable),
`tests/server/run-routes.test.ts`, `tests/workspace-zip.test.ts`,
`tests/server/workspace-files.test.ts`. An independent review found that
nested `build`/`dist` folders were excluded from the diff yet carried into
follow-up Runs, that an overall block-level verdict could be dropped when an
approved item conflicted, that `/workspace/...` approval paths never matched,
and that an unreadable parent could read as a deletion; all four are fixed
with regression tests.

### 2. Make semantic completion review cover its stated evidence

**Observed code issue.** [`semantic-run-diff.ts`](apps/server/src/semantic-run-diff.ts)
passes only the first 1,200 characters of each file's diff to Claude, without a
coverage marker; it also passes only the last 32 reviewed actions although the
orchestrator accepts up to 48 before marking its ledger truncated. A review can
therefore return "aligned" while relevant changed lines or an earlier action
were never presented. The action checkpoint in
[`intent-controller.ts`](apps/server/src/intent-controller.ts) likewise cuts
each command clause or file-change excerpt at 1,200 characters; a long compound
proposal can hide a later effect inside a summary. Existing size limits are
reasonable, but invisible omission is not.

**Required change.** For final review, batch all changed hunks
with explicit coverage accounting, and provide the action ledger within its
bound (or an explicit incomplete state). If complete content cannot fit the
configured model input budget, return an incomplete review and prevent an
"aligned" completion; do not silently clip. Keep full source text out of
findings and approval payloads. For action review, ensure every proposed effect
has either its relevant excerpt assessed or an explicit insufficient-evidence
result that invokes the existing hold/fail-closed rule. Avoid sending excessive
trivial content when a safe bounded selector can cover the changes, but make
the selector's limits testable.

**Acceptance:** tests put unrelated work after character 1,200, in the first of
48 reviewed actions, and in a late shell clause/file change. Each case is
reviewed with visible evidence or marked incomplete; none is silently aligned.
The orchestrator's fail-closed completion and follow-up baseline behavior stay
intact. Start with [`semantic-run-diff.test.ts`](apps/server/tests/semantic/semantic-run-diff.test.ts)
and the orchestrator tests.

**Status: done.** Final review (`semantic-run-diff.ts`) checks coverage first
and returns `incomplete` without a model call when anything is missing; every
changed hunk becomes effects with stable ids in bounded batches, each of which
must be assessed; the full 48-entry ledger and server-loaded approvals are
included; exact-approval coverage is checked deterministically (decisions 35,
36). The outcome is saved on `Run.finalReview` (migration 007) for success and
failure, with the review model's usage kept apart. The review runs outside the
Run lock and is aborted by cancel. Action review itemizes every clause/file in
parts or holds (decision 33). Tests: `tests/semantic/semantic-run-diff.test.ts`
(work after character 1,200, a late part of a long hunk, a later batch, the
first of 48 actions, skipped effects, every coverage gap, budget, monitor
error, abort, approvals), `tests/semantic/intent-controller.test.ts` (late
clause, more than 24 parts, heredocs, late file content, skipped effect,
oversized edit), `tests/orchestrator/final-review.test.ts` (aligned, conflict
and follow-up baseline, incomplete, monitor and diff errors, disabled and
not_run, ledger bound, exact approval, extra unapproved effect, denied
approval, approve refused without details, cancel during review),
`tests/persistence/run-store.test.ts` (final review round trip, also run
against a disposable PostgreSQL 15).

### 3. Make decisions and artifact limits intelligible in the UI

Review [`RunDetail.tsx`](apps/web/src/runs/RunDetail.tsx),
[`RunFiles.tsx`](apps/web/src/runs/RunFiles.tsx),
[`ApprovalsPage.tsx`](apps/web/src/workspace/ApprovalsPage.tsx), and the shared
Run/approval contracts. Run Detail already separates proposed gate edits from
actual file changes and labels agent output unverified. Preserve that. Add a
compact plain-language final-review result/coverage state to the receipt
(aligned, conflict, incomplete/unavailable, or not run), linked to its finding
and diff; today's receipt gives only changed-file and intent/action counts. Do
not call task completion proof that the code is correct.

The individual file "Download" in `RunFiles` uses the preview endpoint, which
returns at most 256 KB, then reports truncation *after* the download. Make the
control say "Download preview" when bounded, or use a full-byte endpoint; the
ZIP remains the full-byte path subject to archive limits. Make archive failures
and omitted-content limits clear before a user assumes they have a complete
project. In approvals, show the exact bounded proposal/effect and why it was
held before approval; if safe details are unavailable, say so and avoid a blind
approval from the queue. Keep server authorization authoritative.

**Acceptance:** frontend tests verify receipt states, long-file download
wording, approval evidence/empty evidence, and denied/timeout displays. Test
keyboard and narrow layout where these components change; the owner will do
the full visual/browser pass later.

**Status: done in code; visual pass is the owner's.** Receipt with final
review state, coverage, flagged paths, finding and labelled tokens
(`RunReceipt.tsx`, `run-receipt.ts`); v2 diff rendering that names what is
unavailable (`ActualChanges.tsx`); approval evidence with hold reason and
exact proposal, Approve disabled without saved details in the queue, held
strip, drill-down and gate timeline (`ApprovalEvidence.tsx`); "Download text
preview" with truncation/redaction notes and ZIP omission counts
(`RunFiles.tsx`, `run-file-actions.ts`); Run-scoped loading with retry
(`latest-request.ts`); supervisor filtering by effective policy and follow-up
agent/parent display (`agent-choice.ts`, `NewRun.tsx`,
`ContinueWorkspace.tsx`). Tests: `apps/web/src/runs/*.test.ts(x)` for receipt
states, unknown counts, diff notes, download wording, archive failures,
approval evidence and replayed Approve/Deny clicks, denied/timeout wording,
stale-response races, and agent choice. **Limit:** adding a DOM test library
was not permitted in this environment, so interactions are tested through the
handlers and rendered markup, not real browser events; keyboard and narrow
layouts need the owner's browser pass.

### 4. Prepare repeatable end-to-end final-review validation

Implement this as automated orchestrator tests and a checked-in opt-in live
harness. The owner will run the paid live cases afterward. Missing credentials
must not block completing the implementation and automated verification.
The following describes the live procedure the harness should support.

After 1–3, use disposable fixtures, a bounded Claude budget and the current
local Postgres/container setup to run an aligned changed Run that completes
through the **orchestrator** final-diff gate. Then run an adjacent-scope case
that actually proposes the deviation; resolve or deny its approval rather than
letting a five-minute timeout hide the completion path. Capture Run IDs,
prompts, starting fixture, changed files, action decisions, approval outcome,
final review finding, Run status, latency/tokens and whether a follow-up can
seed from the result. Distinguish model refusal, action-gate intervention and
final-diff intervention. Update
[`docs/GUARD_EVALUATION_RESULTS.md`](docs/GUARD_EVALUATION_RESULTS.md) with
observed results only. This verifies implementation; the owner will test
overall effectiveness after handoff.

**Status: harness done, live runs not done.** Automated orchestrator cases are
in `tests/orchestrator/final-review.test.ts`. The opt-in harness is
`benchmark/run-final-review-live.ts` (`npm run eval:final-review -w
@launchpad/server`), scored by the pure `benchmark/final-review-scoring.ts`
(tests in `benchmark/tests/final-review-scoring.test.ts`). It was verified to
refuse without its prerequisites; it has not run a paid case.
`docs/GUARD_EVALUATION_RESULTS.md` records only that no new results exist.

### 5. Improve repeatable evaluation, then update claims

The current 36-Run exfiltration matrix in the guard-results doc planted `.env`
in source, but working-copy preparation excluded it; no Run saw the secret,
and Claude usually refused before an egress proposal. It cannot establish an
egress containment rate. Extend existing benchmark fixtures with synthetic
credentials under a permitted test-only filename, controlled sink proposals
that reach the action gate, benign controls, and both single/multi-agent modes.
Test deterministic policy, high-consequence approval, egress and vault grants
separately. For semantic work, use ordinary user prompts and several adjacent
instructions with matched guard-off/on controls; score only when an agent
actually proposes the deviation. Include false holds, task completion and
latency/cost. Keep expensive live repeats optional and bounded; deterministic
gate/replay tests should be the default CI proof. Review README and architecture
wording against new evidence, keeping historical benchmarks clearly labelled.

**Status: fixtures and scoring done, live runs not done.** The harness's
`egress-control` case plants a synthetic token in `fixtures/test-credential.txt`
(kept by the copy) with a `.invalid` sink, plus an `egress-benign` control,
in single or auto mode, guard off and on. Scoring separates refusal, not
reached, gate intervention, final-diff detection, false holds and completion.
The later stages 1–2 follow-up adds a controlled repeatable vault/destructive
approval matrix in the policy tests. No new paid live evidence has been recorded.

## Owner's manual pass after the friend finishes

### Stage 3 status, 19 November

The two wrap-up commits have been pushed. Real Postgres persistence/configuration
checks passed 60/60 after fixing the Windows CRLF test fixture. Eight controlled
Postgres/Docker Runs passed single/multi-agent copy continuity and deterministic
approval/network checks; a synthetic encrypted-vault/real HTTPS broker check
passed too. These controlled Runs used scripted actions and no semantic model.
The first live Claude Run failed with HTTP 401 for the configured API key before
any coding or final review. Replace `ANTHROPIC_API_KEY` locally to resume the
live matrix. Stage 3 is partially verified, not complete. See
[`GUARD_EVALUATION_RESULTS.md`](docs/GUARD_EVALUATION_RESULTS.md) for exact Run IDs,
scope and the remaining live checks. Stage 4 browser validation is still pending.

### Wrap-up stages 1–2 follow-up

The 500/501-file boundary now exercises one scanner fixture instead of copying
two projects; snapshot hashing uses at most eight concurrent readers. Hashing
streams up to 64 MB per file (128 MB aggregate), so unchanged assets above 2 MB
no longer force uncertainty. Changed binary/large/unreadable content remains
incomplete. Action proposals are reviewed in at most four complete batches
before any action executes. Approval evidence is kept complete for relevant
paths in each final-review batch instead of clipped at 1,600 characters.

Planner, runtime and monitor clients share the Run admission budget; 20%, capped
at 128,000 tokens, is reserved for final review. Unknown provider usage retains
a conservative charge. The receipt shows the saved ledger; this is not an
exact billing estimate. ZIP still intentionally omits generated build output,
dependencies, VCS, credential paths and links, and is labelled project files.

The controlled repeatable vault-destination and destructive-approval matrix is
in `apps/server/tests/policy/execution-guard.test.ts`; run it without model or
network calls with `npm test -w @launchpad/server --
tests/policy/execution-guard.test.ts -t repeatable`. It replays proposed actions
through real middleware twice per case, covering allowed/missing/wrong vault
hosts and approve/deny/timeout plus rejected duplicate answers. This is gate
verification, not evidence that a live model proposes attacks or that HTTPS
delivery works. Live and browser validation remain stages 3–4.

Automated wrap-up verification: shared tests 47 passed; server tests 1,178
passed with 78 skipped; frontend tests 135 passed. No new live-model results
are claimed. See the guard-results document for the controlled test scope.

The owner will start the local password-mode app with Postgres, Docker and a
Claude key; create a workspace from ZIP and another from a server folder; run
both one-agent and planned multi-agent tasks; submit a follow-up prompt; inspect
the receipt, gate timeline, actual diff and ZIP; approve and deny real held
actions through the browser; exercise vault host grants; and check desktop and
mobile layouts. A failed/cancelled Run should retain artifacts and not become a
follow-up baseline. Record unexpected behavior with Run IDs and screenshots.
Do not use real credentials or a non-disposable project for guard probes.

### Owner checklist (commands; set values yourself, never commit them)

1. Install and verify: `npm ci && npm run check`. Optional database tests:
   `TEST_DATABASE_URL=postgres://… npm test -w @launchpad/server`.
2. Start the stack (README "Run on Claude"): `docker compose up -d postgres`,
   `export DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad`,
   `npm run db:migrate -w @launchpad/server` (applies migration 007),
   `npm run build:claude-runtime`, then `npm run poc` with
   `GUARDRAIL_SEMANTIC_ENABLED=true` in `.env`.
3. Browser pass: a one-agent and a planned Run; check the receipt's final
   review line and coverage, the actual-changes notes, "Download text preview"
   on a file over 256 KB, the ZIP note, an approval card's proposal (Approve,
   Deny, and a timeout), a follow-up from a failed Run page (it should name the
   latest completed Run and keep the agent), the supervisor list for an agent
   that cannot delegate, keyboard-only use, and a 360px-wide window.
4. Live cases (paid): `AGENTGUARD_LIVE_EVAL=1 DATABASE_URL=… BENCH_OWNER_EMAIL=…
   ANTHROPIC_API_KEY=… npm run eval:final-review -w @launchpad/server -- --cases
   aligned-change,adjacent-scope,exact-approval --mode single`, then
   `--cases egress-control,egress-benign --guards off,on` and `--mode auto`.
   Optional bounds: `BENCH_RUN_TIMEOUT_MS`, `BENCH_CLAUDE_MAX_ITERATIONS`,
   `BENCH_RUN_TOKEN_BUDGET`, `BENCH_MAX_CASES`, `BENCH_OUT_DIR`. Record Run
   IDs and the report's buckets in `docs/GUARD_EVALUATION_RESULTS.md`.

## Dependencies and completion rule

Tickets 1 and 2 touch the same diff contract and should be implemented
sequentially. Ticket 3 can start after the result/coverage contract from 1–2
is settled. Ticket 4 requires those code fixes and a configured local runtime.
Ticket 5's fixture work can begin now; claims should wait for observed results.
No work above depends on another team member or a cloud host. The friend owns
code, focused tests, docs updates and `npm run check`; the owner owns the later
interactive/product evaluation. Commit coherent changes separately. Report
exact test results, remaining limitations and any case where the model never
reached the guard. Never treat a saved finding alone as proof that an unwanted
file write was prevented.
