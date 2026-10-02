# Architecture direction

This document records the agreed direction for the next phase of AgentGuard. It is intentionally a design boundary, not an implementation plan for the full multi-agent system.

- A **Workspace** represents one logical project or codebase.
- A **Run** represents one overall developer request. A Run will eventually contain **Tasks**, and each Task may have one or more **AgentExecutions**.
- Each Run should execute against its own isolated working copy or runtime workspace. Git integration is optional and is not required for orchestration.
- Multiple read-only agents may operate concurrently. Write-capable agents should initially be serialised to avoid conflicting edits.
- Security remains external to agents. Relevant agent-to-tool and agent-to-agent actions pass through a security decision interface.
- Future policy evaluation follows `mandatory platform rules -> workspace rules -> agent capabilities`; lower-level policies cannot weaken mandatory protections.
- Raw execution traces remain artifact/file storage rather than large PostgreSQL blobs.
- PostgreSQL is the planned replacement for JSON persistence; repository ports should keep that migration localized.
- Avoid unnecessary Kubernetes, Kafka, service mesh, or broad microservice decomposition.

The current single-agent runtime remains supported during this transition. Its existing `AgentRun` shape is a compatibility model; future work should introduce the Run/Task/AgentExecution relationship without breaking existing traces or approval behavior.

## Where this stands

- The shared contracts for this model are in
  [`packages/shared`](../packages/shared/README.md). The decisions behind them,
  and the evidence for each, are in [contract-decisions.md](contract-decisions.md).
- Live run updates are streamed over SSE from `GET /api/runs/:id/events`, with
  durable per-run sequence numbers.
- The security decision interface is defined in
  [`apps/server/src/security-middleware.ts`](../apps/server/src/security-middleware.ts).
- An end-to-end integration harness
  ([`apps/server/tests/integration`](../apps/server/tests/integration/README.md))
  checks Gate 1 scenarios and Run invariants. For now it runs against stand-ins
  for the pieces still to be built.
