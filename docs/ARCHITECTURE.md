# Architecture

AgentGuard is a single-node control plane for running and supervising coding
agents. It has two modes. **Password mode** is the multi-agent platform: signed-in
users, workspace roles, PostgreSQL and Run → Task → AgentExecution, described under
"Multi-agent model" below. **Token mode** is the original single-agent path: one
shared token and a JSON store. Its routes do not exist in password mode.

The diagram and components here are token mode's.

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Store["JSON store"]
    Service --> Workspace["Agent workspace"]
    Service --> Runner{"AgentRunner"}
    Runner -->|Local POC| Container["Disposable Runtime container"]
    Runner -->|ECS| Process["Codex child process"]
    Container --> Guard["Trace checks + semantic intent controller"]
    Guard --> Model["OpenAI Responses API"]
    Process --> Model
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs. It never receives the model API key.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, workspaces, and Runs. One Agent can
have only one active Run.

```text
ready -> busy -> ready
  |       |
  v       v
stopped  error
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agent, message, and Run metadata
workspaces/AgentID/       Agent-created files
workspaces/.deleted/      Archived deleted workspaces
codex-home/               Codex configuration and sessions
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `CodexRunner` runs Codex inside the application container for ECS.
- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every local turn.

Both providers bound output and time, resume the stored Codex thread, and
escalate termination after a grace period. The container provider uses Codex
app-server's bidirectional JSON-RPC stream so the control plane can trace,
approve, steer, and interrupt a live turn. The local-process provider still
uses `codex exec` and does not run the live guard pipeline.

### Guard and semantic control path

```text
verbatim JSON-RPC trace
  ├─ deterministic Check[] ── hard invariant finding
  └─ bounded trajectory state ── async semantic assessment
                                  │
                                  v
                         deterministic IntentController
                         allow / steer / decline / interrupt
```

The original prompt and configured Agent instructions are trusted task context.
Repository files, tool output, reasoning narration, commands, and diffs are
lower-authority evidence. Semantic inference never talks to the Runtime
directly; `runTurn()` remains the only live enforcement point. Derived findings
are persisted on the Run and do not modify the append-only raw trace.

When `GUARDRAIL_SEMANTIC_ENABLED=true`, the container runner resolves an
explicit turn security policy before starting Codex: `workspace-write` sandbox
limited to `/workspace`, `untrusted` approval policy, and denied network. The
writable sandbox exposes Codex's file-change tool; the approval handler remains
the intended pre-execution gate. The runtime interrupts when a file change
completes without an approval request, but that backstop cannot undo the edit.
The pinned Codex 0.111.0 runtime was verified with a local mock Responses API:
it emitted a file-change approval request before applying the patch, and
declining left the isolated workspace file absent. Re-run this check with
`npm run verify:codex-file-change-approval -w @launchpad/server` after building
the local runtime image. For each execution whose resolved policy denies
network, the runtime also passes `web_search="disabled"` to app-server. This
closes the service-side web search path that is outside the workspace's network
sandbox. This does not make every
operation a semantic-model call. It makes every command except a known-safe
read, plus state-changing workspace actions, pause at Codex's real approval
request, where `runTurn()` waits
for prior reasoning assessment, applies deterministic checks, and only then
performs a selected semantic action review. Read/list/search work remains
ungated. A completed file change without its expected approval is recorded as
an enforcement-boundary violation and interrupts the turn, but cannot undo an
already-completed change.

### Multi-agent runs

The multi-agent model is Run → Task → AgentExecution (see
[architecture-direction.md](architecture-direction.md)). It runs alongside the
single-agent path above, which is unchanged. These parts exist:

- **Shared contracts** ([`packages/shared`](../packages/shared)): Zod schemas
  for the domain model, the security contract, run events and API shapes, used
  by both server and web. The reasons are recorded in
  [contract-decisions.md](contract-decisions.md).
- **Live run events:** `RunEventHub` fans out each committed event, with its
  durable seq, and `GET /api/runs/:id/events` streams them as Server-Sent
  Events. Each frame is redacted, and clients resume or resync by seq.
- **Security middleware interface**
  ([`security-middleware.ts`](../apps/server/src/security-middleware.ts) and
  [`security-middleware-impl.ts`](../apps/server/src/security-middleware-impl.ts)):
  a concrete policy resolver and one stateful guard per AgentExecution,
  including bounded in-memory run-scoped credential taint. The middleware is
  composed into password-authenticated container-mode server startup. The
  integration harness also exercises the orchestrator and routes, using
  stand-ins for persistence and middleware in its default scenarios; focused
  middleware tests cover the concrete implementation. This is not a full
  production-stack test.
- **Orchestrator**
  ([`apps/server/src/orchestrator`](../apps/server/src/orchestrator/README.md)):
  - plans with a tool-less supervisor call, validates the plan, and delegates
    each task through the middleware;
  - schedules tasks in dependency order, with limited parallelism and one
    write-capable execution at a time;
  - handles retries, approvals, cancellation and restart recovery, and writes
    the audit trail;
  - validates each specialist's strict final disposition, so a successfully
    ended turn cannot complete a Task that the specialist reports incomplete.
- **Run routes** ([`run-routes.ts`](../apps/server/src/run-routes.ts)): create,
  snapshot, cancel and resolve-approval, as specified in `packages/shared/src/api.ts`.
- **Gated Codex runtime**
  ([`gated-turn.ts`](../apps/server/src/gated-turn.ts),
  [`codex-execution-runtime.ts`](../apps/server/src/orchestrator/codex-execution-runtime.ts)):
  one container per execution, on the Run's own working copy. Every approval
  request goes to the middleware, and it fails closed. Each execution mounts a
  disposable Codex home containing only generated provider configuration; the
  shared host Codex home is not mounted into agent containers.
- **Web console** ([`apps/web/src`](../apps/web/src), conventions in
  [`apps/web/DESIGN.md`](../apps/web/DESIGN.md)): a shared shell with real URLs
  (`/`, `/runs`, `/runs/new`, `/runs/:id`, `/playground`, `/safety`, `/members`;
  old `#/runs/...` links redirect). The Dashboard and Runs list read the list-runs
  API. Run Detail has the task graph, the gate timeline and proposed file changes
  from saved rows, the task drill-down and approvals, with live updates from the
  event stream. The sign-in token is kept only in memory, so reloading a tab in
  password mode asks for sign-in again and returns to the same URL.
