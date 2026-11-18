import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Run, RunDiffResponse } from "@launchpad/shared";
import type { WorkingCopies } from "./ports.js";
import { isCredentialName } from "../credential-names.js";
import { loadOrComputeRunDiff } from "../run-diff.js";
import { captureSnapshot, writeJsonAtomic } from "../workspace-snapshot.js";

// One isolated copy of the project per Run:
//
//   <root>/<runId>/workspace           the copy agents work in
//   <root>/<runId>/diff-baseline.json  bounded scan taken right after copying
//   <root>/<runId>/diff.json           the actual diff, written once execution stops
//
// The first Run copies the configured source. Later Runs copy the latest
// successful Run's files, so prompts continue the project while the configured
// source and completed Run artifacts remain untouched.
//
// The baseline is captured only when the copy is created, before any agent can
// touch it. A copy that already exists without one keeps no baseline: capturing
// one after edits would erase exactly the changes the diff exists to show.
//
// Symbolic links are copied as links, verbatim, never followed. Following one
// could pull a file from outside the project (a key in ~/.ssh) into the copy.
// Inside the container a link that points outside /workspace resolves to
// nothing. Anything on the host that later reads the copy must still refuse to
// follow links out of it.

// The credential exclusions are a curated filename denylist in
// credential-names.ts, not secret detection: a credential under any other name
// is still copied.

/** Never copied: rebuildable dependencies, tool and VCS state, and local credential stores. */
export const DEFAULT_EXCLUDED_NAMES = ["node_modules", ".codex", ".git"] as const;

export interface WorkspaceSources {
  /** The project's files on this host, or null for a workspace that starts empty. */
  sourcePath(workspaceId: string): Promise<string | null>;
}

export class DirectoryWorkingCopies implements WorkingCopies {
  private readonly root: string;
  private readonly sources: WorkspaceSources;
  private readonly excluded: ReadonlySet<string>;

  constructor(options: { root: string; sources: WorkspaceSources; excludedNames?: readonly string[] }) {
    this.root = path.resolve(options.root);
    this.sources = options.sources;
    // Caller exclusions can add to the platform defaults, but cannot turn
    // secret-file filtering off for one execution.
    this.excluded = new Set(
      [...DEFAULT_EXCLUDED_NAMES, ...(options.excludedNames ?? [])].map((name) => name.toLowerCase()),
    );
  }

  /** Where a Run's copy lives. The id is checked so it cannot climb out of the root. */
  pathFor(runId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error(`Not a run id: ${JSON.stringify(runId)}`);
    }
    return path.join(this.root, runId, "workspace");
  }

  async prepare(run: Run): Promise<string> {
    const target = this.pathFor(run.id);
    // Already prepared, possibly already edited: never take a new baseline here.
    if (await exists(target)) return target;
    await mkdir(path.dirname(target), { recursive: true });

    const source = run.parentRunId === null
      ? await this.sources.sourcePath(run.workspaceId)
      : this.pathFor(run.parentRunId);
    if (source === null) {
      await mkdir(target);
      await saveBaseline(target);
      return target;
    }
    const resolvedSource = path.resolve(source);
    const info = await stat(resolvedSource).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`The workspace source is not a directory: ${resolvedSource}`);
    }
    if (run.parentRunId === null && (isInside(this.root, resolvedSource) || isInside(resolvedSource, this.root))) {
      // Copying a tree into itself, or the run copies into each new copy.
      throw new Error("The workspace source and the working-copy root must not contain each other");
    }
    if (run.parentRunId !== null && (!isInside(this.root, resolvedSource) || isInside(resolvedSource, target))) {
      throw new Error("The parent Run working copy is outside the configured working-copy root");
    }

    await cp(resolvedSource, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (entry) => entry === resolvedSource || !this.isExcluded(entry),
    });
    await saveBaseline(target);
    return target;
  }

  /** The Run's actual diff. Call once execution has stopped; the first call saves it. */
  async diff(runId: string): Promise<RunDiffResponse> {
    return loadOrComputeRunDiff(runDiffPaths(this.pathFor(runId)));
  }

  private isExcluded(entry: string): boolean {
    const name = path.basename(entry).toLowerCase();
    return this.excluded.has(name) || isCredentialName(name);
  }
}

/** Where a Run's diff inputs and artifact live, next to (never inside) its copy. */
export function runDiffPaths(workspace: string) {
  const runDirectory = path.dirname(workspace);
  return {
    workspaceRoot: workspace,
    baselinePath: path.join(runDirectory, "diff-baseline.json"),
    artifactPath: path.join(runDirectory, "diff.json"),
  };
}

/** The baseline: the same bounded scan the final diff uses, with redacted text kept for line diffs. */
async function saveBaseline(workspace: string): Promise<void> {
  const snapshot = await captureSnapshot(workspace, { retainText: true });
  await writeJsonAtomic(runDiffPaths(workspace).baselinePath, snapshot);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}
