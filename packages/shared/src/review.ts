import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";

// What changed in a Run's working copy, and whether AgentGuard's final review
// covered it. Four kinds of coverage stay separate here, because each fails in
// its own way and none implies another:
//
//   inventory   Did both bounded scans finish, so presence and absence are known?
//   content     Is every changed line of every changed entry in the artifact?
//   review      Did the semantic reviewer assess every changed hunk? (FinalReview)
//   preview     How much of one file a browser is sent (RunFileResponse.truncated).
//
// Unknown stays unknown: a missing baseline is not zero changes, a stopped scan
// is not an empty directory, and an entry that could not be read is changed with
// unavailable contents, never deleted.

/** Version of the stored diff artifact. A cached artifact of another version is shown as legacy and claims no coverage. */
export const RUN_DIFF_VERSION = 2;

/** Bounds shared by the baseline scan and the final scan. Both sides always use the same values. */
export const SNAPSHOT_LIMITS = {
  /** Files (and links) recorded. One more found means the scan stopped. */
  maxFiles: 500,
  /** Directory levels below the copy's root that are listed. */
  maxDepth: 16,
  /** Directory entries examined in total, across every listed directory. */
  maxDirectoryEntries: 20_000,
  /** Largest file hashed; larger files are present but cannot be compared by content. */
  maxHashFileBytes: 2 * 1024 * 1024,
  /** Bytes hashed in total in one scan. */
  maxTotalHashBytes: 128 * 1024 * 1024,
  /** Largest file whose text is kept for a line diff. */
  maxTextFileBytes: 256 * 1024,
  /** Text kept in total by the baseline scan. */
  maxBaselineTextBytes: 2 * 1024 * 1024,
} as const;

/** Directories neither scan lists: dependencies, VCS internals and build output. Changes inside them are not compared. */
export const SNAPSHOT_EXCLUDED_DIRECTORIES = ["node_modules", ".git", "dist", "build", ".next", "coverage"] as const;

/** Bounds on what the diff artifact stores. */
export const RUN_DIFF_LIMITS = {
  /** Changed entries listed. Beyond it the artifact lists no more, and says so. */
  maxListedChanges: 500,
  /** Hunk text kept per entry; more means the entry's content is partial. */
  maxHunkCharsPerEntry: 64_000,
  /** Hunk text kept in total. */
  maxTotalHunkChars: 2_000_000,
  /** Current-side text read in total to compute diffs. */
  maxFinalTextBytes: 8 * 1024 * 1024,
  /** Unchanged lines shown around each change. */
  contextLines: 2,
  /**
   * Line-diff work per entry before the changed region is shown as one
   * replacement (every old line removed, every new line added): coarser, never incomplete.
   */
  maxDiffWorkPerEntry: 20_000_000,
} as const;

export const snapshotStopReasonSchema = z.enum([
  /** More files than SNAPSHOT_LIMITS.maxFiles exist. */
  "file_limit",
  /** A directory deeper than SNAPSHOT_LIMITS.maxDepth has entries. */
  "depth_limit",
  /** SNAPSHOT_LIMITS.maxDirectoryEntries were examined before the walk ended. */
  "traversal_limit",
  /** SNAPSHOT_LIMITS.maxTotalHashBytes were hashed before the walk ended. */
  "hash_budget",
  /** A directory could not be listed; its contents are unknown, not empty. */
  "directory_unreadable",
]);
export type SnapshotStopReason = z.infer<typeof snapshotStopReasonSchema>;

/** One scan's coverage. `complete` means every entry within the declared scope was recorded. */
export const snapshotCoverageSchema = z.object({
  complete: z.boolean(),
  stopReasons: z.array(snapshotStopReasonSchema),
  entriesRecorded: z.number().int().nonnegative(),
  unreadableDirectories: z.number().int().nonnegative(),
});
export type SnapshotCoverage = z.infer<typeof snapshotCoverageSchema>;

