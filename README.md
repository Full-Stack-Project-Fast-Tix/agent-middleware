# AgentGuard

AgentGuard is a CS464 capstone proof of concept for secure, observable coding-agent workflows. Users submit coding tasks in a browser; Claude works on an isolated project copy while server-owned middleware checks tool actions, delegation and agent handoffs. Users can inspect decisions, answer approvals, review actual file changes and download the resulting project.

The product combines configurable agent roles and capability ceilings with deterministic guards, task-aware semantic review and an audit trail. It is intended for a trusted local demonstration, not a production service for untrusted tenants.

## What is implemented

- **Single and automatic modes:** one selected specialist, or a tool-less supervisor that plans a dependency graph of specialist Tasks. Each attempt is an AgentExecution. Defaults allow six Tasks, two concurrent executions and one writer at a time.
- **Project continuity:** each prompt creates a new Run from the workspace's latest successful copy. Failed Runs retain their evidence but do not become the next project's starting point. Only one Run may be active per workspace.
- **Security boundaries:** platform and workspace capability ceilings constrain each agent. Every tool call passes the server gate before execution. Deterministic checks detect recognized sensitive egress and encoded outbound blobs; optional intent and learned-watch checks provide warnings.
- **Semantic review:** a Claude monitor compares public action summaries, repository reads and proposed effects against the trusted task. It does not expose private model reasoning. Conflicting actions at risk 0.50 are held for approval and at 0.75 are declined. Confidence is recorded, not used as a permission. Review errors or incomplete action evidence require approval.
- **Final diff review:** with semantic review enabled, actual changed content is reviewed before completion. Conflict, incomplete coverage or review failure fails the Run. This happens after execution and does not undo changes.
- **Human approvals:** the browser displays the saved proposal. Approval permits that proposal; denial and timeout refuse it. Ordinary approvals belong to the Run starter; policy-required approvals belong to a workspace security administrator.
- **Workspace vault:** credentials are encrypted locally with AES-256-GCM. Run grants select credentials and agents. A host-side HTTPS broker applies credentials only to exact granted hosts, with no redirects or private destinations. Values are not injected into tool containers.
- **Browser console:** workspace administration, roles, profiles, policies, Runs, task graph, gate timeline, approvals, findings, audit, receipt, actual diff, file previews and ZIP export. Agent summaries are labelled unverified.
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

The backend host stores files; the browser does not execute agents or keep the project's working directory. PostgreSQL stores accounts, membership, policies, Runs, Tasks, findings, approvals and audit events. Run files live at `APP_DATA_DIR/runs/<runId>/workspace`, traces at `APP_DATA_DIR/traces`, encrypted credentials at `APP_DATA_DIR/vault`, and uploaded sources under app data. A source folder is copied, not edited in place. Two users reach the same backend workspace through its API, with server-side role checks and serialized Runs.

| Directory | Purpose |
| --- | --- |
| `apps/server` | API, authentication, PostgreSQL adapters, orchestrator, Claude runtime, guards and vault |
| `apps/web` | React console and live event consumers |
| `packages/shared` | Shared Zod contracts and lifecycle rules |
| `apps/server/migrations` | Checksummed PostgreSQL migrations |
| `benchmark` | Replay and opt-in live evaluation harnesses |
| `benchmark-results/2026-08-31-slice` | Historical reproducible trace sample, not current Claude efficacy evidence |
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

Keep this key across restarts. Without it the vault is unavailable; the rest of the application works. Existing project `.env` files are not imported into the vault automatically.

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

The helper builds the tool image and app, validates the bind mount and serves the console at **http://localhost:3000**. It does not create the first account or start PostgreSQL for you.

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

`docker compose up --build` runs the console/API in a container without a nested container engine. It is **not the full agent execution setup**; run the control plane on the host as above.

### UI demonstration without API credits

```bash
npm run dev:demo
```

Open http://127.0.0.1:5173. This uses an in-memory simulated runtime and security decisions. It demonstrates the console, not live guard effectiveness. If a shared token is configured, use it at the unlock screen.

## Validation and evidence

```bash
npm run check
```

This runs typechecking, shared/server/web tests and production builds. For PostgreSQL suites, set `TEST_DATABASE_URL` to a **disposable test database** before running checks; those suites reset their schema. Never point that variable at a database you want to preserve. CI runs checks against a PostgreSQL 16 service.

```bash
npm run verify:claude-runtime -w @launchpad/server
```

The runtime check requires Docker and the built tool image, but no model key. Live harnesses are explicitly opt-in and incur API charges. Recorded results and commands are in [guard evaluation evidence](docs/GUARD_EVALUATION_RESULTS.md) and [orchestration evaluation](docs/orchestration-evaluation.md). A provider refusal is not proof a guard blocked an action; scripted runtime tests are not live Claude evaluations. Historical benchmarks are labelled separately.

## Limits and troubleshooting

- **401 from Anthropic:** check the configured key and model access, then restart. A rejected key prevents a live run and says nothing about guard quality.
- **Frontend proxy ECONNREFUSED:** the backend is not listening on port 3000; inspect its startup error, database connection and configuration.
- **Vault unavailable:** configure the 64-hex-character master key and restart.
- **Held action:** answer it in Run Detail before the configured timeout. Required approvals in password-mode Runs remain active independently of the legacy `HITL_ENABLED` flag.
- **Incomplete final review:** changed binaries, credential-named files, unavailable content, text above 256 KiB, more than 36 changed files, or exhausted evidence limits can fail the Run. Files can still be inspected/downloaded within artifact limits; a failure does not roll back the copy.
- **ZIP export:** omits dependencies, VCS data, build output, links and recognized credentials. It is a source-project download, not a byte-for-byte backup. The diff reviews build output even when export excludes it.
- **Retention:** old finished Run copies and traces expire after 30 days by default. The latest successful workspace copy remains for follow-ups. Database rows and vault entries are not deleted by that sweep.
- **Project dependencies:** working copies omit installed dependencies, and container network defaults off. Use a self-contained project for the first demo; installing dependencies needs deliberate network permission and a suitable runtime image.
- **Capabilities:** policy ceilings and profiles are enforced. Arbitrary policy rule expressions are unsupported and rejected, rather than silently ignored. Read-only agents use a restricted command allowlist; tests and builds belong to a writer.
- **Isolation:** containers use a non-root user, dropped capabilities and resource limits. Network defaults off but explicit operator/profile permission can enable it. They are not hardened tenant sandboxes. Filename exclusions and redaction do not detect every secret; raw traces may contain sensitive content.
- **Single instance:** orchestration, pending approvals, taint and sign-in throttles include process-local state. Server restart fails active Runs. No production multi-instance guarantee is claimed.

## Further reference

- [Architecture and execution flow](docs/ARCHITECTURE.md), including [database relationships](docs/ERD.md).
- [Security model and limitations](SECURITY.md) and [resource and token budget](docs/COST.md).
- [Interface and security contract decisions](docs/contract-decisions.md) for maintainers.
- [Optional Linux deployment and backup](docs/DEPLOYMENT.md); deployment is outside the local submission requirement.

The separately submitted capstone report describes the system and recorded results. Runtime behavior and the implementation take precedence where historical measurements differ. Internal npm package names retain `@launchpad/*` for compatibility.

Licensed under the MIT License; see `LICENSE`.
