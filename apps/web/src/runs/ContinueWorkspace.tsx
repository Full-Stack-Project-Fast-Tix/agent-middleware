import { useState } from "react";
import type { OrchestrationMode, RunStatus } from "@launchpad/shared";
import { Link, navigate, paths } from "../router";
import { Button, ErrorState, Select } from "../ui";
import { workspaceApi } from "../workspace/workspace-api";
import { agentChoices, followUpAgent } from "./agent-choice";
import { useLatest } from "./latest-request";
import { runsApi } from "./runs-api";
import { WorkspaceVaultPicker } from "./WorkspaceVaultPicker";

/**
 * A follow-up prompt starts a new audited Run. It starts from the workspace's
 * latest completed Run, which may not be the one on this page, and keeps the
 * agent this Run used unless the person picks another: the workspace default
 * never silently takes over.
 */
export function ContinueWorkspace({ workspaceId, mode, previousAgentId, currentRun }: {
  workspaceId: string;
  mode: OrchestrationMode;
  /** The agent (single) or supervisor (auto) this Run used. */
  previousAgentId: string | null;
  currentRun: { id: string; status: RunStatus };
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [vaultGrants, setVaultGrants] = useState<Array<{ secretName: string; agentIds: string[] }>>([]);
  const agents = useLatest(workspaceId, (id) => runsApi.agents(id));
  const permissions = useLatest(workspaceId, (id) => workspaceApi.effective(id));
  const parent = useLatest(workspaceId, (id) => runsApi.listRuns(id, { status: "completed", limit: 1 }));

  const list = agents.state.status === "ready" ? agents.state.value : [];
  const choices = agentChoices(list, mode, permissions.state.status === "ready" ? permissions.state.value : null);
  const kept = followUpAgent(previousAgentId, choices.agents);
  const agentId = picked ?? kept.agentId;
  const parentRun = parent.state.status === "ready" ? parent.state.value.runs[0] ?? null : undefined;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy || agentId === "") return;
    setBusy(true);
    setError(null);
    try {
      const run = await runsApi.createRun(workspaceId, {
        userPrompt: prompt.trim(),
        orchestrationMode: mode,
        agentId,
        ...(vaultGrants.length ? { vaultGrants } : {}),
      });
      navigate(paths.run(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-section continue-workspace" aria-label="Continue this workspace">
      <h2>Continue this workspace</h2>
      <p className="meta">
        Your next prompt starts a new Run. This Run stays in the workspace history.{" "}
        {parentRun === undefined
          ? parent.state.status === "error" ? "Which Run it starts from could not be loaded." : "Finding the Run it starts from…"
          : parentRun === null
            ? "No Run in this workspace has completed yet, so it starts from the workspace's source files."
            : parentRun.id === currentRun.id
              ? "It starts from this Run's files."
              : <>It starts from the latest completed Run, <Link to={paths.run(parentRun.id)}>{runLabel(parentRun.userPrompt)}</Link>, not from this one.</>}
        {currentRun.status !== "completed" && " Failed and cancelled Runs never become the starting point; their files stay here to inspect."}
      </p>
      {error !== null && <ErrorState title="The follow-up run did not start" message={error} onRetry={() => setError(null)} retryLabel="Dismiss" />}
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Next task
          <textarea
            aria-label="Next task"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the agents do next?"
            rows={4}
            maxLength={20_000}
            required
          />
        </label>
        <Select
          label={mode === "auto" ? "Supervisor" : "Agent"}
          value={agentId}
          onChange={setPicked}
          disabled={choices.agents.length === 0}
          options={[
            { value: "", label: mode === "auto" ? "Choose a supervisor" : "Choose an agent" },
            ...choices.agents.map((agent) => ({ value: agent.id, label: agent.name, hint: agent.description || undefined })),
          ]}
        />
        {agents.state.status === "ready" && !kept.kept && previousAgentId !== null && (
          <p className="meta">The {mode === "auto" ? "supervisor" : "agent"} this Run used is no longer available{mode === "auto" ? " or can no longer delegate" : ""}, so choose one.</p>
        )}
        {agents.state.status === "ready" && choices.agents.length === 0 && (
          <p className="notice notice-held">
            {mode === "auto"
              ? "No agent here may delegate under its effective permissions, so a planned Run cannot start. Start a one-agent Run instead, or ask a Security Admin to change a profile."
              : "No agent in this workspace is enabled."}
          </p>
        )}
        {mode === "auto" && !choices.filtered && agents.state.status === "ready" && (
          <p className="meta">Effective permissions did not load, so supervisors are not filtered; the server still refuses one that cannot delegate.</p>
        )}
        <WorkspaceVaultPicker workspaceId={workspaceId} agents={list.filter((agent) => agent.enabled && agent.archivedAt === null)} value={vaultGrants} onChange={setVaultGrants} />
        <div className="new-run-footer">
          <span>{mode === "auto" ? "Plan and delegate" : "One agent"}, new Run</span>
          <Button type="submit" variant="primary" busy={busy} disabled={!prompt.trim() || agentId === ""}>
            Submit next prompt
          </Button>
        </div>
      </form>
    </section>
  );
}

function runLabel(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? prompt;
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}
