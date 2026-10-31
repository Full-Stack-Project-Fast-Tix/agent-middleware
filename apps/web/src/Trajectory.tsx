// Two levels of the same run.
//
// "Agent activity" is the readable summary: what the agent did, one line each,
// drawn on the gate line. "Technical details" keeps every finding and protocol
// record for audit.
//
// The summary is derived. The raw view is the evidence, and wins on any
// disagreement.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isOurs,
  isStreamingNoise,
  stepForRecord,
  type FileChangeSummary,
  type TraceRecord,
  type TraceStep,
} from "./trace";
import type { AgentRun, Finding, HumanApprovalRequest } from "./types";
import { Button, DecisionMark, Foreign, GateLine, GateRow, SeverityBadge, StatusBadge } from "./ui";

export interface TrajectoryProps {
  steps: TraceStep[];
  records: TraceRecord[];
  /** True while the run is still going. */
  live: boolean;
  /** Run status, so the empty state can explain itself. */
  status: string | null;
  findings: NonNullable<AgentRun["findings"]>;
  /**
   * How many values the server replaced with a fingerprint on the way out,
   * from the `x-redactions` response header. Zero when nothing was altered.
   */
  redactions: number;
  pendingApproval?: HumanApprovalRequest | null;
  approvalBusy?: boolean;
  onApprovalDecision?: (decision: "approve" | "deny") => void;
}

