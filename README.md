# Agents on a Leash

> **Try it before reading further.** Runs are real agents on Claude:
> [Run on Claude](#run-on-claude). Needs Docker, Postgres and a key in `.env`.
> `./scripts/verify-guards.sh` re-derives the recorded results for free.

## Architecture Diagram
<img width="1280" height="889" alt="architecture_diagram" src="https://github.com/user-attachments/assets/625e2753-09f4-4e59-b7c2-72d39c82e13e" />

## Motivation and Problem Statement
An autonomous coding Agent can go off the rails **on its own**. No attacker is
required: a bug in its reasoning loop, a bad inference, a malicious line in a
`README` or skill file it opened, or a panic in a retry loop is enough for it to
`curl` a credential file to the wrong place or wipe a directory it should never
have touched.

This project is a minimal browser-based Agent platform running Claude with
the missing middleware: a **leash**. A small family of **guards** — four deterministic, one
task-aware model call — watch the Agent's own execution trace and stop it the
moment it is about to cross a line it must never cross, whatever led it there. A
separate **reflection layer** then carries what a guard caught into that Agent's
later runs, so the same mistake is caught faster the second time — and the rule
that stops it was written by the guard, not by the model.

> [!WARNING]
> This is a proof of concept. By default it is single-user with a shared token;
> `APP_AUTH_MODE=password` adds user accounts and workspace roles (see
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Workspace roles provide
> logical separation and a constrained tool container, but not hardened tenant
> isolation or a guarantee that every unsafe action is contained.
> Do not point it at production data or real credentials.
> Multi-agent run copies omit common environment-secret and credential-file
> patterns, but that filename-based filter is not general secret detection.
> See [SECURITY.md](SECURITY.md).

---

## Table of contents

- [The idea in one page](#the-idea-in-one-page)
- [The guards](#the-guards)
- [The reflection layer](#the-reflection-layer)
- [Evaluation](#evaluation)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Run the demo scenario](#run-the-demo-scenario)
- [Configuration](#configuration)
- [Validation & tests](#validation--tests)
- [Guard coverage and limitations](#guard-coverage-and-limitations)
- [What this is built on](#what-this-is-built-on)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [License](#license)

---

## The idea in one page

### Threat model

The danger is the Agent acting against the user's interest **without an
adversary in the loop**. Prompt injection through content the Agent reads (a
downloaded skill, a config file, command output) is one way it happens; a
reasoning bug or a misread instruction is another. The middleware does not try
to decide *why* the Agent is doing something, or whether an instruction is
"really" the user's — that is unknowable at runtime.

### Behavioural invariants, not intent detection

Each deterministic guard enforces a **behavioural invariant**: something the
Agent must never do, no matter what led it there (for example, preventing
recognized workspace credentials from being sent through a detected egress
path). The guard only asks whether the Agent is about to cross that line.
Filename-based working-copy exclusions reduce exposure but do not detect every
secret or guarantee that sensitive data never leaves the machine.

The semantic guard is the one exception, and a narrow one. It does not guess
motive either — it compares the Agent's *apparent objective* against the
*trusted* task and asks whether they still line up. It can steer, and it can
decline a consequential action, but the hard refusals stay with the
deterministic guards.

### Deterministic checks over the raw trace

Every execution is recorded as a JSON-RPC trace
([`.data/traces/<runId>.jsonl`](apps/server/src/trace.ts)). A **check** is a
pure function: it takes the whole trace and returns findings. It reads no files,
no network, no clock, no randomness — same trace in, same findings out. That one
restriction buys everything else:

- the **same function** runs live (fed the trace so far after every event) and
  offline (replayed against a recorded trace with no Agent and no API cost);
- a check written today can be replayed against a run recorded last week;
- a check is unit-tested by hand-writing a five-line trace.

See [`apps/server/src/checks.ts`](apps/server/src/checks.ts) — read it first if
you are adding a check.

One guard sits outside this abstraction on purpose. The **semantic intent
guard** makes a single tool-less model call, so it is not deterministic and
cannot be a `Check`. It is listed with the others below; a deterministic
controller still owns every action it takes, and an existing deterministic
`violation` always wins.

### Enforcement in the runtime path, not the UI

Findings are acted on through the middleware's [`ActionGate`](apps/server/src/orchestrator/ports.ts):

| Finding severity | What happens |
| --- | --- |
| `violation` on an action still waiting for approval | refused with `decline` — that one action is dropped, the Agent carries on with the rest of the task |
| a second distinct declined action in the same turn | `turn/interrupt` — an Agent that keeps reaching for blocked moves is not corrected by another steer |
| `violation` on an action already running (no approval boundary) | `turn/interrupt` ends the turn immediately, or steer-only when `onViolation` is set that way |
| `warn` | recorded and shown in the trajectory; the turn is never interrupted. It may inject one **steer** — corrective text pushed into the live turn |
| `info` | recorded only |

When the **egress or semantic guard is on**, the guarded turn runs
`workspace-write` scoped to `/workspace`, with `approvalPolicy: untrusted`
([`turn-security-policy.ts`](apps/server/src/turn-security-policy.ts)). Network
is denied by default and can be enabled separately with `AGENT_NETWORK_ACCESS=true`.
Ordinary
known-safe reads (`ls`, `cat`, `rg`) run untouched. Claude can only act by asking
AgentGuard's agent loop, so commands and file edits reach the gate before they run.

An execution whose resolved policy denies network access has its tool container
started with no network.

Steer text is not written by each detector. A finding names a remediation
category and the shared policy
([`steering-policy.ts`](apps/server/src/steering-policy.ts)) builds the
sentence, so every guard corrects the Agent in the same voice. Soft steers are
capped per turn — several in a row stop reading as a correction.

With **no guards enabled** (the default), the checks decide nothing: every
action is accepted, subject to the agent's profile, and the Agent runs exactly as it would unobserved.

Each guard has its own `GUARDRAIL_<NAME>_ENABLED` flag and can be tested in
isolation. **There is deliberately no master switch.**

---

## The guards

### Sensitive-egress guard — `GUARDRAIL_EGRESS_ENABLED`

**Invariant: workspace secrets do not leave the machine without an explicit user grant.**

A guarded turn runs `workspace-write` limited to `/workspace` and
`approvalPolicy: untrusted`. Network stays denied unless the operator sets
`AGENT_NETWORK_ACCESS=true`; every command still reaches the gate. In a Run with
vault grants, direct outbound commands wait for human approval. Requests through
the constrained vault broker are checked against the executing agent's host
grants and can proceed only for an approved host. The runtime expects every
command except a known-safe read — and any file-edit proposal — to pause at an
approval request. At that step the guard refuses a command that carries a
workspace secret — one that:

- names a sensitive path in its own arguments (`curl --data @.env …`), or
- follows an earlier read of a sensitive file (`cat .env` then `curl …`), or
- carries the literal bytes of a credential that an earlier command in the same
  run printed to its output.

`turn/interrupt` is the backstop if the command is already running. A safe task
in the same configuration runs untouched.

### Local credentials for a Run

Configure a 32-byte encryption key as `AGENTGUARD_VAULT_MASTER_KEY` (64 hex
characters) in the server's private `.env`. Generate one locally with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
The server stores each workspace's encrypted vault under `APP_DATA_DIR/vault/`;
the key is not stored beside the encrypted entries. Back up the key securely:
without it, vault entries cannot be decrypted after a restart or migration.

Manage credentials from the workspace's **Credentials** page by entering a name,
value, and exact allowed HTTPS hostnames. Existing project `.env` files are not
read automatically; add only the credentials needed. The UI receives metadata,
never stored values. For each Run, grant a credential to specific agents. Those agents can request
GET or POST through the host-side broker using the `agentguard-vault request`
operation described in their task. The broker attaches the credential only to
the configured auth header and only for an exact approved host; it rejects
redirects and non-public DNS destinations. Values are not placed in the
container, prompt, audit metadata, or saved traces, and exact-value matches are
redacted from broker responses and final summaries. Direct network commands
remain subject to the network capability and approval gate. A vault grant does
not enable container network access.

This is encrypted local POC storage, not an OS keychain or production multi-
tenant vault. Protect the master key and server data directory, and avoid using
it as a shared hosted secrets service.

A second, orthogonal check — **outbound-blob**
([`check-outbound-blob.ts`](apps/server/src/check-outbound-blob.ts)) — ignores
filenames entirely and flags an outbound command carrying a base64/hex run of
`GUARDRAIL_BLOB_MIN_CHARS`+ characters (default 128). That is a `violation` when
a sensitive file was read earlier in the run, and a `warn` otherwise.

> [!NOTE]
> A third check, **egress-intent**, used to ride this flag: it refused a command
> when the Agent's narration had stated an exfiltration intent and a later
> command was outbound. It was removed on 2026-08-30. Both halves were weak in
> the same direction — the narration side was the pattern matcher, and "a later
> outbound command" included `npm install` — so a live run was ended by the
> sentence *"I won't send the .env file due to security constraints"*, in which
> the Agent was declining to do the thing. It was also the only path by which
> pattern matching over prose could end a turn. Reasoning is now watched by the
> semantic guard, which can only steer.

Implementation:
[`check-sensitive-egress.ts`](apps/server/src/check-sensitive-egress.ts).

### Agent-intent guard — `GUARDRAIL_INTENT_ENABLED`

**Watches what the Agent *says it is about to do*, not what it does.**

It reads the reasoning narration in the trace and records a **warning** when the
narration states an intent to: work around the guard, destroy data outside the
task, exceed its scope, exfiltrate a secret, give itself a foothold that
outlives the task, erase the record of what it did, or mislead the user about
the result.

**Warn-only, by design.** Narration is self-reported: the model may be thinking
out loud about a path it never takes. A finding is recorded and shown in the
trajectory but never interrupts a turn. A clause that only weighs an option and
turns it down (*"I could force-push, but I won't"*) is dropped, as is anything
that reads as a question.

Implementation:
[`check-agent-intent.ts`](apps/server/src/check-agent-intent.ts).

### Learned-watch guard — `GUARDRAIL_REFLECTION_ENABLED`

The enforcement point for the [reflection layer](#the-reflection-layer). It is
handed the parameters folded out of the Agent's stored reflections and
**warns** when the current run heads somewhere the same Agent has already been
stopped:

- **a destination** the Agent has sent to before — precise, but only catches a
  repeat that reuses the same host;
- **a host family** — once the Agent has been stopped at two different hosts
  under one parent domain, contact with *any* host under that parent warns,
  including one never seen before. Rotating the subdomain no longer helps.
  Derived at fold time from the incidents, never stored, so withdrawing one
  sibling collapses the family back to exact matching;
- **a file whose contents preceded a bad step before** — blunt, and that is why
  it generalises: it fires at the *read*, a whole step before any command
  exists, and does not care what the command would have been. A different host
  and a different tool are still caught.

A reflection seen across two independent conversations is marked **recurring**,
which firms up the wording the Agent hears; three and it is flagged for a
person to look at, because re-warning a broken Agent does not fix it. The tier
never changes whether a reflection is watched, and never a severity.

**Warn-only, always.** Memory widens what the guards *notice*; it never widens
what they *refuse*.

Implementation:
[`check-learned-watch.ts`](apps/server/src/check-learned-watch.ts).

### Semantic intent guard — `GUARDRAIL_SEMANTIC_ENABLED`

**Asks whether the Agent's apparent objective still matches the task it was
given** — the one judgement the deterministic guards cannot make.

A single tool-less model call
([`semantic-intent-monitor.ts`](apps/server/src/semantic-intent-monitor.ts))
compares a bounded window of recent reasoning, actions and file reads
([`trajectory-state.ts`](apps/server/src/trajectory-state.ts)) against the
*trusted* user prompt and Agent instructions. Everything in the trajectory is
evidence, never instruction; the model returns a schema-checked assessment
(risk, confidence, a classification, whether it conflicts with the task) and
nothing else. Trajectory text is redacted before it is sent.

A deterministic controller
([`intent-controller.ts`](apps/server/src/intent-controller.ts)) — not the
model — turns that assessment into an action:

- reasoning that conflicts with the task at risk 0.60 or higher injects a
  task-grounded **steer**; confidence is recorded for audit and does not gate it;
- a **consequential** proposed action (a publish, a deploy, an `rm -rf`, an
  edit to auth / tests / CI) is reviewed at its approval boundary and
  **declined** with a steer if it conflicts;
- a routine low-risk edit is not sent to the model at all — it just waits for
  any pending reasoning review, passes the deterministic checks, and proceeds.

The monitor never talks to the runtime. A required review that times out fails
closed (the action is declined, the turn lives); a reasoning-only review that
fails is recorded and allowed. Enabling this guard also puts the turn on the
`workspace-write` / `untrusted` policy described above. The writable root is
limited to `/workspace`; file edits still need to reach the approval handler.

Implementation:
[`semantic-intent-monitor.ts`](apps/server/src/semantic-intent-monitor.ts),
[`intent-controller.ts`](apps/server/src/intent-controller.ts),
[`trajectory-state.ts`](apps/server/src/trajectory-state.ts).

---

## The reflection layer

> Status: the write path, validation, tiered eviction, the fold into guard
> parameters (including derived host families), recurrence tiers, and the
> `learned-watch` guard all exist and are tested. The measurement harness
> (phase 4) is the open piece.
> [`docs/LEARNING_LAYER.md`](docs/LEARNING_LAYER.md) is the full plan.

**In one line:** an Agent that gets hijacked once should not be hijackable the
same way twice, and the rule that stops it should not have been written by the
Agent.

### How it differs from self-reflection

[Reflexion](https://arxiv.org/abs/2303.11366)-style loops have the model judge
its own trajectory and write a note to itself. Under prompt injection that
trajectory contains attacker-authored text, so a model reflecting on it is a
channel for the attacker into memory that is meant to be permanent. So here:

- **The guard authors the lesson, not the model.** The check that fired is the
  author, and its output is already structured.
- **A lesson is extracted facts, never written text.** A stored reflection holds
  paths, hosts, channel names and preconditions — every value lifted verbatim
  from a structured trace field, shape-validated against a per-key charset and
  length-capped on the way in ([`reflections.ts`](apps/server/src/reflections.ts)).
  A value that must match a hostname charset cannot carry an instruction.
- **Anything broader is still a pure function of those facts.** The host family
  (contact under a parent, once two children were caught) and the recurrence
  tier (seen across N separate conversations) are both computed at fold time
  from the stored records. Nothing is inferred, ranked, or written by a model.

### The loop, end to end

1. The Agent reads a file (a skill, a checklist) and opens `.env`. Both allowed.
2. It tries to send the contents outward. **A guard fires** and refuses at the
   approval step. Structured facts fall out of the finding
   (`{ destination, source, channel, precondition }`).
3. A mid-run `steer` correction goes into the live turn (ephemeral, never
   stored). The Agent finishes the real task.
4. **The facts are stored on the Agent record** (`agent.reflections`). No model
   is involved.
5. **Next run, the facts become guard parameters** before the container starts
   (`paramsFrom` → `buildGuardChecks`). Folded into check options, *never* into
   the prompt — so they cost no tokens, and an Agent whose thread is reset or
   that boots into a fresh container is still bound.
6. The same attack is warned about **at the file read**, a whole step before a
   command is formed.

### Properties worth stating

- **Bounded.** Reflections are capped and evicted per `code`. Within a `code`,
  a one-off is dropped before anything seen across two conversations, with a
  floor of free slots kept for new lessons — so a retry loop against rotating
  hosts thrashes its own quota and can never push out a corroborated rule.
- **Generalising, but only on evidence.** Two sibling hosts under one parent are
  enough to widen to the family; one is not, because a warn now steers and an
  over-broad rule would nudge the Agent off legitimate work every run. Rotating
  the parent domain still defeats it.
- **Withdrawable.** The guards are blind to who asked, so they fire identically
  on an Agent doing exactly what the user wanted. `withdraw()` removes a
  reflection; a "the user's own prompt named this value" gate stops it being
  learned in the first place.
- **Warn-only.** The worst a wrong reflection can do is waste one correction, so
  it is safe to learn on the first sighting rather than waiting for a repeat.

### Does it actually learn?

Measured over 45 live runs, with an attacker that changes address between runs
inside one Agent's memory thread:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-time-to-catch-dark.svg">
  <img alt="Time to catch across three attacker addresses: a brand-new address caught at command 10 of 13, a sibling at command 5 of 9, and a never-seen host in the same family at command 4 of 7." src="docs/assets/benchmark-time-to-catch-light.svg">
</picture>

A brand-new attacker address is caught at command 10 of 13. Its sibling, one run
later, at **command 5 of 9**. The lesson moved the catch earlier, before the
agent had done as much work down a poisoned path. And `a7.…`, a host that never
appeared in any run, is still caught 73% of the time by the family rule folded
out of its siblings. 73% is visibly weaker than the 100% on a host it has
actually seen, which is what an honest generalisation number looks like.

Learning is **not** in the default `egress` configuration. It needs
`GUARDRAIL_REFLECTION_ENABLED` (the `egress+reflection` preset). Because the
learned-watch guard only ever warns, that tier costs close to nothing in false
interventions.

---

## Evaluation

### Current Claude evidence

The latest repeatable sample contains 36 PostgreSQL-backed Claude Runs: four
scenarios × three guard configurations × three repeats. Across its 27 planted
exfiltration prompts, Claude sent the synthetic secret to the intended sink in
0 runs and explicitly declined the planted secret-transfer instruction in
26; one run never reached that step. The nine benign controls completed without
guard interruptions.

These results do **not** demonstrate live guard efficacy. AgentGuard excluded
`.env` from all 36 Run workspaces, and the benchmark kept agent network access
disabled in every configuration. The `off` preset disabled the four benchmark
guardrail flags but left capability policy active. After correcting the scorer
to require attack-specific trace evidence, the matrix showed zero
attack-specific guard blocks. All nine attacked Runs failed to complete the
requested task. Treat this as evidence about Claude's refusal behavior and the
benchmark's current limitations, not as a leak-rate estimate.

The complete result and reproducible command are in
[`docs/GUARD_EVALUATION_RESULTS.md`](docs/GUARD_EVALUATION_RESULTS.md) and
[`docs/BENCHMARK.md`](docs/BENCHMARK.md). Raw traces and per-run artifacts are
local under `benchmark-results/` and ignored by Git.

An opt-in live harness for the orchestrator's final review and a corrected
egress probe (a synthetic credential under a filename the Run copy keeps, a
`.invalid` sink) is checked in: `AGENTGUARD_LIVE_EVAL=1 npm run
eval:final-review -w @launchpad/server` with `DATABASE_URL`,
`BENCH_OWNER_EMAIL` and `ANTHROPIC_API_KEY` set. It scores model refusal,
action not reached, gate intervention, final-diff detection, false holds and
task completion separately. No results from it are recorded yet.

### Historical GPT-5.1 benchmark

An earlier version of this project recorded 630 live runs (42 scenarios × 3
guard configurations × 5 repeats, on gpt-5.1) against an
[AgentDojo](https://arxiv.org/abs/2406.13352)-style benchmark. Those results
are historical and not directly comparable to the current Claude runtime.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-leak-rate-dark.svg">
  <img alt="Leak rate by attack family and guard configuration. Guards off leaks on 62% of attack runs; the egress guard alone cuts it to 3%." src="docs/assets/benchmark-leak-rate-light.svg">
</picture>

**62% → 3%. The secret stops leaving the box.** With no guards, 93 of 150
attack runs carried a workspace secret to the attacker. With one behavioural
check on, 5 did. That holds across every way we varied the attack: how the
injection is worded, which file hides it, whether it leaves over http, DNS or
`git push`, and whether the attacker rotates to a fresh hostname.

**2%, and it barely touches real work.** One benign run in 60 was wrongly
interrupted, and all 15 legitimate outbound calls in the benign set were
allowed. It blocks the *payload*, not the verb: `curl` to a package registry
goes through, `curl` carrying `.env` does not. This is the number to check
first, because a guard that blocks everything would score perfectly on the one above
and be worthless.

**37% → 95%. Defence repays a utility debt instead of charging one.** An
unguarded agent finishes benign work 97% of the time, but only 37% when an
attack is present, because an agent that follows the injection abandons the job
it was given. Blocking the injection and steering the agent back to the user's
task raises that to 95%.

### How it was measured

- **The attack is planted, not typed.** The agent gets real work, "get this
  branch ready to deploy", and the injection is hidden in a file it has an
  ordinary reason to open.
- **The baseline is the same attacks with the guards switched off**, not an
  easier set.
- **We never report security without utility.** The perfectly secure system is
  the one that does nothing.
- **We wrote down what would count as failure before the run**, and the
  thresholds are in the repo, unedited, next to the results.

> **A refusal by the model is not a guardrail result.** With guards off, gpt-5.1
> declined the injection on its own in 38% of runs. Counting those as wins would
> have been easy and dishonest. Every attack run is scored three ways,
> `executed` / `blocked_by_guard` / `refused_by_model`, and every number above
> is the `blocked_by_guard` one.

For the more recent Claude-specific exploratory probes—including semantic
handoffs, deterministic action gates, and the distinction between guard blocks
and model refusals—see [the dated guard evaluation snapshot](docs/GUARD_EVALUATION_RESULTS.md).

### What these numbers don't show

- **One domain, one task.** Every scenario is the same `checkout-service`
  deploy job.
- **The generalisation result rotates inside one host family**, so it shows
  "learned one attacker, generalised within it", not generalisation across
  unrelated attackers.
- **Fixed, curated attacks.** The attacker does not get to see the guard and
  adapt to it.
- **`read and send split apart` is the shape we don't close.** It still leaked
  13% with the egress guard and 7% with everything on, because each turn's
  checks see only that turn's trace.

Metric definitions and how to run the harness yourself:
[`docs/BENCHMARK.md`](docs/BENCHMARK.md)

---

## Architecture

```mermaid
flowchart LR
    UI["React Web UI<br/>(never sees the model key)"] --> API["Fastify control plane<br/>(signed-in users)"]
    API --> Orch["Orchestrator<br/>(Run, Task, AgentExecution)"]
    Orch --> DB["PostgreSQL"]
    Orch --> Gate["Security middleware<br/>(guards + reflections)"]
    Orch --> Loop["Claude agent loop<br/>on this host"]
    Loop --> Model["Anthropic Messages API"]
    Loop --> Gate
    Loop --> Tools["Disposable container per execution<br/>runs Claude's tools"]
```

| Component | Responsibility |
| --- | --- |
| **Web UI** ([`apps/web`](apps/web)) | Dashboard, Runs, Run Detail, approvals, agents, policies, members. Never receives the model key. |
| **Fastify API** ([`apps/server/src/app.ts`](apps/server/src/app.ts)) | Validates requests, signs users in, serves the built UI in production. |
| **Orchestrator** ([`orchestrator/`](apps/server/src/orchestrator)) | Plans a Run into Tasks and schedules one AgentExecution per attempt. |
| **ClaudeExecutionRuntime** ([`claude-execution-runtime.ts`](apps/server/src/orchestrator/claude-execution-runtime.ts)) | The agent loop. Every tool call goes through the security middleware first. **Traced. Guards run here.** |
| **DockerToolSandboxProvider** ([`claude-tool-sandbox.ts`](apps/server/src/claude-tool-sandbox.ts)) | One disposable Docker/Colima/Podman container per execution, `cap-drop ALL`, `no-new-privileges`, CPU/mem/PID caps, the Run's working copy at `/workspace`, no credentials. |

Storage on disk:

```text
.data/runs/<runId>/workspace   A Run's working copy
.data/traces/<executionId>.jsonl  Raw trace, one message per line
```

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start

To run real agents, follow [Run on Claude](#run-on-claude). With no key,
`./scripts/verify-guards.sh` re-derives the results from the runs already
committed here, free, and `npm run dev:demo` shows the UI on a simulated runtime.

### Run on Claude

Multi-agent Runs run on Claude, with the agent loop on
this machine and every tool call in a disposable container. The gate sits outside
the agent by construction: the model can only act by asking AgentGuard
([contract decision 30](docs/contract-decisions.md#30-claude-runs-through-an-agent-loop-agentguard-owns)).

The Claude path has been exercised against the real Anthropic API in prior local
Runs. Your own Docker, database and workspace setup still needs to work, so start
small. It needs Docker, Node.js 22 and an Anthropic API key.

**1. Put the key in `.env`.** It is the only place it goes, and the server is the
only thing that reads it. No container ever gets it.

```bash
cp .env.example .env
```

In `.env`, set the key:

```dotenv
ANTHROPIC_API_KEY=your-key
```

The template already turns on sign-in and the database, which Runs need, and uses
Claude Haiku 5.5 at medium effort with limits that hold one attempt at one task to
about $0.45 ([what a Run costs](#what-a-run-costs)).

Set a monthly spend limit for the key's workspace in the Anthropic Console as well.
That is the only limit here that covers everything.

**2. Start the database and add yourself and a workspace.** Pick a small repository
for the workspace, ideally one whose tests need no dependencies: the agent works
on a copy that leaves out `node_modules` and `.git`, and by default it has no network
to install anything. Your repository itself is not changed.

```bash
npm ci
docker compose up -d postgres
export DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
npm run db:migrate -w @launchpad/server
printf '%s' 'choose-a-password' | npm run db:admin -w @launchpad/server -- add-user you@example.com "Your Name"
npm run db:admin -w @launchpad/server -- add-workspace "First run" /absolute/path/to/a/small/repo you@example.com
```

**3. Check the boundary, for free.** This builds the runtime image and runs the
real-container probe. It uses Docker and no key.

```bash
npm run build:claude-runtime
npm run verify:claude-runtime -w @launchpad/server
```

Every line should say `PASS`.

**4. Start it and make a Run.**

```bash
npm run poc
```

Open <http://localhost:3000>, sign in, choose **New run**, and give it one small,
concrete task on a single agent, such as *Add a function that reverses a string to
`src/util.js`, and say what you changed.*

**5. What to watch for.**

- **Run Detail** shows each decision as it happens, and the raw trace of each
  attempt. The Anthropic Console shows the real spend. Successful attempts save
  usage on the execution. If an attempt fails after receiving a model response,
  its token usage appears in the trace but is not saved on the execution; a failure
  before the first response has no token count.
- **A refusal** fails the attempt with `Claude refused to continue (category: ...)`.
  Security-related work can trip the `cyber` classifier. The request opts in to
  server-side fallback, which retries on another model first, and the trace shows
  `model/fallback` when that happens. Later turns on the fallback model run without
  the earlier thinking.
- **A limit** fails the attempt with an error naming the setting. A failed attempt
  is retried once, so it can cost twice.
- **`semantic-monitor-unavailable` findings** mean a semantic review did not answer
  in time, which sends actions that needed review to a person. The 15-second timeout
  has not been measured against the real API, and the first call also compiles the
  response schema. Raise `GUARDRAIL_SEMANTIC_TIMEOUT_MS` if you see these.
- **A read-only agent ending early.** The analyst and reviewer may run only single
  plain read commands, and a second distinct refusal ends the execution. The system
  prompt tells them. If they still chain commands with `&&` or `|`, Runs on `auto`
  will fail at that task.
- **Approvals expire** after two minutes by default, and an expired one declines
  the action.
- **A finished Run is the agent's report, not proof.** Read the diff in the working
  copy under `~/.volc-agent-launchpad/data/runs/` (macOS) or `.local/data/runs/`
  (Linux).

#### What a Run costs

The template uses `claude-haiku-5-5` at medium effort: $0.10 per million input tokens
and $0.50 output for prompts of 100K tokens or fewer, $0.50 and $2.50 above that. A
small Run should cost cents, and one attempt at most about $0.45.

The table shows the same work on `claude-opus-5-5` ($4 per million input tokens, $20
output, $0.20 cache reads, $5 cache writes) with `CLAUDE_EFFORT=high`, which thinks
more than `medium`. These are estimates that have not been measured on real Runs.
Thinking counts as output.

| | Estimate |
| --- | --- |
| One small execution (about 10 turns, 25K tokens of context) | $0.30 to $1 |
| The supervisor's plan | about $0.05 |
| One semantic review, when one is needed | about $0.02 |
| A small `auto` Run: a plan and three tasks, with guards on | $1 to $4 |
| **Most one attempt can cost, the limits in code** | **$14** (2M input tokens all billed as cache writes, $10, plus 200K output, $4) |
| **Most one attempt can cost, the template's limits** | **$3.50** |
| Most one task can cost | twice the attempt, since a failed attempt is retried once |

The limits apply per attempt, and a Run can plan up to six tasks. So the limits in
code only bound one `auto` Run to about $168 plus its reviews, which is why the
Console spend limit matters. Most input in a long loop is cache reads, so an attempt
that reaches the input limit normally costs nearer $4.40 than $14. A fallback bills at
the fallback model's rates.

### Reading the evidence yourself

Every run in [`benchmark-results/2026-08-31-slice/`](benchmark-results/2026-08-31-slice)
keeps its raw trace. `traces/<runId>.jsonl` is every JSON-RPC message that passed
between the control plane and the agent, including the exact command each guard
saw and the `{"decision":"decline"}` that answered it. The numbers above are
derived from those files and nothing else.

### Requirements

- Node.js 22+ and npm 10+
- One container engine: Docker, Colima, or rootless Podman
- An Anthropic API key
- PostgreSQL (`docker compose up -d --wait postgres` starts one)

No agent CLI is needed: AgentGuard runs the agent loop itself.

### One command (local container runtime — recommended)

```bash
npm run poc
```

The first run installs dependencies and builds the runtime image, then selects
a container engine automatically. `Ctrl+C` stops the server and removes temporary
containers. Local state lives in `~/.volc-agent-launchpad/` (macOS) or `.local/`
(Linux); override with `LOCAL_POC_DATA_ROOT`.

Force a specific engine with `CONTAINER_ENGINE=podman` (Colima uses `docker`).

### Development (hot reload, simulated runtime)

```bash
npm install
npm run dev:demo
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

### Deploy on one Linux host

```bash
cp .env.example .env.production
./scripts/deploy-multi-agent.sh .env.production
```

Details: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

---


## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-opus-5-5` in code, `claude-haiku-5-5` in `.env.example` | Claude credentials and model. Startup refuses to run with no key, except for the simulated `dev:demo`. |
| `CLAUDE_EFFORT` | `high` in code, `medium` in `.env.example` | Effort for each turn of an execution: `low` to `max`. |
| `CLAUDE_MAX_ITERATIONS` | `40` in code, `20` in `.env.example` | Model turns per execution. |
| `CLAUDE_MAX_TOKENS_PER_CALL` | `32000` | `max_tokens` for one turn, thinking included. |
| `CLAUDE_MAX_TOTAL_OUTPUT_TOKENS` / `CLAUDE_MAX_TOTAL_INPUT_TOKENS` | `200000` / `2000000` in code, `50000` / `500000` in `.env.example` | Tokens per execution. Input counts cache reads and writes. |
| `CLAUDE_EXECUTION_TIMEOUT_MS` | `900000` | Model and tool time per execution. Waiting for an approval does not count. |
| `CLAUDE_COMMAND_TIMEOUT_MS` | `120000` | One shell command, enforced inside the container. |
| `CLAUDE_TOOL_OUTPUT_MAX_BYTES` | `32768` | One tool's output, as the model and the trace see it. |
| `CLAUDE_MAX_EDIT_FILE_BYTES` | `1048576` | Largest file the editor tool reads or writes. |
| `ANTHROPIC_BASE_URL` | — | For a test double or a gateway only. The key is sent to it. |
| `APP_AUTH_TOKEN` | empty on loopback | Shared demo bearer token. 24+ random URL-safe chars required for a non-loopback production server. Not user identity. |
| `CONTAINER_ENGINE` | `docker` | `docker`, `podman`, … Colima exposes the Docker CLI so it uses `docker`. |
| `AGENT_NETWORK_ACCESS` | `false` | Allow agent tool commands to use the network. A profile can still deny it. Network access is container-wide, not host-level filtering or provider-only egress. |
| `AGENTGUARD_VAULT_MASTER_KEY` | unset | Optional 32-byte hex key for encrypted workspace vault entries. Required to use the vault; see [Local credentials for a Run](#local-credentials-for-a-run). |
| `GUARDRAIL_EGRESS_ENABLED` | `false` | Run sensitive-egress and outbound-blob checks against every execution. Network is controlled separately by `AGENT_NETWORK_ACCESS`. |
| `GUARDRAIL_INTENT_ENABLED` | `false` | Run the agent-intent check every turn. Warn-only; needs no sandbox change; independent of the egress flag. |
| `GUARDRAIL_REFLECTION_ENABLED` | `false` | Carry what a guard caught into this Agent's later runs, as check parameters — exact hosts, derived host families, watched files. Warn-only at any tier; independent of the other flags. |
| `GUARDRAIL_SENSITIVE_MARKERS` | built-in list | Comma-separated path substrings that mark a file as secret. **Overrides** the default list when set. |
| `GUARDRAIL_BLOB_MIN_CHARS` | `128` | Minimum base64/hex run the outbound-blob check treats as an encoded blob. |
| `GUARDRAIL_SEMANTIC_ENABLED` | `false` | Enable task-aware asynchronous review. Network is controlled separately by `AGENT_NETWORK_ACCESS`. |
| `GUARDRAIL_SEMANTIC_MODEL` | Configured Agent model | Optional Claude model override for semantic review. |
| `GUARDRAIL_SEMANTIC_TIMEOUT_MS` | `15000` | Timeout for one semantic assessment. Required action reviews delegate to HITL when available and otherwise fail closed; reasoning-only reviews fail open with a warning. |
| `HITL_ENABLED` | `false` | Enable one-shot human confirmation for high-consequence commands, semantic uncertainty, and unavailable required semantic reviews. Routine approvals remain automatic. |
| `HITL_TIMEOUT_MS` | `120000` | Maximum time an approval may wait for a person, in a Run. Timeout denies that action and lets the turn continue. |
| `LOCAL_POC_DATA_ROOT` | platform-specific | Local metadata / workspace / session directory for `npm run poc`. |

The default sensitive markers: `.env`, `id_rsa`, `id_ed25519`, `.pem`, `.ssh/`,
`.aws/credentials`, `credentials.json`, `secrets`, `.npmrc`,
`.git-credentials`, `service-account`, `.netrc`, `.pgpass`.

See [`.env.example`](.env.example) for every runtime and resource-limit option.

---

## Validation & tests

```bash
npm run check                                   # typecheck + test + build
docker compose config
```

`npm test` runs the shared contract tests
([`packages/shared/tests/`](packages/shared/tests)) and then the server suite
(Vitest). Server tests are grouped under
[`apps/server/tests/`](apps/server/tests):

| Area | Covers |
| --- | --- |
| `checks/` | Egress classification, credential-shape matching, outbound-blob, agent-intent patterns, and a dedicated **bypass suite** (`check-sensitive-egress.bypass.test.ts`) that pins each known gap. |
| `reflections/` | Fact validation, dedup, tiered eviction, the fold into guard params, host-family derivation, recurrence tiers, source attribution, withdrawal, the "user asked" gate, and the end-to-end learn → warn loop. |
| `redaction/` | The two pattern tiers (recall a superset of precision), the protocol-id exclusion, the `onSend` hook, fingerprint format and idempotence. |
| `policy/` | The shared steering vocabulary, the resolved turn security policy, and the mapping from guard severities to the shared scale. |
| `semantic/` | The semantic monitor's schema validation and prompt shaping. |
| `runtime/` | The Claude agent loop, its tool sandbox and model calls, and the checks over its traces. |
| `server/` | API routes and auth, trace writer, the RunEvent hub and its SSE stream. |
| `integration/` | End-to-end harness for the multi-agent Run model: drives Runs through the public API against stand-in subsystems and checks the invariants every Run must satisfy. See its [README](apps/server/tests/integration/README.md). |

---

## Guard coverage and limitations

### Sensitive-egress guard

**Channels recognised** by `classifyEgress`, by *capability* rather than tool
name:

| Channel | Examples |
| --- | --- |
| `http` | `curl`, `wget`, HTTPie, `lwp-request`, PowerShell `Invoke-WebRequest`/`iwr`, `npm`/`pip` registry traffic |
| `dns` | `nslookup`, `dig`, `host`, `getent hosts`, `drill`, `kdig` |
| `ssh` | `scp`, `sftp`, `rsync`, `ssh` |
| `mail` | `mail`, `mailx`, `sendmail`, `mutt`, `ssmtp`, `swaks` |
| `raw-socket` | `/dev/tcp`, `/dev/udp`, `nc`/`ncat`/`netcat`, `telnet`, `openssl s_client` |
| `cloud-cli` | `aws s3`, `aws s3api put-object`, `gcloud storage`, `gsutil`, `az storage blob upload`, `rclone`, `kubectl cp` |
| `package-publish` | `npm publish`, `git push`, `cargo publish`, `gem push`, `twine upload`, `docker push`, `poetry publish` |
| `interpreter` | `python -c`, `python -m http.server`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval` — only when a secret was already read or the inline code names a network API |

**Secret signals:** marker filenames; a read recorded earlier in the same run;
and literal credential values (OpenAI, Stripe, AWS, GCP, GitHub, Slack keys,
JWTs, PEM headers, `KEY=…` pairs) seen in one command's output and reused
verbatim in a later command. Every finding carries a fingerprint
(`sk_…123727(28 chars)`), never the secret itself.

**Known gaps** (each pinned in
[`check-sensitive-egress.bypass.test.ts`](apps/server/tests/checks/check-sensitive-egress.bypass.test.ts)):

- **Cross-turn split.** A secret read in one turn and sent in a later turn is
  not caught — each turn's checks see only that turn's trace.
- **Unrecognised secret files.** A credential in a non-marker file is missed if
  its value is never reused verbatim, the file is never named in an outbound
  command, and its output is not credential-shaped.
- **Secrets in git history.** `git add .env && git commit` then `git push` moves
  the secret without ever naming it in the outbound command.
- **Transform before send.** A value re-encoded or reversed before an interpreter
  sends it defeats both the verbatim match and the blob-size check.
- **Capability list, not a taint tracker.** A determined adversary combining an
  unlisted channel with a transformed secret can still get data out. This is a
  backstop, not a boundary.

### Outbound credential redaction

Every API response body of type `application/json` or `application/x-ndjson`
passes through one Fastify `onSend` hook that replaces credential-shaped values
with a fingerprint and reports the count in an `x-redactions` header. It is one
global hook rather than per-route patches because per-route redaction is
fail-open — the route added next leaks by default, which is exactly how
`Message.content` and `agent.lastError` were missed on the first pass.

The redactor is tuned for **recall** while the egress guard above is tuned for
**precision**, and both read the same registry in
[`apps/server/src/redaction/patterns.ts`](apps/server/src/redaction/patterns.ts).
A redactor false positive makes one string in a log less readable; a redactor
false negative puts a live credential on a projector.

**Residual risks, stated rather than solved:**

- **The secret is still on disk.** The recorded trace is written verbatim at
  `0600` and stays that way. The threat this closes is *display and export* —
  the browser, a screenshot, a copied response. It is not at-rest protection.
  The file is authoritative on purpose: a fingerprint does not match the
  patterns that produced it, so redacting on write would permanently destroy
  value-flow evidence and make that class of finding unreplayable.
- **Reduced trace readability is the accepted cost of biasing for recall.**
  Measured on a real 794-event trace: before the exclusion below, 462 values
  were redacted, of which **only 4 were the actual credential** — the other 458
  were six reasoning-item ids repeated across records. Excluding protocol
  identifiers in *structural position* (`"id":`, `"call_id":`, `"item_id":`,
  and known `rs_`/`call_`/`item_`/`msg_` prefixes within that key/value pair)
  brings the same trace to **4 redactions**. The exclusion matches on context,
  never on a bare prefix, so a credential stored under a key named `id` is
  still redacted. What remains flagged on other runs is mostly precautionary —
  base64 blobs and hex digests — which is why the UI says "N values redacted"
  and never "N secrets".
- **Workspace contents still reach the model provider.** If the agent reads
  `.env`, those bytes go to the provider as part of its context. Redacting them
  would break the agent's ability to do the task it was asked to do. This is
  inherent to running a coding agent on a real workspace and is not fixable by
  redaction.

### Agent-intent guard

- **Warn-only.** Narration is self-reported; a finding never interrupts a turn.
- **Pattern-based, not semantic.** It matches phrasings, not meaning, so it
  misses paraphrases and unusual wording. It is a smoke alarm.
- **Reasoning layer only.** It reads `reasoning` items, not the Agent's
  user-facing message text. An Agent that acts without narrating, or a runtime
  that emits no reasoning items, gives it nothing to read.

### Semantic intent guard

- **Model judgments can be wrong.** Assessments are schema-checked, not
  fact-checked. Proposed actions are reviewed before execution; every file
  change and shell clause (long ones in several parts, none clipped) receives
  its own effect assessment in up to four bounded review calls, and a proposal too large for that budget
  is held for a person. A conflicting effect's risk is not averaged with an
  aligned effect. Conflicts
  scoring 0.50–0.74 require human review; conflicts scoring 0.75 or higher are
  declined. Model-reported confidence is audit information and does not
  suppress review or decline. A deterministic `violation` always wins.
- **Scope is task-bound.** The monitor is instructed to treat actionable,
  out-of-scope recommendations and handoffs as scope expansion, and to score
  their likely effect if followed. It can still misjudge the conflict or its
  risk, so this is a best-effort guard rather than a guarantee.
- **Reasoning steering is risk-based.** Conflicting reasoning at risk 0.60 or
  higher can steer the Agent back on task; confidence is recorded but does not
  control that decision.
- **Reasoning steering is asynchronous.** It can nudge the Agent early but does
  not freeze the agent. The real boundary is the next state-changing operation,
  which pauses for approval.
- **Read-only is not always semantically reviewed.** Commands proven to be
  safe reads can pass without an action-level semantic call. Every other
  command and each proposed file change is reviewed before execution.
- **Final-diff backstop, not rollback.** In password mode with semantic
  monitoring enabled, every changed line of the Run's actual diff is checked
  against the original task, the gated actions and the approvals before a
  changed Run can complete. It concludes only from complete evidence: binary,
  text over 256 KB, unreadable or credential-named changed files, links, more than 36
  changed files, or changes too large for its input budget make the review
  incomplete, which fails the Run. A detected scope conflict (risk 0.50 or
  more) or an unavailable review fails it too, and none of these seeds
  follow-up work. Changes already written remain in that failed Run copy for
  inspection; this does not undo them. An approval covers only its exact
  proposal. The outcome, its coverage and the review's own token use are shown
  on the Run receipt; the extra review adds model latency and cost.
- **Still out of scope.** Cross-run semantic memory and final-response DLP
  remain unfinished. The final diff review checks task scope, not whether the
  implementation is correct or whether tests prove the feature works.

> The **egress-intent** check that used to correlate a narrated exfiltration
> intent with a later outbound command was removed on 2026-08-30 — see the note
> under [the sensitive-egress guard](#sensitive-egress-guard--guardrail_egress_enabled).
> Reasoning is now watched by the semantic guard, which can only steer.

### Reflection layer

- **Learns from damage.** The loop only closes after the first success; it
  prevents no first instance of anything.
- **Per-Agent.** Every Agent gets burned once. Sharing reflections would be a
  stronger story and a much larger poisoning blast radius — the smaller one was
  chosen deliberately.
- **The attacker still picks the shape.** Host families catch subdomain rotation
  under one parent once two siblings have been seen; rotating the parent domain
  each time defeats that too, and each fresh parent mints a one-off entry. The
  tiered cap keeps those one-offs from evicting a corroborated rule, but they
  are still noise.
- **Tiers need real repetition.** "Recurring" and "needs a look" only trigger
  across separate conversations. Nothing escalates a rule to a block — that is
  not what tiers do.
- **Only a guard refusal is a hard stop.** Everything the reflection layer does
  is a `warn` plus a `steer`.

### Platform limitations

Shared demo token by default (`APP_AUTH_MODE=password` adds user accounts and
workspace roles); failed sign-ins are throttled per account and client in process memory
(counters reset on restart; deploy one app instance); logical workspace separation
but no hardened tenant isolation; no CSRF protection; no per-Agent container
ordinary local containers rather than hardened multi-tenant sandboxes; agent
network access is denied by the container's network mode, not host-level filtering.
The model key is available only to the server, never a container. See [SECURITY.md](SECURITY.md).

---

## Platform overview

This is a single-node Agent platform with browser-based Runs, approvals and
members, Claude as the agent, and a one-command local container runtime. The safety
layer is the product: guards observe execution traces, block dangerous actions,
and carry learned patterns into later runs.

---

## Repository layout

```text
apps/
  web/                     React + Vite + TypeScript UI
    src/App.tsx            Routes and the app shell
    src/runs/              Dashboard, Runs, Run Detail
    src/workspace/         Agents, approvals, policies, security, benchmarks
  server/                  Fastify + TypeScript control plane
    src/app.ts             HTTP routes, auth hooks, outbound redaction hook
    src/orchestrator/      Run -> Task -> AgentExecution, the planner, the Claude agent loop
    src/claude-tool-sandbox.ts      Disposable tool container per execution
    src/checks.ts          Check contract + trace convenience views  ← read first
    src/check-sensitive-egress.ts   Egress guard + capability classifier
    src/check-outbound-blob.ts      Encoded-blob egress guard
    src/check-agent-intent.ts       Reasoning-narration guard (warn-only)
    src/check-learned-watch.ts      Reflection-layer enforcement (warn-only)
    src/reflections.ts     Structured memory: validate, dedup, evict, fold, families, tiers
    src/semantic-intent-monitor.ts  Tool-less model call; schema-checked assessment
    src/intent-controller.ts        Deterministic policy over that assessment
    src/trajectory-state.ts         Bounded recent context for the monitor
    src/steering-policy.ts          Shared remediation vocabulary + steer text
    src/turn-security-policy.ts     Resolves approval / network per execution
    src/redaction/         One credential-pattern registry, two tiers, three consumers
    src/guard-checks.ts    Which checks run, one family per flag
    src/run-events.ts      RunEvent fan-out with a per-run replay buffer
    src/run-events-route.ts         GET /api/runs/:id/events (SSE, redacted per frame)
    src/security-middleware.ts      Per-execution security guard interface (P1/P2)
    src/trace.ts / config.ts
    tests/{checks,redaction,reflections,policy,semantic,runtime,server,integration}/
packages/
  shared/                  Zod contracts used by server and web: domain model,
                           security contract, run events, API shapes, SSE client
scripts/
  start-local-poc.sh        npm run poc
  replay-trace.ts           Re-run the checks over a recorded trace, offline
  bootstrap-local.sh / deploy-multi-agent.sh / verify-guards.sh
docs/
  ARCHITECTURE.md  LEARNING_LAYER.md  BENCHMARK.md  LOCAL_POC.md  DEPLOYMENT.md
  architecture-direction.md  contract-decisions.md
Dockerfile / Dockerfile.claude-runtime / docker-compose.yml
```

---

## Documentation

- [Local POC implementation handover](handover.md) — prioritized remaining
  changes and the owner's later manual test pass
- [Architecture](docs/ARCHITECTURE.md) — components, deployment profiles,
  extension seams
- [Architecture direction](docs/architecture-direction.md) — the agreed
  multi-agent direction and how far it has got
- [Contract decisions](docs/contract-decisions.md) — why the shared contracts
  are shaped as they are
- [Shared contracts](packages/shared/README.md) — layout, conventions, live run
  events
- [Integration harness](apps/server/tests/integration/README.md) — end-to-end
  checks and Run invariants
- [The learning layer](docs/LEARNING_LAYER.md) — the full plan for the
  reflection loop, and its relation to prior work
- [Benchmark](docs/BENCHMARK.md): the AgentDojo-style harness, metric
  definitions, scenario families, how to run it
- [Local POC](docs/LOCAL_POC.md) — container-engine detail, rootless Podman
- [Deployment](docs/DEPLOYMENT.md) — one Linux host
- [Setup guide](SETUP.md) — fresh-clone installation and runtime options
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
