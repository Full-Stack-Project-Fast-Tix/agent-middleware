# Security policy

AgentGuard is a security-focused proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- The runtime container has bridged network connectivity. Agent tool commands
  and built-in web search are denied network access by default where supported;
  `CODEX_NETWORK_ACCESS=true` opts into broad access on unguarded container turns;
  egress, semantic, and HITL guarded turns still deny it.
  This is not host-level egress filtering.
- Multi-agent working copies exclude known environment-secret patterns and
  common credential stores/files by default, but this is a filename-based
  denylist rather than general secret detection. Unrecognized secrets in
  copied files may still be visible to the Agent.
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container. With
  `MODEL_PROVIDER=anthropic` the key is available to the server only: the agent loop
  runs there, and tools run in a container without it. Repository content the agent
  reads still reaches Anthropic as tool results.
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation. Runtime containers use a read-only image
filesystem, but their selected Agent workspace and Codex session directory are
writable bind mounts, and `/tmp` is a bounded writable tmpfs. This narrows
writable locations; it does not make the container a hardened boundary. Raw
traces use a 16 MiB rolling window. When the window fills, older events are
evicted and a `trace/rolled` marker indicates that the retained trace is
incomplete; the runtime continues. Security checks still observe the live
protocol stream independently of what remains in the bounded trace file.
