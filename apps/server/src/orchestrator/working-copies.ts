import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Run } from "@launchpad/shared";
import type { WorkingCopies } from "./ports.js";

// One isolated copy of the project per Run (plan section 3.2):
//
//   <root>/<runId>/workspace
//
// A Workspace is the logical project; its files live at a source path. Each
// Run copies them, so Runs never overwrite each other and the source is never
// edited by an agent. Git is not required: this is a plain copy.
//
// Symbolic links are copied as links, verbatim, never followed. Following one
// could pull a file from outside the project (a key in ~/.ssh) into the copy.
// Inside the container a link that points outside /workspace resolves to
// nothing. Anything on the host that later reads the copy must still refuse to
// follow links out of it.

/** Directories never copied: rebuildable data or local credential stores. */
export const DEFAULT_EXCLUDED_NAMES = [
  "node_modules",
  ".codex",
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".docker",
  ".kube",
] as const;

const EXCLUDED_CREDENTIAL_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".envrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "application_default_credentials.json",
  "service-account.json",
  "service_account.json",
]);

const EXCLUDED_CREDENTIAL_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore", ".tfstate"];
const ENVIRONMENT_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

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
    if (await exists(target)) return target;
    await mkdir(path.dirname(target), { recursive: true });

    const source = await this.sources.sourcePath(run.workspaceId);
    if (source === null) {
      await mkdir(target);
      return target;
    }
    const resolvedSource = path.resolve(source);
    const info = await stat(resolvedSource).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`The workspace source is not a directory: ${resolvedSource}`);
    }
    if (isInside(this.root, resolvedSource) || isInside(resolvedSource, this.root)) {
      // Copying a tree into itself, or the run copies into each new copy.
      throw new Error("The workspace source and the working-copy root must not contain each other");
    }

    await cp(resolvedSource, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (entry) => entry === resolvedSource || !this.isExcluded(entry),
    });
    return target;
  }

  private isExcluded(entry: string): boolean {
    const name = path.basename(entry).toLowerCase();
    if (this.excluded.has(name) || EXCLUDED_CREDENTIAL_FILE_NAMES.has(name)) return true;

    // Environment files are often ignored by Git, but this copy does not use
    // Git's ignore rules. Keep checked-in examples/templates for setup docs.
    if (name === ".env" || name === ".envrc" || name.startsWith(".env.")) {
      return !ENVIRONMENT_TEMPLATES.has(name) && !/\.(?:example|sample|template)$/.test(name);
    }

    return EXCLUDED_CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}
