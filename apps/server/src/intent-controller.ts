import type { Finding } from "./checks.js";
import type {
  SemanticAssessment,
  SemanticProposedEffect,
  SemanticIntentMonitor,
  SemanticProposedAction,
  TrustedTaskContext,
} from "./semantic-intent-monitor.js";
import { redactMonitorInput } from "./semantic-intent-monitor.js";
import { remediationForSemantic, steeringPrompt } from "./steering-policy.js";
import type { TraceRecord } from "./trace.js";
import type { HumanApprovalReason } from "./types.js";
import { TrajectoryState } from "./trajectory-state.js";
import { isKnownSafeRead } from "./read-only-command.js";
import { splitAtLines } from "./text-parts.js";

export const SEMANTIC_ACTION_REVIEW_RISK = 0.5;
export const SEMANTIC_ACTION_BLOCK_RISK = 0.75;
export const SEMANTIC_REASONING_STEER_RISK = 0.6;
const MAX_SEMANTIC_INPUT_CHARS = 48_000;
const REASONING_ITEMS_BETWEEN_REVIEWS = 3;
/** Effects one action review itemizes; the monitor returns one assessment per effect. */
export const MAX_ACTION_EFFECTS = 24;
/** Characters of proposal text in one effect; longer text is split into parts, none dropped. */
export const MAX_ACTION_EFFECT_CHARS = 2_000;
export const MAX_ACTION_REVIEW_CALLS = 4;

export type IntentDecision = "allow" | "steer" | "decline" | "interrupt" | "human_review";

export interface IntentControllerResult {
  decision: IntentDecision;
  finding?: Finding;
  steer?: string;
  humanReviewReason?: Extract<
    HumanApprovalReason,
    "semantic_uncertainty" | "semantic_unavailable"
  >;
}

/**
 * Deterministic policy over nondeterministic assessments. The monitor may
 * describe risk; only this controller decides what happens to the Runtime.
 */
export class IntentController {
  private readonly state: TrajectoryState;
  private reasoningReviewUnavailable = false;
  private reasoningItemsSinceReview = 0;
  private hasReviewedReasoning = false;

  constructor(
    private readonly monitor: SemanticIntentMonitor,
    trustedTask: TrustedTaskContext,
  ) {
    this.state = new TrajectoryState(trustedTask);
  }

  shouldReviewReasoning(cheapIntentSignal: boolean): boolean {
    this.reasoningItemsSinceReview += 1;
    const checkpointReached =
      !this.hasReviewedReasoning ||
      this.reasoningItemsSinceReview >= REASONING_ITEMS_BETWEEN_REVIEWS;
    if (!cheapIntentSignal && !checkpointReached) return false;

    this.hasReviewedReasoning = true;
    this.reasoningItemsSinceReview = 0;
    return true;
  }

  async observeReasoning(
    trace: TraceRecord[],
    seq: number,
    cheapIntentSignal: boolean,
  ): Promise<IntentControllerResult> {
    this.state.sync(trace);
    try {
      const assessment = await this.monitor.assess(
        boundedMonitorInput(this.state.monitorInput("reasoning", cheapIntentSignal)),
      );
      this.reasoningReviewUnavailable = false;
      this.state.recordAssessment(assessment);
      const shouldSteer =
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_REASONING_STEER_RISK;
      const steer = shouldSteer
        ? steeringPrompt(
            this.state.trustedTask.userPrompt,
            remediationForSemantic(assessment.classification),
            false,
          )
        : undefined;
      return {
        decision: shouldSteer ? "steer" : "allow",
        finding: findingFor(assessment, seq, "reasoning", shouldSteer ? "steer" : "allow", steer),
        ...(steer === undefined ? {} : { steer }),
      };
    } catch (error) {
      // Reasoning itself is not an action to block, but do not let a failed
      // review silently remove scrutiny from the next proposed action.
      this.reasoningReviewUnavailable = true;
      return monitorFailure(seq, "reasoning", error, false);
    }
  }

