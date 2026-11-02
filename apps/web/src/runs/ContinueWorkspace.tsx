import { useEffect, useState } from "react";
import type { OrchestrationMode } from "@launchpad/shared";
import { navigate, paths } from "../router";
import { Button, ErrorState } from "../ui";
import { runsApi } from "./runs-api";

/** A follow-up prompt starts a new audited Run from the workspace's latest successful files. */
export function ContinueWorkspace({ workspaceId, mode }: { workspaceId: string; mode: OrchestrationMode }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vaultNames, setVaultNames] = useState<string[]>([]);
  const [vaultSecretNames, setVaultSecretNames] = useState<string[]>([]);

  useEffect(() => {
    setVaultSecretNames([]);
    runsApi.vaultNames(workspaceId).then(setVaultNames).catch(() => setVaultNames([]));
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
        ...(vaultSecretNames.length ? { vaultSecretNames } : {}),
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
        {vaultNames.length > 0 && (
          <fieldset className="mode-choice">
            <legend>Local credentials for this run</legend>
            <p className="meta">Selected values are available to agent commands. Outbound commands require human approval.</p>
            {vaultNames.map((name) => (
              <label key={name} className="mode-card">
                <input
                  type="checkbox"
                  checked={vaultSecretNames.includes(name)}
                  onChange={(event) => setVaultSecretNames((current) => event.target.checked ? [...current, name] : current.filter((item) => item !== name))}
                />
                <strong>{name}</strong>
              </label>
            ))}
          </fieldset>
        )}
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
