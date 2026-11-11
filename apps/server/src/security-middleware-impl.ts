import {
  highestSeverity,
  proposedActionSchema,
  securityContextSchema,
  agentSchema,
  type ApprovalStatus,
  type FindingSeverity,
  type ProposedAction,
  type SecurityContext,
  type SecurityDecision,
  type SecurityFindingDraft,
} from "@launchpad/shared";
import type { AppConfig } from "./config.js";
import { runChecks, reasoningOf, type Check, type Finding } from "./checks.js";
import {
  classifyEgress,
  DEFAULT_SENSITIVE_MARKERS,
  harvestCredentialValues,
  sensitiveReadSeqs,
} from "./check-sensitive-egress.js";
import { buildGuardChecks } from "./guard-checks.js";
import { isKnownSafeRead, isPlainRead } from "./read-only-command.js";
import { IntentController, isHighConsequenceCommand, type IntentControllerResult } from "./intent-controller.js";
import { sharedSeverityOf, type ExecutionGuard, type ResolvedPolicy, type SecurityMiddleware } from "./security-middleware.js";
import { resolveAgentPolicy, type SecurityPolicySource } from "./security-policy-resolver.js";
import type { SemanticIntentMonitor } from "./semantic-intent-monitor.js";
import { resolveTurnSecurityPolicy } from "./turn-security-policy.js";
import type { LearnInput, Reflection } from "./reflections.js";
import { redactSensitiveText } from "./redaction/index.js";
import { parseVaultRequestCommand } from "./vault-broker.js";
import type { TraceRecord } from "./trace.js";

/** Trusted execution facts loaded by IDs; callers cannot supply goal or policy text. */
export interface SecurityExecutionFacts {
  workspaceId: string;
  runId: string;
  taskId: string;
  agentId: string;
  userPrompt: string;
  taskObjective: string;
  agentInstructions: string;
  delegationDepth: number;
  reflections?: Reflection[];
}

export interface SecurityExecutionSource extends SecurityPolicySource {
  getExecutionFacts(context: SecurityContext): Promise<SecurityExecutionFacts | null>;
  getTaskIdentity(taskId: string): Promise<{ workspaceId: string; runId: string } | null>;
  foldReflections?(agentId: string, input: Omit<LearnInput, "reflections">): Promise<void>;
}

export interface SecurityMiddlewareOptions {
  config: AppConfig;
  source: SecurityExecutionSource;
  semanticMonitor?: SemanticIntentMonitor | null;
  checks?: (reflections: Reflection[]) => Check[];
}

interface RunTaintState {
  readonly values: Set<string>;
  activeExecutions: number;
  sensitiveSourceRead: boolean;
  vaultHostsByAgent: Map<string, Set<string>>;
  taintIncomplete: boolean;
  expiresAt: number;
  touchedAt: number;
}

const RUN_TAINT_TTL_MS = 60 * 60 * 1_000;
const MAX_TAINTED_RUNS = 1_000;
export const MAX_TAINT_VALUES_PER_RUN = 1_024;
const MAX_TAINT_VALUE_CHARS = 4_096;

/** Concrete Person 1 middleware. It is constructed with trusted persistence adapters by the host. */
export class DefaultSecurityMiddleware implements SecurityMiddleware {
  private readonly checkFactory: (reflections: Reflection[]) => Check[];
  private readonly runTaints = new Map<string, RunTaintState>();

  constructor(private readonly options: SecurityMiddlewareOptions) {
    this.checkFactory = options.checks ?? ((reflections) => buildGuardChecks(options.config, reflections));
  }

  async resolvePolicy(workspaceId: string, agentId: string): Promise<ResolvedPolicy> {
    const resolved = await resolveAgentPolicy(this.options.source, workspaceId, agentId);
    const runtime = resolveTurnSecurityPolicy(this.options.config);
    return {
      capabilities: resolved.capabilities,
      appliedPolicies: resolved.appliedPolicies,
      // The isolated writable workspace, with every non-read action stopping at the gate.
      runtime: {
        ...runtime,
        sandboxMode: "workspace-write",
        denyNetwork: runtime.denyNetwork || !resolved.capabilities.network,
        approvalPolicy: "untrusted",
        effectGating: true,
      },
    };
  }

