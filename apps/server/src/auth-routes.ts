import type { FastifyInstance, FastifyRequest } from "fastify";
import { signInRequestSchema, type User } from "@launchpad/shared";
import { isOpenRequest } from "./api-access.js";
import type { Session } from "./db/postgres-identity.js";
import { HttpError } from "./errors.js";

// Sessions for signed-in users, as specified in packages/shared/src/api.ts.
// With sessions on, they replace the operator's shared APP_AUTH_TOKEN: every
// /api/ request needs a live session token as its bearer, except the health
// check, GET /api/auth and signing in.

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, set by registerSessionAuth's hook. */
    user: User | null;
  }
  interface FastifyContextConfig {
    /** false skips the response redaction hook, for a body that is a credential on purpose. */
    redact?: boolean;
  }
}

export interface Identity {
  signIn(email: string, password: string): Promise<Session | null>;
  userForToken(token: string): Promise<User | null>;
  signOut(token: string): Promise<void>;
}

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** The signed-in user. Behind registerSessionAuth's hook there always is one. */
export function signedInUser(request: FastifyRequest): User {
  if (request.user === null) throw new HttpError(401, "Authentication required");
  return request.user;
}

export function registerSessionAuth(app: FastifyInstance, identity: Identity): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request, reply) => {
    if (isOpenRequest(request)) return;
    const token = bearerToken(request);
    request.user = token === "" ? null : await identity.userForToken(token);
    if (request.user === null) return reply.code(401).send({ error: "Authentication required", code: "unauthenticated" });
  });

  app.post("/api/auth/session", { config: { redact: false } }, async (request, reply) => {
    const { email, password } = signInRequestSchema.parse(request.body);
    const session = await identity.signIn(email, password);
    if (session === null) throw new HttpError(401, "The email or password is not right.");
    return reply.code(201).send(session);
  });

  app.delete("/api/auth/session", async (request, reply) => {
    await identity.signOut(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => ({ user: signedInUser(request) }));
}
