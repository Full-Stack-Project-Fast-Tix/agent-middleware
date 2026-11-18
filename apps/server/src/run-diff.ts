import { readFile } from "node:fs/promises";
import {
  RUN_DIFF_LIMITS,
  RUN_DIFF_VERSION,
  SNAPSHOT_EXCLUDED_DIRECTORIES,
  SNAPSHOT_LIMITS,
  runDiffResponseSchema,
  type RunDiffBaselineStatus,
  type RunDiffChange,
  type RunDiffChangeReason,
  type RunDiffHunk,
  type RunDiffInventoryReason,
  type RunDiffResponse,
} from "@launchpad/shared";
import { diffLines, splitLines } from "./line-diff.js";
import { redactSensitiveText } from "./redaction/index.js";
import {
  SnapshotRootMissingError,
  captureSnapshot,
  presenceInside,
  readBaseline,
  readFileInside,
  sha256,
  writeJsonAtomic,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.js";

// The actual changes in a Run's working copy: the baseline captured when the
// copy was made, against a scan taken after execution stopped. Both scans are
// the same bounded walk (workspace-snapshot.ts). The artifact is computed once,
// written atomically outside the copy, and served unchanged afterwards, so Run
// Detail shows exactly what the final review saw.
//
// Never compared: a missing, older-format or corrupt baseline. Nothing here
// ever captures a replacement baseline, because one taken after edits would
// make those edits disappear.

const SCOPE = {
  excludedDirectories: [...SNAPSHOT_EXCLUDED_DIRECTORIES],
  maxFiles: SNAPSHOT_LIMITS.maxFiles,
  maxDepth: SNAPSHOT_LIMITS.maxDepth,
  maxHashFileBytes: SNAPSHOT_LIMITS.maxHashFileBytes,
  maxTextFileBytes: SNAPSHOT_LIMITS.maxTextFileBytes,
};

export interface RunDiffPaths {
  workspaceRoot: string;
  baselinePath: string;
  artifactPath: string;
}

/**
 * The Run's diff artifact: the saved one when present, otherwise computed and
 * saved. Call only once execution has stopped. A cached artifact from an older
 * version is returned as legacy, claiming no coverage, and never overwritten.
 */
export async function loadOrComputeRunDiff(paths: RunDiffPaths, now: () => string = () => new Date().toISOString()): Promise<RunDiffResponse> {
  const saved = await readSavedArtifact(paths.artifactPath);
  if (saved !== null) return saved;
  const artifact = await computeRunDiff(paths.workspaceRoot, paths.baselinePath, now);
  await writeJsonAtomic(paths.artifactPath, artifact);
  return artifact;
}

/** A diff that compares nothing, for a baseline or copy that is not there. */
export function unavailableRunDiff(baseline: RunDiffBaselineStatus, reasons: RunDiffInventoryReason[], generatedAt: string | null): RunDiffResponse {
  return runDiffResponseSchema.parse({
    version: RUN_DIFF_VERSION,
    generatedAt,
    baseline,
    changes: [],
    changedFileCount: null,
    uncertainCount: 0,
    listTruncated: false,
    coverage: {
      inventory: { status: "unavailable", reasons, baseline: null, final: null },
      content: { status: "unknown", changedEntries: 0, completeEntries: 0 },
    },
    scope: SCOPE,
  });
}

async function readSavedArtifact(file: string): Promise<RunDiffResponse | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Missing or unreadable: compute it again from the baseline and the stopped copy.
    return null;
  }
  const current = runDiffResponseSchema.safeParse(raw);
  if (current.success && current.data.version === RUN_DIFF_VERSION) return current.data;
  return legacyArtifact(raw);
}

/** A version 1 artifact: shown for what it says, with no claim of coverage or positions. */
function legacyArtifact(raw: unknown): RunDiffResponse | null {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { changes?: unknown }).changes)) return null;
  const legacy = raw as { changes: Array<Record<string, unknown>>; changedFileCount?: unknown; baselineAvailable?: unknown };
  const changes: RunDiffChange[] = legacy.changes.slice(0, RUN_DIFF_LIMITS.maxListedChanges).flatMap((change) => {
    const kind = change.kind;
    if (typeof change.path !== "string" || (kind !== "added" && kind !== "modified" && kind !== "deleted")) return [];
    const text = typeof change.diff === "string" ? redactSensitiveText(change.diff).slice(0, RUN_DIFF_LIMITS.maxHunkCharsPerEntry) : null;
    return [{
      path: change.path,
      kind,
      entryType: "file" as const,
      content: text === null ? "unavailable" as const : "partial" as const,
      reasons: [],
      hunks: text === null ? [] : [{ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, text }],
      size: null,
    }];
  });
  const count = typeof legacy.changedFileCount === "number" && Number.isInteger(legacy.changedFileCount) && legacy.changedFileCount >= 0
    ? legacy.changedFileCount
    : null;
  return runDiffResponseSchema.parse({
    version: 1,
    generatedAt: null,
    baseline: legacy.baselineAvailable === true ? "legacy" : "missing",
    changes,
    changedFileCount: count,
    uncertainCount: 0,
    listTruncated: count !== null && count > changes.length,
    coverage: {
      inventory: { status: "incomplete", reasons: ["legacy_artifact"], baseline: null, final: null },
      content: { status: "unknown", changedEntries: count ?? changes.length, completeEntries: 0 },
    },
    scope: SCOPE,
  });
}