  async openExecution(input: SecurityContext): Promise<ExecutionGuard> {
    const context = securityContextSchema.parse(input);
    const [facts, policy, rawAgent] = await Promise.all([
      this.options.source.getExecutionFacts(context),
      this.resolvePolicy(context.workspaceId, context.agentId),
      this.options.source.getAgent(context.agentId),
    ]);
    if (
      facts === null || facts.workspaceId !== context.workspaceId || facts.runId !== context.runId ||
      facts.taskId !== context.taskId || facts.agentId !== context.agentId
    ) {
      throw new Error("Security execution context could not be verified");
    }
    const agent = rawAgent === null ? null : agentSchema.parse(rawAgent);
    if (agent === null || agent.instructions !== facts.agentInstructions) {
      throw new Error("Trusted agent instructions could not be verified");
    }
    if (!Number.isInteger(facts.delegationDepth) || facts.delegationDepth < 0) {
      throw new Error("Security execution context has an invalid delegation depth");
    }

    const checks = this.checkFactory(facts.reflections ?? []);
    const sensitiveMarkers = this.options.config.guardrailSensitiveMarkers.length > 0
      ? this.options.config.guardrailSensitiveMarkers
      : DEFAULT_SENSITIVE_MARKERS;
    const runTaint = this.getRunTaint(context.workspaceId, context.runId);
    runTaint.activeExecutions += 1;
    const semantic = this.options.semanticMonitor
      ? new IntentController(this.options.semanticMonitor, {
          // Only the original user request is trusted task authority.
          userPrompt: facts.userPrompt,
          agentInstructions: facts.agentInstructions,
        })
      : undefined;
    return new StatefulExecutionGuard(
      context, policy, facts.delegationDepth, checks, this.options.source, semantic,
      sensitiveMarkers, runTaint, facts, this.options.config.reflectionGuardEnabled,
    );
  }

  private getRunTaint(workspaceId: string, runId: string): RunTaintState {
    const now = Date.now();
    for (const [key, state] of this.runTaints) {
      if (state.activeExecutions === 0 && state.expiresAt <= now) this.runTaints.delete(key);
    }

    const key = `${workspaceId}:${runId}`;
    let state = this.runTaints.get(key);
    if (state === undefined) {
      if (this.runTaints.size >= MAX_TAINTED_RUNS) {
        throw new Error("Run security taint capacity reached");
      }
      state = {
        values: new Set(),
        activeExecutions: 0,
        sensitiveSourceRead: false,
        vaultHostsByAgent: new Map(),
        taintIncomplete: false,
        expiresAt: now + RUN_TAINT_TTL_MS,
        touchedAt: now,
      };
      this.runTaints.set(key, state);
    }
    state.touchedAt = now;
    state.expiresAt = now + RUN_TAINT_TTL_MS;
    return state;
  }
}

/** Per-execution trace/check/semantic state behind the orchestrator contract. */
class StatefulExecutionGuard implements ExecutionGuard {
  private readonly trace: TraceRecord[] = [];
  private readonly seenFindings = new Set<string>();
  private readonly pending = new Map<string, ProposedAction>();
  private readonly deniedActions = new Set<string>();
  private semanticQueue: Promise<void> = Promise.resolve();
  private deferredFindings: Finding[] = [];
  private deferredSteer: string | null = null;
  private closed = false;
  private reflectionFolded = false;

  seedVaultGrants(grants: readonly { value: string; allowedHosts: readonly string[] }[]): void {
    if (this.runTaint === undefined) return;
    const hosts = this.runTaint.vaultHostsByAgent.get(this.context.agentId) ?? new Set<string>();
    for (const grant of grants) {
      for (const host of grant.allowedHosts) hosts.add(host.toLowerCase());
      const value = grant.value;
      if (value.length < 4) continue;
      if (value.length > MAX_TAINT_VALUE_CHARS || this.runTaint.values.size >= MAX_TAINT_VALUES_PER_RUN) {
        this.runTaint.taintIncomplete = true;
        continue;
      }
      this.runTaint.values.add(value);
    }
    if (grants.length > 0) this.runTaint.vaultHostsByAgent.set(this.context.agentId, hosts);
  }

  constructor(
    private readonly context: SecurityContext,
    private readonly policy: ResolvedPolicy,
    private readonly delegationDepth: number,
    private readonly checks: Check[],
    private readonly source: SecurityExecutionSource,
    private readonly semantic?: IntentController,
    private readonly sensitiveMarkers: string[] = [],
    private readonly runTaint?: RunTaintState,
    private readonly facts?: SecurityExecutionFacts,
    private readonly reflectionEnabled = false,
  ) {}

