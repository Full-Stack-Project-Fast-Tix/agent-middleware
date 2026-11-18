import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractWorkspaceZip } from "../src/workspace-archive.js";
import { zipWorkspace, zipWorkspaceWithManifest } from "../src/workspace-zip.js";

describe("Run workspace ZIP download", () => {
  it("preserves binary bytes and large text files, and omits known credential files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-zip-source-"));
    const output = await mkdtemp(path.join(tmpdir(), "workspace-zip-output-"));
    try {
      await mkdir(path.join(root, "assets"));
      const binary = Buffer.from([0, 255, 1, 128, 10]);
      await writeFile(path.join(root, "assets", "image.bin"), binary);
      const largeText = "a".repeat(300_000);
      await writeFile(path.join(root, "large.txt"), largeText);
      await writeFile(path.join(root, ".env"), "SECRET=must-not-export");
      const archive = await zipWorkspace(root);
      await extractWorkspaceZip(archive.toString("base64"), output);
      expect(await readFile(path.join(output, "assets", "image.bin"))).toEqual(binary);
      expect(await readFile(path.join(output, "large.txt"), "utf8")).toBe(largeText);
      await expect(readFile(path.join(output, ".env"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  it("says what it left out, so the UI never implies a whole folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-zip-manifest-"));
    try {
      await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "1");
      await writeFile(path.join(root, ".env"), "SECRET=x");
      await writeFile(path.join(root, "index.js"), "ok");
      if (process.platform !== "win32") await symlink(path.join(root, "index.js"), path.join(root, "link.js"));
      const { manifest } = await zipWorkspaceWithManifest(root);
      expect(manifest).toEqual({
        files: 1,
        excludedDirectories: 1,
        credentialEntries: 1,
        skippedEntries: process.platform === "win32" ? 0 : 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