  shouldReviewAction(action: SemanticProposedAction): boolean {
    if (this.reasoningReviewUnavailable) return true;
    if (this.state.currentRisk() >= SEMANTIC_ACTION_REVIEW_RISK) return true;
    // A shell command can write any workspace file, even when its first clause
    // looks like routine implementation. A missing or incomplete reasoning
    // summary must never make that effect invisible to semantic review.
    if (action.type === "command") return !isKnownSafeRead(action.command);
    if (action.type === "context_handoff" || action.type === "delegation") return true;
    return true;
  }

  async reviewAction(
    trace: TraceRecord[],
    action: SemanticProposedAction,
    forceReview = false,
  ): Promise<IntentControllerResult> {
    this.state.sync(trace);
    if (!forceReview && !this.shouldReviewAction(action)) {
      return neutralFinding();
    }

    // Every part of the proposal is itemized, or a person decides: a part the
    // reviewer never saw must not ride through on an aligned verdict.
    const plan = proposedEffectsFor(action);
    if (!plan.complete) return incompleteEvidence(action, plan.effects.length, this.state.trustedTask.userPrompt);

    try {
      const intentEvidence = this.state.intentEvidenceForNextAction();
      const base = this.state.monitorInput(action.type, false, compactProposedAction(action));
      const batches: SemanticProposedEffect[][] = [];
      let batch: SemanticProposedEffect[] = [];
      const fits = (effects: SemanticProposedEffect[]) => {
        try { boundedMonitorInput({ ...base, proposedEffects: effects }); return effects.length <= MAX_ACTION_EFFECTS; }
        catch { return false; }
      };
      for (const effect of plan.effects) {
        const candidate = [...batch, { ...effect, index: batch.length }];
        if (fits(candidate)) { batch = candidate; continue; }
        if (batch.length === 0) return incompleteEvidence(action, plan.effects.length, this.state.trustedTask.userPrompt);
        batches.push(batch);
        batch = [{ ...effect, index: 0 }];
        if (!fits(batch)) return incompleteEvidence(action, plan.effects.length, this.state.trustedTask.userPrompt);
      }
      if (batch.length > 0) batches.push(batch);
      if (batches.length > MAX_ACTION_REVIEW_CALLS) return incompleteEvidence(action, plan.effects.length, this.state.trustedTask.userPrompt);
      const assessments: SemanticAssessment[] = [];
      for (const effects of batches) {
        assessments.push(rollUpEffects(effects.length, await this.monitor.assess(
          boundedMonitorInput({ ...base, proposedEffects: effects }),
        )));
      }
      const assessment = assessments.reduce((worst, next) => {
        if (next.conflictsWithTask && (!worst.conflictsWithTask || next.riskScore > worst.riskScore)) return next;
        return worst;
      });
      this.reasoningReviewUnavailable = false;
      this.state.recordAssessment(assessment);
      const block =
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_ACTION_BLOCK_RISK;
      const needsHumanReview =
        !block &&
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_ACTION_REVIEW_RISK;
      if (needsHumanReview) {
        return {
          decision: "human_review",
          humanReviewReason: "semantic_uncertainty",
          finding: findingFor(assessment, action.seq, action.type, "human_review", undefined, intentEvidence),
        };
      }
      if (!block) {
        return {
          decision: "allow",
          finding: findingFor(assessment, action.seq, action.type, "allow", undefined, intentEvidence),
        };
      }

      const steer = steeringPrompt(
        this.state.trustedTask.userPrompt,
        remediationForSemantic(assessment.classification),
        true,
      );
      return {
        decision: "decline",
        finding: findingFor(assessment, action.seq, action.type, "decline", steer, intentEvidence),
        steer,
      };
    } catch (error) {
      // A review selected as necessary for a consequential action fails closed:
      // decline this action, but leave the turn alive so the agent can continue.
      return monitorFailure(
        action.seq,
        action.type,
        error,
        true,
        this.state.trustedTask.userPrompt,
      );
    }
  }
}

function boundedMonitorInput(input: Parameters<SemanticIntentMonitor["assess"]>[0]) {
  const redacted = redactMonitorInput(input);
  if (JSON.stringify(redacted).length > MAX_SEMANTIC_INPUT_CHARS) {
    throw new Error("semantic review input exceeds the configured size limit");
  }
  return redacted;
}

