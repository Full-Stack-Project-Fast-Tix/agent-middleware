import { useState } from "react";
import { APPROVAL_STATUSES, mayAnswerApproval, type ApprovalQueueItem, type ApprovalStatus, type WorkspaceSummary } from "@launchpad/shared";
import { formatWhen, humanize } from "../runs/format";
import { runsApi } from "../runs/runs-api";
import { announceApprovalsChanged } from "../runs/useRunList";
import { Link, paths } from "../router";
import { approvalBadgeStatus, Button, EmptyState, ErrorState, ForeignInline, Loading, Select, StatusBadge } from "../ui";
import { ApprovalActions, ApprovalEvidenceView } from "../runs/ApprovalEvidence";
import { approvalEvidence } from "../runs/approval-evidence";
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
  const evidence = approvalEvidence(approval);
  return (
    <li className="config-card">
      <div className="config-card-head">
        <strong>{humanize(approval.actionType)} held: {humanize(approval.reason)}</strong>
        <StatusBadge status={approvalBadgeStatus(approval.status)} />
      </div>
      <p className="meta">
        Requested {formatWhen(approval.requestedAt)}.
        {approval.taskTitle !== null && <> Task: <ForeignInline>{approval.taskTitle}</ForeignInline>.</>} <Link to={paths.run(approval.runId)}>Open the run</Link>
      </p>
      <ApprovalEvidenceView approval={approval} evidence={evidence} />
      {approval.status === "pending" && (canAnswer ? (
        <ApprovalActions approval={approval} evidence={evidence} busy={busy} onAnswer={onAnswer} />
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
      <p className="members-readonly">An approval covers this exact proposed action only. It does not approve other or later changes, does not confirm the action is safe, and cannot override a mandatory restriction. Approve stays off when the proposal was not saved.</p>
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
