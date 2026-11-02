import { useEffect, useState } from "react";
import type { Agent, WorkspaceVaultSecretInfo } from "@launchpad/shared";
import { runsApi } from "./runs-api";

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
  const [name, setName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authPrefix, setAuthPrefix] = useState("Bearer ");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = () => runsApi.vaultSecrets(workspaceId).then((items) => {
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

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !secretValue || !workspaceId) return;
    setSaving(true);
    setVaultError(null);
    try {
      await runsApi.putVaultSecret(workspaceId, {
        name: name.trim().toUpperCase(),
        value: secretValue,
        allowedHosts: hosts.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
        authHeader,
        authPrefix,
      });
      setName("");
      setSecretValue("");
      await reload();
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (secretName: string, agentId: string, checked: boolean) => {
    const next = new Map(value.map((grant) => [grant.secretName, new Set(grant.agentIds)]));
    const ids = next.get(secretName) ?? new Set<string>();
    if (checked) ids.add(agentId); else ids.delete(agentId);
    if (ids.size) next.set(secretName, ids); else next.delete(secretName);
    onChange([...next].map(([selectedName, selectedIds]) => ({ secretName: selectedName, agentIds: [...selectedIds] })));
  };

  return (
    <section className="mode-choice" aria-label="Workspace vault">
      <h3>Workspace credentials</h3>
      <p className="meta">Credentials are encrypted on the server. Grant each one only to the agents that need it. Agents can use the broker for HTTPS requests to the listed hosts; the secret value is never sent into the container.</p>
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
              <button type="button" onClick={async () => {
                if (!window.confirm(`Delete ${secret.name} from this workspace vault?`)) return;
                try { await runsApi.deleteVaultSecret(workspaceId, secret.name); onChange(value.filter((grant) => grant.secretName !== secret.name)); await reload(); }
                catch (error) { setVaultError(error instanceof Error ? error.message : String(error)); }
              }}>Delete credential</button>
            </fieldset>;
          })}
        </div>
      )}
      <details>
        <summary>Add or replace a credential</summary>
        <form onSubmit={(event) => void save(event)} className="new-run-task">
          <label>Credential name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="SERVICE_API_KEY" autoComplete="off" /></label>
          <label>Secret value<input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} autoComplete="new-password" /></label>
          <label>Allowed HTTPS hosts, comma separated<input value={hosts} onChange={(event) => setHosts(event.target.value)} placeholder="api.example.com" /></label>
          <label>Authentication header<input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} placeholder="Authorization" /></label>
          <label>Header value prefix<input value={authPrefix} onChange={(event) => setAuthPrefix(event.target.value)} placeholder="Bearer " /></label>
          <button type="submit" disabled={saving || !name.trim() || !secretValue || !hosts.trim()}>{saving ? "Saving…" : "Encrypt and save"}</button>
        </form>
      </details>
    </section>
  );
}
