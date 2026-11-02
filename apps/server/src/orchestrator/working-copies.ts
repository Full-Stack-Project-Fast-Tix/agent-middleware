import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Run } from "@launchpad/shared";
import type { WorkingCopies } from "./ports.js";

// One isolated copy of the project per Run:
//
//   <root>/<runId>/workspace
//
// The first Run copies the configured source. Later Runs copy the latest
// successful Run's files, so prompts continue the project while the configured
// source and completed Run artifacts remain untouched.
//
// Symbolic links are copied as links, verbatim, never followed. Following one
// could pull a file from outside the project (a key in ~/.ssh) into the copy.
// Inside the container a link that points outside /workspace resolves to
// nothing. Anything on the host that later reads the copy must still refuse to
// follow links out of it.

// The exclusions below are a curated filename denylist, not secret detection: a
// credential under any other name is still copied. Names are compared in lower
// case, against files and directories alike. When DEFAULT_SENSITIVE_MARKERS in
// check-sensitive-egress.ts gains a name, decide here whether it is excluded too;
// working-copies.test.ts fails until that decision is recorded.

/** Directories never copied: rebuildable data or local credential stores. */
export const DEFAULT_EXCLUDED_NAMES = [
  "node_modules",
  ".codex",
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gcloud",
  "legacy_credentials",
  ".volcengine",
  ".gnupg",
  ".docker",
  ".kube",
  // Docker Compose's secrets folder. A source folder with this name is omitted
  // too; an agent that cannot find it fails visibly, which beats exposing one.
  "secrets",
  ".secrets",
] as const;

const EXCLUDED_CREDENTIAL_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".pgpass",
  "pgpass.conf",
  ".my.cnf",
  ".htpasswd",
  ".dockercfg",
  ".boto",
  ".s3cfg",
  ".vault-token",
  "credentials.json",
  ".credentials",
  ".credentials.json",
  "credentials.db",
  "access_tokens.db",
  "credentials.tfrc.json",
  "application_default_credentials.json",
  "client_secret.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.toml",
  "secrets.ini",
  "secrets.txt",
]);

const EXCLUDED_CREDENTIAL_SUFFIXES = [
  ".pem",
  ".key",
  ".p8",
  ".p12",
  ".pfx",
  ".ppk",
  ".keystore",
  ".jks",
  ".kdbx",
  ".tfstate",
  ".tfstate.backup",
  ".tfvars",
];

/** `id_rsa`, `id_ed25519_sk`, `id_rsa.bak`, `id_rsa_work`. Public keys stay. */
const SSH_PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/;
const SERVICE_ACCOUNT_KEY = /service[-_]account.*\.json$/;
/** `.env`, `.envrc`, `.env.production`, `.env-prod`, `.envrc.local`, `production.env`. */
const ENVIRONMENT_FILE = /^\.env(?:rc)?(?:[._-].*)?$|\.env$/;
/** Checked-in templates that document the settings without holding them. */
const ENVIRONMENT_TEMPLATE = /\.(?:example|sample|template)$|^\.env(?:rc)?[-_](?:example|sample|template)$/;

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

    const source = run.parentRunId === null
      ? await this.sources.sourcePath(run.workspaceId)
      : this.pathFor(run.parentRunId);
    if (source === null) {
      await mkdir(target);
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
    return target;
  }

  private isExcluded(entry: string): boolean {
    const name = path.basename(entry).toLowerCase();
    if (this.excluded.has(name) || EXCLUDED_CREDENTIAL_FILE_NAMES.has(name)) return true;

    // Environment files are often ignored by Git, but this copy does not use
    // Git's ignore rules. Keep checked-in examples/templates for setup docs.
    if (ENVIRONMENT_FILE.test(name)) return !ENVIRONMENT_TEMPLATE.test(name);

    return (
      (SSH_PRIVATE_KEY.test(name) && !name.endsWith(".pub")) ||
      SERVICE_ACCOUNT_KEY.test(name) ||
      EXCLUDED_CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
    );
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}
