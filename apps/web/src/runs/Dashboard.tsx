import { Link, paths } from "../router";
import { ButtonLink, DataTable, DecisionGlyph, EmptyState, ErrorState, Loading, PageHeader } from "../ui";
import { formatWhen } from "./format";
import { RunsTable, WorkspaceRequired } from "./RunsPage";
import { useRunList } from "./useRunList";

const PAGE = 20;

/** Runs a person has to answer. Absent when there are none, so its presence means something. */
function WaitingOnYou({ workspaceId }: { workspaceId: string }) {
  const { list } = useRunList(workspaceId, { limit: PAGE, status: "waiting_approval" });
  if (list === null || list.runs.length === 0) return null;
  return (
    <section className="page-section waiting-on-you" aria-labelledby="waiting-heading">
      <h2 id="waiting-heading" className="waiting-heading">
        <DecisionGlyph decision="require_approval" />
        Waiting on you
      </h2>
      <DataTable caption="Runs waiting on a decision">
        <thead>
          <tr><th>Task</th><th>Held</th><th className="waiting-started">Started</th><th><span className="sr-only">Open</span></th></tr>
        </thead>
        <tbody>
          {list.runs.map((run) => (
            <tr key={run.id} className="run-row">
              <td className="cell-prompt"><Link to={paths.run(run.id)}>{run.userPrompt}</Link></td>
              <td className="num count-held">{run.pendingApprovalCount}</td>
              <td className="num waiting-started">{formatWhen(run.startedAt ?? run.createdAt)}</td>
              <td className="cell-action"><ButtonLink to={paths.run(run.id)} variant="primary">Review</ButtonLink></td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {list.nextCursor !== null && (
        <p className="see-all"><Link to={`${paths.runs}?status=waiting_approval`}>See every run that is held</Link></p>
      )}
    </section>
  );
}

function RecentRuns({ workspaceId }: { workspaceId: string }) {
  const { list, error, refresh } = useRunList(workspaceId, { limit: PAGE });
  if (list === null) {
    return error !== null
      ? <ErrorState title="The runs did not load" message={error} onRetry={() => void refresh()} />
      : <Loading label="Loading runs" />;
  }
  if (list.runs.length === 0) {
    return (
      <EmptyState
        title="No runs in this workspace yet"
        action={<ButtonLink to={paths.newRun} variant="primary">Start a run</ButtonLink>}
      >
        Start a run to follow its tasks and answer what it asks for.
      </EmptyState>
    );
  }
  return (
    <section className="page-section" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent runs</h2>
      {error !== null && <p className="notice notice-held" role="alert">This list stopped updating: {error}</p>}
      <RunsTable caption="Recent runs" runs={list.runs} />
      {list.nextCursor !== null && <p className="see-all"><Link to={paths.runs}>See all runs</Link></p>}
    </section>
  );
}

export function Dashboard() {
  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="What needs a decision now, and what ran recently in this workspace."
        actions={<ButtonLink to={paths.newRun} variant="primary" page>Start a run</ButtonLink>}
      />
      <WorkspaceRequired>
        {(workspaceId) => (
          <>
            <WaitingOnYou workspaceId={workspaceId} />
            <RecentRuns workspaceId={workspaceId} />
          </>
        )}
      </WorkspaceRequired>
    </div>
  );
}
