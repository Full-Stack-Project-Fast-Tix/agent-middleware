import type { RunTimeline, RunTimelineEntry, SecurityDecisionOutcome, TimelineProposal } from "@launchpad/shared";

// What the gate line and the file list say about a saved decision. Pure, so it
// is tested without a DOM. See the contract's notes in packages/shared/src/api.ts.
//
// `proposed` is the only agent-authored field. A missing one is said out loud,
// never left blank, and an allowed file is never described as changed.

export interface Names {
  task: (taskId: string) => string;
  /** A planner wrote this task's title, so it is shown as foreign material. */
  writtenByPlan: (taskId: string) => boolean;
  agent: (agentId: string) => string;
}

export interface GateEntryView {
  /** Trusted line above the proposal. */
  caption: string;
  /** A handoff's tasks and size, for the caption. Task titles are not trusted text. */
  handoff: { fromTaskId: string; toTaskId: string; characters: number } | null;
  /** What the agent proposed. Render as foreign material. */
  proposal: string | null;
  /** Trusted statement of what was not saved. */
  missing: string | null;
  /** Null when no decision took effect, so no decision mark is true. */
  decision: SecurityDecisionOutcome | null;
  decisionLabel: string | undefined;
  /** Trusted facts after the reason. */
  notes: string[];
  /** Set when this row is waiting for a person's answer. */
  heldApprovalId: string | null;
}

const OBSERVED = "Noticed in the agent's activity";

const ACTION_CAPTIONS: Readonly<Record<string, { caption: string; missing: string }>> = {
  command: { caption: "Command", missing: "The command text was not saved." },
  file_change: { caption: "File change", missing: "The file list was not saved." },
  delegation: { caption: "Delegation", missing: "The delegation details were not saved." },
  context_handoff: { caption: "Context handoff", missing: "The handoff details were not saved." },
};

function fileLine(file: { path: string; kind: string; movePath: string | null }): string {
  return file.movePath === null ? `${file.kind} ${file.path}` : `${file.kind} ${file.path} to ${file.movePath}`;
}

function describeProposal(proposed: TimelineProposal, names: Names): Pick<GateEntryView, "caption" | "proposal"> {
  switch (proposed.type) {
    case "command":
      return {
        caption: "Command",
        proposal: proposed.cwd === null ? proposed.command : `${proposed.command}\nin ${proposed.cwd}`,
      };
    case "file_change":
      return {
        caption: proposed.filesTotal > proposed.files.length
          ? `File change, ${proposed.files.length} of ${proposed.filesTotal} files shown`
          : "File change",
        proposal: proposed.files.map(fileLine).join("\n"),
      };
    case "delegation":
      return {
        caption: `Delegation to ${names.agent(proposed.targetAgentId)}`,
        proposal: `${proposed.title}\n${proposed.objective}`,
      };
    case "context_handoff":
      return {
        caption: "Context handoff",
        proposal: null,
      };
  }
}

/** A held action, or one whose run ended before an answer took effect. */
function isHeld(entry: Pick<RunTimelineEntry, "decision" | "approval">): boolean {
  return entry.decision === "require_approval" && entry.approval?.status === "pending";
}

const APPROVAL_NOTES: Readonly<Record<string, { word: string; note: string }>> = {
  approved: { word: "approved", note: "Approved by a person." },
  denied: { word: "denied", note: "Denied by a person." },
  timed_out: { word: "timed out", note: "Nobody answered in time." },
};

/** A held action whose answer is in but whose final decision is not saved yet. */
const ANSWER_RECORDED: Readonly<Record<string, { label: string; note: string }>> = {
  approved: { label: "Approved", note: "The answer was recorded and the action is continuing." },
  denied: { label: "Denied", note: "The answer was recorded. The action will not run." },
  timed_out: { label: "Timed out", note: "Nobody answered in time. The action will not run." },
  cancelled: { label: "Cancelled", note: "The request was cancelled. The action will not run." },
};
const AWAITING_REQUEST = { label: "Waiting", note: "The approval request has not been saved yet." };

/** Who answered, unless the decision's reason already says it. */
function approvalNote(entry: RunTimelineEntry): string | null {
  if (entry.decision === "require_approval" || !entry.approval) return null;
  const known = APPROVAL_NOTES[entry.approval.status];
  return known === undefined || entry.reason.toLowerCase().includes(known.word) ? null : known.note;
}

function stopNote(entry: RunTimelineEntry): string | null {
  if (entry.stop === "execution") return "This stopped the agent's attempt.";
  if (entry.stop === "action") return "This stopped the action.";
  return null;
}

