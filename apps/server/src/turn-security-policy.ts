import type { AppConfig } from "./config.js";

/**
 * The security-relevant portion of an execution, resolved once rather than
 * spread across its callers. "untrusted" means nothing but a read runs before
 * the security middleware has seen it, and Claude's loop only starts under it:
 * see assertGatedPolicy.
 */
export interface TurnSecurityPolicy {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  denyNetwork: boolean;
  approvalPolicy?: "untrusted";
  /** True only when the Runtime is required to gate workspace writes. */
  semanticEnforcement: boolean;
  /** True when hard guards rely on the verified pre-execution boundary. */
  effectGating: boolean;
}

export function resolveTurnSecurityPolicy(config: AppConfig): TurnSecurityPolicy {
  if (config.semanticGuardEnabled || config.egressGuardEnabled || config.hitlEnabled) {
    return {
      sandboxMode: "workspace-write",
      // Defence in depth after the approval boundary: even an unexpected ungated
      // network attempt remains inside a networkless container.
      denyNetwork: true,
      approvalPolicy: "untrusted",
      semanticEnforcement: config.semanticGuardEnabled,
      effectGating: true,
    };
  }

  return {
    sandboxMode: "workspace-write",
    denyNetwork: !config.agentNetworkAccess,
    semanticEnforcement: false,
    effectGating: false,
  };
}

export class UngatedRuntimePolicyError extends Error {
  constructor(policy: TurnSecurityPolicy) {
    super(
      "Refusing to run an execution whose actions would not reach the security middleware: " +
        `sandbox ${policy.sandboxMode}, approval policy ${JSON.stringify(policy.approvalPolicy ?? null)}. ` +
        'Only "workspace-write" with "untrusted" requires non-read actions to wait for approval.',
    );
    this.name = "UngatedRuntimePolicyError";
  }
}

/**
 * Under any other combination some actions run without an approval request,
 * so evaluate() would never see them. The middleware chooses the policy; this
 * only refuses one that would bypass it.
 */
export function assertGatedPolicy(policy: TurnSecurityPolicy): void {
  if (policy.sandboxMode !== "workspace-write" || policy.approvalPolicy !== "untrusted") {
    throw new UngatedRuntimePolicyError(policy);
  }
}