/** Compare the baseline with the copy as it is now. Pure apart from reading both. */
export async function computeRunDiff(workspaceRoot: string, baselinePath: string, now: () => string): Promise<RunDiffResponse> {
  const generatedAt = now();
  const baselineRead = await readBaseline(baselinePath);
  if (baselineRead.status !== "available") {
    return unavailableRunDiff(baselineRead.status, [`baseline_${baselineRead.status}`], generatedAt);
  }
  const baseline = baselineRead.snapshot;
  let final: WorkspaceSnapshot;
  try {
    final = await captureSnapshot(workspaceRoot, { retainText: false, now });
  } catch (error) {
    if (error instanceof SnapshotRootMissingError) return unavailableRunDiff("available", ["working_copy_missing"], generatedAt);
    throw error;
  }

  const inventoryReasons: RunDiffInventoryReason[] = [];
  if (!baseline.coverage.complete) inventoryReasons.push("baseline_scan_incomplete");
  if (!final.coverage.complete) inventoryReasons.push("final_scan_incomplete");

  const budget = { finalTextBytes: RUN_DIFF_LIMITS.maxFinalTextBytes, hunkChars: RUN_DIFF_LIMITS.maxTotalHunkChars };
  const changes: RunDiffChange[] = [];
  let changed = 0;
  let uncertain = 0;
  let completeEntries = 0;
  let unlisted = 0;
  const paths = [...new Set([...Object.keys(baseline.entries), ...Object.keys(final.entries)])].sort();
  for (const filePath of paths) {
    const before = baseline.entries[filePath];
    const after = final.entries[filePath];
    const change = await compareEntry(workspaceRoot, filePath, before, after, baseline.coverage.complete, final.coverage.complete, budget);
    if (change === null) continue;
    if (change.kind === "uncertain") uncertain += 1;
    else changed += 1;
    if (changes.length < RUN_DIFF_LIMITS.maxListedChanges) {
      changes.push(change);
      if (change.content === "complete") completeEntries += 1;
    } else {
      unlisted += 1;
    }
  }

  const inventoryComplete = inventoryReasons.length === 0;
  const allContentComplete = unlisted === 0 && completeEntries === changes.length;
  return runDiffResponseSchema.parse({
    version: RUN_DIFF_VERSION,
    generatedAt,
    baseline: "available",
    changes,
    changedFileCount: changed,
    uncertainCount: uncertain,
    listTruncated: unlisted > 0,
    coverage: {
      inventory: {
        status: inventoryComplete ? "complete" : "incomplete",
        reasons: inventoryReasons,
        baseline: baseline.coverage,
        final: final.coverage,
      },
      content: {
        status: allContentComplete ? "complete" : "incomplete",
        changedEntries: changed + uncertain,
        completeEntries,
      },
    },
    scope: SCOPE,
  });
}

interface Budget {
  finalTextBytes: number;
  hunkChars: number;
}

/** One path's change, or null when it is unchanged. */
async function compareEntry(
  root: string,
  filePath: string,
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined,
  baselineComplete: boolean,
  finalComplete: boolean,
  budget: Budget,
): Promise<RunDiffChange | null> {
  if (before !== undefined && after !== undefined) {
    if (before.type === after.type && before.type === "other") return null;
    if (before.type === after.type && before.hash !== null && after.hash !== null) {
      if (before.hash === after.hash) return null;
      return describe(root, filePath, "modified", before, after, budget);
    }
    if (before.type !== after.type) return describe(root, filePath, "modified", before, after, budget);
    // At least one side was not hashed: only a size difference proves a change.
    if (before.size !== null && after.size !== null && before.size !== after.size) {
      return describe(root, filePath, "modified", before, after, budget);
    }
    const reasons: RunDiffChangeReason[] =
      before.content === "oversized" && after.content === "oversized" ? ["size_only_comparison"] : ["unreadable"];
    return { path: filePath, kind: "uncertain", entryType: after.type, content: "unavailable", reasons, hunks: [], size: after.size };
  }
  if (before !== undefined) {
    // Absence is established by a complete scan, or by the filesystem saying so for the path itself.
    const gone = finalComplete || (await presenceInside(root, filePath)) === "absent";
    if (!gone) {
      return { path: filePath, kind: "uncertain", entryType: before.type, content: "unavailable", reasons: [], hunks: [], size: before.size };
    }
    return describe(root, filePath, "deleted", before, undefined, budget);
  }
  if (after !== undefined) {
    if (!baselineComplete) {
      return { path: filePath, kind: "uncertain", entryType: after.type, content: "unavailable", reasons: [], hunks: [], size: after.size };
    }
    return describe(root, filePath, "added", undefined, after, budget);
  }
  return null;
}