- **Integration harness**
  ([`apps/server/tests/integration`](../apps/server/tests/integration)): drives
  Runs through the public API and checks the invariants every Run must
  satisfy, against the real orchestrator and routes. Its default scenarios use
  stand-ins for persistence and middleware, so it does not replace a full
  PostgreSQL/container deployment check.

Multi-agent run copies omit `.env` and `.env.*` except example/sample/template
files, common credential stores and filenames, and selected private-key/state
file extensions. Folders named `secrets` are omitted even when they hold source
code. This is a filename-based denylist, not a general secret scanner; secrets
stored under unrecognized names may still be copied. See
[`working-copies.ts`](../apps/server/src/orchestrator/working-copies.ts) for
the exact defaults.

One `auto` Run, end to end. Every arrow into the middleware is a decision that
can allow, steer, block or require approval:

```mermaid
sequenceDiagram
    actor Dev as Developer (browser)
    participant API as Run routes
    participant O as Orchestrator
    participant P as Supervisor planner
    participant M as Security middleware (P1)
    participant R as Codex runtime (container)
    participant S as RunStore + RunEventHub

    Dev->>API: POST /api/workspaces/:id/runs
    API->>O: createRun
    O->>S: Run queued, then planning
    S-->>Dev: run.updated (SSE)
    O->>P: user request + agent list (no workspace content)
    P-->>O: plan as JSON, then schema + validatePlan
    loop each planned task
        O->>M: delegation
        M-->>O: allow / block / require_approval
        O->>S: task.created (only if allowed)
    end
    loop each ready task (dependency order, one writer at a time)
        O->>M: resolvePolicy, then openExecution
        O->>M: context_handoff for each dependency's result
        O->>R: execute(prompt, working copy, gate)
        R->>M: every approval request (command, file change)
        M-->>R: accept / decline / interrupt
        opt require_approval
            O->>S: approval.requested
            S-->>Dev: approval.requested (SSE)
            Dev->>API: POST /api/approvals/:id/resolve
            API->>O: resolveApproval
        end
        R-->>O: validated disposition, result, trace path
        O->>S: execution completed; task completed or failed
    end
    O->>S: Run completed: the final tasks' results
    S-->>Dev: run.updated (SSE)
```

