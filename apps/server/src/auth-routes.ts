import type { FastifyInstance, FastifyRequest } from "fastify";
import { signInRequestSchema, type User } from "@launchpad/shared";
import type { Session } from "./db/postgres-identity.js";
import { HttpError } from "./errors.js";
import { SignInThrottle } from "./sign-in-throttle.js";

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

export function registerSessionAuth(app: FastifyInstance, identity: Identity, throttle = new SignInThrottle()): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request, reply) => {
    const open =
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      (request.method === "POST" && request.url === "/api/auth/session");
    if (open) return;
    const token = bearerToken(request);
    request.user = token === "" ? null : await identity.userForToken(token);
    if (request.user === null) return reply.code(401).send({ error: "Authentication required", code: "unauthenticated" });
  });

  app.post("/api/auth/session", { config: { redact: false } }, async (request, reply) => {
    const { email, password } = signInRequestSchema.parse(request.body);
    // request.ip is the connecting peer: this app does not trust X-Forwarded-For.
    const retryAfter = throttle.admit(email, request.ip);
    if (retryAfter !== null) {
      request.log.warn({ ip: request.ip }, "Sign-in attempts throttled");
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: "Too many sign-in attempts. Try again later.", code: "rate_limited" });
    }
    const session = await identity.signIn(email, password).catch((error: unknown) => {
      throttle.abandoned(email, request.ip);
      throw error;
    });
    if (session === null) throw new HttpError(401, "The email or password is not right.");
    throttle.succeeded(email, request.ip);
    return reply.code(201).send(session);
  });

  app.delete("/api/auth/session", async (request, reply) => {
    await identity.signOut(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => ({ user: signedInUser(request) }));
}
