import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceVault, type WorkspaceVaultSecret } from "../src/workspace-vault.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const DUMMY_VALUE = "synthetic-vault-evaluation-value-never-a-real-key";
const secret = (name = "TEST_TOKEN"): WorkspaceVaultSecret => ({ name, value: DUMMY_VALUE, allowedHosts: ["api.example.invalid"], authHeader: "Authorization", authPrefix: "Bearer ", createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z", createdByUserId: OTHER, updatedByUserId: OTHER });
let root: string;
let key: string;
let vault: WorkspaceVault;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "agentguard-vault-evaluation-")); key = randomBytes(32).toString("hex"); vault = new WorkspaceVault(root, key); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const encryptedFile = () => path.join(root, `${WORKSPACE}.vault`);

describe("local vault security evaluation", () => {
  it("encrypts values on disk, returns metadata without values and survives reopening", async () => {
    await vault.put(WORKSPACE, secret());
    const disk = await readFile(encryptedFile(), "utf8");
    expect(disk).not.toContain(DUMMY_VALUE);
    expect(disk).not.toContain(key);
    expect(await vault.list(WORKSPACE)).toEqual([expect.objectContaining({ name: "TEST_TOKEN", allowedHosts: ["api.example.invalid"] })]);
    expect(JSON.stringify(await vault.list(WORKSPACE))).not.toContain(DUMMY_VALUE);
    expect(await new WorkspaceVault(root, key).get(WORKSPACE, "TEST_TOKEN")).toEqual(secret());
  });
  it("keeps secrets in separate workspace documents", async () => {
    await vault.put(WORKSPACE, secret());
    expect(await vault.list(OTHER)).toEqual([]);
    expect(await vault.get(OTHER, "TEST_TOKEN")).toBeNull();
  });
  it("uses a fresh authenticated-encryption nonce for every write", async () => {
    await vault.put(WORKSPACE, secret());
    const first = JSON.parse(await readFile(encryptedFile(), "utf8"));
    await vault.put(WORKSPACE, secret());
    const second = JSON.parse(await readFile(encryptedFile(), "utf8"));
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(await vault.get(WORKSPACE, "TEST_TOKEN")).toEqual(secret());
  });
  it("refuses decryption with a different master key", async () => {
    await vault.put(WORKSPACE, secret());
    await expect(new WorkspaceVault(root, randomBytes(32).toString("hex")).get(WORKSPACE, "TEST_TOKEN")).rejects.toThrow("could not be decrypted");
  });
  it("detects modified ciphertext through its authentication tag", async () => {
    await vault.put(WORKSPACE, secret());
    const document = JSON.parse(await readFile(encryptedFile(), "utf8"));
    const bytes = Buffer.from(document.ciphertext, "base64"); bytes[0] = bytes[0]! ^ 1;
    document.ciphertext = bytes.toString("base64");
    await writeFile(encryptedFile(), JSON.stringify(document));
    await expect(vault.get(WORKSPACE, "TEST_TOKEN")).rejects.toThrow("could not be decrypted");
  });
  it("serializes concurrent writes without losing credentials", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => vault.put(WORKSPACE, secret(`TOKEN_${index}`))));
    expect((await vault.list(WORKSPACE)).map((s) => s.name).sort()).toEqual(Array.from({ length: 12 }, (_, index) => `TOKEN_${index}`).sort());
  });
  it("persists deletion while preserving other entries", async () => {
    await vault.put(WORKSPACE, secret()); await vault.put(WORKSPACE, secret("KEEP_TOKEN"));
    expect(await vault.delete(WORKSPACE, "TEST_TOKEN", OTHER)).toBe(true);
    const reopened = new WorkspaceVault(root, key);
    expect(await reopened.get(WORKSPACE, "TEST_TOKEN")).toBeNull();
    expect(await reopened.get(WORKSPACE, "KEEP_TOKEN")).toEqual(secret("KEEP_TOKEN"));
    expect(await reopened.delete(WORKSPACE, "MISSING_TOKEN", OTHER)).toBe(false);
  });
  it("requires a configured encryption key before accessing the vault", async () => {
    await expect(new WorkspaceVault(root, undefined).list(WORKSPACE)).rejects.toMatchObject({ statusCode: 503 });
  });
  it("refuses wildcard/URL destinations and authentication-header injection", async () => {
    for (const host of ["*.example.invalid", "https://api.example.invalid", "api.example.invalid:443", "api.example.invalid/path"]) {
      await expect(vault.put(WORKSPACE, { ...secret(), allowedHosts: [host] })).rejects.toThrow("exact DNS hostnames");
    }
    await expect(vault.put(WORKSPACE, { ...secret(), authHeader: "Authorization\r\nInjected" })).rejects.toThrow("header is not valid");
    await expect(vault.put(WORKSPACE, { ...secret(), authPrefix: "Bearer \r\n" })).rejects.toThrow("header is not valid");
    expect(await vault.list(WORKSPACE)).toEqual([]);
  });
});
