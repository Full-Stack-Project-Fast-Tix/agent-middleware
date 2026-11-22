# Security model

AgentGuard is a local capstone proof of concept. Password mode provides PostgreSQL-backed accounts, hashed sessions, workspace roles and server-side authorization. Shared-token mode is for the simulated UI demo; it does not provide per-user authorization.

## Enforced boundaries

- Trusted server middleware checks delegation, context handoffs, commands and file changes before they run. Capabilities combine mandatory platform ceilings, workspace ceilings and agent profiles; lower layers cannot grant what a higher layer denies.
- Tools run in disposable containers as non-root users with dropped capabilities, no-new-privileges and CPU, memory and PID limits. The workspace mount is read-only for agents without write permission. The image filesystem is not an immutable sandbox; writers can use writable locations inside the container.
- Container network defaults off. Explicit operator permission plus effective agent policy can enable a bridge network even with guards on; guards still evaluate actions. There is no host-level destination firewall.
- The Anthropic API key stays on the host. Repository/tool content read by the agent is sent to the model provider.
- Known credential filenames are excluded from working copies. The encrypted workspace vault keeps selected credentials on the host and allows narrowly granted HTTPS requests through its broker.
- Deterministic checks take precedence over semantic assessments. Risk and confidence from the semantic model are judgments, not calibrated probabilities. Final diff review fails closed on incomplete evidence, but happens after execution and does not roll back the copy.
- Sign-in failure tracking is bounded and expires, but is process-local. Sessions are bearer tokens sent in Authorization headers; the browser keeps them in memory. Use HTTPS beyond loopback.

## Limits

Containers are not hardened isolation for mutually untrusted users. Secret filename exclusions, command classification and output redaction are incomplete defenses; transformed or unrecognized secrets may evade them. Raw rolling traces may contain sensitive data and do not constitute a complete audit history. Access to raw traces is restricted; the bounded findings and audit trail are separate.

Run copies and traces follow configured retention, except that the latest successful workspace copy remains for continuation. Vault entries and database rows are not erased by Run retention. Protect the master key and data directory, and use synthetic credentials and disposable projects for demonstrations.

Run one control-plane instance. A restart ends active Runs; orchestration, approval waiters, credential taint and throttling are not coordinated across replicas. No certification, complete injection detection, production tenant isolation or guaranteed containment is claimed.

## Reporting a defect

Give the repository owner the revision, reproduction steps and impact through a private channel. Do not include real credentials, personal data or raw sensitive traces in public issues.
