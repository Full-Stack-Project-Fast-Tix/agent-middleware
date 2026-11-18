import { Fragment, useEffect, useRef, useState } from "react";
import { Button, DataTable, ErrorState, ForeignInline, Loading } from "../ui";
import { LatestRequest, useLatest } from "./latest-request";
import { archiveFailure, downloadRunArchive, downloadTextPreview, formatBytes, PREVIEW_LIMIT_TEXT, type SaveFile } from "./run-file-actions";
import { runsApi } from "./runs-api";

/** Hands a blob to the browser as a download. */
const saveFile: SaveFile = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

/** What the agents left in this Run's copy of the project, even if the Run failed. */
export function RunFiles({ runId, runEnded }: { runId: string; runEnded: boolean }) {
  // Reload when the Run ends, and drop answers for a Run this page has left.
  const listing = useLatest(`${runId}:${runEnded}`, () => runsApi.files(runId));
  const [note, setNote] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean; size: number } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  // Previews, downloads and notes belong to one Run.
  const actions = useRef(new LatestRequest());

  useEffect(() => {
    actions.current.cancel();
    setNote(null);
    setPreview(null);
    setLoadingPreview(null);
    setDownloadingAll(false);
  }, [runId]);

  /** Runs one file action for this Run; its result is shown only if nothing newer started. */
  const act = async <T,>(work: () => Promise<T>, done: (value: T) => void, failed: (message: string) => void) => {
    const ticket = actions.current.begin();
    try {
      const value = await work();
      if (actions.current.isCurrent(ticket)) done(value);
    } catch (reason) {
      if (actions.current.isCurrent(ticket)) failed(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const download = (filePath: string) => {
    setNote(null);
    void act(
      () => downloadTextPreview(runsApi, saveFile, runId, filePath),
      (text) => setNote({ text, tone: "info" }),
      (message) => setNote({ text: `The preview was not downloaded: ${message}`, tone: "error" }),
    );
  };

  const togglePreview = (filePath: string) => {
    if (preview?.path === filePath) {
      setPreview(null);
      return;
    }
    setLoadingPreview(filePath);
    setNote(null);
    void act(
      () => runsApi.file(runId, filePath),
      (file) => {
        setPreview({ path: file.path, content: file.content, truncated: file.truncated, size: file.size });
        setLoadingPreview(null);
      },
      (message) => {
        setNote({ text: message, tone: "error" });
        setLoadingPreview(null);
      },
    );
  };

  const downloadAll = () => {
    setDownloadingAll(true);
    setNote(null);
    void act(
      () => downloadRunArchive(runsApi, saveFile, runId),
      (text) => {
        setNote({ text, tone: "info" });
        setDownloadingAll(false);
      },
      (message) => {
        setNote({ text: archiveFailure(message), tone: "error" });
        setDownloadingAll(false);
      },
    );
  };

  const files = listing.state.status === "ready" ? listing.state.value.files : null;
  const truncated = listing.state.status === "ready" && listing.state.value.truncated;
  return (
    <section className="page-section" aria-labelledby="run-files-heading">
      <div className="section-copy">
        <h2 id="run-files-heading">Files in this run's copy</h2>
        <p className="meta">
          Agents work on a copy, so nothing here has changed your project. The ZIP has the full bytes of every file it includes, binary files
          too, up to 500 files and 100 MB; it never includes dependency, VCS or build folders, credential-named files, or links. A text preview
          is redacted text of at most {PREVIEW_LIMIT_TEXT}, not the file itself.
        </p>
        {files !== null && files.length > 0 && (
          <Button variant="primary" busy={downloadingAll} onClick={downloadAll}>
            Download Run folder as ZIP
          </Button>
        )}
      </div>
      {note !== null && <p className={note.tone === "error" ? "notice notice-blocked" : "notice notice-passed"} role="status">{note.text}</p>}
      {listing.state.status === "error" && <ErrorState title="The file list did not load" message={listing.state.message} onRetry={listing.reload} />}
      {(listing.state.status === "loading" || listing.state.status === "idle") && <Loading label="Loading files" />}
      {truncated && <p className="notice notice-held">This list stops at 500 files or 8 folder levels; the copy has more. Use the ZIP, which reports its own limits.</p>}
      {files !== null && files.length === 0 && <p className="meta">No files are left in this run's copy.</p>}
      {files !== null && files.length > 0 && (
        <DataTable caption="Files in this run's copy">
          <thead>
            <tr><th>File</th><th>Size</th><th>Changed</th><th><span className="sr-only">File actions</span></th></tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <Fragment key={file.path}>
                <tr>
                  <td className="cell-file"><ForeignInline>{file.path}</ForeignInline></td>
                  <td className="tabular">{formatBytes(file.size)}</td>
                  <td className="tabular">{new Date(file.modifiedAt).toLocaleString()}</td>
                  <td className="run-file-actions">
                    <Button
                      variant="ghost"
                      aria-expanded={preview?.path === file.path}
                      aria-controls={`run-file-preview-${encodeURIComponent(file.path)}`}
                      busy={loadingPreview === file.path}
                      onClick={() => togglePreview(file.path)}
                    >
                      {preview?.path === file.path ? "Hide preview" : "Preview"}
                    </Button>
                    <Button variant="ghost" aria-label={`Download text preview of ${file.path}`} onClick={() => download(file.path)}>
                      Download text preview
                    </Button>
                  </td>
                </tr>
                {preview?.path === file.path && (
                  <tr>
                    <td colSpan={4}>
                      <div id={`run-file-preview-${encodeURIComponent(file.path)}`} className="run-file-preview">
                        <div className="run-file-preview-head">
                          <strong>{file.path}</strong>
                          {preview.truncated && <span className="meta">Preview shows the first {PREVIEW_LIMIT_TEXT} of {formatBytes(preview.size)}.</span>}
                        </div>
                        <pre><code>{preview.content}</code></pre>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