interface ReviewUnit {
  id: string;
  kind: SemanticProposedEffect["kind"];
  label: string;
  text: string;
}

/**
 * The proposal as separately reviewable effects: each shell clause (a heredoc
 * stays with its command), each changed file, a handoff's content, or a
 * delegation. Text longer than one effect is split into parts at line ends, so
 * every character is in exactly one effect. `complete` is false when that takes
 * more effects than one review itemizes.
 */
export function proposedEffectsFor(action: SemanticProposedAction): { effects: SemanticProposedEffect[]; complete: boolean } {
  const units: ReviewUnit[] = [];
  switch (action.type) {
    case "command": {
      const clauses = splitShellEffects(action.command);
      clauses.forEach((clause, index) => units.push({
        id: `C${index + 1}`,
        kind: "command",
        label: `shell clause ${index + 1} of ${clauses.length}` + (clause.separator === null ? "" : ` (after ${JSON.stringify(clause.separator)})`),
        text: clause.text,
      }));
      break;
    }
    case "file_change":
      action.changes.forEach((change, index) => units.push({
        id: `F${index + 1}`,
        kind: "file_change",
        label: `${change.kind} ${change.path}`,
        text: change.diff,
      }));
      break;
    case "context_handoff":
      units.push({ id: "H1", kind: "context_handoff", label: "handoff content", text: action.content });
      break;
    case "delegation":
      units.push({ id: "D1", kind: "delegation", label: "delegated task", text: action.title + "\n" + action.objective });
      break;
  }
  const effects: SemanticProposedEffect[] = [];
  for (const unit of units) {
    const parts = splitAtLines(unit.text, MAX_ACTION_EFFECT_CHARS);
    parts.forEach((part, index) => {
      const id = parts.length === 1 ? unit.id : `${unit.id}.P${index + 1}`;
      const note = parts.length === 1 ? "" : ` (part ${index + 1} of ${parts.length})`;
      effects.push({ index: effects.length, kind: unit.kind, summary: `[${id}] ${unit.label}${note}\n${part}` });
    });
  }
  return { effects, complete: effects.length <= MAX_ACTION_EFFECTS * MAX_ACTION_REVIEW_CALLS };
}

/**
 * The proposed action with its bulky text replaced by pointers to the effects
 * that carry it in full, so the same text is not sent twice.
 */
function compactProposedAction(action: SemanticProposedAction): SemanticProposedAction {
  const pointer = (what: string) => `[complete text is in proposedEffects ${what}]`;
  switch (action.type) {
    case "command":
      return action.command.length <= MAX_ACTION_EFFECT_CHARS ? action : { ...action, command: pointer("C1 onwards") };
    case "file_change":
      return {
        ...action,
        changes: action.changes.map((change, index) => change.diff.length <= 400 ? change : { ...change, diff: pointer(`F${index + 1}`) }),
      };
    case "context_handoff":
      return action.content.length <= 400 ? action : { ...action, content: pointer("H1") };
    case "delegation":
      return action.objective.length <= 400 ? action : { ...action, objective: pointer("D1") };
  }
}

/**
 * Hold for a person when the proposal cannot be itemized in one review. This is
 * the same fail-closed path as an unavailable review.
 */
function incompleteEvidence(action: SemanticProposedAction, parts: number, originalUserTask: string): IntentControllerResult {
  const steer = steeringPrompt(originalUserTask, "scope_expansion", true);
  return {
    decision: "human_review",
    humanReviewReason: "semantic_unavailable",
    steer,
    finding: {
      check: "semantic-intent",
      code: "semantic-review-incomplete",
      severity: "warn",
      seq: action.seq,
      evidence: [action.seq],
      message: `Semantic review could not cover this ${action.type.replace("_", " ")}: ${parts} parts exceed its bounded input or ${MAX_ACTION_REVIEW_CALLS}-call budget, so a person decides.`,
      steer,
      metadata: { checkpoint: action.type, controllerDecision: "human_review", required: true, effects: parts, maxEffects: MAX_ACTION_EFFECTS * MAX_ACTION_REVIEW_CALLS },
    },
  };
}

