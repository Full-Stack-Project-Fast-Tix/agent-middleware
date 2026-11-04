import { Fragment, useState, type FormEvent } from "react";
import type { AgentCapabilities, AgentProfile, CapabilityCeiling, SecurityPolicy, WorkspaceSummary } from "@launchpad/shared";
import { Button, DataTable, ErrorState, Loading } from "../ui";
import { CAPABILITIES, CapabilityList, capabilityWord, ChangeError, useChange, useLoad, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

function ceilingWords(ceiling: CapabilityCeiling): string {
  const denied = CAPABILITIES.filter((capability) => ceiling[capability] === false).map(capabilityWord);
  const depth = ceiling.maxDelegationDepth === undefined ? [] : [`Delegation depth at most ${ceiling.maxDelegationDepth}`];
  const parts = [...(denied.length > 0 ? [`Denies: ${denied.join(", ")}`] : []), ...depth];
  return parts.length === 0 ? "No limit" : parts.join(". ");
}

function PolicyForm({ policy, busy, onSave, onCancel }: {
  policy: SecurityPolicy | null;
  busy: boolean;
  onSave: (fields: { name: string; capabilityCeiling: CapabilityCeiling }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(policy?.name ?? "");
  const [denied, setDenied] = useState(new Set(CAPABILITIES.filter((capability) => policy?.capabilityCeiling[capability] === false)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A ceiling can only take a capability away, so an unticked one is left out, not set to true.
    const capabilityCeiling: CapabilityCeiling = {
      ...(policy?.capabilityCeiling.maxDelegationDepth === undefined ? {} : { maxDelegationDepth: policy.capabilityCeiling.maxDelegationDepth }),
      ...Object.fromEntries([...denied].map((capability) => [capability, false])),
    };
    onSave({ name: name.trim(), capabilityCeiling });
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
      <p className="members-readonly">This editor manages capability ceilings and profiles. Fine-grained policy rules are not supported yet, and the locked platform baseline cannot be changed here.</p>
      <ChangeError message={change.error} />

      <section className="page-section">
        <div className="config-section-heading">
          <div>
            <h2>Policies</h2>
            <p className="meta">Limits apply in order: platform, workspace, then agent profile. Each layer can only remove capabilities.</p>
          </div>
          <span className="config-count">{policies.length} active</span>
        </div>
        <DataTable caption="Security policies">
          <thead>
            <tr><th>Policy</th><th>Applies to</th><th>Limits</th><th>Version</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {policies.length === 0 && <tr><td colSpan={isAdmin ? 5 : 4} className="config-empty">No workspace policies are configured. The locked platform baseline still applies.</td></tr>}
            {policies.map((policy) => (
              <Fragment key={policy.id}>
                <tr>
                  <td><strong>{policy.name}</strong></td>
                  <td>{policy.scope === "platform" ? "Whole platform (locked)" : "This workspace"}</td>
                  <td>{ceilingWords(policy.capabilityCeiling)}</td>
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
                  <tr><td colSpan={5}>
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
        <div className="config-section-heading">
          <div>
            <h2>Agent profiles</h2>
            <p className="meta">Profiles set each agent's starting capabilities before policy limits are applied.</p>
          </div>
          <span className="config-count">{profiles.length} active</span>
        </div>
        <DataTable caption="Agent profiles">
          <thead>
            <tr><th>Profile</th><th>Allows</th><th>Version</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {profiles.length === 0 && <tr><td colSpan={isAdmin ? 4 : 3} className="config-empty">No profiles are configured for this workspace.</td></tr>}
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
    <WorkspacePage title="Policies" description="What the agents in this workspace are allowed to do.">
      {(workspace) => <Policies workspace={workspace} />}
    </WorkspacePage>
  );
}
