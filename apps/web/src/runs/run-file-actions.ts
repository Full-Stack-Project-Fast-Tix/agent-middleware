import type { RunFileResponse } from "@launchpad/shared";

// The two ways to take files out of a Run, kept honest about what each gives:
//
//   text preview  one file as redacted text, at most its first 256 KB. Never
//                 the file's bytes: binary files are decoded as text, and
//                 credential-shaped values are replaced.
//   ZIP           full bytes of every file the archive includes, within its
//                 limits (500 files, 100 MB). Dependencies, VCS and build
//                 folders, credential-named files and links are left out.

export interface ArchiveManifest {
  files: number | null;
  excludedDirectories: number | null;
  credentialEntries: number | null;
  skippedEntries: number | null;
}

export interface FileActionsApi {
  file(runId: string, filePath: string): Promise<RunFileResponse>;
  archive(runId: string): Promise<{ blob: Blob; manifest: ArchiveManifest }>;
}

/** Hands a blob to the browser as a download. */
export type SaveFile = (blob: Blob, filename: string) => void;

export const PREVIEW_LIMIT_TEXT = "256 KB";

/** Download a text preview; returns what to tell the person about what they got. */
export async function downloadTextPreview(api: FileActionsApi, save: SaveFile, runId: string, filePath: string): Promise<string> {
  const file = await api.file(runId, filePath);
  const name = `${filePath.split("/").at(-1) ?? "file"}.preview.txt`;
  save(new Blob([file.content], { type: "text/plain" }), name);
  return file.truncated
    ? `Saved a text preview of ${filePath}: only its first ${PREVIEW_LIMIT_TEXT} of ${formatBytes(file.size)}, with credential-shaped values redacted. Download the ZIP for the full file.`
    : `Saved a text preview of ${filePath}, with credential-shaped values redacted. It is text, not the original bytes; the ZIP has those.`;
}

/** Download the Run's ZIP; returns what it left out. Throws with the server's reason when no ZIP was made. */
export async function downloadRunArchive(api: FileActionsApi, save: SaveFile, runId: string): Promise<string> {
  const { blob, manifest } = await api.archive(runId);
  save(blob, `agentguard-run-${runId}.zip`);
  return archiveNote(manifest);
}

export function archiveNote(manifest: ArchiveManifest): string {
  const left: string[] = [];
  if ((manifest.excludedDirectories ?? 0) > 0) left.push(`${count(manifest.excludedDirectories!, "dependency, VCS or build folder")}`);
  if ((manifest.credentialEntries ?? 0) > 0) left.push(`${count(manifest.credentialEntries!, "credential-named file or folder", "credential-named files or folders")}`);
  if ((manifest.skippedEntries ?? 0) > 0) left.push(`${count(manifest.skippedEntries!, "link or special file")}`);
  const saved = manifest.files === null ? "Saved the Run ZIP." : `Saved the Run ZIP with ${count(manifest.files, "file")}.`;
  if (manifest.excludedDirectories === null) return `${saved} The server did not say what it left out; dependency, VCS and build folders, credential-named files and links are never included.`;
  return left.length === 0 ? `${saved} Nothing was left out.` : `${saved} Left out on purpose: ${left.join(", ")}.`;
}

export function archiveFailure(message: string): string {
  return `No ZIP was downloaded: ${message} Nothing partial was saved.`;
}

/** Read the counts the server sends with a ZIP; a missing or malformed header is unknown. */
export function manifestFromHeaders(headers: Pick<Headers, "get">): ArchiveManifest {
  const number = (name: string) => {
    const value = headers.get(name);
    if (value === null || !/^\d+$/.test(value)) return null;
    return Number(value);
  };
  return {
    files: number("x-archive-files"),
    excludedDirectories: number("x-archive-excluded-directories"),
    credentialEntries: number("x-archive-credential-entries"),
    skippedEntries: number("x-archive-skipped-entries"),
  };
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