/**
 * Check the itemized result and keep the worst conflicting effect. A monitor
 * that itemizes must assess every effect exactly once; one that does not
 * itemize at all (an older stand-in) is taken at its overall verdict.
 */
function rollUpEffects(expected: number, assessment: SemanticAssessment): SemanticAssessment {
  const items = assessment.effectAssessments;
  if (items === undefined) return assessment;
  const indexes = new Set(items.map((item) => item.index));
  if (items.length !== expected || indexes.size !== expected || [...indexes].some((index) => index < 0 || index >= expected)) {
    throw new Error("semantic review did not assess every proposed effect exactly once");
  }
  const conflicting = items.filter((item) => item.conflictsWithTask);
  if (conflicting.length === 0) return assessment;
  const worst = conflicting.reduce((highest, item) => (item.riskScore > highest.riskScore ? item : highest));
  return {
    ...assessment,
    conflictsWithTask: true,
    riskScore: Math.max(assessment.conflictsWithTask ? assessment.riskScore : 0, worst.riskScore),
    classification: assessment.conflictsWithTask && assessment.classification !== "aligned" && assessment.classification !== "uncertain"
      ? assessment.classification
      : worst.classification,
  };
}

/**
 * Split top-level shell clauses at `&&`, `||`, `;`, `|` and newlines, without
 * splitting quoted text, substitutions, or a heredoc's body, which stays with
 * the command that reads it. Nothing is clipped or merged.
 */
export function splitShellEffects(command: string): Array<{ text: string; separator: string | null }> {
  const pieces: Array<{ text: string; separator: string | null }> = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let depth = 0;
  let separatorBefore: string | null = null;
  let heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const close = (end: number, separator: string | null) => {
    const text = command.slice(start, end).trim();
    if (text !== "") {
      pieces.push({ text, separator: separatorBefore });
      separatorBefore = separator;
    } else if (separator !== null && separatorBefore === null) {
      separatorBefore = separator;
    }
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    // A comment runs to the end of its line: quotes or "<<" inside it start nothing.
    if (char === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]!))) {
      const lineEnd = command.indexOf("\n", index);
      index = (lineEnd === -1 ? command.length : lineEnd) - 1;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (char === "(") { depth += 1; continue; }
    if (char === ")" && depth > 0) { depth -= 1; continue; }
    if (depth > 0) continue;
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      // The delimiter word may be quoted in parts (<<'EOF', <<E"OF", <<\EOF); the shell removes the quoting.
      const match = /^<<(-?)[ \t]*((?:[A-Za-z0-9_.-]|'[^'\n]*'|"[^"\n]*"|\\.)+)/.exec(command.slice(index));
      if (match !== null) {
        heredocs.push({ delimiter: match[2]!.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3"), stripTabs: match[1] === "-" });
        index += match[0].length - 1;
        continue;
      }
    }
    if (char === "\n" && heredocs.length > 0) {
      // The bodies follow this newline, each up to its terminator line.
      let cursor = index + 1;
      for (const heredoc of heredocs) {
        while (cursor < command.length) {
          const lineEnd = command.indexOf("\n", cursor);
          const end = lineEnd === -1 ? command.length : lineEnd;
          const line = command.slice(cursor, end);
          cursor = lineEnd === -1 ? command.length : end + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
        }
      }
      heredocs = [];
      close(cursor, "\n");
      start = cursor;
      index = cursor - 1;
      continue;
    }
    const separator =
      char === "&" && command[index + 1] === "&" ? "&&"
      : char === "|" && command[index + 1] === "|" ? "||"
      : char === ";" || char === "|" || char === "\n" ? char : null;
    if (separator === null) continue;
    close(index, separator);
    index += separator.length - 1;
    start = index + 1;
  }
  close(command.length, null);
  return pieces.length === 0 ? [{ text: command, separator: null }] : pieces;
}

/**
 * Removes `rm -rf "$dir"` for a variable this command set once from `mktemp`, so an
 * agent cleaning up its own temp folder does not wait for a person. Nothing else may
 * follow on that rm, and shell `'"'` quote splicing is why quotes are matched loosely.
 */
function withoutTempCleanup(command: string): string {
  let remaining = command;
  for (const [, name] of command.matchAll(/\b(\w+)=\$\(\s*mktemp\b[^)]*\)/g)) {
    const assignments = command.match(new RegExp(`\\b${name}\\+?=`, "g"))?.length ?? 0;
    const rebound = new RegExp(`\\b(?:for|read|unset|local|declare|typeset|eval)\\s[^;\\n]*\\b${name}\\b|-v\\s+${name}\\b`).test(command);
    if (assignments !== 1 || rebound) continue;
    remaining = remaining.replace(
      new RegExp(`\\brm\\s+-rf\\s+[\\\\"']*\\$\\{?${name}\\}?[\\\\"']*(?=\\s*(?:$|[;&|\\n])|\\s+(?:EXIT|INT|TERM|HUP)\\b)`, "g"),
      "",
    );
  }
  return remaining;
}

