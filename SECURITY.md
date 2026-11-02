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
- Ordinary local containers, not hardened multi-tenant sandboxes
- Agent tool commands are denied network access by default, with a container that
  has no network. `AGENT_NETWORK_ACCESS=true` opts into a bridge network on unguarded
  executions; egress, semantic, and HITL guarded executions still deny it. This is
  not host-level egress filtering.
- Multi-agent working copies exclude known environment-secret patterns and
  common credential stores/files by default, but this is a filename-based
  denylist rather than general secret detection. Unrecognized secrets in
  copied files may still be visible to the Agent.
- Prompt-triggered command and file execution
- The Anthropic key is available to the server only: the agent loop
  runs there, and tools run in a container without it. Repository content the agent
  reads still reaches Anthropic as tool results.

## Safe use

- Use a dedicated development machine or disposable host.
- Use a scoped, revocable Anthropic key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict Web and SSH access to a host.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide cloud account credentials to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Tool containers use a read-only image filesystem, but the Run's working copy is a
writable bind mount for an agent that may write, and `/tmp` is a bounded writable tmpfs. This narrows
writable locations; it does not make the container a hardened boundary. Raw
traces use a 16 MiB rolling window. When the window fills, older events are
evicted and a `trace/rolled` marker indicates that the retained trace is
incomplete; the runtime continues. Security checks still observe the live
tool calls independently of what remains in the bounded trace file.
