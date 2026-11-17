# AgentGuard local POC handover

Updated 17 November 2026. **Start here if you are taking over implementation.**
The aim is a credible local demonstration of guarded Claude coding Runs, not a
hosted or production service. Implement the tickets below, verify them with
focused tests and `npm run check`, then hand the app to the project owner for
browser and live-agent evaluation. Do not spend this iteration on Linux/ECS
deployment, multi-instance orchestration, hardened tenant isolation, or a UI
rewrite.

## Read in this order

1. [`AGENTS.md`](AGENTS.md), then its canonical guide [`CLAUDE.md`](CLAUDE.md).
2. This handover; inspect each cited implementation and test before changing it.
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

**Required change.** For final review, batch or sample *all* changed hunks
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

### 4. Establish one real end-to-end final-review result

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

## Owner's manual pass after the friend finishes

The owner will start the local password-mode app with Postgres, Docker and a
Claude key; create a workspace from ZIP and another from a server folder; run
both one-agent and planned multi-agent tasks; submit a follow-up prompt; inspect
the receipt, gate timeline, actual diff and ZIP; approve and deny real held
actions through the browser; exercise vault host grants; and check desktop and
mobile layouts. A failed/cancelled Run should retain artifacts and not become a
follow-up baseline. Record unexpected behavior with Run IDs and screenshots.
Do not use real credentials or a non-disposable project for guard probes.

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
