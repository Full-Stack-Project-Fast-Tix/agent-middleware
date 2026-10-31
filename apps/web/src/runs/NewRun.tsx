import { useEffect, useState } from "react";
import type { Agent, OrchestrationMode } from "@launchpad/shared";
import { ApiError } from "../api";
import { Link, navigate, paths } from "../router";
import { readRecentRuns, rememberRun } from "./routes";
import { runsApi, type WorkspaceSummary } from "./runs-api";

const EXAMPLES = [
  "Add input validation to the checkout endpoint and return 400 on bad input.",
  "Find why the signup test is flaky and fix it.",
];

/** Start a Run: describe the work, choose one agent or let the supervisor plan it. */
export function NewRun() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("auto");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = readRecentRuns();

  useEffect(() => {
    runsApi
      .workspaces()
      .then((list) => {
        setWorkspaces(list);
        setWorkspaceId((current) => current || list[0]?.id || "");
      })
      .catch((reason) => {
        setWorkspaces([]);
        setError(
          reason instanceof ApiError && reason.status === 404
            ? "This server does not offer multi-agent runs yet. For local development, start it with RUNS_DEMO=1."
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
      });
  }, []);

  useEffect(() => {
    setAgents([]);
    setAgentId("");
    if (!workspaceId) return;
    runsApi.agents(workspaceId).then(setAgents).catch(() => setAgents([]));
  }, [workspaceId]);

  const usable = agents.filter((agent) => agent.enabled && agent.archivedAt === null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const run = await runsApi.createRun(workspaceId, {
        userPrompt: prompt.trim(),
        orchestrationMode: mode,
        ...(agentId ? { agentId } : {}),
      });
      rememberRun({ id: run.id, prompt: run.userPrompt, createdAt: run.createdAt });
      navigate(paths.run(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="runs-page">
      <header className="runs-header">
        <div>
          <span className="eyebrow">Runs</span>
          <h1>Start a run</h1>
          <p>Describe the work. A single agent can do it, or a supervisor can split it between specialists.</p>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <form className="new-run-card" onSubmit={submit}>
        {workspaces !== null && workspaces.length > 1 && (
          <label>
            Workspace
            <select aria-label="Workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </label>
        )}
        {workspaces?.length === 1 && (
          <p className="new-run-workspace">
            Workspace <strong>{workspaces[0]!.name}</strong>
          </p>
        )}

        <fieldset className="mode-choice">
          <legend>How should it run?</legend>
          <label className={mode === "auto" ? "selected" : ""}>
            <input type="radio" name="mode" value="auto" checked={mode === "auto"} onChange={() => { setMode("auto"); setAgentId(""); }} />
            <strong>Plan and delegate</strong>
            <span>A supervisor splits the work between specialist agents. Every delegation is checked.</span>
          </label>
          <label className={mode === "single" ? "selected" : ""}>
            <input type="radio" name="mode" value="single" checked={mode === "single"} onChange={() => { setMode("single"); setAgentId(""); }} />
            <strong>One agent</strong>
            <span>A single agent does the whole task.</span>
          </label>
        </fieldset>

        <label>
          {mode === "auto" ? "Supervisor" : "Agent"}
          <select
            aria-label={mode === "auto" ? "Supervisor" : "Agent"}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={usable.length === 0}
          >
            <option value="">Workspace default</option>
            {usable.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}{agent.description ? ` — ${agent.description}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label>
          Task
          <textarea
            aria-label="Task"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the agents do?"
            rows={5}
            maxLength={20_000}
            required
          />
        </label>
        <div className="new-run-examples">
          {EXAMPLES.map((example) => (
            <button type="button" key={example} onClick={() => setPrompt(example)}>↗ {example}</button>
          ))}
        </div>

        <div className="new-run-footer">
          <span>Commands, file changes and delegations all pass the security checks before they run.</span>
          <button className="button button-primary" disabled={busy || !workspaceId || !prompt.trim()}>
            {busy ? "Starting…" : "Start run"}
          </button>
        </div>
      </form>

      {recent.length > 0 && (
        <section className="recent-runs">
          <span className="eyebrow">Started in this browser</span>
          <ul>
            {recent.map((item) => (
              <li key={item.id}>
                <Link to={paths.run(item.id)}>{item.prompt}</Link>
                <span>{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
