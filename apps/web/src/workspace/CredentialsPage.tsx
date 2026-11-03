import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceVaultSecretInfo } from "@launchpad/shared";
import { Button, EmptyState, ErrorState, Loading } from "../ui";
import { workspaceApi } from "./workspace-api";
import { WorkspacePage } from "./shared";

function Credentials({ workspaceId, auditor }: { workspaceId: string; auditor: boolean }) {
  const [secrets, setSecrets] = useState<WorkspaceVaultSecretInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authPrefix, setAuthPrefix] = useState("Bearer ");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setSecrets(await workspaceApi.vaultSecrets(workspaceId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSecrets([]);
    }
  };

  useEffect(() => {
    let mounted = true;
    workspaceApi.vaultSecrets(workspaceId).then(
      (items) => { if (mounted) { setSecrets(items); setError(null); } },
      (reason: unknown) => {
        if (mounted) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setSecrets([]);
        }
      },
    );
    return () => { mounted = false; };
  }, [workspaceId]);

  if (auditor) {
    return <EmptyState title="Auditors cannot manage credentials">A developer or security admin in this workspace can manage vault entries.</EmptyState>;
  }
  if (secrets === null) return error === null ? <Loading label="Loading workspace credentials" /> : <ErrorState message={error} onRetry={() => void reload()} />;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.putVaultSecret(workspaceId, {
        name: name.trim().toUpperCase(),
        value: secretValue,
        allowedHosts: hosts.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
        authHeader,
        authPrefix,
      });
      setName("");
      setSecretValue("");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secret: WorkspaceVaultSecretInfo) => {
    if (!window.confirm(`Delete ${secret.name} from this workspace vault?`)) return;
    setError(null);
    try {
      await workspaceApi.deleteVaultSecret(workspaceId, secret.name);
      setSecrets((current) => current?.filter((entry) => entry.name !== secret.name) ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      {error !== null && <ErrorState title="The credential change did not complete" message={error} onRetry={() => void reload()} />}
      <section className="page-section">
        <h2>Stored credentials</h2>
        <p className="meta">Values are encrypted on the server and never returned to this page. Each Run grants an entry to selected agents. Replacing an entry requires entering its value again.</p>
        {secrets.length === 0 ? <p className="meta">No credentials are configured for this workspace.</p> : (
          <ul className="vault-settings-list">
            {secrets.map((secret) => (
              <li key={secret.name} className="config-card">
                <div className="config-card-head">
                  <strong>{secret.name}</strong>
                  <Button variant="danger" onClick={() => void remove(secret)}>Delete</Button>
                </div>
                <p className="meta">Allowed hosts: {secret.allowedHosts.join(", ")}</p>
                <p className="meta">Authentication: {secret.authHeader}{secret.authPrefix ? ` (${secret.authPrefix.trim() || "no prefix"})` : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="page-section">
        <h2>Add or replace a credential</h2>
        <form className="config-form" onSubmit={(event) => void save(event)}>
          <label>Credential name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="SERVICE_API_KEY" autoComplete="off" required /></label>
          <label>Secret value<input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} autoComplete="new-password" required /></label>
          <label className="config-wide">Allowed HTTPS hosts, comma separated<input value={hosts} onChange={(event) => setHosts(event.target.value)} placeholder="api.example.com" required /></label>
          <label>Authentication header<input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} required /></label>
          <label>Header value prefix<input value={authPrefix} onChange={(event) => setAuthPrefix(event.target.value)} /></label>
          <div className="config-wide"><Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !secretValue || !hosts.trim()}>Encrypt and save</Button></div>
        </form>
      </section>
    </>
  );
}

export function CredentialsPage() {
  return (
    <WorkspacePage title="Credentials" description="Manage encrypted API credentials for this workspace. Grants are chosen separately for each Run.">
      {(workspace) => <Credentials key={workspace.id} workspaceId={workspace.id} auditor={workspace.role === "auditor"} />}
    </WorkspacePage>
  );
}
