# AgentGuard

AgentGuard is a CS464 capstone platform for secure, observable coding-agent workflows. Users submit coding tasks in a browser; Claude works on an isolated project copy while server-owned middleware checks tool actions, delegation and agent handoffs. Users can inspect decisions, answer approvals, review actual file changes and download the resulting project.

The platform brings agent orchestration, configurable permissions, task-aware security review and execution evidence into one console. It is designed to run locally with a shared project workspace and a server-controlled execution environment.

## Core capabilities

- **Single and automatic modes:** one selected specialist, or a tool-less supervisor that plans a dependency graph of specialist Tasks. Each attempt is an AgentExecution. Defaults allow six Tasks, two concurrent executions and one writer at a time.
- **Project continuity:** each prompt creates a new Run from the workspace's latest successful copy. Each Run keeps its own evidence and working copy, with sequential Runs protecting project continuity.
- **Security boundaries:** platform and workspace capability ceilings constrain each agent. Every tool call passes the server gate before execution. Deterministic checks detect recognized sensitive egress and encoded outbound blobs; optional intent and learned-watch checks provide warnings.
- **Semantic review:** a Claude monitor compares public action summaries, repository reads and proposed effects against the trusted task. Conflicting actions at risk 0.50 are held for approval and at 0.75 are declined. Unresolved reviews are referred to a person.
- **Final diff review:** with semantic review enabled, actual changed content is reviewed before completion. Completion depends on the review result, providing a second check against task drift.
- **Human approvals:** the browser displays the saved proposal. Approval permits that proposal; denial and timeout refuse it. Ordinary approvals belong to the Run starter; policy-required approvals belong to a workspace security administrator.
- **Workspace vault:** credentials are encrypted locally with AES-256-GCM. Run grants select credentials and agents. A host-side HTTPS broker applies credentials only to exact granted hosts, with no redirects or private destinations. Values are not injected into tool containers.
- **Browser console:** workspace administration, roles, profiles, policies, Runs, task graph, gate timeline, approvals, findings, audit, receipt, actual diff, file previews and ZIP export. Agent summaries sit alongside the recorded execution evidence.
- **Project import:** empty workspace, approved server folder, or a validated ZIP uploaded before the first Run.

## Architecture and files

```mermaid
flowchart LR
    Browser[React console] --> API[Fastify API and authentication]
    API --> Orch[Run orchestrator]
    Orch --> DB[(PostgreSQL)]
    Orch --> Loop[Claude agent loop on host]
    Loop --> Model[Anthropic API]
    Loop --> Gate[Security middleware]
    Gate --> Tools[Disposable tool container]
    Gate --> Vault[Host HTTPS vault broker]
    Tools --> Copy[Run working copy]
    Copy --> Final[Actual diff and final review]
```

The backend hosts the project files and agent execution; users interact through the browser. PostgreSQL stores accounts, membership, policies, Runs, Tasks, findings, approvals and audit events. Run files live at `APP_DATA_DIR/runs/<runId>/workspace`, traces at `APP_DATA_DIR/traces`, encrypted credentials at `APP_DATA_DIR/vault`, and uploaded sources under app data. A source folder is copied, not edited in place. Two users reach the same backend workspace through its API, with server-side role checks and serialized Runs.

| Directory | Purpose |
| --- | --- |
| `apps/server` | API, authentication, PostgreSQL adapters, orchestrator, Claude runtime, guards and vault |
| `apps/web` | React console and live event consumers |
| `packages/shared` | Shared Zod contracts and lifecycle rules |
| `apps/server/migrations` | Checksummed PostgreSQL migrations |
| `benchmark` | Replay and opt-in live evaluation harnesses |
| `benchmark-results/2026-08-31-slice` | Reproducible historical benchmark trace sample |
| `scripts` | Local startup, runtime verification, replay, backup and optional deployment |

## Local setup

Use Node.js 22+, npm, Git, Docker Desktop/Engine with Compose, and an Anthropic API key with access to the selected model. The Bash startup helper supports Linux/macOS; Windows users can use WSL2 with Docker integration, or the explicit PowerShell path below. Start Docker and confirm `docker info` works before continuing.

### Install and configure

```bash
npm ci
cp .env.example .env
```

On PowerShell use `Copy-Item .env.example .env`. Edit the private `.env`:

```dotenv
APP_AUTH_MODE=password
ANTHROPIC_API_KEY=your-key
# Select a model available to your Anthropic account.
ANTHROPIC_MODEL=your-accessible-claude-model-id
DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
HOST=127.0.0.1
GUARDRAIL_EGRESS_ENABLED=true
GUARDRAIL_SEMANTIC_ENABLED=true
HITL_ENABLED=true
AGENT_NETWORK_ACCESS=false
```

Use an actual model identifier from your account in place of the example placeholder. The model is configurable; availability and API billing depend on your account. Model calls, including semantic reviews, consume API credits. Keep `.env` private.

For direct host startup, replace the sample container paths with **absolute local paths** for `APP_DATA_DIR` and `AGENT_WORKSPACE_ROOT`, for example `/home/me/agentguard-state/data` and `/home/me/agentguard-state/workspaces`, or `C:/Users/me/agentguard-state/data` and `C:/Users/me/agentguard-state/workspaces`. Keep these outside a source folder you intend to import. `npm run poc` chooses host paths automatically.

