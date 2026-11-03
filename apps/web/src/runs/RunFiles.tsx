import { Fragment, useEffect, useState } from "react";
import type { RunFilesResponse } from "@launchpad/shared";
import { Button, DataTable, ForeignInline } from "../ui";
import { runsApi } from "./runs-api";

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** What the agents left in this Run's copy of the project, even if the Run failed. */
export function RunFiles({ runId, runEnded }: { runId: string; runEnded: boolean }) {
  const [files, setFiles] = useState<RunFilesResponse["files"] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  useEffect(() => {
    let mounted = true;
    setFiles(null);
    setNote(null);
    setPreview(null);
    runsApi.files(runId).then(
      (loaded) => { if (mounted) setFiles(loaded); },
      (reason: unknown) => { if (mounted) setNote(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => {
      mounted = false;
    };
  }, [runId, runEnded]);

  const download = async (filePath: string) => {
    setNote(null);
    try {
      const file = await runsApi.file(runId, filePath);
      const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filePath.split("/").at(-1) ?? "file";
      link.click();
      URL.revokeObjectURL(url);
      if (file.truncated) setNote(`${filePath} was too large to send whole, so the download is only its start.`);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const togglePreview = async (filePath: string) => {
    if (preview?.path === filePath) {
      setPreview(null);
      return;
    }
    setLoadingPreview(filePath);
    setNote(null);
    try {
      const file = await runsApi.file(runId, filePath);
      setPreview({ path: file.path, content: file.content, truncated: file.truncated });
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingPreview(null);
    }
  };

  const downloadAll = async () => {
    if (files === null || files.length === 0) return;
    setDownloadingAll(true);
    setNote(null);
    try {
      const archive = await runsApi.archive(runId);
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agentguard-run-${runId}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <section className="page-section" aria-labelledby="run-files-heading">
      <div className="section-copy">
        <h2 id="run-files-heading">Files in this run's copy</h2>
        <p className="meta">Agents work on a copy, so nothing here has changed your project. Download the Run copy as a ZIP to keep full file bytes, including binary files. The archive omits dependencies, build output, and known credential files; limits are 500 files and 100 MB.</p>
        {files !== null && files.length > 0 && (
          <Button variant="primary" busy={downloadingAll} onClick={() => void downloadAll()}>
            Download Run folder as ZIP
          </Button>
        )}
      </div>
      {note !== null && <p className="notice notice-held" role="status">{note}</p>}
      {files === null && note === null && <p className="meta">Loading files…</p>}
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
                  <td className="tabular">{formatSize(file.size)}</td>
                  <td className="tabular">{new Date(file.modifiedAt).toLocaleString()}</td>
                  <td className="run-file-actions">
                    <Button
                      variant="ghost"
                      aria-expanded={preview?.path === file.path}
                      aria-controls={`run-file-preview-${encodeURIComponent(file.path)}`}
                      busy={loadingPreview === file.path}
                      onClick={() => void togglePreview(file.path)}
                    >
                      {preview?.path === file.path ? "Hide preview" : "Preview"}
                    </Button>
                    <Button variant="ghost" onClick={() => void download(file.path)}>Download</Button>
                  </td>
                </tr>
                {preview?.path === file.path && (
                  <tr>
                    <td colSpan={4}>
                      <div id={`run-file-preview-${encodeURIComponent(file.path)}`} className="run-file-preview">
                        <div className="run-file-preview-head">
                          <strong>{file.path}</strong>
                          {preview.truncated && <span className="meta">Preview shows the first 256 KB.</span>}
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
