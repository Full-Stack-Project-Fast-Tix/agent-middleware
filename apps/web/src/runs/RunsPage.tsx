import { useState, type ReactNode } from "react";
import { RUN_STATUSES, type RunStatus, type RunSummary } from "@launchpad/shared";
import { Link, navigate, paths, type Route } from "../router";
import { Button, ButtonLink, DataTable, EmptyState, ErrorState, Loading, PageHeader, Select, StatusBadge } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { formatWhen } from "./format";
import { NewRun } from "./NewRun";
import { RunDetail } from "./RunDetail";
import { statusFromSearch } from "./run-list";
import { isRunActive } from "./run-view";
import { useRunList } from "./useRunList";

const STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  waiting_approval: "Held",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The columns the Dashboard and the Runs page share. */
export function RunsTable({ caption, runs }: { caption: string; runs: readonly RunSummary[] }) {
  return (
    <DataTable caption={caption}>
      <thead>
        <tr>
          <th>Task</th>
          <th>Status</th>
          <th>Tasks</th>
          <th>Held</th>
          <th>Findings</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const active = isRunActive(run.status);
          return (
            <tr key={run.id} className="run-row">
              <td className="cell-prompt"><Link to={paths.run(run.id)}>{run.userPrompt}</Link></td>
              <td>
                <span className="cluster run-row-status">
                  <StatusBadge status={run.status} live={active} />
                  {run.cancelRequestedAt !== null && active && <span className="meta">Cancelling</span>}
                </span>
              </td>
              <td className="num">{run.taskCount}</td>
              <td className={"num" + (run.pendingApprovalCount > 0 ? " count-held" : "")}>{run.pendingApprovalCount}</td>
              <td className="num">{run.findingCount}</td>
              <td className="num">{formatWhen(run.startedAt ?? run.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

/** Shared by the pages that need a workspace before they can ask for anything. */
export function WorkspaceRequired({ children }: { children: (workspaceId: string) => ReactNode }) {
  const { workspaces, current, error, reload } = useCurrentWorkspace();
  if (error !== null) return <ErrorState title="Your workspaces did not load" message={error} onRetry={reload} />;
  if (workspaces === null) return <Loading label="Loading your workspaces" />;
  if (current === null) {
    return (
      <EmptyState title="You are not in a workspace yet">
        Ask your platform operator to add you to one. Runs belong to a workspace.
      </EmptyState>
    );
  }
  return <>{children(current.id)}</>;
}

function RunsList({ workspaceId, status, onClearFilter }: {
  workspaceId: string;
  status: RunStatus | null;
  onClearFilter: () => void;
}) {
  const { list, error, loadingMore, loadMore, refresh } = useRunList(workspaceId, { limit: 50, status: status ?? undefined });

  if (list === null) {
    return error !== null
      ? <ErrorState title="The runs did not load" message={error} onRetry={() => void refresh()} />
      : <Loading label="Loading runs" />;
  }
  if (list.runs.length === 0) {
    return status !== null ? (
      <EmptyState
        title={`No runs with the status ${STATUS_LABELS[status]}`}
        action={<Button onClick={onClearFilter}>Show all runs</Button>}
      >
        Runs in other statuses are still in this workspace.
      </EmptyState>
    ) : (
      <EmptyState
        title="No runs in this workspace yet"
        action={<ButtonLink to={paths.newRun} variant="primary">Start a run</ButtonLink>}
      >
        Start a run to follow its tasks and answer what it asks for.
      </EmptyState>
    );
  }
  return (
    <>
      {error !== null && <p className="notice notice-held" role="alert">This list stopped updating: {error}</p>}
      <RunsTable caption="Runs in this workspace" runs={list.runs} />
      {list.nextCursor !== null && (
        <div><Button busy={loadingMore} onClick={() => void loadMore()}>Show more runs</Button></div>
      )}
    </>
  );
}

function RunsIndex() {
  const [status, setStatus] = useState<RunStatus | null>(() => statusFromSearch(window.location.search));
  const choose = (next: RunStatus | null) => {
    setStatus(next);
    navigate(next === null ? paths.runs : `${paths.runs}?status=${next}`, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        title="Runs"
        description="Every run in this workspace, newest first."
        actions={<ButtonLink to={paths.newRun} variant="primary" page>Start a run</ButtonLink>}
      />
      <div>
        <Select
          label="Status"
          inlineLabel
          value={status ?? ""}
          onChange={(next) => choose(statusFromSearch(`?status=${next}`))}
          options={[
            { value: "", label: "All statuses" },
            ...RUN_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
          ]}
        />
      </div>
      <WorkspaceRequired>
        {(workspaceId) => <RunsList workspaceId={workspaceId} status={status} onClearFilter={() => choose(null)} />}
      </WorkspaceRequired>
    </div>
  );
}

type RunsRoute = Extract<Route, { page: "runs" | "new-run" | "run" }>;

/** `/runs` lists, `/runs/new` starts a Run, `/runs/<id>` follows one. */
export function RunsPage({ route }: { route: RunsRoute }) {
  if (route.page === "run") return <RunDetail key={route.runId} runId={route.runId} />;
  if (route.page === "new-run") return <NewRun />;
  return <RunsIndex />;
}
