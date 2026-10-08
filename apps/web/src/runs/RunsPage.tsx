import { NewRun } from "./NewRun";
import { RunDetail } from "./RunDetail";
import { useRunsRoute } from "./routes";
import "./runs.css";

/** The Runs surface: `#/runs/new` starts a Run, `#/runs/<id>` follows one. */
export function RunsPage() {
  const route = useRunsRoute();
  if (route?.page === "run") return <RunDetail key={route.runId} runId={route.runId} />;
  return <NewRun />;
}
