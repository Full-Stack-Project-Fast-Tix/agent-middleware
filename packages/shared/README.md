# @launchpad/shared

Shared TypeScript/Zod contracts for AgentGuard: the domain model, the security
middleware interface, live run events and HTTP payloads. The server and the web
app both import from here so these shapes are defined once.

```ts
import { runEventSchema, type SecurityDecision } from "@launchpad/shared";
```

Every contract is a Zod schema with its inferred type next to it. Validate at
trust boundaries (HTTP bodies, SSE data, model output, database rows) and use the
types everywhere else.

## Layout

| File | Contents | Reviewed by |
| --- | --- | --- |
| `common.ts` | ids, timestamps, JSON payload helpers | all |
| `enums.ts` | statuses, roles, layers, outcomes | all |
| `lifecycle.ts` | allowed status transitions, terminal statuses | P2 |
| `identity.ts` | User, Workspace, WorkspaceMember | P3 |
| `agents.ts` | Agent, AgentProfile, capabilities, SecurityPolicy | P1, P2 |
| `runs.ts` | Run, Task, TaskDependency, AgentExecution | P2, P3 |
| `security.ts` | SecurityFinding, Approval, Reflection, ReflectionSighting | P1, P3 |
| `middleware.ts` | SecurityContext, ProposedAction, SecurityDecision, SecurityEvaluator | P1, P2 |
| `audit.ts` | AuditEvent and its event types | P3 |
| `events.ts` | RunEvent (SSE), RunSnapshot | P2, P4 |
| `api.ts` | routes, error shape, pagination, request and response bodies | all |
| `sse-client.ts` | SSE parser and `followRunEvents` client | P4 |

## Conventions

- Ids are UUIDs. Timestamps are UTC ISO-8601 strings ending in `Z`.
- A nullable column is `T | null` and always present. `?` is only used in
  request bodies, where leaving a field out means "default" or "unchanged".
- Success responses name the resource (`{ run }`, `{ runs }`). Errors are
  `{ error, code?, details? }`.
- Each RunEvent carries a full snapshot of its entity. To apply one, upsert by
  id. Load the `RunSnapshot` first, then apply only events with
  `seq > lastEventSeq`.
- Runtime-only state (process handles, working-copy paths, the semantic
  trajectory window, raw JSONL traces) is never part of a persisted entity.

## Live run events

The server publishes RunEvents through `RunEventHub` (`apps/server/src/run-events.ts`)
and streams them at `GET /api/runs/:id/events` as Server-Sent Events. Browsers and
the integration harness follow the stream with `followRunEvents`. It uses fetch
rather than `EventSource` so it can send the Authorization header:

```ts
const snapshot = await loadRunSnapshot(runId); // your API call
applySnapshot(snapshot);
await followRunEvents({
  url: `/api/runs/${runId}/events`,
  afterSeq: snapshot.lastEventSeq,
  headers: { authorization: `Bearer ${token}` },
  signal: controller.signal,
  onEvent: (event) => upsert(event), // each event carries a full entity
  onResync: async () => {
    const fresh = await loadRunSnapshot(runId);
    applySnapshot(fresh);
    return fresh.lastEventSeq;
  },
});
```

The client reconnects after network drops and resumes from the last seq it
applied. The server replies with a `resync` event when it cannot replay from
that seq: it restarted, or its per-run buffer has moved past it. The client
then reloads the snapshot. Every frame is redacted on the server before it is
written.

## Changing a contract

Contract changes are team changes. Open a small PR, tag the owners listed
above, and update the tests in `tests/`. The enum tests pin the values from the
work plan on purpose: if they fail, that change needs to be agreed.

## Build and resolution

The `development` export condition points at `src/`. Vite, vitest and
`tsx --conditions=development` read the TypeScript directly, so there is
no build step in development. The compiled server and `vite build` use
`dist/`, which `npm run build` at the repo root builds first.

```bash
npm run test -w @launchpad/shared
npm run typecheck -w @launchpad/shared
npm run build -w @launchpad/shared
```