  async evaluate(action: ProposedAction): Promise<SecurityDecision> {
    this.assertOpen();
    await this.semanticQueue;
    const deferredFindings = this.deferredFindings.splice(0);
    const deferredSteer = this.deferredSteer;
    this.deferredSteer = null;
    const parsed = actionSchemaParse(action);
    const refuse = (finding: SecurityFindingDraft) =>
      // The orchestrator proposes a handoff, not the agent, so it must not count towards stopping the agent.
      parsed.type === "context_handoff"
        ? this.decision("block", [...deferredFindings, finding], { stop: "action", steer: deferredSteer })
        : this.blockAction(parsed.actionId, [...deferredFindings, finding], false, deferredSteer);
    const capabilityFinding = await this.capabilityFinding(parsed);
    if (capabilityFinding !== null) return refuse(capabilityFinding);

    const taintFinding = this.runTaintFinding(parsed);
    if (taintFinding !== null) return refuse(taintFinding);

    const records = this.recordsFor(parsed);
    const deterministic = runChecks(this.checks, [...this.trace, ...records]);
    const actionFindings = records.length === 0
      ? []
      : deterministic.filter((finding) => finding.seq >= records[0]!.seq);
    const violation = actionFindings.find((finding) => finding.severity === "violation");
    if (violation !== undefined) {
      return this.blockAction(
        parsed.actionId,
        [...deferredFindings, ...actionFindings],
        violation.code.startsWith("ungated-"),
        deferredSteer,
      );
    }

    let semanticResult: IntentControllerResult | undefined;
    if (
      this.semantic &&
      (parsed.type === "command" || parsed.type === "file_change" || parsed.type === "context_handoff" || parsed.type === "delegation")
    ) {
      semanticResult = await this.semantic.reviewAction(
        [...this.trace, ...records],
        parsed.type === "command"
          ? { type: "command", seq: records[0]!.seq, itemId: parsed.actionId, command: parsed.command }
          : parsed.type === "file_change"
            ? {
                type: "file_change", seq: records[0]!.seq, itemId: parsed.actionId,
                changes: parsed.changes.map((change) => ({ ...change, diff: change.diff ?? "" })),
              }
            : parsed.type === "context_handoff"
              ? {
                  type: "context_handoff",
                  seq: (this.trace.at(-1)?.seq ?? 0) + 1,
                  itemId: parsed.actionId,
                  fromTaskId: parsed.fromTaskId,
                  toTaskId: parsed.toTaskId,
                  content: parsed.content,
                }
              : {
                  type: "delegation",
                  seq: (this.trace.at(-1)?.seq ?? 0) + 1,
                  itemId: parsed.actionId,
                  targetAgentId: parsed.targetAgentId,
                  title: parsed.title,
                  objective: parsed.objective,
                },
      );
      if (semanticResult.decision === "decline" || semanticResult.decision === "interrupt") {
        return this.blockAction(
          parsed.actionId,
          [...deferredFindings, ...actionFindings, ...(semanticResult.finding ? [semanticResult.finding] : [])],
          semanticResult.decision === "interrupt",
          semanticResult.steer ?? deferredSteer,
        );
      }
      if (semanticResult.decision === "human_review") {
        this.pending.set(parsed.actionId, parsed);
        return this.decision("require_approval", [...deferredFindings, ...actionFindings, ...(semanticResult.finding ? [semanticResult.finding] : [])], {
          approvalReason: semanticResult.humanReviewReason ?? "semantic_uncertainty",
          ...(deferredSteer === null ? {} : { steer: deferredSteer }),
        });
      }
    }

    const warnings = [...deferredFindings, ...actionFindings, ...(semanticResult?.finding ? [semanticResult.finding] : [])];
    // Asked regardless of what the checks thought: the effect reaches outside the working copy.
    if (
      parsed.type === "command" &&
      (isHighConsequenceCommand(parsed.command) ||
        (this.runTaint?.vaultHostsByAgent.has(this.context.agentId) === true &&
          classifyEgress(parsed.command, false).egress && parseVaultRequestCommand(parsed.command) === null))
    ) {
      this.pending.set(parsed.actionId, parsed);
      return this.decision("require_approval", warnings, {
        approvalReason: "high_consequence",
        // Not the first warning: an aligned semantic note would read as the reason it is held.
        reason: this.runTaint?.vaultHostsByAgent.has(this.context.agentId) === true && classifyEgress(parsed.command, false).egress
          ? "This agent has a local vault grant; direct outbound commands require a person to approve them."
          : "This command can reach outside the run's working copy, so a person decides.",
        ...(deferredSteer === null ? {} : { steer: deferredSteer }),
      });
    }
    if (deferredSteer !== null) {
      return this.decision("steer", warnings, { steer: deferredSteer });
    }
    return warnings.length > 0 && warnings.some((finding) => finding.severity !== "info")
      ? this.decision("steer", warnings, { steer: warnings.find((finding) => finding.steer)?.steer ?? "Continue only with actions that serve the original task and respect the active policy." })
      : this.decision("allow", warnings);
  }

