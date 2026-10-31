import { useState } from "react";
import { APPROVAL_STATUSES, mayAnswerApproval, type ApprovalQueueItem, type ApprovalStatus, type WorkspaceSummary } from "@launchpad/shared";
import { formatWhen, humanize } from "../runs/format";
import { runsApi } from "../runs/runs-api";
import { announceApprovalsChanged } from "../runs/useRunList";
import { Link, paths } from "../router";
import { approvalBadgeStatus, Button, EmptyState, ErrorState, Foreign, Loading, Select, StatusBadge } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { ChangeError, useChange, usePaged, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

const STATUS_OPTIONS = APPROVAL_STATUSES.map((status) => ({ value: status, label: humanize(status) }));

function ApprovalCard({ approval, canAnswer, onAnswer, busy }: {
  approval: ApprovalQueueItem;
  canAnswer: boolean;
  onAnswer: (decision: "approve" | "deny") => void;
  busy: boolean;
}) {
  return (
    <li className="config-card">
      <div className="config-card-head">
        <strong>{approval.summary}</strong>
        <StatusBadge status={approvalBadgeStatus(approval.status)} />
      </div>
      <p className="meta">
        {humanize(approval.actionType)}. {humanize(approval.reason)}. Requested {formatWhen(approval.requestedAt)}.
        {approval.taskTitle !== null && <> Task: {approval.taskTitle}.</>} <Link to={paths.run(approval.runId)}>Open the run</Link>
      </p>
      {approval.safeDetails !== null && (
        <Foreign label="What the agent proposed" preformatted maxHeight={160}>{JSON.stringify(approval.safeDetails, null, 2)}</Foreign>
      )}
      {approval.status === "pending" && (canAnswer ? (
        <div className="cluster">
          <Button variant="primary" busy={busy} onClick={() => onAnswer("approve")}>Approve</Button>
          <Button variant="danger" disabled={busy} onClick={() => onAnswer("deny")}>Deny</Button>
        </div>
      ) : (
        <p className="meta">{approval.reason === "policy_required" ? "A Security Admin answers this." : "The person who started this run answers this."}</p>
      ))}
    </li>
  );
}

function Approvals({ workspace }: { workspace: WorkspaceSummary }) {
  const { viewerId } = useCurrentWorkspace();
  const [status, setStatus] = useState<ApprovalStatus>("pending");
  const list = usePaged(`${workspace.id}:${status}`, (cursor) =>
    workspaceApi.approvals(workspace.id, { status, ...(cursor === undefined ? {} : { cursor }) }),
  );
  const change = useChange(async () => {
    announceApprovalsChanged();
    await list.reload();
  });

  return (
    <>
      <p className="members-readonly">An approval covers this proposed action only. It does not approve the rest of the Run or confirm that the action is safe.</p>
      <div className="config-filters">
        <Select label="Status" inlineLabel value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </div>
      <ChangeError message={change.error} />
      {list.items === null ? (
        list.error !== null ? <ErrorState message={list.error} onRetry={() => void list.reload()} /> : <Loading label="Loading approvals" />
      ) : list.items.length === 0 ? (
        <EmptyState title={status === "pending" ? "Nothing is waiting for an answer" : `No ${humanize(status).toLowerCase()} approvals`}>
          Actions the middleware holds for a person appear here.
        </EmptyState>
      ) : (
        <ul className="config-cards">
          {list.items.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              busy={change.busy}
              canAnswer={viewerId !== null && mayAnswerApproval({
                role: workspace.role,
                userId: viewerId,
                runCreatedByUserId: approval.runCreatedByUserId,
                reason: approval.reason,
              })}
              onAnswer={(decision) => void change.run(() => runsApi.resolveApproval(approval.id, decision))}
            />
          ))}
        </ul>
      )}
      {list.hasMore && <p className="see-all"><Button busy={list.loadingMore} onClick={() => void list.loadMore()}>Load more</Button></p>}
    </>
  );
}

export function ApprovalsPage() {
  return (
    <WorkspacePage title="Approvals" description="Actions held for a person across every run in this workspace, and what was decided.">
      {(workspace) => <Approvals workspace={workspace} />}
    </WorkspacePage>
  );
}
