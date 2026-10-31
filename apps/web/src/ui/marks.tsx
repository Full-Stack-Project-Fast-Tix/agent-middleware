import type { ReactNode } from "react";
import type { FindingSeverity, SecurityDecisionOutcome } from "@launchpad/shared";

// The status vocabulary for the whole app. A shape and a word always travel
// together, so colour is never the only signal.

export const DECISION_WORDS: Readonly<Record<SecurityDecisionOutcome, string>> = {
  allow: "Allowed",
  steer: "Steered",
  require_approval: "Held",
  block: "Blocked",
};

function Tick() {
  return (
    <>
      <polyline points="3.5,10.5 8,15 16.5,5" fill="none" stroke="var(--mark-halo, transparent)" strokeWidth="5.5" />
      <polyline points="3.5,10.5 8,15 16.5,5" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </>
  );
}

function Chevron() {
  return (
    <>
      <polyline points="7,3.5 14,10 7,16.5" fill="none" stroke="var(--mark-halo, transparent)" strokeWidth="5.5" />
      <polyline points="7,3.5 14,10 7,16.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </>
  );
}

function HollowSquare() {
  return <rect x="4" y="4" width="12" height="12" fill="var(--mark-fill, none)" stroke="currentColor" strokeWidth="2.5" />;
}

function Bar() {
  return <rect x="1" y="6.5" width="18" height="7" fill="currentColor" />;
}

function ThinBar() {
  return <rect x="3" y="9" width="14" height="2" fill="currentColor" />;
}

function DashedSquare() {
  return <rect x="4" y="4" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />;
}

function WorkingSquare({ live }: { live: boolean }) {
  return (
    <>
      <rect x="4" y="4" width="12" height="12" fill="none" stroke="var(--rule)" strokeWidth="2" />
      <rect
        className={live ? "mark-live-segment" : undefined}
        x="4"
        y="4"
        width="12"
        height="12"
        fill="none"
        stroke="var(--graphite)"
        strokeWidth="2"
        strokeDasharray="12 36"
      />
    </>
  );
}

function Glyph({ size, tone, children }: { size: number; tone: string; children: ReactNode }) {
  return (
    <svg className={"mark mark-" + tone} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  );
}

const DECISION_GLYPHS: Readonly<Record<SecurityDecisionOutcome, () => ReactNode>> = {
  allow: Tick,
  steer: Chevron,
  require_approval: HollowSquare,
  block: Bar,
};

/** The shape alone. Anything showing it must also carry the word nearby. */
export function DecisionGlyph({ decision, size = 16 }: { decision: SecurityDecisionOutcome; size?: number }) {
  const Shape = DECISION_GLYPHS[decision];
  return <Glyph size={size} tone={decision}><Shape /></Glyph>;
}

/** A middleware decision: its shape and its word. */
export function DecisionMark({ decision, label, size = 16 }: {
  decision: SecurityDecisionOutcome;
  /** Replaces the standard word, for instance "Held for your approval". */
  label?: string;
  size?: number;
}) {
  return (
    <span className={"decision decision-" + decision}>
      <DecisionGlyph decision={decision} size={size} />
      {label ?? DECISION_WORDS[decision]}
    </span>
  );
}

type BadgeTone = "neutral" | "held" | "blocked" | "passed" | "steered";

interface StatusStyle {
  word: string;
  tone: BadgeTone;
  glyph: (live: boolean) => ReactNode;
  glyphTone: string;
}

const held = (word: string): StatusStyle => ({
  word,
  tone: "held",
  glyph: () => <HollowSquare />,
  glyphTone: "require_approval",
});
const waiting = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: () => <DashedSquare />,
  glyphTone: "neutral",
});
const working = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: (live) => <WorkingSquare live={live} />,
  glyphTone: "graphite",
});
const stopped = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: () => <ThinBar />,
  glyphTone: "neutral",
});
const failed = (word: string): StatusStyle => ({
  word,
  tone: "blocked",
  glyph: () => <Bar />,
  glyphTone: "block",
});

// "completed" reads "Finished" on purpose: it means the agent's turn ended, and
// is no evidence that the requested code is correct.
const STATUS_STYLES: Readonly<Record<string, StatusStyle>> = {
  queued: waiting("Queued"),
  pending: waiting("Pending"),
  ready: waiting("Ready"),
  planning: working("Planning"),
  running: working("Running"),
  waiting_approval: held("Held"),
  completed: { word: "Finished", tone: "neutral", glyph: () => <Tick />, glyphTone: "graphite" },
  failed: failed("Failed"),
  cancelled: stopped("Cancelled"),
  skipped: stopped("Skipped"),
  // Approval statuses. A pending approval is what the app calls Held.
  approved: { word: "Approved", tone: "passed", glyph: () => <Tick />, glyphTone: "allow" },
  denied: failed("Denied"),
  timed_out: stopped("Timed out"),
};

function fallbackStyle(status: string): StatusStyle {
  const word = status.replaceAll("_", " ");
  return stopped(word.charAt(0).toUpperCase() + word.slice(1));
}

/**
 * The status of a Run, Task, AgentExecution or Approval. Pass `live` while the
 * page is receiving updates: a running glyph only moves when that is true.
 * An approval's `pending` should be passed as `waiting_approval`, or it shows
 * as Pending; use {@link approvalBadgeStatus}.
 */
export function StatusBadge({ status, live = false }: { status: string; live?: boolean }) {
  const style = STATUS_STYLES[status] ?? fallbackStyle(status);
  return (
    <span className={"badge badge-" + style.tone}>
      <Glyph size={14} tone={style.glyphTone}>{style.glyph(live)}</Glyph>
      {style.word}
    </span>
  );
}

export const approvalBadgeStatus = (status: string): string => (status === "pending" ? "waiting_approval" : status);

const SEVERITY_TONES: Readonly<Record<FindingSeverity, string>> = {
  info: "neutral",
  low: "neutral",
  medium: "held",
  high: "blocked",
  critical: "critical",
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return (
    <span className={"badge badge-" + SEVERITY_TONES[severity]}>
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
}
