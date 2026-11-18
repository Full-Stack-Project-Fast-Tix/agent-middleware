import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  SNAPSHOT_EXCLUDED_DIRECTORIES,
  SNAPSHOT_LIMITS,
  snapshotCoverageSchema,
  type SnapshotCoverage,
  type SnapshotStopReason,
} from "@launchpad/shared";
import { isCredentialPath } from "./credential-names.js";
import { redactSensitiveText } from "./redaction/index.js";

// One bounded scan of a Run's working copy, used for both the baseline taken
// right after the copy is made and the final scan taken after execution stops.
// Both sides use exactly this walk, these exclusions and these limits, so a path
// is compared only against a scan that could have seen it.
//
// The walk is breadth-first in byte order of names, so an unchanged tree yields
// the same entries on both sides even when a limit stops it. Every limit is
// checked before reading: a file is hashed only after its size is known, and a
// scan that stops says why. Reaching a limit exactly is not a stop; finding one
// more entry is.
//
// Links are recorded, never followed: a link's "content" is its target text.
// Files are opened with O_NOFOLLOW, and only real directories are descended into,
// so nothing outside the copy is read. Credential-named paths are hashed (to
// notice a change) but their contents are never kept.

export const SNAPSHOT_VERSION = 2;

/** What the scan knows about one entry's contents. */
export type SnapshotContent =
  | "text"
  | "binary"
  | "oversized"
  | "text_too_large"
  | "text_not_retained"
  | "unreadable"
  | "credential_withheld"
  | "link"
  | "special";

const snapshotEntrySchema = z.object({
  type: z.enum(["file", "symlink", "other"]),
  size: z.number().int().nonnegative().nullable(),
  /** SHA-256 of a file's bytes or a link's target; null when not hashed. */
  hash: z.string().nullable(),
  content: z.enum(["text", "binary", "oversized", "text_too_large", "text_not_retained", "unreadable", "credential_withheld", "link", "special"]),
  /** Redacted text, kept only by a scan that retains text. */
  text: z.string().optional(),
  /** Redacted, bounded link target. */
  target: z.string().optional(),
});
export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

const workspaceSnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  capturedAt: z.string(),
  coverage: snapshotCoverageSchema,
  entries: z.record(z.string(), snapshotEntrySchema),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export class SnapshotRootMissingError extends Error {
  constructor() {
    super("The working copy does not exist");
    this.name = "SnapshotRootMissingError";
  }
}

export interface SnapshotOptions {
  /** Keep redacted text for a later line diff (the baseline does; the final scan reads text on demand). */
  retainText: boolean;
  now?: () => string;
  /** Overrides for tests; the shared SNAPSHOT_LIMITS otherwise. */
  limits?: Partial<typeof SNAPSHOT_LIMITS>;
}

