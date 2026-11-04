import { useState, type FormEvent } from "react";
import type { Agent, AgentProfile, EffectivePermissionsResponse, WorkspaceSummary } from "@launchpad/shared";
import { runsApi } from "../runs/runs-api";
import { Button, DataTable, ErrorState, Loading, Select, StatusBadge } from "../ui";
import { CapabilityList, ChangeError, useChange, useLoad, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

type Effective = EffectivePermissionsResponse["agents"][number];

function EffectiveCell({ entry }: { entry: Effective | undefined }) {
  if (entry?.policy == null) return <span className="meta">Cannot run</span>;
  return <CapabilityList capabilities={entry.policy.capabilities} />;
}

function AgentForm({ agent, profiles, canChangeProfile, onSave, onCancel, busy }: {
  agent: Agent | null;
  profiles: AgentProfile[];
  canChangeProfile: boolean;
  onSave: (fields: { name: string; description: string; instructions: string; profileId: string; enabled: boolean }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [profileId, setProfileId] = useState(agent?.profileId ?? profiles.find((profile) => profile.archivedAt === null)?.id ?? "");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const options = profiles
    .filter((profile) => profile.archivedAt === null || profile.id === agent?.profileId)
    .map((profile) => ({ value: profile.id, label: profile.name }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name: name.trim(), description, instructions, profileId, enabled });
  };
  return (
    <form className="config-form" onSubmit={submit}>
      <label>Name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Description<input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="config-wide">
        Instructions
        <textarea rows={6} value={instructions} maxLength={20000} onChange={(event) => setInstructions(event.target.value)} />
        <span className="meta">The semantic monitor holds the agent to these, alongside the person's request.</span>
      </label>
      <Select label="Profile" value={profileId} onChange={setProfileId} options={options} disabled={agent !== null && !canChangeProfile} />
      {agent !== null && (
        <label className="config-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled
        </label>
      )}
      <div className="cluster config-wide">
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !profileId}>{agent === null ? "Add agent" : "Save changes"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function Agents({ workspace }: { workspace: WorkspaceSummary }) {
  const { data, error, refresh } = useLoad(workspace.id, async () => {
    const [agents, profiles, effective] = await Promise.all([
      runsApi.agents(workspace.id),
      workspaceApi.profiles(workspace.id),
      workspaceApi.effective(workspace.id),
    ]);
    return { agents, profiles, effective };
  });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const change = useChange(refresh);
  const canEdit = workspace.role !== "auditor";
  const isAdmin = workspace.role === "security_admin";

  if (data === null) return error !== null ? <ErrorState message={error} onRetry={() => void refresh()} /> : <Loading label="Loading agents" />;
  const profileNames = new Map(data.profiles.map((profile) => [profile.id, profile.name]));
  const archived = data.agents.filter((agent) => agent.archivedAt !== null).length;
  const shown = data.agents.filter((agent) => showArchived || agent.archivedAt === null);

  return (
    <>
      <ChangeError message={change.error} />
      <section className="page-section">
        <div className="config-section-heading">
          <div>
            <h2>Configured agents</h2>
            <p className="meta">Effective capabilities include platform and workspace limits. Check agent reports against review and test evidence.</p>
          </div>
          <span className="config-count">{data.agents.length} total</span>
        </div>
        <DataTable caption="Agents">
          <thead>
            <tr><th>Agent</th><th>Profile</th><th>May do, after policies</th><th>Status</th>{canEdit && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={canEdit ? 5 : 4} className="config-empty">{data.agents.length === 0 ? "No agents are configured for this workspace yet." : "No active agents to show."}</td></tr>}
            {shown.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                profileName={profileNames.get(agent.profileId) ?? "Unknown"}
                effective={data.effective.find((entry) => entry.agentId === agent.id)}
                canEdit={canEdit}
                editing={editing === agent.id}
                onEdit={() => setEditing(agent.id)}
                onArchive={() => void change.run(() => workspaceApi.archiveAgent(workspace.id, agent.id))}
                form={
                  <AgentForm
                    agent={agent}
                    profiles={data.profiles}
                    canChangeProfile={isAdmin}
                    busy={change.busy}
                    onCancel={() => setEditing(null)}
                    onSave={(fields) => void change
                      .run(() => workspaceApi.updateAgent(workspace.id, agent.id, {
                        ...fields,
                        // Only a Security Admin may send a profile, so others leave it out.
                        ...(isAdmin ? {} : { profileId: undefined }),
                        expectedVersion: agent.version,
                      }))
                      .then((saved) => { if (saved) setEditing(null); })}
                  />
                }
              />
            ))}
          </tbody>
        </DataTable>
        {archived > 0 && (
          <p className="see-all"><Button variant="ghost" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Hide" : "Show"} {archived} archived</Button></p>
        )}
      </section>

      {canEdit && (
        <section className="page-section">
          {editing === "new" ? (
            <>
              <h2>Add an agent</h2>
              <AgentForm
                agent={null}
                profiles={data.profiles}
                canChangeProfile
                busy={change.busy}
                onCancel={() => setEditing(null)}
                onSave={({ enabled: _enabled, ...fields }) => void change
                  .run(() => workspaceApi.createAgent(workspace.id, fields))
                  .then((saved) => { if (saved) setEditing(null); })}
              />
            </>
          ) : (
            <Button onClick={() => setEditing("new")}>Add an agent</Button>
          )}
        </section>
      )}
    </>
  );
}

function AgentRow({ agent, profileName, effective, canEdit, editing, onEdit, onArchive, form }: {
  agent: Agent;
  profileName: string;
  effective: Effective | undefined;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onArchive: () => void;
  form: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const live = agent.archivedAt === null;
  return (
    <>
      <tr>
        <td><strong>{agent.name}</strong>{agent.description && <span className="meta config-note">{agent.description}</span>}</td>
        <td>{profileName}</td>
        <td><EffectiveCell entry={effective} /></td>
        <td>{!live ? <StatusBadge status="archived" /> : agent.enabled ? <StatusBadge status="enabled" /> : <StatusBadge status="disabled" />}</td>
        {canEdit && (
          <td className="cell-action">
            {live && !editing && (
              <div className="cluster">
                <Button onClick={onEdit}>Edit</Button>
                {confirming ? (
                  <>
                    <Button variant="danger" onClick={onArchive}>Archive {agent.name}</Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirming(true)}>Archive</Button>
                )}
              </div>
            )}
          </td>
        )}
      </tr>
      {editing && <tr><td colSpan={5}>{form}</td></tr>}
    </>
  );
}

export function AgentsPage() {
  return (
    <WorkspacePage title="Agents" description="The specialists runs can use, and what each one may really do once every policy applies.">
      {(workspace) => <Agents workspace={workspace} />}
    </WorkspacePage>
  );
}