/** Why one changed entry's content is not completely in the artifact. */
export const runDiffChangeReasonSchema = z.enum([
  "binary",
  /** Over SNAPSHOT_LIMITS.maxHashFileBytes: present, but never read. */
  "oversized",
  /** Hashed, but over SNAPSHOT_LIMITS.maxTextFileBytes for a line diff. */
  "text_too_large",
  /** The baseline's aggregate text budget was spent before this file. */
  "baseline_text_not_retained",
  /** The diff's aggregate current-text budget was spent before this file. */
  "final_text_not_read",
  "unreadable",
  /** A credential-named path: tracked by hash, contents never captured. */
  "credential_withheld",
  /** A symbolic link: its target text is shown, the link is never followed. */
  "link_not_followed",
  /** A socket, FIFO or device: present, no contents. */
  "special_file",
  /** Both sides are too large to hash and have the same size: whether it changed is unknown. */
  "size_only_comparison",
  /** Hashes differ but the redacted, decoded text is identical. */
  "redacted_or_encoding_change",
  /** Complete hunks exceed RUN_DIFF_LIMITS.maxHunkCharsPerEntry or the total. */
  "hunks_truncated",
]);
export type RunDiffChangeReason = z.infer<typeof runDiffChangeReasonSchema>;

/** A contiguous change with positions, as unified-diff lines (" ", "-", "+"), redacted. */
export const runDiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  text: z.string(),
});
export type RunDiffHunk = z.infer<typeof runDiffHunkSchema>;

export const runDiffChangeSchema = z.object({
  path: z.string(),
  /** `uncertain`: present on both sides but could not be compared, so it may or may not have changed. */
  kind: z.enum(["added", "modified", "deleted", "uncertain"]),
  /** The entry's type after the Run, or before it for a deletion. */
  entryType: z.enum(["file", "symlink", "other"]),
  /** `complete`: every changed line is in `hunks`. */
  content: z.enum(["complete", "partial", "unavailable"]),
  reasons: z.array(runDiffChangeReasonSchema),
  hunks: z.array(runDiffHunkSchema),
  /** Bytes after the Run (before it for a deletion); null when unknown. */
  size: z.number().int().nonnegative().nullable(),
});
export type RunDiffChange = z.infer<typeof runDiffChangeSchema>;

export const runDiffBaselineStatusSchema = z.enum([
  "available",
  /** No baseline was captured when the copy was made. Never recreated afterwards. */
  "missing",
  /** Captured by an older version whose scope differs; nothing is compared against it. */
  "legacy",
  "corrupt",
  /** Removed with the Run's other files after the retention period. */
  "expired",
]);
export type RunDiffBaselineStatus = z.infer<typeof runDiffBaselineStatusSchema>;

export const runDiffInventoryReasonSchema = z.enum([
  "baseline_missing",
  "baseline_legacy",
  "baseline_corrupt",
  "baseline_expired",
  "baseline_scan_incomplete",
  "final_scan_incomplete",
  "working_copy_missing",
  /** A cached artifact from an older version: no coverage is claimed. */
  "legacy_artifact",
]);
export type RunDiffInventoryReason = z.infer<typeof runDiffInventoryReasonSchema>;

export const runDiffResponseSchema = z.object({
  version: z.number().int().positive(),
  /** When the artifact was computed, after execution stopped; null for a legacy artifact. */
  generatedAt: timestampSchema.nullable(),
  baseline: runDiffBaselineStatusSchema,
  changes: z.array(runDiffChangeSchema),
  /** Added, modified and deleted entries found. Null when no comparison was possible; a lower bound when the inventory is incomplete. */
  changedFileCount: z.number().int().nonnegative().nullable(),
  /** Entries that may or may not have changed: present but not comparable, or outside a stopped scan. */
  uncertainCount: z.number().int().nonnegative(),
  /** `changes` lists fewer entries than `changedFileCount`. */
  listTruncated: z.boolean(),
  coverage: z.object({
    inventory: z.object({
      status: z.enum(["complete", "incomplete", "unavailable"]),
      reasons: z.array(runDiffInventoryReasonSchema),
      baseline: snapshotCoverageSchema.nullable(),
      final: snapshotCoverageSchema.nullable(),
    }),
    content: z.object({
      /** `complete` only when every listed and unlisted change has complete hunks. */
      status: z.enum(["complete", "incomplete", "unknown"]),
      changedEntries: z.number().int().nonnegative(),
      completeEntries: z.number().int().nonnegative(),
    }),
  }),
  /** The declared scope both scans used. */
  scope: z.object({
    excludedDirectories: z.array(z.string()),
    maxFiles: z.number().int().positive(),
    maxDepth: z.number().int().positive(),
    maxHashFileBytes: z.number().int().positive(),
    maxTextFileBytes: z.number().int().positive(),
  }),
});
export type RunDiffResponse = z.infer<typeof runDiffResponseSchema>;