const EXCLUDED: ReadonlySet<string> = new Set(SNAPSHOT_EXCLUDED_DIRECTORIES);
const MAX_LINK_TARGET = 1_000;

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Scan `root` within the shared bounds. Throws only when `root` itself is missing. */
export async function captureSnapshot(root: string, options: SnapshotOptions): Promise<WorkspaceSnapshot> {
  const limits = { ...SNAPSHOT_LIMITS, ...options.limits };
  const rootInfo = await lstat(root).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory()) throw new SnapshotRootMissingError();

  const entries: Record<string, SnapshotEntry> = {};
  const stops = new Set<SnapshotStopReason>();
  const queue: Array<{ directory: string; relative: string; depth: number }> = [{ directory: root, relative: "", depth: 0 }];
  let examined = 0;
  let recorded = 0;
  let hashedBytes = 0;
  let textBytes = 0;
  let unreadableDirectories = 0;

  walk: while (queue.length > 0) {
    const current = queue.shift()!;
    let items;
    try {
      items = await readdir(current.directory, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      stops.add("directory_unreadable");
      continue;
    }
    items.sort((a, b) => byteOrder(a.name, b.name));
    for (const item of items) {
      examined += 1;
      if (examined > limits.maxDirectoryEntries) {
        stops.add("traversal_limit");
        break walk;
      }
      const absolute = path.join(current.directory, item.name);
      const relative = current.relative === "" ? item.name : `${current.relative}/${item.name}`;
      if (item.isDirectory()) {
        if (EXCLUDED.has(item.name)) continue;
        if (current.depth + 1 > limits.maxDepth) {
          stops.add("depth_limit");
          continue;
        }
        queue.push({ directory: absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (recorded >= limits.maxFiles) {
        stops.add("file_limit");
        break walk;
      }
      if (item.isSymbolicLink()) {
        recorded += 1;
        entries[relative] = await linkEntry(absolute);
        continue;
      }
      if (!item.isFile()) {
        recorded += 1;
        entries[relative] = { type: "other", size: null, hash: null, content: "special" };
        continue;
      }
      const info = await lstat(absolute).catch(() => null);
      if (info === null || !info.isFile()) {
        recorded += 1;
        entries[relative] = { type: "file", size: info?.size ?? null, hash: null, content: "unreadable" };
        continue;
      }
      if (info.size > limits.maxHashFileBytes) {
        recorded += 1;
        entries[relative] = { type: "file", size: info.size, hash: null, content: "oversized" };
        continue;
      }
      if (hashedBytes + info.size > limits.maxTotalHashBytes) {
        stops.add("hash_budget");
        break walk;
      }
      recorded += 1;
      const bytes = await readRegularFile(absolute, limits.maxHashFileBytes);
      if (bytes === null) {
        entries[relative] = { type: "file", size: info.size, hash: null, content: "unreadable" };
        continue;
      }
      hashedBytes += bytes.length;
      const entry: SnapshotEntry = { type: "file", size: bytes.length, hash: sha256(bytes), content: "text" };
      if (isCredentialPath(relative)) entry.content = "credential_withheld";
      else if (bytes.includes(0)) entry.content = "binary";
      else if (bytes.length > limits.maxTextFileBytes) entry.content = "text_too_large";
      else if (options.retainText) {
        if (textBytes + bytes.length <= limits.maxBaselineTextBytes) {
          textBytes += bytes.length;
          entry.text = redactSensitiveText(bytes.toString("utf8"));
        } else {
          entry.content = "text_not_retained";
        }
      }
      entries[relative] = entry;
    }
  }

  const coverage: SnapshotCoverage = {
    complete: stops.size === 0,
    stopReasons: [...stops].sort(),
    entriesRecorded: recorded,
    unreadableDirectories,
  };
  return {
    version: SNAPSHOT_VERSION,
    capturedAt: (options.now ?? (() => new Date().toISOString()))(),
    coverage,
    entries,
  };
}

async function linkEntry(absolute: string): Promise<SnapshotEntry> {
  const target = await readlink(absolute).catch(() => null);
  if (target === null) return { type: "symlink", size: null, hash: null, content: "unreadable" };
  const shown = redactSensitiveText(target);
  return {
    type: "symlink",
    size: Buffer.byteLength(target),
    hash: sha256(Buffer.from(`link:${target}`, "utf8")),
    content: "link",
    target: shown.length <= MAX_LINK_TARGET ? shown : shown.slice(0, MAX_LINK_TARGET - 1) + "…",
  };
}

/** A regular file's bytes without following a link at the last component; null if it is not one or is too large. */
export async function readRegularFile(absolute: string, maxBytes: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === info.size ? buffer : buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read a file at a relative path inside `root`, refusing any path whose parent
 * directories are not the real directories they name (an agent may have
 * replaced one with a link). Null when absent, a link, unreadable or too large.
 */
export async function readFileInside(root: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  if (!isSafeRelative(relative)) return null;
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) return null;
  const parent = path.dirname(path.join(root, relative));
  const realParent = await realpath(parent).catch(() => null);
  const expectedParent = path.dirname(path.join(realRoot, relative));
  if (realParent === null || realParent !== expectedParent) return null;
  return readRegularFile(path.join(realRoot, relative), maxBytes);
}

/**
 * Whether anything exists at `relative` reached only through real directories.
 * A path whose parent was replaced by a link counts as absent there.
 */
export async function existsInside(root: string, relative: string): Promise<boolean> {
  if (!isSafeRelative(relative)) return false;
  let current = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const info = await lstat(current).catch(() => null);
    if (info === null) return false;
    if (index < segments.length - 1 && !info.isDirectory()) return false;
  }
  return true;
}

function isSafeRelative(relative: string): boolean {
  return (
    relative.length > 0 &&
    !relative.includes("\0") &&
    !path.isAbsolute(relative) &&
    relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BaselineRead =
  | { status: "available"; snapshot: WorkspaceSnapshot }
  | { status: "missing" | "legacy" | "corrupt" };

/** The baseline at `file`, distinguishing absent, older-format and unreadable ones. Never creates one. */
export async function readBaseline(file: string): Promise<BaselineRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "corrupt" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "corrupt" };
  }
  if (raw !== null && typeof raw === "object" && !("version" in raw) && "files" in raw) return { status: "legacy" };
  const parsed = workspaceSnapshotSchema.safeParse(raw);
  return parsed.success ? { status: "available", snapshot: parsed.data } : { status: "corrupt" };
}

/** Write JSON so a reader sees the old file or the whole new one, never a partial one. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
