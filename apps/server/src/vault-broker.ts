import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import type { WorkspaceVaultSecret } from "./workspace-vault.js";
type BrokerSecret = Pick<WorkspaceVaultSecret, "value" | "allowedHosts" | "authHeader" | "authPrefix">;

export interface VaultRequestInput {
  secretName: string;
  method: "GET" | "POST";
  url: URL;
  body?: string;
}

const BROKER_COMMAND = /^agentguard-vault request --secret ([A-Z][A-Z0-9_]{0,63}) --method (GET|POST) --url (https:\/\/[^\s'"<>;|&`$]+)(?: --body-base64 ([A-Za-z0-9_-]{1,87384}))?$/;

/** Parse one constrained shell-tool command. Shell syntax and arbitrary headers are deliberately unsupported. */
export function parseVaultRequestCommand(command: string): VaultRequestInput | null {
  const match = BROKER_COMMAND.exec(command.trim());
  if (match === null) return null;
  let url: URL;
  try {
    url = new URL(match[3]!);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.port !== "" && url.port !== "443" || url.hash !== "" ||
    isIP(url.hostname) !== 0 || match[4] !== undefined && Buffer.from(match[4], "base64url").byteLength > 65_536
  ) return null;
  if (match[2] === "GET" && match[4] !== undefined) return null;
  if (match[4] !== undefined) {
    try { JSON.parse(Buffer.from(match[4], "base64url").toString("utf8")); }
    catch { return null; }
  }
  return {
    secretName: match[1]!,
    method: match[2] as "GET" | "POST",
    url,
    ...(match[4] === undefined ? {} : { body: Buffer.from(match[4], "base64url").toString("utf8") }),
  };
}

/** Execute one request with a vault secret, pinned to a public IPv4 address and with redirects disabled. */
export async function requestWithVaultSecret(
  secret: BrokerSecret,
  input: VaultRequestInput,
  signal: AbortSignal,
): Promise<string> {
  const hostname = input.url.hostname.toLowerCase();
  if (!secret.allowedHosts.includes(hostname)) throw new Error("The vault secret is not approved for this API host");
  if (input.url.port !== "" && input.url.port !== "443") throw new Error("The vault broker only permits HTTPS on port 443");
  const records = await lookup(hostname, { family: 4, all: true, verbatim: true });
  const address = records.find((record) => isPublicIPv4(record.address))?.address;
  if (address === undefined) throw new Error("The API host did not resolve to an allowed public address");

  const path = input.url.pathname + input.url.search;
  if (path.length > 8_192) throw new Error("The API request path is too long");
  const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(value ?? "");
    };
    const onAbort = () => request.destroy(new Error("The API request was cancelled"));
    if (signal.aborted) return finish(new Error("The API request was cancelled"));
    const request = https.request({
      protocol: "https:",
      hostname,
      port: 443,
      path,
      method: input.method,
      headers: {
        [secret.authHeader]: `${secret.authPrefix}${secret.value}`,
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(body.byteLength) }),
      },
      lookup: (_host, _options, callback) => callback(null, address, 4),
      timeout: 15_000,
      maxHeaderSize: 16_384,
    }, (response) => {
      if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        finish(new Error("The vault broker refuses redirects"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 65_536) {
          response.destroy(new Error("The API response exceeded the 64 KB limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () => finish(undefined,
        `HTTP ${response.statusCode ?? 0}\n${Buffer.concat(chunks).toString("utf8")}`));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new Error("The API request timed out")));
    request.on("error", (error) => finish(error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 0 || b === 168) ||
    a === 192 && b === 0 && parts[2] === 2 ||
    a === 198 && (b === 18 || b === 19 || b === 51 && parts[2] === 100) ||
    a === 203 && b === 0 && parts[2] === 113
  );
}