/** True when the artifact establishes every change and every changed line. */
export function isRunDiffComplete(diff: RunDiffResponse): boolean {
  return (
    diff.version === RUN_DIFF_VERSION &&
    diff.baseline === "available" &&
    diff.coverage.inventory.status === "complete" &&
    diff.coverage.content.status === "complete" &&
    !diff.listTruncated &&
    diff.uncertainCount === 0 &&
    diff.changedFileCount !== null
  );
}

// ---------------------------------------------------------------------------
// Final review
// ---------------------------------------------------------------------------

/** Changed entries the final review accepts; more is incomplete. */
export const FINAL_REVIEW_MAX_FILES = 36;
/** Gated actions recorded for the final review; more is incomplete. */
export const FINAL_REVIEW_MAX_ACTIONS = 48;

export const FINAL_REVIEW_STATUSES = [
  /** Every change was reviewed and none conflicts with the request at review risk. */
  "aligned",
  /** A change conflicts with the request at risk 0.50 or more and no exact approval covers it. */
  "conflict",
  /** Some evidence could not be presented, so nothing was concluded. */
  "incomplete",
  /** The review could not be performed: the monitor or the diff failed. */
  "unavailable",
  /** A complete comparison found no changed files. */
  "no_changes",
  /** The Run ended before its final review. */
  "not_run",
  /** Semantic review is not configured for this server. */
  "disabled",
] as const;
export const finalReviewStatusSchema = z.enum(FINAL_REVIEW_STATUSES);
export type FinalReviewStatus = z.infer<typeof finalReviewStatusSchema>;

export const finalReviewReasonSchema = z.enum([
  "baseline_unavailable",
  "legacy_artifact",
  "inventory_incomplete",
  "comparison_uncertain",
  "content_incomplete",
  "list_truncated",
  "file_limit",
  "review_budget_exhausted",
  "action_ledger_incomplete",
  "effect_assessment_missing",
  "approval_unmatched",
  "scope_conflict",
  "monitor_error",
  "diff_error",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "semantic_review_disabled",
]);
export type FinalReviewReason = z.infer<typeof finalReviewReasonSchema>;

/**
 * The saved outcome of a Run's final review, success or failure. Absent (null)
 * means it was never recorded, as for Runs from before it existed: unknown,
 * not aligned.
 */
export const finalReviewSchema = z.object({
  status: finalReviewStatusSchema,
  reasons: z.array(finalReviewReasonSchema).max(16),
  reviewedAt: timestampSchema,
  coverage: z.object({
    /** From the diff; null when the comparison could not establish it. */
    changedFiles: z.number().int().nonnegative().nullable(),
    /** Hunks or hunk parts that needed an assessment. */
    effects: z.number().int().nonnegative(),
    /** Of those, how many the reviewer assessed. */
    assessedEffects: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    /** Gated actions given to the reviewer. */
    actions: z.number().int().nonnegative(),
    actionLedgerComplete: z.boolean(),
    approvals: z.number().int().nonnegative(),
  }),
  riskScore: z.number().min(0).max(1).nullable(),
  classification: z.string().max(64).nullable(),
  /** Model-written and redacted: the reviewer's explanation, not a fact. */
  rationale: z.string().max(1_000).nullable(),
  /** Paths with a conflicting change, to link to the diff. */
  conflictingPaths: z.array(z.string().max(300)).max(24),
  /** Approvals whose exact proposal covered a conflicting change. */
  approvalsApplied: z.array(idSchema).max(16),
  /** The finding recorded when the review stopped the Run. */
  findingId: idSchema.nullable(),
  /** The reviewer's own model usage, separate from agent execution usage. */
  monitorUsage: z
    .object({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      durationMs: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type FinalReview = z.infer<typeof finalReviewSchema>;
