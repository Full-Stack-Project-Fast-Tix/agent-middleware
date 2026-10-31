import type { ReactNode } from "react";
import type { FindingSeverity, SecurityDecisionOutcome } from "@launchpad/shared";

// The status vocabulary for the whole app. A shape and a word always travel
// together, so colour is never the only signal. Shapes sit on a 20-unit square,
// with round ends so they read as one family.

export const DECISION_WORDS: Readonly<Record<SecurityDecisionOutcome, string>> = {
  allow: "Allowed",
  steer: "Steered",
  require_approval: "Held",
  block: "Blocked",
};

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Tick() {
  return <path d="m4.5 10.5 3.8 3.8 7.2-8.3" {...STROKE} />;
}

/** The agent went on a different way: a line that bends and carries on. */
function Bend() {
  return <path d="M4.5 15v-1.5A5.5 5.5 0 0 1 10 8h5.5m-3.2-3.2L15.5 8l-3.2 3.2" {...STROKE} />;
}

/** Paused until a person answers. */
function Pause() {
  return (
    <>
      <rect x="5.6" y="4.5" width="3" height="11" rx="1.5" fill="currentColor" />
      <rect x="11.4" y="4.5" width="3" height="11" rx="1.5" fill="currentColor" />
    </>
  );
}

/** A no-entry sign. The one filled shape, because it is the one hard stop. */
function NoEntry() {
  return (
    <>
      <circle cx="10" cy="10" r="8.5" fill="currentColor" />
      <rect x="5.2" y="8.8" width="9.6" height="2.4" rx="1.2" fill="var(--on-solid)" />
    </>
  );
}

function Dash() {
  return <path d="M5 10h10" {...STROKE} />;
}

function DashedRing() {
  return <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2.6 3.2" />;
}

function WorkingRing({ live }: { live: boolean }) {
  return (
    <>
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <path className={live ? "mark-live-segment" : undefined} d="M10 3.5A6.5 6.5 0 0 1 16.5 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
  steer: Bend,
  require_approval: Pause,
  block: NoEntry,
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
  glyph: () => <Pause />,
  glyphTone: "require_approval",
});
const waiting = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: () => <DashedRing />,
  glyphTone: "neutral",
});
const working = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: (live) => <WorkingRing live={live} />,
  glyphTone: "ink",
});
const stopped = (word: string): StatusStyle => ({
  word,
  tone: "neutral",
  glyph: () => <Dash />,
  glyphTone: "neutral",
});
const failed = (word: string): StatusStyle => ({
  word,
  tone: "blocked",
  glyph: () => <NoEntry />,
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
  completed: { word: "Finished", tone: "neutral", glyph: () => <Tick />, glyphTone: "ink" },
  failed: failed("Failed"),
  cancelled: stopped("Cancelled"),
  skipped: stopped("Skipped"),
  // Agent statuses in the Playground.
  busy: working("Busy"),
  stopped: stopped("Stopped"),
  error: failed("Error"),
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
