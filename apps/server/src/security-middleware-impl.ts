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
import { buildGuardChecks } from "./container-codex-runner.js";
import { IntentController, isHighConsequenceCommand, type IntentControllerResult } from "./intent-controller.js";
import { sharedSeverityOf, type ExecutionGuard, type ResolvedPolicy, type SecurityMiddleware } from "./security-middleware.js";
import { resolveAgentPolicy, type SecurityPolicySource } from "./security-policy-resolver.js";
import type { SemanticIntentMonitor } from "./semantic-intent-monitor.js";
import { resolveTurnSecurityPolicy } from "./turn-security-policy.js";
import type { Reflection } from "./reflections.js";
import { redactSensitiveText } from "./redaction/index.js";
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
  taintIncomplete: boolean;
  expiresAt: number;
  touchedAt: number;
}

const RUN_TAINT_TTL_MS = 60 * 60 * 1_000;
const MAX_TAINTED_RUNS = 1_000;
const MAX_TAINT_VALUES_PER_RUN = 16;
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
      // Codex 0.111 hides its file-change tool in read-only mode. Expose it in
      // the isolated writable workspace and require untrusted approval. The
      // pinned runtime's approval boundary is exercised by the local mock
      // Responses API probe. Also keep service-side web search off whenever
      // this resolved runtime policy denies network access.
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
      sensitiveMarkers, runTaint,
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

  constructor(
    private readonly context: SecurityContext,
    private readonly policy: ResolvedPolicy,
    private readonly delegationDepth: number,
    private readonly checks: Check[],
    private readonly source: SecurityExecutionSource,
    private readonly semantic?: IntentController,
    private readonly sensitiveMarkers: string[] = [],
    private readonly runTaint?: RunTaintState,
  ) {}

  async evaluate(action: ProposedAction): Promise<SecurityDecision> {
    this.assertOpen();
    await this.semanticQueue;
    const deferredFindings = this.deferredFindings.splice(0);
    const deferredSteer = this.deferredSteer;
    this.deferredSteer = null;
    const parsed = actionSchemaParse(action);
    const capabilityFinding = await this.capabilityFinding(parsed);
    if (capabilityFinding !== null) {
      return this.blockAction(parsed.actionId, [...deferredFindings, capabilityFinding], false, deferredSteer);
    }

    const taintFinding = this.runTaintFinding(parsed);
    if (taintFinding !== null) {
      return this.blockAction(parsed.actionId, [...deferredFindings, taintFinding], false, deferredSteer);
    }

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
    if (parsed.type === "command" && isHighConsequenceCommand(parsed.command)) {
      this.pending.set(parsed.actionId, parsed);
      return this.decision("require_approval", warnings, {
        approvalReason: "high_consequence",
        // Not the first warning: an aligned semantic note would read as the reason it is held.
        reason: "This command can reach outside the run's working copy, so a person decides.",
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
      const serialized = JSON.stringify(record);
      for (const value of harvestCredentialValues(serialized)) {
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
      if (egress && (this.runTaint.sensitiveSourceRead || this.runTaint.taintIncomplete || carriesValue)) {
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
    return null;
  }

  private async capabilityFinding(action: ProposedAction): Promise<SecurityFindingDraft | null> {
    const capabilities = this.policy.capabilities;
    if (action.type === "file_change" && !capabilities.write) {
      return policyFinding("capability-write-denied", "This agent profile does not permit workspace changes.", "high", true);
    }
    if (action.type === "command") {
      const isSafeRead = isKnownSafeRead(action.command);
      if (!capabilities.shell && !isSafeRead) {
        return policyFinding("capability-shell-denied", "This agent profile does not permit this shell command.", "high", true);
      }
      if (!capabilities.write && !isSafeRead) {
        return policyFinding("capability-write-denied", "This agent profile does not permit commands outside the read-only command set.", "high", true);
      }
      if (!capabilities.network && classifyEgress(action.command, this.trace.length > 0).egress) {
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
      reason: drafts[0]?.message ?? (outcome === "allow" ? "The action passed the active security checks." : "The action requires security intervention."),
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

function isKnownSafeRead(command: string): boolean {
  // This accepts only a single plain command. Shell syntax, substitutions,
  // redirections and command chaining require the shell capability.
  if (/[;&|<>`$()\\\n\r]/.test(command)) return false;
  return /^\s*(?:ls|pwd|cat|head|tail|rg|grep|find|stat|file|wc|sed|awk)(?:\s+[^\n]*)?\s*$/i.test(command);
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
