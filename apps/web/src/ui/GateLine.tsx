import type { ReactNode } from "react";
import type { SecurityDecisionOutcome } from "@launchpad/shared";
import { DECISION_WORDS, DecisionGlyph } from "./marks";
import { Foreign } from "./primitives";

/**
 * The gate line: agent-authored material on the left, the middleware's trusted
 * decision on the right, one unbroken line between them. Takes plain props; the
 * page supplies the data. Children are GateRows, oldest first.
 */
export function GateLine({ label = "Actions and decisions", proposalHeading = "The agent proposed", decisionHeading = "AgentGuard decided", children }: {
  /** Names the list for screen readers. */
  label?: string;
  proposalHeading?: string;
  decisionHeading?: string;
  children: ReactNode;
}) {
  return (
    <ol className="gate-line" aria-label={label}>
      <li className="gate-row gate-row-head" aria-hidden="true">
        <div className="gate-proposal">{proposalHeading}</div>
        <div className="gate-axis" />
        <div className="gate-decision">{decisionHeading}</div>
      </li>
      {children}
    </ol>
  );
}

/** A click on the row opens it, unless it finished selecting text or belongs to a control. */
export function openRow(target: EventTarget, open: () => void) {
  if (window.getSelection()?.toString()) return;
  if (target instanceof Element && target.closest("a, button:not(.gate-open), input, summary")) return;
  open();
}

export function GateRow({ proposal, proposalMissing, caption, decision, decisionLabel, reason, time, fresh = false, selected = false, onSelect, selectLabel, actions }: {
  /** What the agent proposed. Agent-authored, so it renders as foreign material. */
  proposal?: ReactNode;
  /** A trusted statement that the proposal was not saved. Never leave the side blank. */
  proposalMissing?: ReactNode;
  /** Trusted line above the proposal, for instance "Command" or "File change". */
  caption?: ReactNode;
  /**
   * The middleware's decision. Null for a timeline entry that is not a decision,
   * such as a task starting: it gets a small neutral mark, and decisionLabel.
   */
  decision: SecurityDecisionOutcome | null;
  /** Replaces the standard word, for instance "Held for your approval". */
  decisionLabel?: string;
  /** Why, in plain words. Trusted server fact. */
  reason?: ReactNode;
  /** Preformatted time. */
  time?: string;
  /** Set only on a row that just arrived live: its mark draws onto the line once. */
  fresh?: boolean;
  selected?: boolean;
  /** Makes the whole row open something, such as the task's drill-down. */
  onSelect?: () => void;
  /** Describes what selecting does. Required with onSelect when the proposal is not text. */
  selectLabel?: string;
  /** Controls for a held action. These stay clickable inside a selectable row. */
  actions?: ReactNode;
}) {
  const nothingProposed = proposal === undefined && proposalMissing === undefined;
  // Selected means what it opens is already showing, so there is nothing to offer.
  const openable = onSelect !== undefined && !selected;
  const classes = [
    "gate-row",
    "gate-row-" + (decision ?? "note"),
    caption ? "gate-row-captioned" : null,
    nothingProposed ? "gate-row-unproposed" : null,
    fresh ? "gate-row-fresh" : null,
    selected ? "gate-row-selected" : null,
    openable ? "gate-row-open" : null,
  ].filter(Boolean).join(" ");
  const proposalBody = proposal !== undefined
    ? <Foreign preformatted>{proposal}</Foreign>
    : proposalMissing !== undefined && <span className="gate-missing">{proposalMissing}</span>;
  return (
    <li className={classes} onClick={openable ? (event) => openRow(event.target, onSelect) : undefined}>
      <div className="gate-proposal">
        {caption && <div className="gate-caption">{caption}</div>}
        {proposalBody}
        {openable && <button type="button" className="gate-open" aria-label={selectLabel}>Show task</button>}
      </div>
      <div className="gate-axis">
        <span className="gate-link" />
        <span className="gate-node">
          {decision !== null && <DecisionGlyph decision={decision} size={decision === "block" ? 24 : 15} />}
        </span>
      </div>
      <div className="gate-decision">
        <div className="gate-verdict">
          {decision === null
            ? <span className="gate-note-word">{decisionLabel}</span>
            : <span className={"decision decision-" + decision}>{decisionLabel ?? DECISION_WORDS[decision]}</span>}
          {time && <time className="gate-time">{time}</time>}
        </div>
        {reason && <div className="gate-reason">{reason}</div>}
        {actions && <div className="gate-actions">{actions}</div>}
      </div>
    </li>
  );
}
