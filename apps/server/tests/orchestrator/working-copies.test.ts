import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@launchpad/shared";
import { DEFAULT_SENSITIVE_MARKERS } from "../../src/check-sensitive-egress.js";
import { DirectoryWorkingCopies } from "../../src/orchestrator/working-copies.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "working-copies-"));
  temporary.push(base);
  const source = path.join(base, "project");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(source, ".aws"), { recursive: true });
  await writeFile(path.join(source, "src", "signup.ts"), "export const signup = 1;\n");
  await writeFile(path.join(source, ".env"), "API_KEY=sk-test\n");
  await writeFile(path.join(source, ".env.production"), "API_KEY=sk-production-test\n");
  await writeFile(path.join(source, ".env.example"), "API_KEY=replace-me\n");
  await writeFile(path.join(source, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  await writeFile(path.join(source, "id_ed25519"), "private key\n");
  await writeFile(path.join(source, "tls.key"), "private key\n");
  await writeFile(path.join(source, ".aws", "credentials"), "aws_secret_access_key=test\n");
  await writeFile(path.join(source, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const root = path.join(base, "runs");
  let sourcePath: string | null = source;
  const copies = new DirectoryWorkingCopies({ root, sources: { sourcePath: async () => sourcePath } });
  return {
    base,
    source,
    root,
    copies,
    setSource: (value: string | null) => {
      sourcePath = value;
    },
  };
}

const run = (id = RUN_ID) => ({ id, workspaceId: "00000000-0000-4000-8000-000000000001" }) as Run;

/** One path per guard marker, standing for what that marker recognizes. */
const EXAMPLE_FOR_MARKER: Record<string, string[]> = {
  ".env": [".env"],
  id_rsa: ["id_rsa"],
  id_ed25519: ["id_ed25519"],
  ".pem": ["tls.pem"],
  ".ssh/": [".ssh/config"],
  ".aws/credentials": [".aws/credentials"],
  "credentials.json": ["credentials.json"],
  secrets: ["secrets/db_password.txt", "secrets.json"],
  ".npmrc": [".npmrc"],
  ".git-credentials": [".git-credentials"],
  "service-account": ["service-account.json", "service_account.json"],
  ".netrc": [".netrc"],
  ".pgpass": [".pgpass"],
};

/** Prepares a copy of a project holding only these files; returns what arrived. */
async function copiedFrom(files: string[]): Promise<string[]> {
  const base = await mkdtemp(path.join(tmpdir(), "working-copies-"));
  temporary.push(base);
  const source = path.join(base, "project");
  await mkdir(source);
  for (const file of files) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), "placeholder\n");
  }
  const copies = new DirectoryWorkingCopies({ root: path.join(base, "runs"), sources: { sourcePath: async () => source } });
  const target = await copies.prepare(run());
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(target, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("DirectoryWorkingCopies", () => {
  it("copies project files but excludes environment secrets, credentials, and dependencies", async () => {
    const { root, copies } = await setup();
    const target = await copies.prepare(run());

    expect(target).toBe(path.join(root, RUN_ID, "workspace"));
    expect(await readFile(path.join(target, "src", "signup.ts"), "utf8")).toBe("export const signup = 1;\n");
    expect(await readFile(path.join(target, ".env.example"), "utf8")).toBe("API_KEY=replace-me\n");
    expect((await readdir(target)).sort()).toEqual([".env.example", "src"]);
  });

  it("excludes a representative of every marker the egress guard treats as sensitive", async () => {
    // A new marker fails here until someone decides what the copy does with it.
    expect(Object.keys(EXAMPLE_FOR_MARKER).sort()).toEqual([...DEFAULT_SENSITIVE_MARKERS].sort());

    const excluded = await copiedFrom(Object.values(EXAMPLE_FOR_MARKER).flat());
    expect(excluded).toEqual([]);
  });

  it("excludes credential files by name, at any depth and in any case", async () => {
    const names = [
      ".env-prod",
      ".env_local",
      ".envrc",
      ".envrc.local",
      "production.env",
      "_netrc",
      "pgpass.conf",
      ".my.cnf",
      ".htpasswd",
      ".dockercfg",
      ".boto",
      ".s3cfg",
      ".vault-token",
      ".credentials",
      ".credentials.json",
      "credentials.db",
      "access_tokens.db",
      "credentials.tfrc.json",
      "client_secret.json",
      "secrets.yaml",
      "secrets.yml",
      "secrets.toml",
      "secrets.ini",
      "secrets.txt",
      "prod-service-account-key.json",
      "SERVICE_ACCOUNT.JSON",
      "Credentials.JSON",
      "id_ecdsa",
      "id_dsa",
      "id_ed25519_sk",
      "id_rsa.bak",
      "id_rsa_work",
      "signing.p8",
      "putty.ppk",
      "release.jks",
      "passwords.kdbx",
      "terraform.tfstate",
      "terraform.tfstate.backup",
      "terraform.tfvars",
      "prod.auto.tfvars",
      ".gcloud/credentials",
      "legacy_credentials/account/adc.json",
      ".volcengine/config.json",
      ".secrets/token",
    ];
    expect(await copiedFrom(names)).toEqual([]);
    expect(await copiedFrom(names.map((name) => path.join("deploy", "nested", name)))).toEqual([]);
  });

  it("keeps templates, public keys and source files whose names only resemble credentials", async () => {
    const kept = [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.production.example",
      ".env-example",
      ".env_sample",
      ".envrc.example",
      "production.env.example",
      "terraform.tfvars.example",
      "id_rsa.pub",
      "id_ed25519.pub",
      "src/secrets.ts",
      "src/credentials.ts",
      "src/service-account.ts",
      "k8s/service-account.yaml",
      "src/environment.ts",
      ".environment",
      "keys.json",
    ];
    expect(await copiedFrom(kept)).toEqual([...kept].sort());
  });

  it("does not treat a similar template-like name as a template", async () => {
    expect(await copiedFrom([".env.prod-sample", ".env.production", ".env.examples", "prod.env"])).toEqual([]);
  });

  it("lets a caller add exclusions but not turn off the defaults", async () => {
    const { source, root } = await setup();
    await mkdir(path.join(source, "vendor"));
    const copies = new DirectoryWorkingCopies({
      root,
      sources: { sourcePath: async () => source },
      excludedNames: ["VENDOR"],
    });
    const target = await copies.prepare(run());
    expect((await readdir(target)).sort()).toEqual([".env.example", "src"]);
  });

  it("prepares once: a second call keeps the agents' edits", async () => {
    const { copies } = await setup();
    const target = await copies.prepare(run());
    await writeFile(path.join(target, "src", "signup.ts"), "edited by an agent\n");
    expect(await copies.prepare(run())).toBe(target);
    expect(await readFile(path.join(target, "src", "signup.ts"), "utf8")).toBe("edited by an agent\n");
  });

  it("gives separate runs separate copies, and never touches the source", async () => {
    const { source, copies } = await setup();
    const first = await copies.prepare(run());
    const second = await copies.prepare(run("66666666-7777-4888-8999-aaaaaaaaaaaa"));
    await writeFile(path.join(first, "src", "signup.ts"), "changed\n");
    expect(await readFile(path.join(second, "src", "signup.ts"), "utf8")).toBe("export const signup = 1;\n");
    expect(await readFile(path.join(source, "src", "signup.ts"), "utf8")).toBe("export const signup = 1;\n");
  });

  it("starts an empty working copy for a workspace with no source", async () => {
    const { copies, setSource } = await setup();
    setSource(null);
    expect(await readdir(await copies.prepare(run()))).toEqual([]);
  });

  it("rejects ids that could climb out of the root, and sources that would copy into themselves", async () => {
    const { base, copies, setSource } = await setup();
    expect(() => copies.pathFor("../../etc")).toThrow("Not a run id");
    setSource(base);
    await expect(copies.prepare(run())).rejects.toThrow("must not contain each other");
    setSource(path.join(base, "missing"));
    await expect(copies.prepare(run())).rejects.toThrow("not a directory");
  });

  it.skipIf(process.platform === "win32")("copies symbolic links as links, never following them out of the project", async () => {
    const { base, source, copies } = await setup();
    const outside = path.join(base, "outside-secret");
    await writeFile(outside, "private key\n");
    await symlink(outside, path.join(source, "key-link"));
    const target = await copies.prepare(run());
    expect(await readlink(path.join(target, "key-link"))).toBe(outside);
  });
});
