import { useEffect, useState } from "react";
import type { Agent, OrchestrationMode } from "@launchpad/shared";
import { navigate, paths } from "../router";
import { Button, ErrorState } from "../ui";
import { runsApi } from "./runs-api";
import { WorkspaceVaultPicker } from "./WorkspaceVaultPicker";

/** A follow-up prompt starts a new audited Run from the workspace's latest successful files. */
export function ContinueWorkspace({ workspaceId, mode }: { workspaceId: string; mode: OrchestrationMode }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [vaultGrants, setVaultGrants] = useState<Array<{ secretName: string; agentIds: string[] }>>([]);

  useEffect(() => {
    setVaultGrants([]);
    runsApi.agents(workspaceId).then(setAgents).catch(() => setAgents([]));
  }, [workspaceId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await runsApi.createRun(workspaceId, {
        userPrompt: prompt.trim(),
        orchestrationMode: mode,
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
      <p className="meta">Your next prompt starts a new Run from the latest successfully completed files. This Run remains in the workspace history.</p>
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
        <WorkspaceVaultPicker workspaceId={workspaceId} agents={agents} value={vaultGrants} onChange={setVaultGrants} />
        <div className="new-run-footer">
          <span>{mode === "auto" ? "Plan and delegate" : "One agent"} · new Run</span>
          <Button type="submit" variant="primary" busy={busy} disabled={!prompt.trim()}>
            Submit next prompt
          </Button>
        </div>
      </form>
    </section>
  );
}