Optional vault: generate a key and set the result as `AGENTGUARD_VAULT_MASTER_KEY` in `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep this key across restarts, then add credentials through the workspace Credentials page and grant them to the agents that need them.

### Start PostgreSQL and create the first account

```bash
docker compose up -d postgres
```

The administration CLI reads `DATABASE_URL` from the shell. In Bash:

```bash
export DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
npm run db:migrate -w @launchpad/server
read -r -s -p 'Local account password (12+ characters): ' account_password; printf '\n'
printf '%s' "$account_password" | npm run db:admin -w @launchpad/server -- add-user student@example.com "Student"
unset account_password
npm run db:admin -w @launchpad/server -- add-workspace "Submission demo" - student@example.com
```

PowerShell equivalent (password prompt keeps it out of command history):

```powershell
$env:DATABASE_URL = 'postgres://launchpad:launchpad@127.0.0.1:5433/launchpad'
npm run db:migrate -w @launchpad/server
$accountCredential = Get-Credential -UserName student@example.com -Message 'Choose a local demo password (12+ characters)'
$accountCredential.GetNetworkCredential().Password | npm run db:admin -w @launchpad/server -- add-user student@example.com "Student"
Remove-Variable accountCredential
npm run db:admin -w @launchpad/server -- add-workspace "Submission demo" - student@example.com
```

The workspace owner becomes its security administrator and receives default agent profiles. `-` creates an empty source; upload a ZIP in the browser before its first Run, or replace `-` with an absolute project folder. To select source folders through the UI, configure `WORKSPACE_SOURCE_ROOTS` with the permitted host directories.

### Start the app

On Bash (Linux/macOS/WSL2):

```bash
npm run poc
```

The helper builds the tool image and app, validates the bind mount and serves the console at **http://localhost:3000**. Complete the database and account setup above before starting it.

For direct host startup, including PowerShell:

```bash
npm run build:claude-runtime
npm run build
npm start
```

For hot reload after building the runtime image:

```bash
npm run dev
```

Open **http://127.0.0.1:5173** for hot reload; its `/api` proxy needs the backend running on port 3000. Sign in with the account you created. Start with a small coding task in single mode, inspect its receipt and diff, then submit a follow-up or try automatic mode.

For agent execution, use the host startup commands above with PostgreSQL in Compose. The all-in-Compose profile serves the console/API.

### UI demonstration without API credits

```bash
npm run dev:demo
```

Open http://127.0.0.1:5173. This provides a self-contained console demonstration using an in-memory simulated runtime. If a shared token is configured, use it at the unlock screen.

## Validation and evidence

```bash
npm run check
```

This runs typechecking, shared/server/web tests and production builds. For PostgreSQL suites, set `TEST_DATABASE_URL` to a **disposable test database** before running checks; those suites reset their schema. Never point that variable at a database you want to preserve. CI runs checks against a PostgreSQL 16 service.

```bash
npm run verify:claude-runtime -w @launchpad/server
```

The runtime check requires Docker and the built tool image, but no model key. The submission validation passed **1,372 automated tests**, a separate **592-test PostgreSQL persistence and fuzz suite**, and **13 Docker runtime boundary scenarios**. Typechecking and production builds also passed.

For a focused evaluation of all guard families:

```bash
npm run eval:guards
```

The focused run passed **592/592 checks** across deterministic guards, learned warnings, semantic decision controls, final diff review, capability/approval gates, vault access and redaction. It includes benign controls and 16 supported adversarial egress scenarios. [Per-guard results and examples](docs/GUARD_EVALUATION_RESULTS.md#guard-by-guard-evaluation---2026-11-22) explain what each result demonstrates. The command saves a reusable summary and individual test outcomes.

Earlier live Claude evaluations also demonstrated the semantic layer in action: aligned discount tasks completed in single and automatic modes, both guarded release-drift repeats were held for review, and a human-approved follow-up completed with the proposed version/changelog changes applied. In 19 direct monitor probes, seven aligned proposals were allowed, six scope changes were reviewed and six malicious/access-control changes were blocked. [Recorded semantic outcomes](docs/GUARD_EVALUATION_RESULTS.md#recorded-live-semantic-results) retain the case details and test methods.

Recorded live cases, test methods and reproduction commands are in [guard evaluation evidence](docs/GUARD_EVALUATION_RESULTS.md) and [orchestration evaluation](docs/orchestration-evaluation.md). Live harnesses are opt-in and use API credits; results distinguish model refusals, guard interventions and controlled runtime checks.

## Using the workspace

Runs preserve separate working copies and evidence, while follow-up prompts start from the latest successful copy. Source files are stored on the backend and can be downloaded from Run Detail as a project ZIP. The download includes source files and excludes dependencies, build output, VCS data, links and recognized credentials.

The default profile uses one control-plane instance and denies container network access. Agent capabilities and operator settings determine whether a task may write, delegate or access the network. Give test/build work to a developer agent and enable network permission deliberately when dependencies must be installed.

Final review uses bounded evidence. Keep demonstration tasks within its review capacity: up to 36 changed text files, with captured text up to 256 KiB per file. Run Detail shows the review outcome and its coverage alongside the actual diff.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Anthropic returns 401 | Check the API key and model access, then restart. |
| Frontend proxy reports ECONNREFUSED | Check that the backend is running on port 3000 and inspect its startup output. |
| Vault unavailable | Set the 64-hex-character master key and restart. |
| Action held for review | Open Run Detail and answer the saved proposal before its timeout. |
| Final review incomplete | Inspect its coverage in Run Detail and use a smaller, reviewable change. |

## Further reference

- [Architecture and execution flow](docs/ARCHITECTURE.md), including [database relationships](docs/ERD.md).
- [Security model](SECURITY.md) and [resource and token budget](docs/COST.md).
- [Interface and security contract decisions](docs/contract-decisions.md) for maintainers.
- [Optional Linux deployment and backup](docs/DEPLOYMENT.md).

The separately submitted capstone report describes the design, implementation and measured results. Internal npm package names retain `@launchpad/*` for compatibility.

Licensed under the MIT License; see `LICENSE`.
