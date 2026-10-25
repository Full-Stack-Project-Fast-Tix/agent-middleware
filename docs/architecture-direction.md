# Architecture direction

This document records the agreed architecture direction and distinguishes it from current implementation. The multi-agent system has substantial working foundations; unfinished capabilities are called out below.

- A **Workspace** represents one logical project or codebase.
- A **Run** represents one overall developer request and contains **Tasks**, each with one or more **AgentExecutions**.
- Each Run executes against its own working copy and runtime workspace. Git integration is optional and is not required for orchestration.
- Multiple read-only agents may operate concurrently. Write-capable agents should initially be serialised to avoid conflicting edits.
- Security remains external to agents. Relevant agent-to-tool and agent-to-agent actions pass through a security decision interface.
- Future policy evaluation follows `mandatory platform rules -> workspace rules -> agent capabilities`; lower-level policies cannot weaken mandatory protections.
- Raw execution traces remain artifact/file storage rather than large PostgreSQL blobs.
- PostgreSQL backs the password-authenticated multi-agent path; repository ports keep persistence boundaries localized.
- Avoid unnecessary Kubernetes, Kafka, service mesh, or broad microservice decomposition.

The current single-agent runtime remains supported alongside the multi-agent path. Its existing `AgentRun` shape is a compatibility model; preserve it without breaking existing traces or approval behavior.

## Where this stands

- The shared contracts for this model are in
  [`packages/shared`](../packages/shared/README.md). The decisions behind them,
  and the evidence for each, are in [contract-decisions.md](contract-decisions.md).
- Live run updates are streamed over SSE from `GET /api/runs/:id/events`, with
  durable per-run sequence numbers.
- The security decision interface is defined in
  [`apps/server/src/security-middleware.ts`](../apps/server/src/security-middleware.ts).
- A server implementation now resolves capability ceilings and opens
  per-execution guards around the current deterministic checks and semantic
  controller (`security-middleware-impl.ts` and `security-policy-resolver.ts`).
  It is wired to trusted PostgreSQL persistence and the orchestrator in
  password-authenticated container mode. Arbitrary policy rule payloads beyond
  typed capability ceilings are not yet supported.
- An end-to-end integration harness
  ([`apps/server/tests/integration`](../apps/server/tests/integration/README.md))
  checks Gate 1 scenarios and Run invariants. Its default scenarios use
  stand-ins for persistence and middleware; it is not a full production-stack
  test. The app shell, dashboard, admin workflows, sign-in throttling, and
  stronger tenant isolation remain unfinished.
