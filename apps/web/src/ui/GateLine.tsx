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
        <div className="gate-cell gate-cell-proposal">{proposalHeading}</div>
        <div className="gate-axis" />
        <div className="gate-cell gate-cell-decision">{decisionHeading}</div>
      </li>
      {children}
    </ol>
  );
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
  const classes = ["gate-row", fresh ? "gate-row-fresh" : null, selected ? "gate-row-selected" : null].filter(Boolean).join(" ");
  const proposalBody = proposal !== undefined
    ? <Foreign preformatted>{proposal}</Foreign>
    : proposalMissing !== undefined && <span className="gate-missing">{proposalMissing}</span>;
  return (
    <li className={classes}>
      <div className="gate-cell gate-cell-proposal gate-proposal">
        {caption && <span className="meta">{caption}</span>}
        {onSelect ? (
          <button type="button" className="gate-open" onClick={onSelect} aria-label={selectLabel} aria-pressed={selected}>
            {proposalBody}
          </button>
        ) : proposalBody}
      </div>
      <div className="gate-axis">
        {decision === null ? <span className="gate-axis-dot" /> : <DecisionGlyph decision={decision} size={20} />}
      </div>
      <div className="gate-cell gate-cell-decision gate-decision">
        {decision === null
          ? <span>{decisionLabel}</span>
          : <span className={"decision decision-" + decision}>{decisionLabel ?? DECISION_WORDS[decision]}</span>}
        {reason && <span className="gate-reason">{reason}</span>}
        {time && <time className="gate-time">{time}</time>}
        {actions && <div className="gate-actions">{actions}</div>}
      </div>
    </li>
  );
}
