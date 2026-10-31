// The files an Agent can see, and a way to put one there.
//
// Why this exists: every scenario this project guards against starts with a
// file somebody placed in the workspace — a skill, a runbook, a checklist
// copied from somewhere. That file is the most important input to the whole
// system, and until now it could only be placed from a terminal. A user of the
// product could not see what their Agent was reading, let alone add to it.
//
// Two things this panel deliberately does *not* do:
//
//   * It does not hide sensitive files. Seeing that `.env` sits next to a skill
//     that mentions it is the entire point. The API redacts credential-shaped
//     values on the way out, so the file can be shown without the secret being
//     rendered — which is also why the badge says "Watched", not "Hidden".
//   * It does not warn about what you type. The guards run on what the Agent
//     does, not on what a person writes, and a linter here would imply the
//     protection lives in the editor. It does not.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Reflection, WorkspaceEntry, WorkspaceFile } from "./types";
import { Button, Foreign, ForeignInline } from "./ui";

/**
 * Filename fragments the egress guard treats as a credential read.
 *
 * Mirrors DEFAULT_SENSITIVE_MARKERS on the server. Kept as a display hint only
 * — nothing here changes what is guarded, so drift costs a badge, never a
 * decision.
 */
const SENSITIVE_HINTS = [".env", "credentials", "secrets", ".pem", "id_rsa", ".netrc"];

/** Files whose name marks them as a template, not a real credential store. */
const TEMPLATE_HINT = /\.(example|sample|template|dist|tpl)$/i;

function isSensitive(path: string): boolean {
  const lower = path.toLowerCase();
  if (TEMPLATE_HINT.test(lower)) return false;
  return SENSITIVE_HINTS.some((hint) => lower.includes(hint));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Paths this Agent has been stopped over before, from its reflections. */
function watchedFiles(reflections: Reflection[]): Set<string> {
  const paths = new Set<string>();
  for (const reflection of reflections) {
    const source = reflection.facts.source;
    if (source !== undefined) paths.add(source.replace(/^\/workspace\//, ""));
  }
  return paths;
}

export function Workspace({
  agentId,
  reflections,
  onClose,
}: {
  agentId: string;
  reflections: Reflection[];
  onClose: () => void;
}) {
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [open, setOpen] = useState<WorkspaceFile | null>(null);
  const [draftPath, setDraftPath] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const watched = watchedFiles(reflections);

  const refresh = useCallback(async () => {
    try {
      const result = await api.workspace(agentId);
      setFiles(result.files);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not list the workspace");
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(
    async (path: string) => {
      setError(null);
      setEditing(false);
      try {
        const result = await api.workspaceFile(agentId, path);
        setOpen(result.file);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Could not read that file");
      }
    },
    [agentId],
  );

  const startNew = () => {
    setOpen(null);
    setEditing(true);
    setDraftPath("skills/");
    setDraftBody("");
    setError(null);
    setSaved(null);
  };

  const startEdit = () => {
    if (open === null) return;
    setEditing(true);
    setDraftPath(open.path);
    setDraftBody(open.content);
    setSaved(null);
  };

  const save = async () => {
    const path = draftPath.trim();
    if (path.length === 0) {
      setError("Give the file a path");
      return;
    }
    // The field pre-fills with a directory prefix, so this is the easy mistake:
    // saving `skills/` would name a file `skills` and block the directory.
    if (path.endsWith("/")) {
      setError("Add a file name after the folder, e.g. skills/deploy-helper.md");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveWorkspaceFile(agentId, path, draftBody);
      await refresh();
      await openFile(path);
      setSaved(path);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save that file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="side-panel workspace-panel" aria-label="Agent workspace">
      <header className="side-panel-head">
        <h2>What the agent can read</h2>
        <div className="cluster">
          <Button onClick={startNew}>Add a file</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </header>

      {error !== null && <div className="state-error workspace-error" role="alert">{error}</div>}

      <div className="workspace-body">
        {files.length === 0 ? (
          <p className="meta workspace-empty">No files yet. Add one for the agent to find.</p>
        ) : (
          <ul className="workspace-tree">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="workspace-file"
                  aria-current={open?.path === file.path ? "true" : undefined}
                  onClick={() => void openFile(file.path)}
                >
                  <ForeignInline>{file.path}</ForeignInline>
                  <span className="workspace-file-facts">
                    {watched.has(file.path) && (
                      <span className="badge badge-held" title="This agent has been stopped over this file before">Watched</span>
                    )}
                    {isSensitive(file.path) && (
                      <span className="badge" title="The egress guard treats reading this as a credential read">Sensitive</span>
                    )}
                    <span className="meta tabular">{formatSize(file.size)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="workspace-view">
          {editing ? (
            <div className="form-stack">
              <label>
                Path
                <input
                  value={draftPath}
                  onChange={(event) => setDraftPath(event.target.value)}
                  placeholder="skills/deploy-helper.md"
                  spellCheck={false}
                />
              </label>
              <label>
                Contents
                <textarea
                  className="workspace-textarea"
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  spellCheck={false}
                  rows={14}
                  placeholder={"# deploy-helper\n\n## 1. Check the build\n\nRun the tests."}
                />
              </label>
              <div className="form-actions">
                <Button variant="primary" busy={busy} onClick={() => void save()}>Save to workspace</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
              </div>
              <p className="meta">
                Saved straight into the agent's workspace. Nothing here is checked: the guards run
                on what the agent does with it, on the next run.
              </p>
            </div>
          ) : open !== null ? (
            <>
              <div className="workspace-view-head">
                <ForeignInline>{open.path}</ForeignInline>
                <Button onClick={startEdit}>Edit</Button>
              </div>
              {saved === open.path && (
                <p className="workspace-saved" role="status">Saved. The agent will see this on its next run.</p>
              )}
              <Foreign preformatted>{open.content}</Foreign>
              {open.truncated && (
                <p className="meta">Showing the first 256 KB of {formatSize(open.size)}.</p>
              )}
            </>
          ) : (
            <p className="meta">Pick a file to read it, or add one for the agent to find.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
