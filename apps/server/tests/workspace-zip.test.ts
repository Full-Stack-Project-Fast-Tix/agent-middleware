import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractWorkspaceZip } from "../src/workspace-archive.js";
import { zipWorkspace } from "../src/workspace-zip.js";

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
});