function clock(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function Trajectory({
  steps,
  records,
  live,
  status,
  findings,
  redactions,
  pendingApproval = null,
  approvalBusy = false,
  onApprovalDecision,
}: TrajectoryProps) {
  const [view, setView] = useState<"activity" | "technical">("activity");
  const [showNoise, setShowNoise] = useState(false);
  const [open, setOpen] = useState(live || status !== "completed");

  useEffect(() => {
    if (live) setOpen(true);
    else if (status === "completed") setOpen(false);
  }, [live, status]);

  const rows = useMemo(() => activityRows(steps, records, findings, live), [steps, records, findings, live]);

  if (status === null) return null;

  const visible = showNoise ? records : records.filter((record) => !isStreamingNoise(record));
  const hidden = records.length - visible.length;
  const actionCount = steps.filter(isPrimaryActivityStep).length;
  const warningCount = findings.filter((finding) => finding.severity === "warn").length;
  const blockedCount = findings.filter((finding) => finding.severity === "violation").length;
  const redirectedCount = findings.filter(
    (finding) => isSemanticRedirect(finding),
  ).length;
  const learnedCount = findings.filter((finding) => finding.check === "learned-watch").length;
  const summary = runSummary(actionCount, warningCount, blockedCount, fileChangeTotals(steps));
  // A finished run only means the agent's turn ended. This wording must not say
  // the task was done correctly, because nothing here checked that.
  const visibleIntervention =
    blockedCount > 0
      ? (
          <>
            <DecisionMark decision="block" label={`${blockedCount} action${blockedCount === 1 ? "" : "s"} blocked`} />
            <span>The run continued and the agent's turn finished.</span>
          </>
        )
      : redirectedCount > 0
        ? (
            <>
              <DecisionMark decision="steer" label={`Steered${redirectedCount === 1 ? "" : ` ${redirectedCount} times`}`} />
              <span>The agent changed approach and its turn finished.</span>
            </>
          )
        : learnedCount > 0
          ? (
              <>
                <DecisionMark decision="steer" label="Earlier safety lesson applied" />
                <span>The agent's safety memory was used during this run.</span>
              </>
            )
          : null;

  return (
    <section className="trajectory" aria-label="Run activity">
      <header className="trajectory-head">
        <div className="tab-row" role="tablist" aria-label="Run activity views">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={open && view === "activity"}
            onClick={() => {
              setView("activity");
              setOpen(true);
            }}
          >
            Agent activity
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={open && view === "technical"}
            onClick={() => {
              setView("technical");
              setOpen(true);
            }}
          >
            Technical details
          </button>
        </div>

        <div className="cluster">
          <StatusBadge status={status} live={live} />
          {/* Collapse rather than dismiss, so the panel can always be reopened
              without re-running anything. It stays open during a live run. */}
          {!live && (
            <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide activity" : "Show activity"}
            </Button>
          )}
        </div>
      </header>

      {!open && (
        <div className="trajectory-summary">
          <p className="meta">{summary}</p>
          {status === "completed" && visibleIntervention !== null && (
            <div className="cluster">{visibleIntervention}</div>
          )}
        </div>
      )}

      {open && view === "activity" && (
        <ActivityList
          rows={rows}
          live={live}
          records={records.length}
          status={status}
          approval={onApprovalDecision === undefined ? null : pendingApproval}
          approvalBusy={approvalBusy}
          onApprovalDecision={onApprovalDecision}
        />
      )}

      {open && view === "technical" && (
        <div className="technical-details">
          <RunSafety findings={findings} />
          <div className="cluster technical-trace-head">
            <h3>Protocol trace</h3>
            <span className="meta tabular">{records.length} record{records.length === 1 ? "" : "s"}</span>
            <RedactionNotice count={redactions} />
          </div>
          <RawList
            records={visible}
            hidden={hidden}
            showNoise={showNoise}
            onToggleNoise={() => setShowNoise(!showNoise)}
          />
        </div>
      )}
    </section>
  );
}

const APPROVAL_REASON_COPY: Record<HumanApprovalRequest["reason"], string> = {
  high_consequence: "This action creates an external or difficult-to-reverse effect and requires confirmation.",
  semantic_uncertainty:
    "Automated supervision detected a possible conflict with the delegated task but could not justify an automatic refusal.",
  semantic_unavailable:
    "Automated safety review is temporarily unavailable for this consequential action.",
};

/** The action waiting on a person. It sits on the gate line like any other. */
function ApprovalRow({
  request,
  busy,
  onDecision,
}: {
  request: HumanApprovalRequest;
  busy: boolean;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  const details = request.safeDetails?.trim() ?? "";
  return (
    <GateRow
      caption={request.actionType === "command" ? "Command" : "File change"}
      proposal={
        <>
          {request.summary}
          {details !== "" && (
            <details className="foreign-more">
              <summary>Details</summary>
              {details}
            </details>
          )}
        </>
      }
      decision="require_approval"
      decisionLabel="Held for your approval"
      reason={APPROVAL_REASON_COPY[request.reason]}
      time={`Expires at ${clock(request.expiresAt)}`}
      actions={
        <>
          <Button variant="primary" busy={busy} onClick={() => onDecision("approve")}>Approve once</Button>
          <Button variant="danger" disabled={busy} onClick={() => onDecision("deny")}>Deny</Button>
        </>
      }
    />
  );
}

/**
 * Says that what is displayed below is not byte-for-byte what the agent did.
 *
 * The wording is "values redacted", never "secrets found", and the difference
 * is not pedantry. The redactor is tuned for recall, so most of what it
 * replaces is precautionary — a long base64 run or a hex digest that is
 * probably harmless. Calling those "secrets" would report a breach on almost
 * every run and train everyone to ignore the number.
 */
function RedactionNotice({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="badge badge-held"
      title={
        "Credential-shaped values were replaced with a fingerprint before this " +
        "trace left the server. The recorded trace on disk is unchanged."
      }
    >
      {count} value{count === 1 ? "" : "s"} redacted
    </span>
  );
}

/** The legacy guards report info, warn or violation, not the Run severity scale. */
function FindingMark({ severity }: { severity: Finding["severity"] }) {
  if (severity === "violation") return <DecisionMark decision="block" />;
  if (severity === "warn") return <span className="badge badge-held">Warning</span>;
  return <SeverityBadge severity="info" />;
}

function RunSafety({ findings }: { findings: NonNullable<AgentRun["findings"]> }) {
  if (findings.length === 0) return null;
  return (
    <details className="run-safety">
      <summary>Run safety <span className="meta tabular">{findings.length} event{findings.length === 1 ? "" : "s"}</span></summary>
      <ol className="run-safety-list">
        {findings.map((finding, index) => (
          <li className="run-safety-item" key={`${finding.check}:${finding.code}:${finding.seq}:${index}`}>
            <div><FindingMark severity={finding.severity} /></div>
            <div className="run-safety-body">
              <p>{finding.message}</p>
              <div className="cluster meta">
                <span>{finding.check}/{finding.code}</span>
                <span className="tabular">Evidence: {finding.evidence.map((seq) => `#${seq}`).join(", ")}</span>
              </div>
              {finding.metadata !== undefined && (
                <Foreign preformatted maxHeight={200}>{JSON.stringify(finding.metadata, null, 2)}</Foreign>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

interface ActivityRow {
  key: string;
  seq: number;
  at: string | null;
  /** Trusted line above the proposal: what kind of action this is. */
  caption: string | null;
  /** What the agent did or proposed. Renders as foreign material. */
  proposal: ReactNode;
  /** A real gate decision, or null for something the agent simply did. */
  decision: "allow" | "steer" | "require_approval" | "block" | null;
  label: string;
  reason: string | null;
  /** This row announces the request that the Held row below already shows. */
  announcesApproval?: boolean;
}

function activityRows(
  steps: TraceStep[],
  records: TraceRecord[],
  findings: Finding[],
  live: boolean,
): ActivityRow[] {
  const hasFindingRedirect = findings.some(
    (finding) => finding.check === "learned-watch" || isSemanticRedirect(finding),
  );
  const hasFindingBlock = findings.some((finding) => finding.severity === "violation");
  const rows: ActivityRow[] = [];

  for (const step of steps) {
    if (step.kind === "reply") continue;
    // Routine shell plumbing is still fully available in Technical details.
    // The default timeline focuses on intent, mutations, verification and
    // intervention rather than replaying a terminal transcript.
    if (!isPrimaryActivityStep(step)) continue;
    // Findings are the clear, attributable home for middleware interventions.
    if (step.kind === "steer" && hasFindingRedirect) continue;
    if (step.kind === "approval") {
      if (step.outcome === "allowed") continue;
      if (step.outcome === "blocked" && hasFindingBlock) continue;
    }
    rows.push(rowForStep(step, live));
  }

  const seenFindings = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.check}:${finding.code}:${finding.seq}`;
    if (seenFindings.has(key)) continue;
    seenFindings.add(key);
    const row = rowForFinding(finding, key, steps, records);
    if (row !== null) rows.push(row);
  }

  return rows.sort((left, right) => left.seq - right.seq);
}

function rowForStep(step: TraceStep, live: boolean): ActivityRow {
  const running = live && step.outcome === null;
  const failed = step.outcome === "failed" || step.kind === "problem";
  const base = { key: `step:${step.seq}`, seq: step.seq, at: step.at, reason: null };

  switch (step.kind) {
    case "thinking":
      return { ...base, caption: "Reasoning", proposal: reasoningSummary(step.detail), decision: null, label: running ? "Analyzing" : "Reasoned" };
    case "steer":
      return { ...base, caption: null, proposal: null, decision: "steer", label: "Steered", reason: step.detail };
    case "approval":
      return step.outcome === "blocked"
        ? { ...base, caption: null, proposal: null, decision: "block", label: "Blocked", reason: step.detail }
        : { ...base, caption: null, proposal: null, decision: "require_approval", label: "Held", reason: step.detail, announcesApproval: true };
    case "problem":
      return { ...base, caption: "Runtime", proposal: step.detail, decision: null, label: "Runtime error" };
    case "file":
      return {
        ...base,
        caption: "File change",
        proposal: step.files !== undefined && step.files.length > 0
          ? <FileChangeList files={step.files} />
          : readableFileChange(step.title),
        decision: null,
        label: failed ? "Failed" : running ? "Changing" : "Changed",
      };
    case "command":
    case "search":
    case "reply":
      return {
        ...base,
        caption: step.kind === "command" ? "Command" : null,
        proposal: <StepProposal step={step} />,
        decision: null,
        label: commandLabel(step, running, failed),
      };
  }
}

/** A command, with its output folded away. */
function StepProposal({ step }: { step: TraceStep }) {
  return (
    <>
      {step.title.trim()}
      {step.detail !== null && step.detail.trim() !== "" && (
        <details className="foreign-more">
          <summary>Output</summary>
          {step.detail}
        </details>
      )}
    </>
  );
}

function commandLabel(step: TraceStep, running: boolean, failed: boolean): string {
  if (failed) return "Failed";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|cargo test)\b/i.test(step.title)) {
    return running ? "Running tests" : "Ran tests";
  }
  return running ? "Running" : "Ran";
}

function isPrimaryActivityStep(step: TraceStep): boolean {
  if (step.kind !== "command" && step.kind !== "search") return true;
  if (step.kind === "search") return false;
  return isVerificationCommand(step.title);
}

function isVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn)\s+(?:(?:run\s+)?(?:test|build|lint|typecheck)|check)\b|\b(?:vitest|jest|pytest|cargo test|go test|node\s+--test|tsc\b)/i.test(command);
}

function reasoningSummary(detail: string | null): string | null {
  if (detail === null || detail.trim() === "") return null;
  const compact = detail
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = compact.match(/^.{1,130}?(?:[.!?](?=\s|$)|$)/)?.[0] ?? compact;
  return sentence.length > 112 ? `${sentence.slice(0, 109).trimEnd()}…` : sentence;
}

function readableFileChange(title: string): string {
  return title
    .split(", ")
    .map((entry) => {
      const match = /^(add|update|delete|changed)\s+(.+)$/.exec(entry);
      if (match === null) return entry;
      const verb = match[1] === "add" ? "Added" : match[1] === "delete" ? "Deleted" : "Updated";
      return `${verb} ${match[2]}`;
    })
    .join(", ");
}

/** What the finding was about, from the trace. Empty when it names no action. */
function evidenceFor(finding: Finding, steps: TraceStep[], records: TraceRecord[]): Pick<ActivityRow, "caption" | "proposal"> {
  for (const seq of finding.evidence) {
    const step = stepForRecord(seq, steps, records);
    if (step?.kind === "command") return { caption: "Command", proposal: step.title.trim() };
    if (step?.kind === "file") return { caption: "File change", proposal: readableFileChange(step.title) };
  }
  return { caption: null, proposal: null };
}

function rowForFinding(finding: Finding, key: string, steps: TraceStep[], records: TraceRecord[]): ActivityRow | null {
  const at = records.find((record) => record.seq === finding.seq)?.at ?? null;
  const row = (rest: Pick<ActivityRow, "decision" | "label" | "reason"> & { announcesApproval?: boolean }): ActivityRow => ({
    key,
    seq: finding.seq,
    at,
    ...evidenceFor(finding, steps, records),
    ...rest,
  });

  if (finding.check === "human-approval") {
    const outcome = finding.metadata?.outcome;
    if (outcome === "requested") {
      return row({
        decision: "require_approval",
        label: "Held",
        reason: "The Runtime paused before a user-delegated action.",
        announcesApproval: true,
      });
    }
    if (outcome === "approved") {
      return row({ decision: "allow", label: "Approved once", reason: "You approved this specific action." });
    }
    return row({
      decision: "block",
      label: outcome === "timed_out" ? "Timed out" : "Denied",
      reason:
        outcome === "timed_out"
          ? "The action was declined and the agent continued without it."
          : "The action was declined without counting as a safety violation.",
    });
  }

  if (finding.check === "learned-watch") {
    return row({
      decision: "steer",
      label: "Earlier safety lesson applied",
      reason: "The agent encountered a pattern associated with an earlier unsafe run.",
    });
  }

  if (
    finding.code === "ungated-command" ||
    finding.code === "ungated-file-change" ||
    finding.check === "runtime-enforcement" ||
    finding.check === "semantic-enforcement"
  ) {
    return row({
      decision: "block",
      label: "Runtime safety boundary failed",
      reason: "An action completed without the expected approval checkpoint. The rest of the turn was stopped.",
    });
  }

  if (finding.severity === "violation") {
    const external = finding.check === "sensitive-egress" || finding.check === "outbound-blob";
    return row({
      decision: "block",
      label: external ? "External data transfer blocked" : "Blocked",
      reason: external
        ? "The agent tried to send sensitive workspace data outside the environment. It was redirected and allowed to continue."
        : "The proposed action conflicted with the delegated task and was blocked.",
    });
  }

  if (isSemanticRedirect(finding)) {
    return row({ decision: "steer", label: "Steered", reason: "The current approach conflicted with the delegated task." });
  }

  if (finding.check === "semantic-intent") {
    if (finding.code === "semantic-monitor-unavailable") {
      return row({
        decision: null,
        label: "Safety review unavailable",
        reason: "The agent continued because this checkpoint did not require a blocking review.",
      });
    }
    // Aligned/allow assessments are audit evidence, not interventions. Keep
    // them in Run safety under Technical details without cluttering activity.
    return null;
  }

  return row({ decision: "steer", label: "Safety guidance applied", reason: "The agent was guided back toward the requested task." });
}

function isSemanticRedirect(finding: Finding): boolean {
  if (finding.check !== "semantic-intent") return false;
  const decision = finding.metadata?.controllerDecision;
  return decision === "steer";
}

function ActivityList(props: {
  rows: ActivityRow[];
  live: boolean;
  records: number;
  status: string;
  approval: HumanApprovalRequest | null;
  approvalBusy: boolean;
  onApprovalDecision: ((decision: "approve" | "deny") => void) | undefined;
}) {
  const { rows, live, approval, approvalBusy, onApprovalDecision } = props;

  // Rows present on first paint are history. Only one that arrives after that
  // gets to draw its mark onto the line.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = new Set(rows.map((row) => row.key));
  }, [rows]);

  // The Held row below says this already, with the buttons. Keep it once.
  const lastAnnouncement = approval === null ? -1 : rows.map((row) => row.announcesApproval === true).lastIndexOf(true);
  const shown = rows.filter((_, index) => index !== lastAnnouncement);

  if (shown.length === 0 && approval === null) {
    return <p className="trajectory-empty">{emptyMessage(live, props.records, props.status)}</p>;
  }

  return (
    <>
      {approval !== null && (
        <p className="sr-only" role="status">An action is held for your approval: {approval.summary}</p>
      )}
      <GateLine label="What the agent did and what was decided" proposalHeading="The agent" decisionHeading="AgentGuard">
        {shown.map((row) => (
          <GateRow
            key={row.key}
            fresh={live && seen.current !== null && !seen.current.has(row.key)}
            decision={row.decision}
            decisionLabel={row.label}
            {...(row.caption === null ? {} : { caption: row.caption })}
            {...(row.proposal === null ? {} : { proposal: row.proposal })}
            {...(row.reason === null ? {} : { reason: row.reason })}
            {...(row.at === null ? {} : { time: clock(row.at) })}
          />
        ))}
        {approval !== null && onApprovalDecision !== undefined && (
          <ApprovalRow request={approval} busy={approvalBusy} onDecision={onApprovalDecision} />
        )}
      </GateLine>
    </>
  );
}

function FileChangeList({ files }: { files: FileChangeSummary[] }) {
  return (
    <div className="file-change-list">
      {files.map((file, index) => (
        <details className="foreign-more file-change" key={`${file.path}:${index}`}>
          <summary>
            {file.path}
            <span className="file-change-facts">
              {file.kind}
              {file.additions !== null && ` +${file.additions}`}
              {file.deletions !== null && ` −${file.deletions}`}
            </span>
          </summary>
          {file.diff !== null && file.diff !== "" && file.diff}
          {file.truncated && <p className="file-change-truncated">Diff truncated. Full evidence remains in Technical details.</p>}
        </details>
      ))}
    </div>
  );
}

function fileChangeTotals(steps: TraceStep[]): { files: number; additions: number; deletions: number } {
  const files = steps.flatMap((step) => step.files ?? []);
  return {
    files: files.length,
    additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  };
}

function runSummary(
  actions: number,
  warnings: number,
  blocked: number,
  changes: { files: number; additions: number; deletions: number },
): string {
  const parts = [`${actions} action${actions === 1 ? "" : "s"}`];
  if (changes.files > 0) {
    parts.push(
      `${changes.files} file${changes.files === 1 ? "" : "s"} changed` +
        (changes.additions + changes.deletions > 0
          ? ` (+${changes.additions} −${changes.deletions})`
          : ""),
    );
  }
  if (warnings > 0) parts.push(`${warnings} safety warning${warnings === 1 ? "" : "s"}`);
  if (blocked > 0) parts.push(`${blocked} action${blocked === 1 ? "" : "s"} blocked`);
  return parts.join(", ");
}

function RawList(props: {
  records: TraceRecord[];
  hidden: number;
  showNoise: boolean;
  onToggleNoise: () => void;
}) {
  if (props.records.length === 0) {
    return <p className="trajectory-empty">Nothing recorded yet.</p>;
  }

  return (
    <>
      {props.hidden > 0 && (
        <Button variant="ghost" onClick={props.onToggleNoise}>
          {props.showNoise
            ? "Hide streaming deltas"
            : `Show ${props.hidden} hidden streaming delta${props.hidden === 1 ? "" : "s"}`}
        </Button>
      )}

      <ol className="raw-list">
        {props.records.map((record) => (
          <RawRow key={record.seq} record={record} />
        ))}
      </ol>
    </>
  );
}

function RawRow({ record }: { record: TraceRecord }) {
  const [open, setOpen] = useState(false);
  const ours = isOurs(record);

  return (
    <li className="raw-row">
      <button type="button" className="raw-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="raw-seq tabular">{record.seq}</span>
        {/* Outbound records are the only place our own actions appear, so they
            are marked. Any future refusal or correction shows up here. */}
        <span className={ours ? "raw-dir raw-ours" : "raw-dir"}>{ours ? "AgentGuard" : "Agent"}</span>
        <span className="raw-method">{record.method ?? "Response"}</span>
      </button>

      {open && <Foreign preformatted maxHeight={360}>{JSON.stringify(record.payload, null, 2)}</Foreign>}
    </li>
  );
}

/**
 * An empty trajectory is normal in three quite different situations, and saying
 * which one it is saves a lot of confusion.
 */
function emptyMessage(live: boolean, records: number, status: string): string {
  if (live && records === 0) return "Starting the Runtime container…";
  if (live) return "Connected to the agent. Waiting for its first action…";
  if (status === "failed") {
    return (
      "The run failed before the agent did anything. The trace holds the " +
      "handshake we sent, but the agent never got as far as acting."
    );
  }
  return "This run finished without taking any action.";
}
