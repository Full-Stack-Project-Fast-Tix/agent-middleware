# Local POC implementation specification

18 November 2026. Planned behavior to implement, not a claim that these fixes
exist. Read with [the handover](../handover.md) and canonical `CLAUDE.md`.

> **Status:** implemented on 18 November 2026 except the paid live runs and the
> manual browser pass; the handover's ticket **Status** notes give the code and
> test evidence and the remaining limits. Settled choices are recorded as
> contract decisions 33–37.

## Scope and decisions

Implement the five handover tickets with the details below. Keep Claude only,
one application instance, existing workspace roles, serialized writes and
isolated Run copies. Keep semantic action thresholds at 0.50 for review and
0.75 for blocking; confidence remains explanatory metadata. Improve evidence
coverage before tuning scores again. No deployment, nested delegation, arbitrary
policy language, automatic rollback or UI overhaul is required. The owner will
do manual browser and paid live-model testing after implementation. Deliver
automated checks and an opt-in harness rather than depending on credentials.

## A. Trustworthy snapshots and diffs

Create one shared baseline/final snapshot implementation, not a UI listing that
silently stops walking. Sort entries. Bound file count, directory traversal,
depth, per-file and aggregate bytes before reading whole files. Report exhausted
bounds and filesystem failures. An unreadable directory is incomplete coverage,
not empty. Keep current scale initially: 500 files, 2 MB hashable file size,
256 KB text per file and 2 MB aggregate baseline text. Add documented traversal
and aggregate hash-byte budgets. Exactly reaching a cap is not proof that more
files exist: distinguish complete scans from stopped scans.

Use identical declared exclusions on both sides. Dependencies, VCS internals
and generated output can remain excluded, with that scope disclosed. Detect
ordinary source/configuration edits including dotfiles. Keep credential
exclusions. Never dereference links outside the Run. Record link presence/type;
a changed link is not fully content-reviewed. ZIP scope may differ from review
scope if documented; a shared UI scanner is not a requirement.

Separate path presence from content availability. Present oversized/unreadable
files must never appear deleted. If comparison is impossible, report uncertainty
rather than inventing changed/unchanged status. Establish absence through a
complete scan before claiming deletion. Produce a genuine line diff with
positions and bounded runtime; exhausted computation means incomplete coverage.
Reorders, duplicate lines and edits after line 200 must be visible. Normalize
and redact old/new text consistently. If hashes differ but redaction hides the
change, report redacted-content change, not an empty fully reviewed diff.

Version artifacts; historical cached artifacts cannot imply new completeness.
Old/missing/corrupt baselines yield unavailable, never a replacement baseline
captured after edits. Write artifacts atomically outside the agent-writable
copy, after execution stops. Preserve failed/cancelled Run artifacts.

## B. Semantic coverage and saved outcomes

Distinguish inventory coverage, changed-content coverage, model review coverage
and UI preview truncation in shared validated contracts. Use bounded reason
codes/counts. Historical responses without evidence mean unknown, not aligned.
Batch complete changed hunks under a documented total model budget. Every hunk
must be accounted for; sampling cannot establish complete review. Omitted
content, changed binary files, inaccessible content or exhausted review budgets
produce incomplete review. An unchanged asset need not have displayable content
when its unchanged status was actually established. Keep the 36 changed-file
review limit initially and disclose it in the Run form.

Include all bounded action records instead of dropping the first 16 of 48.
Preserve stable file/effect/chunk identifiers when merging assessments; chunk
indices must not collide. Validate all required effect assessments; retain any
conflict across chunks. Apply explicit coverage accounting to proposed-action
review too. Inspect both full `proposedAction` and shortened `proposedEffects`
before deciding which clipping actually removes evidence. Oversized commands
or edits must be reviewed completely or held/fail closed, never silently aligned.

Persist a bounded final-review result for success as well as failure: status,
coverage reasons/counts, risk/classification where applicable and safe rationale.
Distinguish aligned, conflict, incomplete, unavailable, no changes and not run
or disabled. Absence of a failure finding is not proof that review occurred.
Account for monitor usage/duration separately, or label execution-token totals
as excluding monitor calls rather than implying total model cost.

Enabled final review with conflict >=0.50, incomplete coverage or monitor
failure prevents completed status and follow-up seeding. Artifacts remain
inspectable; no rollback is promised. Cancellation or timeout during final
review must not later become completed: preserve terminal-state guards and
bound monitor timeouts. Explain review failure separately from coding-task
failure using existing statuses where possible.

## C. Exact human approval

An approval authorizes only its exact pending proposal, never related future
work or weaker mandatory policy. Final review needs server-loaded approval
identity/outcome, action binding and bounded safe proposal details. Approved
scope expansion can pass only insofar as actual effects match that approval.
A generic summary is insufficient proof of matching; unresolved matching stays
incomplete/conflicting. Never trust agent claims of approval. Test narrow
approved expansion plus an additional unapproved effect. Denied/timed-out
approvals grant nothing. Deterministic mandatory restrictions remain stronger.
Do not add a post-execution button to promote failed Run copies in this iteration.

## D. Focused interface fixes

Follow `apps/web/DESIGN.md` and existing components. The receipt should show
what ended, what changed, whether final review ran, its coverage and links to
evidence. Unknown counts stay unknown: unavailable baseline is not zero changes.
Preserve unverified-agent-report wording, collapsed task details, and separation
of gate proposals from actual changes. Use existing untrusted-text primitives
for paths, diffs and proposals. Guard async responses against route changes so
old Run evidence cannot appear under a different Run; provide retry on errors.

Choose the minimal download fix: call the existing control "Download text
preview" and disclose truncation/redaction; ZIP provides full bytes of included
files subject to explicit limits/exclusions. Show archive errors clearly.
Approval cards must show the action and hold reason; disable approval with
missing safe proposal details while preserving deny/refresh and server authority.

Filter supervisor choices to agents eligible to delegate under effective policy
and show a useful empty state. For single-agent follow-ups, preserve the chosen
agent when eligible or offer a selector; do not silently switch identity.
Show the actual parent Run, since submission from an old/failed Run page still
uses the workspace's latest completed Run. Verify API behavior before changing
it and preserve the one-active-Run-per-workspace 409 protection.

## E. Verification and completion

Use focused tests, then `npm run check`. Include deterministic snapshot/diff
edge cases in handover ticket 1. Add orchestrator integration cases with
controlled adapters: aligned completion, conflict, incomplete coverage, monitor
error, exact approved effects, additional unapproved effects, cancellation
during review and correct follow-up baseline. Use meaningful frontend tests
for receipt/download/approval behavior and async response races. Static markup
assertions alone do not prove interactions.

Check in an opt-in harness for the owner's live testing. Validate starting
fixtures and guard settings, use synthetic credentials and disposable projects,
bound run/time/token use, save redacted reports and cancel cleanly. Never send
synthetic secrets to public destinations. Score model refusal, action not
reached, action-gate intervention, final-diff detection, false holds and task
completion separately. Guard-off still has mandatory runtime policy; disclose
that rather than implying an unrestricted baseline.

Update architecture and contract decisions for implemented behavior, README for
setup/claims and handover ticket status with code/test evidence. Leave live
outcomes unclaimed until observed. Supply commands and environment variable
names for the owner's later tests, never secret values. Deliver coherent
commits, check results, remaining limitations and a short owner checklist.
No push or deployment is part of this implementation task.
