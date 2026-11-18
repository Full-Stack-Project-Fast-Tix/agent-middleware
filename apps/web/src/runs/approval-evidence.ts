import type { Approval, ApprovalStatus } from "@launchpad/shared";

// What an approver needs before answering: the exact proposal that was held,
// and why. The saved details are redacted and bounded by the server; anything
// in them was written by an agent, so it is shown as foreign material. An
// approval with no saved proposal cannot be approved here, since nobody can see
// what they would allow. The server refuses it too.

export type ProposalPart =
  | { kind: "command"; text: string; cwd: string | null }
  | { kind: "file"; path: string; change: string; movePath: string | null; diff: string | null; diffComplete: boolean | null }
  | { kind: "text"; label: string; text: string; complete: boolean | null }
  | { kind: "fact"; text: string };

export interface ApprovalEvidence {
  /** Whether Approve may be offered. Deny is always offered for a pending approval. */
  canApprove: boolean;
  /** Plain words for why the action was held. */
  holdReason: string;
  /** True when the saved details say they are the whole proposal; null when they do not say (older approvals). */
  complete: boolean | null;
  parts: ProposalPart[];
  /** Said instead of the proposal when it cannot be shown. */
  missing: string | null;
}

const HOLD_REASONS: Record<Approval["reason"], string> = {
  semantic_uncertainty: "The semantic reviewer judged that this may conflict with the request, below the level it declines on its own.",
  semantic_unavailable: "Semantic review could not cover all of this action, so a person decides.",
  high_consequence: "This command can reach outside the Run's copy, so a person decides.",
  policy_required: "Workspace policy requires a person to approve this kind of action.",
};

export function approvalEvidence(approval: Pick<Approval, "actionType" | "reason" | "safeDetails">): ApprovalEvidence {
  const holdReason = HOLD_REASONS[approval.reason] ?? "A person must decide this action.";
  const details = approval.safeDetails;
  if (details === null) {
    return {
      canApprove: false,
      holdReason,
      complete: null,
      parts: [],
      missing: "The proposal was not saved, so it cannot be approved. Deny it, or let it time out.",
    };
  }
  const complete = typeof details.complete === "boolean" ? details.complete : null;
  const parts: ProposalPart[] = [];
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  switch (approval.actionType) {
    case "command": {
      const command = text(details.command);
      if (command !== null) parts.push({ kind: "command", text: command, cwd: text(details.cwd) });
      break;
    }
    case "file_change": {
      const files = Array.isArray(details.files) ? details.files : [];
      for (const file of files) {
        if (file === null || typeof file !== "object") continue;
        const entry = file as Record<string, unknown>;
        const path = text(entry.path);
        if (path === null) continue;
        const kind = entry.kind !== null && typeof entry.kind === "object" ? text((entry.kind as Record<string, unknown>).type) : text(entry.kind);
        parts.push({
          kind: "file",
          path,
          change: kind ?? "change",
          movePath: text(entry.movePath),
          diff: text(entry.diff),
          diffComplete: typeof entry.diffComplete === "boolean" ? entry.diffComplete : null,
        });
      }
      if (typeof details.filesTotal === "number" && details.filesTotal > parts.length) {
        parts.push({ kind: "fact", text: `${details.filesTotal - parts.length} more files are not listed.` });
      }
      break;
    }
    case "delegation": {
      const title = text(details.title);
      const objective = text(details.objective);
      if (title !== null) parts.push({ kind: "text", label: "Task title", text: title, complete: null });
      if (objective !== null) parts.push({ kind: "text", label: "Objective", text: objective, complete });
      break;
    }
    case "context_handoff": {
      const excerpt = text(details.excerpt);
      if (excerpt !== null) parts.push({ kind: "text", label: "Handoff content", text: excerpt, complete });
      else if (typeof details.characters === "number") parts.push({ kind: "fact", text: `A handoff of ${details.characters} characters; its content was not saved.` });
      break;
    }
  }
  // A count or a note is not the proposal: approving on it alone would be blind.
  if (!parts.some((part) => part.kind !== "fact")) {
    return { canApprove: false, holdReason, complete, parts, missing: "The saved details do not show the proposal itself, so it cannot be approved. Deny it, or let it time out." };
  }
  return { canApprove: true, holdReason, complete, parts, missing: null };
}

/** What an answered approval did, in the gate's honest words. */
export function approvalOutcomeText(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "Held: the action has not run.";
    case "approved":
      return "Approved: this one action was allowed to run. It does not approve other changes.";
    case "denied":
      return "Denied: the action did not run.";
    case "timed_out":
      return "Timed out: nobody answered in time, so the action did not run.";
    case "cancelled":
      return "Cancelled with the Run: the action did not run.";
  }
}
