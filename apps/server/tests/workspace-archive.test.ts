import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractWorkspaceZip } from "../src/workspace-archive.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320); }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(name: string, content: string): string {
  const file = Buffer.from(content);
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30 + filename.length + file.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc32(file), 14); local.writeUInt32LE(file.length, 18); local.writeUInt32LE(file.length, 22);
  local.writeUInt16LE(filename.length, 26); filename.copy(local, 30); file.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc32(file), 16); central.writeUInt32LE(file.length, 20); central.writeUInt32LE(file.length, 24); central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]).toString("base64");
}

describe("workspace ZIP extraction", () => {
  it("extracts a regular file under the destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-zip-"));
    try {
      await extractWorkspaceZip(zip("src/index.ts", "export const ok = true;"), root);
      expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toBe("export const ok = true;");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["../escape.txt", ".env", "nested/private.pem"])("rejects unsafe or credential entry %s", async (name) => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-zip-"));
    try { await expect(extractWorkspaceZip(zip(name, "secret"), root)).rejects.toThrow(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
