import type { RunTimeline as RunTimelineData } from "@launchpad/shared";
import { Button, DataTable, DecisionMark, EmptyState, ErrorState, ForeignInline, GateLine, GateRow, Loading, SeverityBadge } from "../ui";
import { formatClock, humanize } from "./format";
import { describeEntry, describeFileDecision, fileListLimits, type Names } from "./timeline-view";

/**
 * The gate line: what agents proposed on one side, what the middleware decided
 * on the other. Saved rows, not the event stream, so it survives a reload.
 */
export function GateTimeline({ timeline, error, onRetry, fresh, active, names, selectedTaskId, onSelectTask, resolvingApprovalId, onResolve }: {
  timeline: RunTimelineData | null;
  error: string | null;
  onRetry: () => void;
  fresh: ReadonlySet<string>;
  active: boolean;
  names: Names;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  resolvingApprovalId: string | null;
  onResolve: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  return (
    <section className="page-section gate-timeline" aria-labelledby="gate-heading">
      <h2 id="gate-heading">Gate timeline</h2>
      {timeline === null ? (
        error !== null
          ? <ErrorState title="The timeline did not load" message={error} onRetry={onRetry} />
          : <Loading label="Loading the timeline" />
      ) : timeline.entries.length === 0 ? (
        <EmptyState title={active ? "Nothing has reached the gate yet" : "Nothing reached the gate in this run"}>
          {active ? "Actions appear here as agents propose them." : "No agent proposed an action the middleware had to decide on."}
        </EmptyState>
      ) : (
        <>
          {error !== null && <p className="list-stale" role="alert">This timeline stopped updating: {error}</p>}
          {timeline.omittedEntries > 0 && (
            <p className="meta">
              {timeline.omittedEntries === 1 ? "1 older decision is" : `${timeline.omittedEntries} older decisions are`} not shown.
            </p>
          )}
          <GateLine>
            {timeline.entries.map((entry) => {
              const row = describeEntry(entry, names);
              const taskId = entry.taskId;
              const taskTitle = taskId === null ? null : names.task(taskId);
              // A handoff's caption already names its tasks.
              const showTask = taskTitle !== null && entry.proposed?.type !== "context_handoff";
              return (
                <GateRow
                  key={entry.id}
                  caption={showTask ? <span className="gate-caption"><span>{row.caption}</span><span>{taskTitle}</span></span> : row.caption}
                  proposal={row.proposal ?? undefined}
                  proposalMissing={row.missing ?? undefined}
                  decision={row.decision}
                  decisionLabel={row.decisionLabel}
                  reason={
                    <>
                      {entry.reason}
                      {row.notes.map((note) => <span key={note} className="gate-note">{note}</span>)}
                      {entry.severity !== null && entry.decision !== "allow" && (
                        <span className="gate-severity"><SeverityBadge severity={entry.severity} /></span>
                      )}
                    </>
                  }
                  time={formatClock(entry.at)}
                  fresh={fresh.has(entry.id)}
                  selected={taskId !== null && taskId === selectedTaskId}
                  onSelect={taskId === null || (row.proposal === null && row.missing === null) ? undefined : () => onSelectTask(taskId)}
                  selectLabel={taskTitle === null ? undefined : `Show task: ${taskTitle}`}
                  actions={row.heldApprovalId === null ? undefined : (
                    <>
                      <Button
                        variant="primary"
                        busy={resolvingApprovalId === row.heldApprovalId}
                        onClick={() => onResolve(row.heldApprovalId!, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={resolvingApprovalId === row.heldApprovalId}
                        onClick={() => onResolve(row.heldApprovalId!, "deny")}
                      >
                        Deny
                      </Button>
                    </>
                  )}
                />
              );
            })}
          </GateLine>
        </>
      )}
    </section>
  );
}

/** Files proposed at the gate. These are proposals: nothing here proves a change landed. */
export function ProposedFiles({ timeline }: { timeline: RunTimelineData }) {
  const { fileChanges, entries } = timeline;
  const limits = fileListLimits(fileChanges);
  return (
    <section className="page-section" aria-labelledby="files-heading">
      <div className="section-copy">
        <h2 id="files-heading">File changes at the gate</h2>
        <p className="meta">Allowed means the gate permitted the change. It does not show the change was applied.</p>
      </div>
      {fileChanges.items.length === 0 ? (
        <p className="meta">No file changes reached the gate.</p>
      ) : (
        <DataTable caption="File changes proposed at the gate">
          <thead>
            <tr><th>File</th><th>Change</th><th>Decision</th><th>Proposed</th></tr>
          </thead>
          <tbody>
            {fileChanges.items.map((item) => {
              const decision = describeFileDecision(item, entries);
              return (
                <tr key={item.entryId + item.path}>
                  <td className="cell-file">
                    <ForeignInline>{item.path}</ForeignInline>
                    {item.movePath !== null && <> to <ForeignInline>{item.movePath}</ForeignInline></>}
                  </td>
                  <td>{humanize(item.kind)}</td>
                  <td className="cell-decision">
                    {decision.decision === null
                      ? <span className="meta">{decision.label}</span>
                      : <DecisionMark decision={decision.decision} label={decision.label} />}
                  </td>
                  <td className="num">{formatClock(item.at)}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      {limits.length > 0 && (
        <ul className="file-limits meta">
          {limits.map((limit) => <li key={limit}>{limit}</li>)}
        </ul>
      )}
    </section>
  );
}
