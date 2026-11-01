import { useEffect, useState } from "react";
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

  useEffect(() => {
    let mounted = true;
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

  return (
    <section className="page-section" aria-labelledby="run-files-heading">
      <div className="section-copy">
        <h2 id="run-files-heading">Files in this run's copy</h2>
        <p className="meta">Agents work on a copy, so nothing here has changed your project. Check a file before you use it.</p>
      </div>
      {note !== null && <p className="notice notice-held" role="status">{note}</p>}
      {files !== null && files.length === 0 && <p className="meta">No files are left in this run's copy.</p>}
      {files !== null && files.length > 0 && (
        <DataTable caption="Files in this run's copy">
          <thead>
            <tr><th>File</th><th>Size</th><th>Changed</th><th><span className="sr-only">Download</span></th></tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.path}>
                <td className="cell-file"><ForeignInline>{file.path}</ForeignInline></td>
                <td className="tabular">{formatSize(file.size)}</td>
                <td className="tabular">{new Date(file.modifiedAt).toLocaleString()}</td>
                <td><Button variant="ghost" onClick={() => void download(file.path)}>Download</Button></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
