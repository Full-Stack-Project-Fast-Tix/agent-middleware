export interface ZipTextFile {
  path: string;
  content: string;
}

const MAX_FILES = 500;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function archivePath(path: string): string {
  if (
    path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    /^[a-z]:/i.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Cannot safely include ${path || "an unnamed file"} in the ZIP archive.`);
  }
  return path;
}

/** Build a bounded, uncompressed ZIP from the already-redacted text file API responses. */
export function zipTextFiles(files: readonly ZipTextFile[]): Blob {
  if (files.length > MAX_FILES) throw new Error(`This Run has more than ${MAX_FILES} files; download files individually.`);

  const entries = files.map((file) => {
    const name = encoder.encode(archivePath(file.path));
    const content = encoder.encode(file.content);
    if (name.length > 0xffff) throw new Error("A file path is too long to include in the ZIP archive.");
    return { name, content, crc: crc32(content) };
  });
  const contentBytes = entries.reduce((total, entry) => total + entry.content.length, 0);
  if (contentBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("The Run's files exceed the 20 MB ZIP limit. Download files individually instead.");
  }

  const localBytes = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.content.length, 0);
  const centralBytes = entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const archive = new ArrayBuffer(localBytes + centralBytes + 22);
  const bytes = new Uint8Array(archive);
  const view = new DataView(archive);
  let cursor = 0;
  const centralRecords: Array<{ entry: (typeof entries)[number]; offset: number }> = [];
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);

  for (const entry of entries) {
    const offset = cursor;
    centralRecords.push({ entry, offset });
    u32(cursor, 0x04034b50);
    u16(cursor + 4, 20);
    u16(cursor + 6, 0x0800);
    u16(cursor + 8, 0);
    u16(cursor + 10, 0);
    u16(cursor + 12, 33);
    u32(cursor + 14, entry.crc);
    u32(cursor + 18, entry.content.length);
    u32(cursor + 22, entry.content.length);
    u16(cursor + 26, entry.name.length);
    u16(cursor + 28, 0);
    cursor += 30;
    bytes.set(entry.name, cursor);
    cursor += entry.name.length;
    bytes.set(entry.content, cursor);
    cursor += entry.content.length;
  }

  const centralOffset = cursor;
  for (const { entry, offset } of centralRecords) {
    u32(cursor, 0x02014b50);
    u16(cursor + 4, 20);
    u16(cursor + 6, 20);
    u16(cursor + 8, 0x0800);
    u16(cursor + 10, 0);
    u16(cursor + 12, 0);
    u16(cursor + 14, 33);
    u32(cursor + 16, entry.crc);
    u32(cursor + 20, entry.content.length);
    u32(cursor + 24, entry.content.length);
    u16(cursor + 28, entry.name.length);
    u16(cursor + 30, 0);
    u16(cursor + 32, 0);
    u16(cursor + 34, 0);
    u16(cursor + 36, 0);
    u32(cursor + 38, 0);
    u32(cursor + 42, offset);
    cursor += 46;
    bytes.set(entry.name, cursor);
    cursor += entry.name.length;
  }

  const centralSize = cursor - centralOffset;
  u32(cursor, 0x06054b50);
  u16(cursor + 4, 0);
  u16(cursor + 6, 0);
  u16(cursor + 8, entries.length);
  u16(cursor + 10, entries.length);
  u32(cursor + 12, centralSize);
  u32(cursor + 16, centralOffset);
  u16(cursor + 20, 0);

  return new Blob([archive], { type: "application/zip" });
}
