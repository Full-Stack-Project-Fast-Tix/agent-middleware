import { useEffect, useState } from "react";
import type { Agent, OrchestrationMode } from "@launchpad/shared";
import { navigate, paths } from "../router";
import { Button, ErrorState, PageHeader, Select } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { runsApi } from "./runs-api";

const EXAMPLES = [
  "Add input validation to the checkout endpoint and return 400 on bad input.",
  "Find why the signup test is flaky and fix it.",
];

/** Start a Run: describe the work, choose one agent or let the supervisor plan it. */
export function NewRun() {
  const { workspaces, current, error: workspacesError, reload } = useCurrentWorkspace();
  const workspaceId = current?.id ?? "";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("auto");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      navigate(paths.run(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader
        title="Start a run"
        description="Describe the work. A single agent can do it, or a supervisor can split it between specialists."
      />

      {workspacesError !== null && <ErrorState title="Your workspaces did not load" message={workspacesError} onRetry={reload} />}
      {error && (
        <div className="notice notice-blocked" role="alert">
          <span>{error}</span>
          <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      )}

      <form className="new-run-form" onSubmit={submit}>
        {current !== null && (
          <p className="new-run-workspace">
            Workspace <strong>{current.name}</strong>
            {workspaces !== null && workspaces.length > 1 && " Switch workspace at the top of the page."}
          </p>
        )}
        {workspaces !== null && current === null && workspacesError === null && (
          <p className="new-run-workspace">You are not in a workspace yet. Ask your platform operator to add you to one.</p>
        )}

        <fieldset className="mode-choice">
          <legend>How should it run?</legend>
          <label className={"mode-card" + (mode === "auto" ? " mode-card-chosen" : "")}>
            <input type="radio" name="mode" value="auto" checked={mode === "auto"} onChange={() => { setMode("auto"); setAgentId(""); }} />
            <strong>Plan and delegate</strong>
            <span>A supervisor splits the work between specialist agents. Every delegation is checked.</span>
          </label>
          <label className={"mode-card" + (mode === "single" ? " mode-card-chosen" : "")}>
            <input type="radio" name="mode" value="single" checked={mode === "single"} onChange={() => { setMode("single"); setAgentId(""); }} />
            <strong>One agent</strong>
            <span>A single agent does the whole task.</span>
          </label>
        </fieldset>

        <Select
          label={mode === "auto" ? "Supervisor" : "Agent"}
          value={agentId}
          onChange={setAgentId}
          disabled={usable.length === 0}
          options={[
            { value: "", label: "Workspace default" },
            ...usable.map((agent) => ({ value: agent.id, label: agent.name, hint: agent.description || undefined })),
          ]}
        />

        <div className="new-run-task">
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
              <button type="button" className="new-run-example" key={example} onClick={() => setPrompt(example)}>{example}</button>
            ))}
          </div>
        </div>

        <div className="new-run-footer">
          <span>AgentGuard checks commands, file changes and delegations before they run.</span>
          <Button type="submit" variant="primary" page busy={busy} disabled={!workspaceId || !prompt.trim()}>
            Start run
          </Button>
        </div>
      </form>
    </div>
  );
}