export function describeEntry(entry: RunTimelineEntry, names: Names, runEnded = true): GateEntryView {
  const action = entry.actionType === null ? null : ACTION_CAPTIONS[entry.actionType];
  const shown = entry.proposed === null
    ? { caption: action?.caption ?? OBSERVED, proposal: null }
    : describeProposal(entry.proposed, names);
  const caption = entry.source === "observed" && shown.caption !== OBSERVED
    ? `${shown.caption}, noticed in the agent's activity`
    : shown.caption;
  const missing = entry.proposed === null ? (action?.missing ?? "The action's details were not saved.") : null;
  const notes = [approvalNote(entry), stopNote(entry)].filter((note): note is string => note !== null);
  const handoff = entry.proposed?.type === "context_handoff"
    ? { fromTaskId: entry.proposed.fromTaskId, toTaskId: entry.proposed.toTaskId, characters: entry.proposed.characters }
    : null;

  if (isHeld(entry)) {
    return {
      caption,
      handoff,
      proposal: shown.proposal,
      missing,
      decision: "require_approval",
      decisionLabel: "Held for your approval",
      notes,
      heldApprovalId: entry.approval!.id,
    };
  }
  if (entry.decision === "require_approval" && !runEnded) {
    const recorded = (entry.approval && ANSWER_RECORDED[entry.approval.status]) || AWAITING_REQUEST;
    return {
      caption,
      handoff,
      proposal: shown.proposal,
      missing,
      decision: null,
      decisionLabel: recorded.label,
      notes: [recorded.note, ...notes],
      heldApprovalId: null,
    };
  }
  if (entry.decision === "require_approval") {
    return {
      caption,
      handoff,
      proposal: shown.proposal,
      missing,
      decision: null,
      decisionLabel: "Did not run",
      notes: ["The run ended before an answer took effect.", ...notes],
      heldApprovalId: null,
    };
  }
  return { caption, handoff, proposal: shown.proposal, missing, decision: entry.decision, decisionLabel: undefined, notes, heldApprovalId: null };
}

/**
 * What each held action proposes, by approval id. An action is only answerable
 * away from its gate row when this says what is being answered.
 */
export function heldProposals(entries: readonly RunTimelineEntry[], names: Names): ReadonlyMap<string, string> {
  const held = new Map<string, string>();
  for (const entry of entries) {
    const view = describeEntry(entry, names);
    if (view.heldApprovalId !== null && view.proposal !== null) held.set(view.heldApprovalId, view.proposal);
  }
  return held;
}

export interface FileDecisionView {
  /** Null when no decision took effect. */
  decision: SecurityDecisionOutcome | null;
  label: string;
}

/** Allowed means the gate permitted the change. It does not show the change landed. */
export function describeFileDecision(
  item: RunTimeline["fileChanges"]["items"][number],
  entries: readonly RunTimelineEntry[],
  runEnded = true,
): FileDecisionView {
  switch (item.decision) {
    case "allow":
      return { decision: "allow", label: "Allowed by the gate" };
    case "steer":
      return { decision: "steer", label: "Steered" };
    case "block":
      return { decision: "block", label: "Blocked" };
    case "require_approval": {
      const entry = entries.find((candidate) => candidate.id === item.entryId);
      if (entry !== undefined && isHeld(entry)) return { decision: "require_approval", label: "Held" };
      if (runEnded) return { decision: null, label: "Did not run" };
      return { decision: null, label: ((entry?.approval && ANSWER_RECORDED[entry.approval.status]) || AWAITING_REQUEST).label };
    }
  }
}

/** Plain statements of what the file list cannot show. Empty when it is complete. */
export function fileListLimits(fileChanges: RunTimeline["fileChanges"]): string[] {
  const limits: string[] = [];
  if (fileChanges.truncated) limits.push("More files were proposed than are listed here.");
  if (fileChanges.entriesWithoutFileList > 0) {
    limits.push(
      fileChanges.entriesWithoutFileList === 1
        ? "1 file change has no saved file list, so its files are missing here."
        : `${fileChanges.entriesWithoutFileList} file changes have no saved file list, so their files are missing here.`,
    );
  }
  if (fileChanges.allowedCommands > 0) {
    limits.push(
      fileChanges.allowedCommands === 1
        ? "1 command was allowed to run. Any files it changed are not listed."
        : `${fileChanges.allowedCommands} commands were allowed to run. Any files they changed are not listed.`,
    );
  }
  return limits;
}

/**
 * Entries that arrived after the first load, added to those already marked. Ids
 * stay marked, so a row's mark draws once and does not redraw on a later refetch.
 */
export function freshEntryIds(
  known: ReadonlySet<string> | null,
  fresh: ReadonlySet<string>,
  entries: readonly Pick<RunTimelineEntry, "id">[],
): ReadonlySet<string> {
  if (known === null) return fresh;
  const arrived = entries.filter((entry) => !known.has(entry.id));
  return arrived.length === 0 ? fresh : new Set([...fresh, ...arrived.map((entry) => entry.id)]);
}