  async observe(record: TraceRecord): Promise<SecurityDecision | null> {
    this.assertOpen();
    if (this.trace.length > 0 && record.seq <= this.trace[this.trace.length - 1]!.seq) {
      throw new Error("Execution trace records must arrive in increasing sequence order");
    }
    this.trace.push(record);
    this.collectRunTaint(record);
    const findings = runChecks(this.checks, this.trace).filter((finding) => this.markFinding(finding));
    const violation = findings.find((finding) => finding.severity === "violation");
    if (violation !== undefined) {
      return this.decision("block", findings, { stop: "execution", steer: null });
    }

    if (this.semantic && reasoningOf([record]).length > 0) {
      const reasoning = reasoningOf([record])[0]!;
      const cheapSignal = findings.some((finding) => finding.check === "agent-intent" && finding.seq === reasoning.seq);
      if (this.semantic.shouldReviewReasoning(cheapSignal)) {
        const snapshot = [...this.trace];
        const seq = reasoning.seq;
        this.semanticQueue = this.semanticQueue.then(async () => {
          const result = await this.semantic!.observeReasoning(snapshot, seq, cheapSignal);
          if (result.finding) this.deferredFindings.push(result.finding);
          if (result.decision === "steer" && result.steer) this.deferredSteer = result.steer;
        }).catch(() => undefined);
      }
    }
    return findings.length === 0 ? null : this.decision("allow", findings);
  }

  async recordApprovalOutcome(actionId: string, outcome: Exclude<ApprovalStatus, "pending">): Promise<SecurityDecision> {
    this.assertOpen();
    if (!this.pending.has(actionId)) throw new Error("No pending security approval exists for this action");
    this.pending.delete(actionId);
    if (outcome === "approved") return this.decision("allow", []);
    const severity: FindingSeverity = outcome === "timed_out" ? "high" : "medium";
    const finding = policyFinding(`approval-${outcome}`, `The action was ${outcome.replace("_", " ")}; it must not be retried in this execution.`, severity, true);
    return this.decision("block", [finding], {
      stop: "action",
      steer: "Do not retry the declined action. Continue with a safe alternative that serves the original task.",
    });
  }

