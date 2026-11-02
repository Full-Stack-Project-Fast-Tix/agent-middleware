import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

export interface WorkspaceVaultSecret {
  name: string;
  value: string;
  allowedHosts: string[];
  authHeader: string;
  authPrefix: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string;
}

export type WorkspaceVaultSecretInfo = Omit<WorkspaceVaultSecret, "value">;

interface VaultDocument {
  version: 1;
  secrets: WorkspaceVaultSecret[];
  audit: Array<{ action: "put" | "delete"; name: string; actorUserId: string; at: string }>;
}

interface EncryptedDocument {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;

/** One encrypted file per workspace. The encryption key is configured outside the vault files. */
export class WorkspaceVault {
  private readonly key: Buffer | null;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly root: string, masterKeyHex: string | undefined) {
    this.key = masterKeyHex === undefined ? null : Buffer.from(masterKeyHex, "hex");
    if (this.key !== null && this.key.byteLength !== 32) throw new Error("AGENTGUARD_VAULT_MASTER_KEY must be 64 hexadecimal characters");
  }

  async list(workspaceId: string): Promise<WorkspaceVaultSecretInfo[]> {
    return (await this.read(workspaceId)).secrets.map(({ value: _value, ...info }) => info);
  }

  async get(workspaceId: string, name: string): Promise<WorkspaceVaultSecret | null> {
    return (await this.read(workspaceId)).secrets.find((secret) => secret.name === name) ?? null;
  }

  async put(workspaceId: string, secret: WorkspaceVaultSecret): Promise<void> {
    this.validate(secret);
    await this.exclusive(workspaceId, async () => {
      const document = await this.read(workspaceId);
      const index = document.secrets.findIndex((item) => item.name === secret.name);
      if (index < 0) document.secrets.push(secret);
      else document.secrets[index] = secret;
      await this.write(workspaceId, {
        ...document,
        audit: [...document.audit, { action: "put" as const, name: secret.name, actorUserId: secret.updatedByUserId, at: secret.updatedAt }].slice(-500),
      });
    });
  }

  async delete(workspaceId: string, name: string, actorUserId: string): Promise<boolean> {
    return this.exclusive(workspaceId, async () => {
      const document = await this.read(workspaceId);
      const remaining = document.secrets.filter((item) => item.name !== name);
      if (remaining.length === document.secrets.length) return false;
      await this.write(workspaceId, {
        ...document,
        secrets: remaining,
        audit: [...document.audit, { action: "delete" as const, name, actorUserId, at: new Date().toISOString() }].slice(-500),
      });
      return true;
    });
  }

  private validate(secret: WorkspaceVaultSecret): void {
    if (!NAME.test(secret.name) || secret.value.length < 4 || secret.value.length > 16_384) {
      throw new HttpError(400, "Secret name or value is outside the supported limits");
    }
    if (!HEADER.test(secret.authHeader) || !/^[\x20-\x7e]{0,80}$/.test(secret.authPrefix)) {
      throw new HttpError(400, "The authentication header is not valid");
    }
    if (secret.allowedHosts.length < 1 || secret.allowedHosts.length > 20) {
      throw new HttpError(400, "Add between one and twenty allowed API hosts");
    }
    const hosts = secret.allowedHosts.map((host) => host.toLowerCase());
    if (hosts.some((host) => host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host))) {
      throw new HttpError(400, "Allowed hosts must be exact DNS hostnames without schemes, ports, paths, or wildcards");
    }
    secret.allowedHosts = [...new Set(hosts)].sort();
  }

  private async read(workspaceId: string): Promise<VaultDocument> {
    const key = this.requireKey();
    let contents: string;
    try {
      contents = await readFile(this.file(workspaceId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, secrets: [], audit: [] };
      throw error;
    }
    try {
      const encrypted = JSON.parse(contents) as EncryptedDocument;
      if (encrypted.version !== 1) throw new Error("unsupported vault version");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const document = JSON.parse(plaintext) as VaultDocument;
      if (document.version !== 1 || !Array.isArray(document.secrets)) throw new Error("invalid vault document");
      document.audit ??= [];
      return document;
    } catch {
      throw new HttpError(500, "The workspace vault could not be decrypted; check AGENTGUARD_VAULT_MASTER_KEY");
    }
  }

  private async write(workspaceId: string, document: VaultDocument): Promise<void> {
    const key = this.requireKey();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);
    const payload: EncryptedDocument = {
      version: 1,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const target = this.file(workspaceId);
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private file(workspaceId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, "Workspace id is invalid");
    return path.join(this.root, `${workspaceId}.vault`);
  }

  private requireKey(): Buffer {
    if (this.key === null) throw new HttpError(503, "Workspace vault is not configured; set AGENTGUARD_VAULT_MASTER_KEY");
    return this.key;
  }

  private async exclusive<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.locks.set(workspaceId, current);
    await previous;
    try {
      return await work();
    } finally {
      unlock();
      if (this.locks.get(workspaceId) === current) this.locks.delete(workspaceId);
    }
  }
}
