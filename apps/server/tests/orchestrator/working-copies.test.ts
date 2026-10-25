import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@launchpad/shared";
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

describe("DirectoryWorkingCopies", () => {
  it("copies project files but excludes environment secrets, credentials, and dependencies", async () => {
    const { root, copies } = await setup();
    const target = await copies.prepare(run());

    expect(target).toBe(path.join(root, RUN_ID, "workspace"));
    expect(await readFile(path.join(target, "src", "signup.ts"), "utf8")).toBe("export const signup = 1;\n");
    expect(await readFile(path.join(target, ".env.example"), "utf8")).toBe("API_KEY=replace-me\n");
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
