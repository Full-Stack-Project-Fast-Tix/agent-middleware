import { useEffect, useState } from "react";
import type { Agent, WorkspaceVaultSecretInfo } from "@launchpad/shared";
import { workspaceApi } from "../workspace/workspace-api";
import { paths } from "../router";
import { ButtonLink } from "../ui";

/** Manage encrypted workspace credentials and choose the agents that may use them in one Run. */
export function WorkspaceVaultPicker({
  workspaceId,
  agents,
  value,
  onChange,
}: {
  workspaceId: string;
  agents: Agent[];
  value: Array<{ secretName: string; agentIds: string[] }>;
  onChange: (grants: Array<{ secretName: string; agentIds: string[] }>) => void;
}) {
  const [secrets, setSecrets] = useState<WorkspaceVaultSecretInfo[]>([]);
  const [vaultError, setVaultError] = useState<string | null>(null);

  const reload = () => workspaceApi.vaultSecrets(workspaceId).then((items) => {
    setSecrets(items);
    setVaultError(null);
  }).catch((error: unknown) => {
    setSecrets([]);
    setVaultError(error instanceof Error ? error.message : String(error));
  });

  useEffect(() => {
    onChange([]);
    void reload();
  // workspace changes reset grants to prevent them crossing workspace boundaries
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const toggle = (secretName: string, agentId: string, checked: boolean) => {
    const next = new Map(value.map((grant) => [grant.secretName, new Set(grant.agentIds)]));
    const ids = next.get(secretName) ?? new Set<string>();
    if (checked) ids.add(agentId); else ids.delete(agentId);
    if (ids.size) next.set(secretName, ids); else next.delete(secretName);
    onChange([...next].map(([selectedName, selectedIds]) => ({ secretName: selectedName, agentIds: [...selectedIds] })));
  };

  return (
    <section className="mode-choice" aria-label="Workspace vault">
      <h3>Credentials for this Run</h3>
      <p className="meta">Choose which agents may use each credential. They can make brokered HTTPS requests to the listed hosts; secret values stay on the server.</p>
      <ButtonLink to={paths.credentials}>Manage workspace credentials</ButtonLink>
      {vaultError && <p className="notice notice-blocked" role="alert">{vaultError}</p>}
      {secrets.length > 0 && (
        <div className="vault-secret-list">
          {secrets.map((secret) => {
            const selected = value.find((grant) => grant.secretName === secret.name)?.agentIds ?? [];
            return <fieldset key={secret.name} className="mode-card">
              <legend><strong>{secret.name}</strong></legend>
              <p className="meta">Hosts: {secret.allowedHosts.join(", ")} · Auth header: {secret.authHeader}</p>
              {agents.filter((agent) => agent.enabled && agent.archivedAt === null).map((agent) => (
                <label key={agent.id}>
                  <input type="checkbox" checked={selected.includes(agent.id)} onChange={(event) => toggle(secret.name, agent.id, event.target.checked)} />
                  {agent.name}
                </label>
              ))}
            </fieldset>;
          })}
        </div>
      )}
      {secrets.length === 0 && !vaultError && <p className="meta">No credentials are configured for this workspace. Add them from Credentials settings.</p>}
    </section>
  );
}
