import path from "node:path";

// A curated filename denylist, not secret detection: a credential under any
// other name is not recognized. Names are compared in lower case, against files
// and directories alike.
//
// Two consumers:
//   working-copies.ts  never copies these into a Run's working copy;
//   workspace-snapshot.ts  tracks them by hash but never captures their contents
//                          into a baseline or diff, if an agent creates one.
//
// When DEFAULT_SENSITIVE_MARKERS in check-sensitive-egress.ts gains a name,
// decide here whether it is excluded too; working-copies.test.ts fails until
// that decision is recorded.

/** Local credential stores, by directory name. */
export const CREDENTIAL_DIRECTORY_NAMES = [
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

const CREDENTIAL_DIRECTORIES: ReadonlySet<string> = new Set(CREDENTIAL_DIRECTORY_NAMES);

const CREDENTIAL_FILE_NAMES = new Set([
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

const CREDENTIAL_SUFFIXES = [
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

/** Whether one file or directory name is a known credential store. */
export function isCredentialName(entryName: string): boolean {
  const name = entryName.toLowerCase();
  if (CREDENTIAL_DIRECTORIES.has(name) || CREDENTIAL_FILE_NAMES.has(name)) return true;

  // Environment files are often ignored by Git, but the copy does not use
  // Git's ignore rules. Keep checked-in examples/templates for setup docs.
  if (ENVIRONMENT_FILE.test(name)) return !ENVIRONMENT_TEMPLATE.test(name);

  return (
    (SSH_PRIVATE_KEY.test(name) && !name.endsWith(".pub")) ||
    SERVICE_ACCOUNT_KEY.test(name) ||
    CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Whether any segment of a POSIX relative path is a credential name. */
export function isCredentialPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => isCredentialName(path.posix.basename(segment)));
}