  async complete(threadId: string | null): Promise<void> {
    await this.semanticQueue;
    if (this.reflectionFolded || !this.reflectionEnabled || !this.facts || !this.source.foldReflections) return;
    this.reflectionFolded = true;
    try {
      await this.source.foldReflections(this.context.agentId, {
        findings: runChecks(this.checks, this.trace),
        trace: this.trace,
        runId: this.context.runId,
        prompt: this.facts.userPrompt,
        now: new Date().toISOString(),
        threadId,
        ...(this.sensitiveMarkers.length > 0 ? { markers: this.sensitiveMarkers } : {}),
      });
    } catch (error) {
      // Reflection memory improves future warnings; persistence failure must not
      // retry a completed agent task or convert its result into a failure.
      console.error(`Could not persist reflections for agent ${this.context.agentId}:`, error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.semanticQueue;
    this.pending.clear();
    if (this.runTaint !== undefined && this.runTaint.activeExecutions > 0) {
      this.runTaint.activeExecutions -= 1;
      this.runTaint.touchedAt = Date.now();
      this.runTaint.expiresAt = this.runTaint.touchedAt + RUN_TAINT_TTL_MS;
    }
  }

  private collectRunTaint(record: TraceRecord): void {
    if (this.runTaint === undefined) return;
    const now = Date.now();
    this.runTaint.touchedAt = now;
    this.runTaint.expiresAt = now + RUN_TAINT_TTL_MS;
    if (sensitiveReadSeqs([record], this.sensitiveMarkers).length > 0) {
      this.runTaint.sensitiveSourceRead = true;
    }
    try {
      for (const value of runTaintValues(record)) {
        if (this.runTaint.values.has(value)) continue;
        if (value.length > MAX_TAINT_VALUE_CHARS || this.runTaint.values.size >= MAX_TAINT_VALUES_PER_RUN) {
          this.runTaint.taintIncomplete = true;
          continue;
        }
        this.runTaint.values.add(value);
      }
    } catch {
      // Malformed trace evidence cannot contribute taint; ordinary checks still run.
    }
  }

  private runTaintFinding(action: ProposedAction): SecurityFindingDraft | null {
    if (this.runTaint === undefined) return null;
    if (action.type === "command") {
      const egress = classifyEgress(action.command, this.runTaint.sensitiveSourceRead).egress;
      const carriesValue = [...this.runTaint.values].some((value) => action.command.includes(value));
      const brokerRequest = parseVaultRequestCommand(action.command);
      const allowedHosts = this.runTaint.vaultHostsByAgent.get(this.context.agentId);
      const approvedBroker = brokerRequest !== null && allowedHosts?.has(brokerRequest.url.hostname.toLowerCase()) === true;
      if (brokerRequest !== null && !approvedBroker) {
        return policyFinding("vault-destination-denied", "This API host is not approved for the granted vault secret.", "high", true);
      }
      if (egress && !approvedBroker && (this.runTaint.sensitiveSourceRead || this.runTaint.taintIncomplete || carriesValue)) {
        return policyFinding(
          "sensitive-egress-run-taint",
          "The outbound command is linked to sensitive material observed earlier in this run.",
          "high",
          true,
        );
      }
    }
    if (
      action.type === "context_handoff" &&
      (this.runTaint.taintIncomplete || [...this.runTaint.values].some((value) => action.content.includes(value)))
    ) {
      return policyFinding(
        "context-handoff-run-taint",
        "The handoff contains a credential observed earlier in this run.",
        "high",
        true,
      );
    }
    if (
      action.type === "file_change" &&
      [...this.runTaint.values].some((value) => action.changes.some((change) => (change.diff ?? "").includes(value)))
    ) {
      return policyFinding(
        "vault-secret-file-change",
        "The proposed file change contains a credential granted from the local vault.",
        "high",
        true,
      );
    }
    return null;
  }

  private async capabilityFinding(action: ProposedAction): Promise<SecurityFindingDraft | null> {
    const capabilities = this.policy.capabilities;
    if (action.type === "file_change" && !capabilities.write) {
      return policyFinding("capability-write-denied", "This agent profile does not permit workspace changes.", "high", true);
    }
    if (action.type === "command") {
      if (!capabilities.shell && !isPlainRead(action.command)) {
        return policyFinding("capability-shell-denied", "This agent profile does not permit this shell command.", "high", true);
      }
      if (!capabilities.write && !isKnownSafeRead(action.command)) {
        return policyFinding("capability-write-denied", "This agent profile does not permit commands outside the read-only command set.", "high", true);
      }
      // Assuming a secret was read whenever a trace exists refused every inline script (`node -e`).
      const brokerRequest = parseVaultRequestCommand(action.command);
      const brokerHostAllowed = brokerRequest !== null &&
        this.runTaint?.vaultHostsByAgent.get(this.context.agentId)?.has(brokerRequest.url.hostname.toLowerCase()) === true;
      if (brokerRequest !== null && !brokerHostAllowed) {
        return policyFinding("vault-destination-denied", "This API host is not approved for the granted vault secret.", "high", true);
      }
      if (!capabilities.network && classifyEgress(action.command, this.runTaint?.sensitiveSourceRead ?? false).egress && !brokerHostAllowed) {
        return policyFinding("capability-network-denied", "This agent profile does not permit network access.", "high", true);
      }
    }
    if (action.type === "delegation") {
      if (!capabilities.delegate) return policyFinding("capability-delegation-denied", "This agent profile does not permit delegation.", "high", true);
      if (this.delegationDepth >= capabilities.maxDelegationDepth) {
        return policyFinding("delegation-depth-exceeded", "The configured delegation depth limit has been reached.", "high", true);
      }
      try {
        await resolveAgentPolicy(this.source, this.context.workspaceId, action.targetAgentId);
      } catch {
        return policyFinding("delegation-target-unavailable", "The delegation target is not an enabled agent in this workspace.", "high", true);
      }
    }
    if (action.type === "context_handoff") {
      const [from, to] = await Promise.all([
        this.source.getTaskIdentity(action.fromTaskId),
        this.source.getTaskIdentity(action.toTaskId),
      ]);
      if (
        action.toTaskId !== this.context.taskId || from === null || to === null ||
        from.runId !== this.context.runId || to.runId !== this.context.runId ||
        from.workspaceId !== this.context.workspaceId || to.workspaceId !== this.context.workspaceId
      ) {
        return policyFinding("context-handoff-scope-denied", "Context can only be passed between tasks in the same verified run and workspace.", "high", true);
      }
      if (redactSensitiveText(action.content) !== action.content) {
        return policyFinding("context-handoff-sensitive-content", "The handoff contains content that matches a sensitive-data pattern.", "high", true);
      }
    }
    return null;
  }

  private recordsFor(action: ProposedAction): TraceRecord[] {
    const seq = (this.trace.at(-1)?.seq ?? 0) + 1;
    const item = action.type === "command"
      ? { id: action.actionId, type: "commandExecution", command: action.command, cwd: action.cwd ?? undefined, commandActions: [] }
      : action.type === "file_change"
        ? { id: action.actionId, type: "fileChange", changes: action.changes.map((change) => ({ ...change, kind: { type: change.kind } })) }
        : null;
    if (item === null) return [];
    return [{ seq, at: new Date().toISOString(), dir: "in", method: "item/started", payload: { method: "item/started", params: { item } } }];
  }

  private decision(
    outcome: SecurityDecision["outcome"],
    findings: Array<Finding | SecurityFindingDraft>,
    extra: Record<string, unknown> = {},
  ): SecurityDecision {
    const drafts = findings.map(toDraft);
    const severity = highestSeverity(drafts.map((finding) => finding.severity));
    return {
      outcome,
      // The finding that intervened, not an earlier aligned note, is why this outcome happened.
      reason: (drafts.find((finding) => finding.intervened) ?? drafts[0])?.message ?? (outcome === "allow" ? "The action passed the active security checks." : "The action requires security intervention."),
      severity,
      findings: drafts,
      appliedPolicies: this.policy.appliedPolicies,
      ...extra,
    } as SecurityDecision;
  }

  private blockAction(
    actionId: string,
    findings: Array<Finding | SecurityFindingDraft>,
    forceExecutionStop = false,
    steer: string | null = null,
  ): SecurityDecision {
    const wasBlocked = this.deniedActions.has(actionId);
    this.deniedActions.add(actionId);
    const stop = forceExecutionStop || (!wasBlocked && this.deniedActions.size >= 2)
      ? "execution"
      : "action";
    return this.decision("block", findings, { stop, steer });
  }

  private markFinding(finding: Finding): boolean {
    const key = `${finding.seq}:${finding.check}:${finding.code}`;
    if (this.seenFindings.has(key)) return false;
    this.seenFindings.add(key);
    return true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Execution security guard is closed");
  }
}

function policyFinding(code: string, message: string, severity: FindingSeverity, intervened: boolean): SecurityFindingDraft {
  return { layer: "policy", check: "capability-policy", code, severity, message, facts: null, evidence: null, intervened };
}

/**
 * Credential-shaped values in one trace record, without the git object hashes on
 * a diff's `index` lines, which are never secrets and would fill the per-run limit.
 */
export function runTaintValues(record: TraceRecord): Set<string> {
  return harvestCredentialValues(JSON.stringify(record).replace(/index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}/g, ""));
}

function toDraft(finding: Finding | SecurityFindingDraft): SecurityFindingDraft {
  if ("layer" in finding) return finding;
  return {
    layer: finding.check === "semantic-intent" ? "semantic" : "deterministic",
    check: finding.check,
    code: finding.code,
    severity: sharedSeverityOf(finding),
    message: finding.message.slice(0, 1_000),
    facts: finding.facts ?? null,
    evidence: { seqs: finding.evidence.slice(0, 24), ...(finding.metadata ? { metadata: finding.metadata } : {}) },
    intervened: finding.severity === "violation" || finding.steer !== undefined || finding.requestSteer === true,
  };
}

function actionSchemaParse(action: ProposedAction): ProposedAction {
  // Inputs are validated at the shared API boundary; this also protects direct
  // server callers that use the middleware without going through that route.
  return proposedActionSchema.parse(action);
}

/**
 * Composition boundary for the host application. The host supplies trusted
 * persistence adapters; policy resolution and execution guarding stay inside
 * this middleware rather than in the orchestrator.
 */
export function createSecurityMiddleware(options: SecurityMiddlewareOptions): SecurityMiddleware {
  return new DefaultSecurityMiddleware(options);
}
