import type { Approval } from "@launchpad/shared";
import { Button, Foreign, ForeignInline } from "../ui";
import { approvalEvidence, approvalOutcomeText, type ApprovalEvidence } from "./approval-evidence";

/**
 * Why an action was held and exactly what was proposed. The server's reason and
 * the hold category are trusted; the proposal is agent-written and shown as
 * foreign material. When the proposal is missing, say so plainly.
 */
export function ApprovalEvidenceView({ approval, evidence = approvalEvidence(approval), compact = false }: {
  approval: Pick<Approval, "id" | "actionType" | "reason" | "safeDetails" | "summary" | "status">;
  evidence?: ApprovalEvidence;
  /** A shorter block for the held strip at the top of Run Detail. */
  compact?: boolean;
}) {
  const height = compact ? 120 : 240;
  return (
    <div className="approval-evidence" id={`approval-evidence-${approval.id}`}>
      <p className="approval-evidence-why">
        <strong>Why it was held:</strong> {evidence.holdReason} <span className="meta">{approval.summary}</span>
      </p>
      {approval.status !== "pending" && <p className="meta">{approvalOutcomeText(approval.status)}</p>}
      {evidence.missing !== null ? (
        <p className="notice notice-held">{evidence.missing}</p>
      ) : (
        <>
          {evidence.complete === false && (
            <p className="meta">
              Only part of this proposal is shown. Approving lets the whole action run, and the final review will not count this
              approval as covering changes outside the request.
            </p>
          )}
          {evidence.complete === null && <p className="meta">This approval does not say whether its proposal is complete.</p>}
          <ul className="approval-evidence-parts">
            {evidence.parts.map((part, index) => (
              <li key={index}>
                {part.kind === "command" && (
                  <Foreign label="Command" note={part.cwd === null ? undefined : <>in <ForeignInline>{part.cwd}</ForeignInline></>} preformatted maxHeight={height}>
                    {part.text}
                  </Foreign>
                )}
                {part.kind === "file" && (
                  <>
                    <p className="approval-evidence-file">
                      {part.change.charAt(0).toUpperCase() + part.change.slice(1)} <ForeignInline>{part.path}</ForeignInline>
                      {part.movePath !== null && <> to <ForeignInline>{part.movePath}</ForeignInline></>}
                    </p>
                    {part.diff === null ? (
                      <p className="meta">The proposed content was not saved for this file.</p>
                    ) : (
                      <Foreign label="Proposed content" note={part.diffComplete === false ? "Excerpt: the rest is not shown" : undefined} preformatted maxHeight={height}>
                        {part.diff === "" ? "(empty)" : part.diff}
                      </Foreign>
                    )}
                  </>
                )}
                {part.kind === "text" && (
                  <Foreign label={part.label} note={part.complete === false ? "Excerpt: the rest is not shown" : undefined} preformatted maxHeight={height}>
                    {part.text}
                  </Foreign>
                )}
                {part.kind === "fact" && <p className="meta">{part.text}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Approve and Deny for a pending approval. Approve stays off when nobody can see what it would allow. */
export function ApprovalActions({ approval, evidence = approvalEvidence(approval), busy, onAnswer, label }: {
  approval: Pick<Approval, "id" | "actionType" | "reason" | "safeDetails" | "summary">;
  evidence?: ApprovalEvidence;
  busy: boolean;
  onAnswer: (decision: "approve" | "deny") => void;
  /** Names the action for screen readers when several sit together. */
  label?: string;
}) {
  const describedBy = evidence.canApprove ? undefined : `approval-evidence-${approval.id}`;
  return (
    <div className="cluster approval-actions">
      <Button
        variant="primary"
        busy={busy}
        disabled={!evidence.canApprove}
        aria-describedby={describedBy}
        aria-label={label === undefined ? undefined : `Approve: ${label}`}
        onClick={() => {
          if (evidence.canApprove) onAnswer("approve");
        }}
      >
        Approve
      </Button>
      <Button variant="danger" disabled={busy} aria-label={label === undefined ? undefined : `Deny: ${label}`} onClick={() => onAnswer("deny")}>
        Deny
      </Button>
    </div>
  );
}