/** The changed lines of an established change, or why they are not all available. */
async function describe(
  root: string,
  filePath: string,
  kind: "added" | "modified" | "deleted",
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined,
  budget: Budget,
): Promise<RunDiffChange> {
  const entryType = (after ?? before)!.type;
  const size = (after ?? before)!.size;
  const reasons = new Set<RunDiffChangeReason>();
  const oldText = before === undefined ? "" : await textOf(root, filePath, before, "before", reasons, budget);
  const newText = after === undefined ? "" : await textOf(root, filePath, after, "after", reasons, budget);
  const base = { path: filePath, kind, entryType, size };
  if (oldText === null || newText === null) {
    return { ...base, content: "unavailable", reasons: [...reasons].sort(), hunks: [] };
  }
  const diff = diffLines(splitLines(oldText), splitLines(newText), { context: RUN_DIFF_LIMITS.contextLines, maxWork: RUN_DIFF_LIMITS.maxDiffWorkPerEntry });
  if (diff.hunks.length === 0) {
    // The bytes differ but nothing visible does: a redacted value or undecodable bytes changed.
    reasons.add("redacted_or_encoding_change");
    return { ...base, content: "partial", reasons: [...reasons].sort(), hunks: [] };
  }
  const { hunks, truncated } = boundHunks(diff.hunks, budget);
  if (truncated) reasons.add("hunks_truncated");
  // A link is shown by its target text, but the link itself was never followed.
  const complete = !truncated && !reasons.has("link_not_followed");
  return { ...base, content: complete ? "complete" : "partial", reasons: [...reasons].sort(), hunks };
}

/** Redacted text for one side, or null with a reason when it is not available. */
async function textOf(
  root: string,
  filePath: string,
  entry: SnapshotEntry,
  side: "before" | "after",
  reasons: Set<RunDiffChangeReason>,
  budget: Budget,
): Promise<string | null> {
  switch (entry.content) {
    case "link":
      reasons.add("link_not_followed");
      return `symlink -> ${entry.target ?? ""}`;
    case "special":
      reasons.add("special_file");
      return null;
    case "binary":
    case "oversized":
    case "text_too_large":
    case "unreadable":
    case "credential_withheld":
      reasons.add(entry.content);
      return null;
    case "text_not_retained":
      reasons.add("baseline_text_not_retained");
      return null;
    case "text":
      break;
  }
  if (side === "before") {
    if (entry.text !== undefined) return entry.text;
    reasons.add("baseline_text_not_retained");
    return null;
  }
  const size = entry.size ?? 0;
  if (size > budget.finalTextBytes) {
    reasons.add("final_text_not_read");
    return null;
  }
  const bytes = await readFileInside(root, filePath, SNAPSHOT_LIMITS.maxTextFileBytes);
  // A different hash means the file is not the one the scan recorded.
  if (bytes === null || sha256(bytes) !== entry.hash) {
    reasons.add("unreadable");
    return null;
  }
  budget.finalTextBytes -= bytes.length;
  return redactSensitiveText(bytes.toString("utf8"));
}

/** Keep whole hunks within the per-entry and total bounds; report whether any were dropped or cut. */
function boundHunks(hunks: RunDiffHunk[], budget: Budget): { hunks: RunDiffHunk[]; truncated: boolean } {
  const kept: RunDiffHunk[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const allowed = Math.min(RUN_DIFF_LIMITS.maxHunkCharsPerEntry - used, budget.hunkChars);
    if (hunk.text.length > allowed) {
      if (allowed > 200) {
        // Keep the start of the hunk that does not fit, so the reader sees where the cut is.
        kept.push({ ...hunk, text: hunk.text.slice(0, allowed) });
        budget.hunkChars -= allowed;
      }
      return { hunks: kept, truncated: true };
    }
    kept.push(hunk);
    used += hunk.text.length;
    budget.hunkChars -= hunk.text.length;
  }
  return { hunks: kept, truncated: false };
}
