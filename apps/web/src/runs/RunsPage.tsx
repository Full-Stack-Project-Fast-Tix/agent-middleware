import { Link, paths, type Route } from "../router";
import { ButtonLink, DataTable, EmptyState, PageHeader } from "../ui";
import { NewRun } from "./NewRun";
import { RunDetail } from "./RunDetail";
import { readRecentRuns } from "./routes";

/**
 * Runs started in this browser. There is no list-runs route in the contract yet,
 * so this says plainly what it covers rather than posing as the workspace's list.
 */
export function RunsHome({ title }: { title: string }) {
  const recent = readRecentRuns();
  return (
    <div className="page">
      <PageHeader
        title={title}
        description="Runs started in this browser. Runs started elsewhere are not listed yet."
        actions={<ButtonLink to={paths.newRun} variant="primary" page>Start a run</ButtonLink>}
      />
      {recent.length === 0 ? (
        <EmptyState title="No runs from this browser yet">
          Start a run to follow its tasks and approve what it asks for.
        </EmptyState>
      ) : (
        <DataTable caption="Runs started in this browser">
          <thead>
            <tr><th>Task</th><th>Started</th></tr>
          </thead>
          <tbody>
            {recent.map((item) => (
              <tr key={item.id}>
                <td className="cell-prompt"><Link to={paths.run(item.id)}>{item.prompt}</Link></td>
                <td className="num">{new Date(item.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

type RunsRoute = Extract<Route, { page: "runs" | "new-run" | "run" }>;

/** `/runs` lists, `/runs/new` starts a Run, `/runs/<id>` follows one. */
export function RunsPage({ route }: { route: RunsRoute }) {
  if (route.page === "run") return <RunDetail key={route.runId} runId={route.runId} />;
  if (route.page === "new-run") return <NewRun />;
  return <RunsHome title="Runs" />;
}
