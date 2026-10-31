import { Fragment, useState, type FormEvent } from "react";
import type { ActionType, AgentCapabilities, AgentProfile, CapabilityCeiling, SecurityPolicy, WorkspaceSummary } from "@launchpad/shared";
import { Button, DataTable, ErrorState, Loading } from "../ui";
import { CAPABILITIES, CapabilityList, capabilityWord, ChangeError, useChange, useLoad, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

const ACTIONS: Array<{ value: ActionType; label: string }> = [
  { value: "file_change", label: "File changes" },
  { value: "command", label: "Commands" },
  { value: "delegation", label: "Delegations" },
  { value: "context_handoff", label: "Results passed between tasks" },
];

function ceilingWords(ceiling: CapabilityCeiling): string {
  const denied = CAPABILITIES.filter((capability) => ceiling[capability] === false).map(capabilityWord);
  const depth = ceiling.maxDelegationDepth === undefined ? [] : [`Delegation depth at most ${ceiling.maxDelegationDepth}`];
  const parts = [...(denied.length > 0 ? [`Denies: ${denied.join(", ")}`] : []), ...depth];
  return parts.length === 0 ? "No limit" : parts.join(". ");
}

const actionsOf = (policy: SecurityPolicy | null): ActionType[] => (policy?.rules.requireApproval as ActionType[] | undefined) ?? [];

function PolicyForm({ policy, busy, onSave, onCancel }: {
  policy: SecurityPolicy | null;
  busy: boolean;
  onSave: (fields: { name: string; capabilityCeiling: CapabilityCeiling; rules: { requireApproval: ActionType[] } }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(policy?.name ?? "");
  const [denied, setDenied] = useState(new Set(CAPABILITIES.filter((capability) => policy?.capabilityCeiling[capability] === false)));
  const [asks, setAsks] = useState(new Set(actionsOf(policy)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A ceiling can only take a capability away, so an unticked one is left out, not set to true.
    const capabilityCeiling: CapabilityCeiling = {
      ...(policy?.capabilityCeiling.maxDelegationDepth === undefined ? {} : { maxDelegationDepth: policy.capabilityCeiling.maxDelegationDepth }),
      ...Object.fromEntries([...denied].map((capability) => [capability, false])),
    };
    onSave({ name: name.trim(), capabilityCeiling, rules: { requireApproval: [...asks] } });
  };
  return (
    <form className="config-form" onSubmit={submit}>
      <label className="config-wide">Name<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required /></label>
      <fieldset>
        <legend>Deny to every agent here</legend>
        {CAPABILITIES.map((capability) => (
          <label key={capability} className="config-check">
            <input
              type="checkbox"
              checked={denied.has(capability)}
              onChange={(event) => setDenied((before) => {
                const next = new Set(before);
                if (event.target.checked) next.add(capability);
                else next.delete(capability);
                return next;
              })}
            />
            {capabilityWord(capability)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Always ask a Security Admin about</legend>
        {ACTIONS.map(({ value, label }) => (
          <label key={value} className="config-check">
            <input
              type="checkbox"
              checked={asks.has(value)}
              onChange={(event) => setAsks((before) => {
                const next = new Set(before);
                if (event.target.checked) next.add(value);
                else next.delete(value);
                return next;
              })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="cluster config-wide">
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>{policy === null ? "Add policy" : "Save changes"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function ProfileForm({ profile, busy, onSave, onCancel }: {
  profile: AgentProfile | null;
  busy: boolean;
  onSave: (fields: { name: string; description: string; capabilities: AgentCapabilities }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(
    profile?.capabilities ?? { write: false, shell: false, network: false, delegate: false, maxDelegationDepth: 0 },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(),
      description,
      capabilities: { ...capabilities, maxDelegationDepth: capabilities.delegate ? Math.max(1, capabilities.maxDelegationDepth) : 0 },
    });
  };
  return (
    <form className="config-form" onSubmit={submit}>
      <label>Name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Description<input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
      <fieldset className="config-wide">
        <legend>Allows</legend>
        {CAPABILITIES.map((capability) => (
          <label key={capability} className="config-check">
            <input
              type="checkbox"
              checked={capabilities[capability]}
              onChange={(event) => setCapabilities((before) => ({ ...before, [capability]: event.target.checked }))}
            />
            {capabilityWord(capability)}
          </label>
        ))}
      </fieldset>
      <div className="cluster config-wide">
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>{profile === null ? "Add profile" : "Save changes"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function Policies({ workspace }: { workspace: WorkspaceSummary }) {
  const { data, error, refresh } = useLoad(workspace.id, async () => {
    const [policies, profiles] = await Promise.all([workspaceApi.policies(workspace.id), workspaceApi.profiles(workspace.id)]);
    return { policies, profiles };
  });
  const [editing, setEditing] = useState<string | null>(null);
  const change = useChange(refresh);
  const isAdmin = workspace.role === "security_admin";

  if (data === null) return error !== null ? <ErrorState message={error} onRetry={() => void refresh()} /> : <Loading label="Loading policies" />;
  const done = (saved: boolean) => {
    if (saved) setEditing(null);
  };
  const policies = data.policies.filter((policy) => policy.archivedAt === null);
  const profiles = data.profiles.filter((profile) => profile.archivedAt === null);
  const editablePolicy = (policy: SecurityPolicy) => isAdmin && policy.scope === "workspace" && !policy.locked;

  return (
    <>
      {!isAdmin && <p className="members-readonly">Only a security admin can change policies and profiles.</p>}
      <ChangeError message={change.error} />

      <section className="page-section">
        <h2>Policies</h2>
        <p className="meta">Every agent is limited by the platform policies, then this workspace's, then its own profile. Each can only take away.</p>
        <DataTable caption="Security policies">
          <thead>
            <tr><th>Policy</th><th>Applies to</th><th>Limits</th><th>Always asks about</th><th>Version</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {policies.map((policy) => (
              <Fragment key={policy.id}>
                <tr>
                  <td><strong>{policy.name}</strong></td>
                  <td>{policy.scope === "platform" ? "Whole platform (locked)" : "This workspace"}</td>
                  <td>{ceilingWords(policy.capabilityCeiling)}</td>
                  <td>{actionsOf(policy).length === 0 ? "Nothing extra" : actionsOf(policy).map((action) => ACTIONS.find((item) => item.value === action)?.label ?? action).join(", ")}</td>
                  <td className="num">{policy.version}</td>
                  {isAdmin && (
                    <td className="cell-action">
                      {editablePolicy(policy) && editing !== policy.id && (
                        <div className="cluster">
                          <Button onClick={() => setEditing(policy.id)}>Edit</Button>
                          <Button variant="ghost" onClick={() => void change.run(() => workspaceApi.archivePolicy(workspace.id, policy.id))}>Archive</Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
                {editing === policy.id && (
                  <tr><td colSpan={6}>
                    <PolicyForm
                      policy={policy}
                      busy={change.busy}
                      onCancel={() => setEditing(null)}
                      onSave={(fields) => void change.run(() => workspaceApi.updatePolicy(workspace.id, policy.id, { ...fields, expectedVersion: policy.version })).then(done)}
                    />
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </DataTable>
        {isAdmin && (editing === "new-policy" ? (
          <PolicyForm policy={null} busy={change.busy} onCancel={() => setEditing(null)} onSave={(fields) => void change.run(() => workspaceApi.createPolicy(workspace.id, fields)).then(done)} />
        ) : (
          <p><Button onClick={() => setEditing("new-policy")}>Add a policy</Button></p>
        ))}
      </section>

      <section className="page-section">
        <h2>Profiles</h2>
        <DataTable caption="Agent profiles">
          <thead>
            <tr><th>Profile</th><th>Allows</th><th>Version</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <Fragment key={profile.id}>
                <tr>
                  <td><strong>{profile.name}</strong>{profile.description && <span className="meta config-note">{profile.description}</span>}</td>
                  <td><CapabilityList capabilities={profile.capabilities} /></td>
                  <td className="num">{profile.version}</td>
                  {isAdmin && (
                    <td className="cell-action">
                      {editing !== profile.id && (
                        <div className="cluster">
                          <Button onClick={() => setEditing(profile.id)}>Edit</Button>
                          <Button variant="ghost" onClick={() => void change.run(() => workspaceApi.archiveProfile(workspace.id, profile.id))}>Archive</Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
                {editing === profile.id && (
                  <tr><td colSpan={4}>
                    <ProfileForm
                      profile={profile}
                      busy={change.busy}
                      onCancel={() => setEditing(null)}
                      onSave={(fields) => void change.run(() => workspaceApi.updateProfile(workspace.id, profile.id, { ...fields, expectedVersion: profile.version })).then(done)}
                    />
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </DataTable>
        {isAdmin && (editing === "new-profile" ? (
          <ProfileForm profile={null} busy={change.busy} onCancel={() => setEditing(null)} onSave={(fields) => void change.run(() => workspaceApi.createProfile(workspace.id, fields)).then(done)} />
        ) : (
          <p><Button onClick={() => setEditing("new-profile")}>Add a profile</Button></p>
        ))}
      </section>
    </>
  );
}

export function PoliciesPage() {
  return (
    <WorkspacePage title="Policies" description="What the agents in this workspace are allowed to do, and what always goes to a person.">
      {(workspace) => <Policies workspace={workspace} />}
    </WorkspacePage>
  );
}
