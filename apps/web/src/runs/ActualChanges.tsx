import type { RunDiffChange, RunDiffResponse } from "@launchpad/shared";
import { ErrorState, Foreign, ForeignInline, Loading } from "../ui";
import type { Loadable } from "./latest-request";
import { changeReasonText, changesSummary, inventoryReasonText } from "./run-receipt";

const KIND_WORDS: Record<RunDiffChange["kind"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  uncertain: "could not be compared",
};

const CONTENT_WORDS: Record<RunDiffChange["content"], string | null> = {
  complete: null,
  partial: "Some of this change is not shown.",
  unavailable: "The contents of this change are not available.",
};

/**
 * What actually changed in the Run's copy, compared with the baseline taken
 * when the copy was made. Separate from what agents proposed at the gate.
 * Says exactly what is unavailable rather than showing an empty or wrong diff.
 */
export function ActualChanges({ diff, onRetry }: { diff: Loadable<RunDiffResponse>; onRetry: () => void }) {
  return (
    <section className="page-section" id="run-changes" aria-labelledby="actual-changes-title">
      <h2 id="actual-changes-title">Actual file changes</h2>
      {diff.status === "error" && <ErrorState title="The change summary did not load" message={diff.message} onRetry={onRetry} />}
      {(diff.status === "loading" || diff.status === "idle") && <Loading label="Loading changes" />}
      {diff.status === "ready" && <DiffBody diff={diff.value} summary={changesSummary(diff)} />}
    </section>
  );
}

function DiffBody({ diff, summary }: { diff: RunDiffResponse; summary: string }) {
  const inventory = diff.coverage.inventory;
  return (
    <>
      <p className="meta">{summary}.</p>
      {diff.version !== 2 && (
        <p className="notice notice-held">This diff was saved by an older version. Its positions and completeness are unknown.</p>
      )}
      {inventory.status !== "complete" && inventory.reasons.length > 0 && diff.version === 2 && (
        <p className="notice notice-held">
          {inventory.status === "unavailable" ? "No comparison was possible" : "The comparison is incomplete"}: {inventoryReasonText(inventory.reasons)}.
          {inventory.status === "incomplete" && " Files outside what the scans reached may have changed without appearing here."}
        </p>
      )}
      {diff.listTruncated && <p className="notice notice-held">More files changed than this list shows.</p>}
      {diff.changes.map((change) => <ChangeEntry key={change.path} change={change} />)}
      <p className="meta">
        Not compared: {diff.scope.excludedDirectories.join(", ")} folders. Files over 2 MB are compared by size only; text diffs cover files up to
        256 KB. Contents are redacted.
      </p>
    </>
  );
}

function ChangeEntry({ change }: { change: RunDiffChange }) {
  const contentNote = CONTENT_WORDS[change.content];
  const reasons = changeReasonText(change.reasons);
  return (
    <details className={"diff-entry" + (change.kind === "uncertain" ? " diff-entry-uncertain" : "")}>
      <summary>
        <ForeignInline>{change.path}</ForeignInline> <span className="meta">{KIND_WORDS[change.kind]}{change.entryType === "symlink" ? " (link)" : ""}</span>
        {change.content !== "complete" && <span className="diff-entry-flag">{change.content === "partial" ? "partly shown" : "not shown"}</span>}
      </summary>
      {(contentNote !== null || reasons.length > 0) && (
        <ul className="diff-entry-notes">
          {contentNote !== null && <li>{contentNote}</li>}
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      {change.hunks.map((hunk, index) => (
        <Foreign
          key={index}
          label={hunk.oldStart === 0 && hunk.newStart === 0 && hunk.oldLines === 0 && hunk.newLines === 0 ? "Change, positions unknown" : `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
          preformatted
          maxHeight={420}
        >
          {hunk.text}
        </Foreign>
      ))}
    </details>
  );
}