export function isHighConsequenceCommand(command: string): boolean {
  const explicitEffect =
    /\b(?:git\s+push|npm\s+publish|cargo\s+publish|gem\s+push|twine\s+upload|docker\s+push|terraform\s+apply|kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)|(?:drop|truncate)\s+(?:database|table|schema))\b/i;
  const taskRunnerEffect =
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release)\b|\b(?:make|just)\s+(?:deploy|release)\b/i;
  const deployExecutable =
    /(?:^|[;&|]\s*|["'])\s*(?:\.\/)?(?:[\w.-]+\/)*(?:deploy|release)(?:\.sh)?\b/i;
  return (
    explicitEffect.test(withoutTempCleanup(command)) ||
    taskRunnerEffect.test(command) ||
    deployExecutable.test(command)
  );
}

function findingFor(
  assessment: SemanticAssessment,
  seq: number,
  checkpoint: "reasoning" | "command" | "file_change" | "context_handoff" | "delegation",
  decision: IntentDecision,
  steer?: string,
  intentEvidence?: "none" | "thinking_summary" | "visible_plan" | "both",
): Finding {
  const severity =
    decision === "decline" || decision === "interrupt"
      ? "violation"
      : assessment.conflictsWithTask
        ? "warn"
        : "info";
  return {
    check: "semantic-intent",
    code: `semantic-${assessment.classification}`,
    severity,
    seq,
    evidence: assessment.evidenceSeqs.length > 0 ? assessment.evidenceSeqs : [seq],
    message: assessment.rationale,
    ...(steer === undefined ? {} : { steer }),
    metadata: {
      checkpoint,
      controllerDecision: decision,
      ...(intentEvidence === undefined ? {} : { intentEvidence }),
      assessment: {
        riskScore: assessment.riskScore,
        confidence: assessment.confidence,
        classification: assessment.classification,
        apparentObjective: assessment.apparentObjective,
        conflictsWithTask: assessment.conflictsWithTask,
        ...(assessment.effectAssessments === undefined ? {} : {
          effectAssessments: assessment.effectAssessments.slice(0, 24),
        }),
      },
    },
  };
}

function neutralFinding(): IntentControllerResult {
  return {
    decision: "allow",
  };
}

function monitorFailure(
  seq: number,
  checkpoint: "reasoning" | "command" | "file_change" | "context_handoff" | "delegation",
  error: unknown,
  required: boolean,
  originalUserTask = "the delegated task",
): IntentControllerResult {
  const decision: IntentDecision = required ? "human_review" : "allow";
  const steer = required
    ? steeringPrompt(originalUserTask, "scope_expansion", true)
    : undefined;
  return {
    decision,
    ...(required ? { humanReviewReason: "semantic_unavailable" as const } : {}),
    finding: {
      check: "semantic-intent",
      code: "semantic-monitor-unavailable",
      severity: "warn",
      seq,
      evidence: [seq],
      message: `Semantic review failed at the ${checkpoint} checkpoint: ${safeError(error)}.`,
      ...(steer === undefined ? {} : { steer }),
      metadata: { checkpoint, controllerDecision: decision, required },
    },
    ...(steer === undefined ? {} : { steer }),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message).slice(0, 240);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