Multi-user mode is `APP_AUTH_MODE=password`, with `DATABASE_URL` and
`RUNTIME_PROVIDER=container`. Users sign in with accounts kept in Postgres
instead of the shared token, and `index.ts` composes the orchestrator with
`PostgresRunStore`, `PostgresAgentDirectory`, P1's middleware on
`PostgresSecuritySource`, the model planner and Codex containers
([`postgres-runs.ts`](../apps/server/src/postgres-runs.ts)). In a workspace,
any role may read bounded Run data; `developer` and `security_admin` may also
start and cancel Runs and read redacted raw execution traces. An `auditor` reads
snapshots and the bounded timeline, but not raw traces. An approval needs the person
who started the Run, or a `security_admin` when its reason is `policy_required`
(contract decision 19). What always asks a person is decision 20, and editing agents,
profiles and policies is decision 21. `npm run db:admin -w
@launchpad/server` bootstraps the first users and registers host project paths;
it also lists users/workspaces and can create empty workspaces. A
`security_admin` can create accounts attached to their workspace, manage its
members, and create additional empty workspaces (contract decision 15). Failed sign-ins
are limited by shared PostgreSQL counters: five attempts per account and 30 per
source address within 15 minutes. Authentication limits are consistent across
restarts and replicas; Run SSE/event delivery remains process-local, so the rest
of the app is still a single-instance deployment. The
default `token` mode is unchanged, and `npm run dev:demo` still runs the simulated
demo. For the two acting roles, an attempt's bounded, redacted raw trace is read through
`GET /api/runs/:runId/executions/:executionId/trace`, under the same workspace
check as the other run routes. Password mode rejects the legacy global
`/api/agents`, `/api/admin`, `/api/system` and single-agent Run routes because
their JSON store has no workspace identity to authorize against.

Each Run has a token budget (`RUN_TOKEN_BUDGET`). Files of a finished Run
are removed after `RUN_ARTIFACT_RETENTION_DAYS` (contract decision 18), while its rows
stay, and reading such a trace answers 410 rather than a plain 404.

Not built yet, by owner:
- **P1:** reflection memory in multi-agent runs. The tables exist and are unused,
  so a guard's catch does not carry into later Runs here as it does in token mode.
  A PostgreSQL-backed live Run/Task benchmark harness now exists at
  `benchmark/run-multi-agent-live.ts`; it has not yet been run against a live
  model/runtime. Policy `rules` stay unsupported until P1 reviews a schema, so
  nothing yet produces `policy_required`.
- **P3:** tenant isolation beyond workspace roles (every workspace's Runs share one
  host). First-account bootstrap and host project paths stay operator-only
  (decision 15); workspace admins can create accounts in their workspace and
  empty workspaces. Password-mode sign-in throttling uses shared Postgres counters.
  Migrating token-mode JSON records
  was decided against (decision 23). The
  integration harness still runs on `InMemoryRunStore`; the fuzz suite and the
  store suite are what exercise Postgres.
- **P3/P4:** applied file changes on the gate timeline. Saved data does not hold
  them, so the timeline says so. Command text is deliberately not added to
  permanent audit storage for this milestone (contract decision 14).

The password-mode console includes workspace Agents and Policies management,
Approvals, Security findings and audit history, and saved Benchmarks reports.
Workspace routes check membership and enforce role/version rules in the server;
the UI only reflects those permissions. Benchmark reports are read from
committed results and are not live measurements or runs initiated by the UI.

Orchestration test and load results are in
[orchestration-evaluation.md](orchestration-evaluation.md).

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| Multi-agent host (`scripts/deploy-multi-agent.sh`) | Host Node.js under systemd, Postgres in Compose | Disposable local container |
| ECS | Application container | Codex process in the same container |
| Local development | Host Node.js | Host Codex process |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The current container or ECS instance is the POC trust boundary. Ordinary
containers are not hardened multi-tenant isolation. Agent network access is
denied in the Codex sandbox, but this is not a host-enforced provider-only
egress path. The multi-agent deployment refuses `danger-full-access` and fails
if its configured workspace-write sandbox cannot be verified; real-host
deployment validation is still required.
