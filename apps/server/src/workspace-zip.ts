import { readFile, realpath, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveInside, type WorkspaceEntry } from "./workspace-files.js";

const MAX_FILES = 500;
const MAX_BYTES = 100 * 1024 * 1024;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".deleted", ".next", "coverage"]);
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".azure", ".gcloud", ".secrets", "secrets", ".gnupg", ".docker", ".kube"]);
const SENSITIVE_FILES = new Set([".env", ".npmrc", ".netrc", ".pgpass", ".git-credentials", "credentials.json", "secrets.json", "client_secret.json"]);
function isSensitive(name: string): boolean {
  const base = path.posix.basename(name).toLowerCase();
  return SENSITIVE_FILES.has(base) || /^\.env(?:rc)?(?:[._-].*)?$/.test(base) || /\.env(?:\..*)?$/.test(base) || /\.(?:pem|key|p8|p12|pfx|ppk|keystore|jks|tfstate|tfvars)$/.test(base) || name.split("/").some((part) => SENSITIVE_DIRS.has(part.toLowerCase()));
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name: string): string {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("The workspace contains a path that cannot be safely archived");
  }
  return name;
}

/** What a Run ZIP left out on purpose, so the UI can say so instead of implying a whole folder. */
export interface ArchiveManifest {
  files: number;
  /** Folders never archived (dependencies, VCS and build output) that were present. */
  excludedDirectories: number;
  /** Credential-named files or folders that were present. */
  credentialEntries: number;
  /** Links (never archived or followed) and other non-regular entries. */
  skippedEntries: number;
}

/** Builds a stored ZIP from full file bytes, retaining binary data and original relative paths. */
export async function zipWorkspace(root: string, files?: WorkspaceEntry[]): Promise<Buffer> {
  return (await zipWorkspaceWithManifest(root, files)).archive;
}

/** The ZIP and what it omitted. Throws, rather than archiving part of the folder, when a limit is exceeded. */
export async function zipWorkspaceWithManifest(root: string, files?: WorkspaceEntry[]): Promise<{ archive: Buffer; manifest: ArchiveManifest }> {
  const manifest: ArchiveManifest = { files: 0, excludedDirectories: 0, credentialEntries: 0, skippedEntries: 0 };
  let entries = files;
  if (entries === undefined) {
    entries = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      for (const item of await readdir(current.directory, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(item.name)) {
          manifest.excludedDirectories += 1;
          continue;
        }
        const absolute = path.join(current.directory, item.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (isSensitive(relative)) {
          manifest.credentialEntries += 1;
          continue;
        }
        if (item.isDirectory()) {
          if (current.depth >= 16) throw new Error("The workspace folder is nested too deeply to archive safely");
          queue.push({ directory: absolute, depth: current.depth + 1 });
        } else if (item.isFile()) {
          if (entries.length >= MAX_FILES) throw new Error(`The workspace contains more than ${MAX_FILES} files; the archive is limited to ${MAX_FILES}.`);
          entries.push({ path: relative, size: 0, modifiedAt: "" });
        } else {
          manifest.skippedEntries += 1;
        }
      }
    }
  }
  if (entries.length > MAX_FILES) throw new Error(`This Run has more than ${MAX_FILES} files; the archive is limited to ${MAX_FILES}.`);
  const realRoot = await realpath(root);
  const records: Array<{ name: Buffer; content: Buffer; crc: number }> = [];
  let total = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeName(entry.path), "utf8");
    if (name.length > 0xffff) throw new Error("A workspace file path is too long to archive");
    const target = resolveInside(root, entry.path);
    const realFile = await realpath(target).catch(() => null);
    // A link out of the copy, or a dangling one, is never followed.
    if (realFile === null || !realFile.startsWith(realRoot + path.sep)) {
      manifest.skippedEntries += 1;
      continue;
    }
    const info = await stat(realFile);
    if (!info.isFile()) {
      manifest.skippedEntries += 1;
      continue;
    }
    const content = await readFile(realFile);
    total += content.length;
    if (total > MAX_BYTES) throw new Error("The workspace exceeds the 100 MB archive limit");
    records.push({ name, content, crc: crc32(content) });
  }
  let localSize = 0, centralSize = 0;
  for (const record of records) { localSize += 30 + record.name.length + record.content.length; centralSize += 46 + record.name.length; }
  const result = Buffer.alloc(localSize + centralSize + 22);
  let offset = 0;
  const central: Array<{ record: typeof records[number]; offset: number }> = [];
  for (const record of records) {
    const start = offset;
    central.push({ record, offset: start });
    result.writeUInt32LE(0x04034b50, offset); result.writeUInt16LE(20, offset + 4); result.writeUInt16LE(0x0800, offset + 6);
    result.writeUInt32LE(record.crc, offset + 14); result.writeUInt32LE(record.content.length, offset + 18); result.writeUInt32LE(record.content.length, offset + 22);
    result.writeUInt16LE(record.name.length, offset + 26); offset += 30;
    record.name.copy(result, offset); offset += record.name.length; record.content.copy(result, offset); offset += record.content.length;
  }
  const centralOffset = offset;
  for (const { record, offset: localOffset } of central) {
    result.writeUInt32LE(0x02014b50, offset); result.writeUInt16LE(20, offset + 4); result.writeUInt16LE(20, offset + 6); result.writeUInt16LE(0x0800, offset + 8);
    result.writeUInt32LE(record.crc, offset + 16); result.writeUInt32LE(record.content.length, offset + 20); result.writeUInt32LE(record.content.length, offset + 24);
    result.writeUInt16LE(record.name.length, offset + 28); result.writeUInt32LE(localOffset, offset + 42); offset += 46;
    record.name.copy(result, offset); offset += record.name.length;
  }
  result.writeUInt32LE(0x06054b50, offset); result.writeUInt16LE(records.length, offset + 8); result.writeUInt16LE(records.length, offset + 10);
  result.writeUInt32LE(centralSize, offset + 12); result.writeUInt32LE(centralOffset, offset + 16);
  manifest.files = records.length;
  return { archive: result, manifest };
}
