import { useEffect, useState } from "react";
import type { Agent, AgentProfile, EffectivePermissionsResponse, OrchestrationMode } from "@launchpad/shared";
import { navigate, paths } from "../router";
import { Button, ButtonLink, EmptyState, ErrorState, PageHeader, Select } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { runsApi } from "./runs-api";
import { WorkspaceVaultPicker } from "./WorkspaceVaultPicker";
import { workspaceApi } from "../workspace/workspace-api";
import { agentChoices } from "./agent-choice";

const EXAMPLES = [
  "Add input validation to the checkout endpoint and return 400 on bad input.",
  "Find why the signup test is flaky and fix it.",
];

/** Start a Run: describe the work, choose one agent or let the supervisor plan it. */
export function NewRun() {
  const { workspaces, current, error: workspacesError, reload } = useCurrentWorkspace();
  const workspaceId = current?.id ?? "";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [permissions, setPermissions] = useState<EffectivePermissionsResponse["agents"]>([]);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [vaultGrants, setVaultGrants] = useState<Array<{ secretName: string; agentIds: string[] }>>([]);
  const [mode, setMode] = useState<OrchestrationMode>("auto");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setAgents([]);
    setAgentId("");
    setVaultGrants([]);
    setProfiles([]);
    setPermissions([]);
    setPermissionsError(null);
    setPermissionsLoading(Boolean(workspaceId));
    if (!workspaceId) return () => { active = false; };
    runsApi.agents(workspaceId).then((nextAgents) => { if (active) setAgents(nextAgents); }).catch(() => { if (active) setAgents([]); });
    Promise.all([workspaceApi.profiles(workspaceId), workspaceApi.effective(workspaceId)]).then(([nextProfiles, nextPermissions]) => {
      if (active) {
        setProfiles(nextProfiles);
        setPermissions(nextPermissions);
        setPermissionsLoading(false);
      }
    }).catch((reason: unknown) => {
      if (active) {
        setPermissionsError(reason instanceof Error ? reason.message : String(reason));
        setPermissionsLoading(false);
      }
    });
    return () => { active = false; };
  }, [workspaceId]);

  const usable = agents.filter((agent) => agent.enabled && agent.archivedAt === null);
  // A supervisor must be able to delegate under its effective policy, not just its profile.
  const permissionsKnown = !permissionsLoading && permissionsError === null;
  const choices = agentChoices(agents, mode, permissionsKnown ? permissions : null);
  const delegatingProfileIds = new Set(profiles.filter((profile) => profile.archivedAt === null && profile.capabilities.delegate).map((profile) => profile.id));
  const defaultSupervisors = choices.filtered
    ? choices.agents
    : usable.filter((agent) => delegatingProfileIds.has(agent.profileId));
  const selectedAgent = choices.agents.find((agent) => agent.id === agentId) ??
    (mode === "auto" && agentId === "" && defaultSupervisors.length === 1 ? defaultSupervisors[0] : undefined);
  const selectedPermissions = selectedAgent === undefined
    ? undefined
    : permissions.find((entry) => entry.agentId === selectedAgent.id)?.policy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !prompt.trim() || selectedAgent === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const run = await runsApi.createRun(workspaceId, {
        userPrompt: prompt.trim(),
        orchestrationMode: mode,
        agentId: selectedAgent.id,
        ...(vaultGrants.length ? { vaultGrants } : {}),
      });
      navigate(paths.run(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (current?.role === "auditor") {
    return (
      <div className="page page-narrow">
        <PageHeader title="Start a run" />
        <EmptyState title="Auditors cannot start runs" action={<ButtonLink to={paths.runs}>Go to runs</ButtonLink>}>
          You are an Auditor in {current.name}, so you can read its runs. A developer or security admin can start one.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <PageHeader
        title="Start a run"
        description="Describe the work. Each prompt creates a separate Run; follow-up Runs continue from the latest successfully completed files in this workspace, until its folder changes."
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

        <section className="new-run-step" aria-labelledby="new-run-task-title">
          <div className="new-run-step-heading">
            <span className="new-run-step-number" aria-hidden="true">01</span>
            <div>
              <h2 id="new-run-task-title">Describe the task</h2>
              <p>Be specific about the change and how you will know it is done.</p>
            </div>
          </div>
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
            <div className="new-run-examples" aria-label="Example tasks">
              <span className="meta">Try an example</span>
              {EXAMPLES.map((example) => (
                <button type="button" className="new-run-example" key={example} onClick={() => setPrompt(example)}>{example}</button>
              ))}
            </div>
          </div>
        </section>

        <section className="new-run-step" aria-labelledby="new-run-setup-title">
          <div className="new-run-step-heading">
            <span className="new-run-step-number" aria-hidden="true">02</span>
            <div>
              <h2 id="new-run-setup-title">Choose how it runs</h2>
              <p>Every agent works within the effective permissions shown below.</p>
            </div>
          </div>
          <fieldset className="mode-choice">
            <legend>Execution mode</legend>
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
          disabled={choices.agents.length === 0}
          options={[
            { value: "", label: mode === "auto"
              ? defaultSupervisors.length === 1 ? `Workspace default: ${defaultSupervisors[0]!.name}` : "Choose a supervisor"
              : "Choose an agent" },
            ...choices.agents.map((agent) => ({ value: agent.id, label: agent.name, hint: agent.description || undefined })),
          ]}
        />
        {mode === "auto" && choices.filtered && choices.agents.length === 0 && agents.length > 0 && (
          <p className="notice notice-held">
            No agent in this workspace may delegate under its effective permissions, so a planned Run cannot start. Choose One agent, or ask a
            Security Admin to give an agent a profile that can delegate.
          </p>
        )}
        {mode === "auto" && !choices.filtered && !permissionsLoading && (
          <p className="meta">Effective permissions did not load, so supervisors are not filtered; the server still refuses one that cannot delegate.</p>
        )}

        <section className="permission-preview" aria-live="polite" aria-label="Effective agent permissions">
          <h3>Effective permissions</h3>
          {permissionsError !== null ? (
            <p className="meta">Could not load the permission preview: {permissionsError}</p>
          ) : permissionsLoading ? (
            <p className="meta">Loading effective permissions…</p>
          ) : selectedAgent === undefined ? (
            <p className="meta">Select an agent to see its effective permissions.{mode === "auto" && defaultSupervisors.length !== 1 ? " This workspace has no unique default supervisor, so choose one." : ""}</p>
          ) : selectedPermissions == null ? (
            <p className="meta">Effective permissions could not be resolved for {selectedAgent.name}; the server may refuse to run it.</p>
          ) : (
            <>
              <p className="meta">{selectedAgent.name} · platform and workspace limits applied</p>
              <ul className="permission-preview-list">
                <li>Write files: <strong>{selectedPermissions.capabilities.write ? "Allowed" : "Blocked"}</strong></li>
                <li>Run commands: <strong>{selectedPermissions.capabilities.shell ? "Allowed" : "Read-only commands"}</strong></li>
                <li>Network capability: <strong>{selectedPermissions.capabilities.network ? "Allowed by policy" : "Blocked"}</strong></li>
                <li>Delegate: <strong>{selectedPermissions.capabilities.delegate ? `Allowed · depth ${selectedPermissions.capabilities.maxDelegationDepth}` : "Blocked"}</strong></li>
              </ul>
              {mode === "auto" && !selectedPermissions.capabilities.delegate && <p className="notice notice-held">This agent cannot delegate under its effective permissions, so a planned run is likely to stop when it tries to assign work.</p>}
              {selectedPermissions.capabilities.network && <p className="meta">The server operator can still disable container networking. Vault broker requests use their separate per-secret host grants.</p>}
            </>
          )}
        </section>

          {workspaceId && <WorkspaceVaultPicker workspaceId={workspaceId} agents={usable} value={vaultGrants} onChange={setVaultGrants} />}
        </section>

        <p className="meta new-run-review-note">
          When semantic review is on, AgentGuard also reviews the Run's actual changes against this request before it can complete: every
          changed line of up to 36 changed files. A Run whose changes cannot all be compared or shown to the reviewer (binary, over 2 MB or
          unreadable files, or more than 36 files) fails closed and does not become the starting point for follow-up Runs.
        </p>
        <div className="new-run-footer">
          <span>AgentGuard checks commands, file changes and delegations before they run.</span>
          <Button type="submit" variant="primary" page busy={busy} disabled={!workspaceId || !prompt.trim() || selectedAgent === undefined}>
            Start run
          </Button>
        </div>
      </form>
    </div>
  );
}
