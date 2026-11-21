import { useState, type FormEvent } from "react";
import type { WorkspaceSummary } from "@launchpad/shared";
import { ROLE_WORDS } from "../members/member-view";
import { navigate, paths } from "../router";
import { Button, DataTable, ErrorState, Loading } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { useLoad, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Pick or create the workspace, see or change its folder, then go start a run in it. */
export function WorkspacesPage() {
  return (
    <WorkspacePage title="Workspaces" description="Pick the project folder your runs work on, then start a run in it.">
      {(current) => <Workspaces current={current} />}
    </WorkspacePage>
  );
}

function Workspaces({ current }: { current: WorkspaceSummary }) {
  const { workspaces, select } = useCurrentWorkspace();
  const open = (workspace: WorkspaceSummary) => {
    select(workspace.id);
    navigate(workspace.role === "auditor" ? paths.runs : paths.newRun);
  };
  // Creating needs security admin somewhere; the new workspace is authorised by that one.
  const adminOf = workspaces?.find((workspace) => workspace.role === "security_admin") ?? null;
  return (
    <>
      <section className="page-section">
        <h2>Pick a workspace</h2>
        <DataTable caption="Your workspaces">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Your role</th>
              <th><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {(workspaces ?? []).map((workspace) => (
              <tr key={workspace.id}>
                <td>
                  <strong>{workspace.name}</strong>
                  {workspace.id === current.id && <span className="member-you">Current</span>}
                </td>
                <td>{ROLE_WORDS[workspace.role]}</td>
                <td className="member-actions">
                  <Button variant={workspace.id === current.id ? "primary" : "secondary"} onClick={() => open(workspace)}>
                    {workspace.role === "auditor" ? "Open runs" : "Start a run here"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </section>

      <Folder key={current.id} workspace={current} />

      {adminOf !== null && <CreateWorkspace authorizationWorkspaceId={adminOf.id} onCreated={(id) => {
        select(id);
        navigate(paths.newRun);
      }} />}
    </>
  );
}

function Folder({ workspace }: { workspace: WorkspaceSummary }) {
  const { data, error, refresh } = useLoad(workspace.id, () => workspaceApi.source(workspace.id).then((sourcePath) => ({ sourcePath })));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canChange = workspace.role === "security_admin";

  const change = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setChangeError(null);
    setNotice(null);
    try {
      await workspaceApi.changeSource(workspace.id, input.trim());
      setInput("");
      setNotice("Folder changed. Your next run here starts fresh from it.");
      await refresh();
    } catch (reason) {
      setChangeError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-section">
      <h2>Project folder for {workspace.name}</h2>
      {error !== null ? (
        <ErrorState message={`The folder did not load: ${error}`} onRetry={() => void refresh()} />
      ) : data === null ? (
        <Loading label="Loading the folder" />
      ) : (
        <p>
          {data.sourcePath === null
            ? "No folder. Runs here start from an empty project."
            : <>Each new run works on a copy of <code>{data.sourcePath}</code>.</>}
        </p>
      )}
      {changeError !== null && <p className="notice notice-blocked" role="alert">{changeError}</p>}
      {notice !== null && <p className="notice notice-passed" role="status">{notice}</p>}
      {canChange && (
        <>
          <form className="members-add" onSubmit={(event) => void change(event)}>
            <label>New folder on this server<input value={input} onChange={(event) => setInput(event.target.value)} maxLength={4096} placeholder="~/projects/app" autoComplete="off" spellCheck={false} required /></label>
            <Button type="submit" variant="primary" busy={busy} disabled={!input.trim()}>Change folder</Button>
          </form>
          <p className="meta">The folder must be inside a root the server operator allows. The next run starts fresh from the new folder; runs already started keep their own copy.</p>
        </>
      )}
    </section>
  );
}

function CreateWorkspace({ authorizationWorkspaceId, onCreated }: { authorizationWorkspaceId: string; onCreated: (id: string) => void }) {
  const { reload } = useCurrentWorkspace();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooBig = archive !== null && archive.size > MAX_ZIP_BYTES;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const trimmed = folder.trim();
      const workspace = await workspaceApi.createWorkspace({
        name: name.trim(),
        authorizationWorkspaceId,
        ...(trimmed === "" ? {} : { sourcePath: trimmed }),
      });
      if (archive !== null) await workspaceApi.uploadWorkspaceArchive(workspace.id, archive);
      reload();
      onCreated(workspace.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The workspace could not be created or uploaded.");
      setBusy(false);
    }
  };

  return (
    <section className="page-section">
      <h2>Create a workspace</h2>
      {error !== null && <p className="notice notice-blocked" role="alert">{error}</p>}
      <form className="members-add" onSubmit={(event) => void create(event)}>
        <label>Workspace name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label>
        <label>Project folder on this server (optional)<input value={folder} onChange={(event) => setFolder(event.target.value)} maxLength={4096} placeholder="~/projects/app" autoComplete="off" spellCheck={false} disabled={archive !== null} /></label>
        <label>Or upload a project ZIP (max 10 MB)<input type="file" accept=".zip,application/zip" onChange={(event) => setArchive(event.target.files?.[0] ?? null)} disabled={folder.trim() !== ""} /></label>
        {tooBig && <p className="notice notice-blocked" role="alert">ZIP files must be no larger than 10 MB.</p>}
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || tooBig}>Create and start a run</Button>
      </form>
      <p className="meta">New workspaces get the standard agents. Give a folder on the server, upload a ZIP, or leave both blank for an empty workspace. ZIP uploads reject links, unsafe paths, credential files, and archives that expand beyond the server limits.</p>
    </section>
  );
}
