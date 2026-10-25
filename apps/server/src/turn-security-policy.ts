import type { AppConfig } from "./config.js";
import type { AskForApproval } from "./codex-protocol.js";
import type { TurnOptions } from "./run-turn.js";

/**
 * The security-relevant portion of a live Codex turn, resolved once rather
 * than spread across the runner and JSON-RPC call sites.
 *
 * Codex app-server 0.111.0 defines `approvalPolicy: "untrusted"` as allowing
 * only known-safe, read-only commands without approval. Every other command
 * requests approval before execution. This is deliberately stronger than
 * `on-request`: a network-denied command may still be attempted inside the
 * sandbox under `on-request` and fail without ever emitting an approval.
 * Guarded effects therefore use `untrusted` as their real pre-execution hook.
 * The writable workspace mode exposes Codex's file-change tool; its filesystem
 * access remains scoped to the isolated run workspace. The pinned Codex
 * approval behavior is checked by the local mock Responses API probe. Network
 * denial also disables Codex's service-side web search tool for that execution.
 */
export interface TurnSecurityPolicy {
  sandboxMode: TurnOptions["sandboxMode"];
  denyNetwork: boolean;
  approvalPolicy?: AskForApproval;
  /** True only when the Runtime is required to gate workspace writes. */
  semanticEnforcement: boolean;
  /** True when hard guards rely on the verified pre-execution boundary. */
  effectGating: boolean;
}

export function resolveTurnSecurityPolicy(config: AppConfig): TurnSecurityPolicy {
  if (config.semanticGuardEnabled || config.egressGuardEnabled || config.hitlEnabled) {
    return {
      // Codex 0.111 does not expose its file-change tool in `readOnly` mode.
      // `untrusted` is the approval policy. Gated runtime also fails closed if
      // a file change completes without the expected approval request.
      sandboxMode: "workspace-write",
      // Defence in depth after the untrusted approval boundary: even an
      // unexpected ungated network attempt remains inside a networkless sandbox.
      denyNetwork: true,
      approvalPolicy: "untrusted",
      semanticEnforcement: config.semanticGuardEnabled,
      effectGating: true,
    };
  }

  return {
    // Codex's full-access profile cannot also deny network. When network is
    // not explicitly enabled, cap that profile at workspace-write so the
    // sandbox can enforce networkAccess=false.
    sandboxMode:
      !config.codexNetworkAccess && config.codexSandboxMode === "danger-full-access"
        ? "workspace-write"
        : config.codexSandboxMode,
    denyNetwork: !config.codexNetworkAccess,
    semanticEnforcement: false,
    effectGating: false,
  };
}
