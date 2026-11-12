# Team handover: current state and next steps

**Updated:** 11 November 2026
**Branch checked:** `main`
**Status:** Core POC implementation is present. Remaining work is validation,
operations, documentation upkeep, and explicitly deferred product scope. This is
not a production-hardened multi-tenant service.

## Current implementation

### P1 — Security

- Claude is the only agent runtime. The server owns the Claude tool loop; each
  tool action passes through AgentGuard middleware before execution. Agent tools
  run in disposable containers, with networking disabled when policy denies it.
- Deterministic and semantic checks produce bounded findings and middleware
  decisions. Semantic confidence is audit information; it does not decide
  whether an action is allowed.
- Workspace vault grants are resolved server-side, scoped to selected agents,
  and mediated through the HTTPS vault broker. Vault use requires the configured
  master key and the Postgres-backed workspace service.
- Workspace working-copy exclusions cover known credential paths and are kept
  aligned with sensitive-file checks by tests. This is a filename-based filter,
  not general secret detection.
- Reflection memory is wired to PostgreSQL using structured findings. Whether
  it improves live multi-agent outcomes remains unmeasured.
- Fine-grained `SecurityPolicy.rules` are unsupported and fail closed. A future
  rules feature needs a versioned schema and reviewed enforcement semantics.

### P2 — Orchestration

- Runs use the Run → Task → AgentExecution model. A supervisor plans and
  delegates one level to specialists; write-capable work is serialized.
- Specialists return a strict completion disposition. A completed model turn
  alone does not complete a Task; incomplete or malformed dispositions fail the
  task without an unsafe retry.
- Dependency handling, approvals, cancellation, retries, and terminal artifact
  retention are implemented. Nested specialist delegation remains deliberately
  disabled for this POC.

### P3 — Platform

- Password-authenticated workspaces, roles, Postgres-backed Runs, workspace
  management, sign-in throttling, and run-scoped working copies are implemented.
- A workspace admin can create an empty workspace or upload a validated ZIP
  before its first Run. ZIP extraction is bounded and rejects unsafe paths,
  links, and known credential files. Server-folder registration remains an
  operator action restricted by `WORKSPACE_SOURCE_ROOTS`.
- A completed Run has a bounded, redacted actual file diff and an outcome
  receipt. The entire Run workspace can also be downloaded as ZIP.
- Sign-in throttling is in process memory. It resets on restart and is not shared
  across replicas. Keep this POC single-instance: event resync does not make
  orchestration waiters, cancellation, approvals, or run-scoped taint
  multi-instance safe.

### P4 — Contracts, UI, and integration

- The console includes Dashboard, Runs, Run Detail, Approvals, Agents, Policies,
  Security/Audit, Members, Credentials, and saved Benchmark reports.
- Start a Run separates task entry from execution setup. Completed Run Detail
  distinguishes gate proposals from actual file changes and labels agent
  reports as unverified. Task details are available in a collapsible panel.
- Desktop navigation groups less-frequent workspace destinations. The mobile
  navigation keeps all destinations directly listed.
- ZIP upload, full Run ZIP download, failed-sign-in throttling, actual Run diffs,
  and the outcome receipt are implemented.

## Remaining work

### P1

- Expand the first small Claude-backed multi-agent benchmark sample with repeated
  trials and varied attacks. The two recent fake-secret runs ended in model
  refusal, so they do not measure egress-guard containment; reflection memory's
  live benefit is still unmeasured. See
  [guard evaluation results](docs/GUARD_EVALUATION_RESULTS.md).
- Re-run the file-change approval and network-denial runtime probes when the
  Claude runtime image or sandbox setup changes.
- Maintain sensitive-file marker parity as the marker list evolves.

### P2

- No outstanding P2 feature implementation is currently identified. Preserve
  the task disposition and lifecycle invariants as orchestration changes.
- Revisit nested delegation only if the product explicitly needs it and a new
  lineage, scheduling, lifecycle, and security design is reviewed.

### P3

- Exercise `scripts/deploy-multi-agent.sh` and its systemd/backup behavior on
  the intended Linux/ECS host. Local build checks do not validate that host.
- Keep bootstrap of the first account and registration of server-side project
  folders operator-only. Do not deploy as multi-instance without shared
  coordination for the process-local state listed above.
- Stronger tenant isolation is deferred; current workspace roles and Run copies
  are logical separation, not hardened isolation between mutually untrusted
  tenants.

### P4

- Do a manual browser review at desktop and mobile widths, especially the
  grouped navigation, Start a Run form, completed Run receipt, and collapsed
  task-details panel. The AppShell regression test checks markup structure, not
  visual layout or real pointer/keyboard interaction.
- Keep docs and UI wording aligned with implemented behavior and distinguish
  saved benchmark artifacts from live efficacy results.

## Deliberate POC boundaries

- Agents have no general network capability. Provider-only egress is not
  implemented or claimed.
- Workspace roles and isolated Run working copies do not provide production
  tenant isolation. Raw traces may contain values missed by redaction and may
  be truncated; they are debugging evidence, not the complete audit record.
- Policy rules beyond capability ceilings, recursive delegation, user-side
  browsing of arbitrary host folders, multi-instance orchestration, and a
  Dashboard covering all aspirational system metrics are outside the current
  implementation.
- `dev:demo` uses simulated Runs. The workspace vault and real account/workspace
  administration require the Postgres-backed mode and configured vault key.

## Dependencies and handoff

| Work | Depends on | Can proceed now? |
| --- | --- | --- |
| P1 expanded live benchmark and reflection review | Dedicated Postgres, container runtime/image, Claude credentials, benchmark budget | Yes, when those are available |
| P1 runtime probes | Claude container image and local runtime access | Yes |
| P3 deployment validation | Intended Linux/ECS host and deployment credentials | No, host access required |
| P4 browser review | Running app and browser at desktop/mobile widths | Yes |
| Fine-grained rules, nested delegation, hardened tenant isolation | New product/security decisions and reviewed designs | Deferred; no one is blocking another |

No remaining implementation item above depends on another person finishing code
first. The live benchmark and deployment checks depend on external environment
access, not P2/P4 code.

## References

- [Architecture](docs/ARCHITECTURE.md) — implemented system and current limits.
- [Architecture direction](docs/architecture-direction.md) — agreed future
  direction, not proof of implementation.
- [Contract decisions](docs/contract-decisions.md) — settled interfaces and
  security choices, especially decisions 18–21, 24–27, 30–32.
- [Deployment](docs/DEPLOYMENT.md) — host prerequisites and POC deployment.
- [Live orchestration benchmark](benchmark/run-multi-agent-live.ts) — P1
  validation harness.
