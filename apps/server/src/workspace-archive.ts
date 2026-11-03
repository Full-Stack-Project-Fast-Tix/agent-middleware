import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const EXCLUDED = new Set([".env", ".npmrc", ".pypirc", ".netrc", ".pgpass", "pgpass.conf", ".my.cnf", ".git-credentials", "credentials.json", "secrets.json", "client_secret.json", "application_default_credentials.json"]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate the central directory completely before writing any extracted entry. */
export async function extractWorkspaceZip(encoded: string, destination: string): Promise<void> {
  const zip = Buffer.from(encoded, "base64");
  if (zip.length === 0 || zip.length > MAX_ARCHIVE_BYTES || zip.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("ZIP upload is invalid or exceeds the 10 MB limit");
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("ZIP end directory is missing");
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  let cursor = zip.readUInt32LE(eocd + 16);
  if (count > MAX_FILES || cursor + centralSize > eocd) throw new Error("ZIP contains too many entries or an invalid directory");
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP directory entry is invalid");
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16), compressedSize = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32);
    const external = zip.readUInt32LE(cursor + 38), localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || flags & 0x40 || (method !== 0 && method !== 8)) throw new Error("Encrypted or unsupported ZIP entries are not accepted");
    const normalized = name.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.includes(":") || normalized.split("/").some((part) => part === ".." || part === ".") || normalized.includes("\0")) throw new Error("ZIP contains an unsafe path");
    const unixMode = external >>> 16;
    if (((unixMode & 0xf000) === 0xa000) || ((unixMode & 0xf000) !== 0 && (unixMode & 0xf000) !== 0x8000 && (unixMode & 0xf000) !== 0x4000)) throw new Error("ZIP links and special files are not accepted");
    const baseName = path.posix.basename(normalized).toLowerCase();
    const credentialLike = EXCLUDED.has(baseName) || /^\.env(?:rc)?(?:[._-].*)?$/.test(baseName) || /\.env(?:\..*)?$/.test(baseName) || /\.(?:pem|key|p8|p12|pfx|ppk|keystore|jks|tfstate|tfvars)$/.test(baseName) || /service[-_]account.*\.json$/.test(baseName);
    if (credentialLike || normalized.split("/").some((part) => [".git", ".ssh", ".aws", ".azure", ".gcloud", ".codex", ".gnupg", ".docker", ".kube", ".volcengine", "node_modules", "secrets", ".secrets"].includes(part.toLowerCase()))) throw new Error("ZIP contains excluded credential or repository files");
    if (name.endsWith("/")) continue;
    expanded += size;
    if (size > 20 * 1024 * 1024 || expanded > MAX_EXPANDED_BYTES || (compressedSize === 0 ? size > 0 : size / compressedSize > 200)) throw new Error("ZIP expands beyond the allowed limits");
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP file entry is invalid");
    const localName = zip.readUInt16LE(localOffset + 26), localExtra = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const compressed = zip.subarray(start, start + compressedSize);
    const bytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error("ZIP entry failed integrity validation");
    entries.push({ name: normalized, bytes });
  }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.resolve(destination, entry.name);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error("ZIP contains an unsafe path");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 });
  }
}
