import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { redactText } from "./redaction/index.js";
import { registerRunEventStream, type RunEventStreamOptions } from "./run-events-route.js";
import { isOpenRequest } from "./api-access.js";
import { registerMemberRoutes } from "./member-routes.js";
import { registerRunRoutes, type RunRoutesOptions } from "./run-routes.js";
import { registerWorkspaceConfigRoutes } from "./workspace-config-routes.js";
import { registerSessionAuth, type Identity } from "./auth-routes.js";

/**
 * Response bodies the outbound redactor runs over. Anything else — static
 * assets above all — is served byte-for-byte as written.
 */
const REDACTED_CONTENT_TYPES = ["application/json", "application/x-ndjson"];

export interface AppExtensions {
  /** Live RunEvent stream. Omitted, the route is not registered. */
  runEvents?: RunEventStreamOptions;
  /** Run, snapshot, cancel and approval routes for the multi-agent model. Omitted, not registered. */
  runs?: RunRoutesOptions;
  /** Where workspace members live. Their routes need signed-in users, so this also needs `identity`. */
  memberDatabase?: pg.Pool;
  /** Signed-in users with sessions, instead of the shared APP_AUTH_TOKEN. */
  identity?: Identity;
  /** Rejects when the database cannot answer, which fails the health check. */
  checkDatabase?: () => Promise<unknown>;
}

export async function createApp(
  config: AppConfig,
  extensions: AppExtensions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  // Before any route: the awaited static-files register below fixes the handler of every route added so far.
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  // Signed-in sessions replace the shared token when the server has identity.
  if (extensions.identity) registerSessionAuth(app, extensions.identity);
  app.addHook("onRequest", async (request, reply) => {
    if (extensions.identity !== undefined || !config.authToken || isOpenRequest(request)) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  /**
   * Redact credential-shaped values out of every response body on the way out.
   *
   * This is one global hook rather than a patch on the routes that are known to
   * leak, and that choice is the whole point. Per-route redaction is fail-open:
   * it protects exactly the routes someone remembered, and every route added
   * afterwards leaks by default until someone notices. That is not a
   * hypothetical failure mode — it is how `Message.content` and `agent.lastError`
   * were missed in the first pass, when only the trace route looked risky.
   *
   * Scoped by content type, not by URL. `application/json` and
   * `application/x-ndjson` are the two shapes that carry agent-produced text.
   * In production this app also serves the built React UI through
   * `fastifyStatic` below; running a credential regex over JS bundles buys
   * nothing and risks corrupting a bundle whose minified output happens to
   * contain a long base64 run.
   *
   * The payload may be a string, a Buffer, or a stream. Streams pass through
   * untouched: buffering one here to redact it would defeat the point of
   * streaming. The one streaming route, the RunEvent SSE stream, bypasses
   * this hook entirely and redacts each frame itself (run-events-route.ts).
   */
  app.addHook("onSend", async (request, reply, payload) => {
    // Only the sign-in response opts out: its body is the session token it hands over.
    if (request.routeOptions.config.redact === false) return payload;
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!REDACTED_CONTENT_TYPES.some((type) => contentType.includes(type))) {
      return payload;
    }

    const isBuffer = Buffer.isBuffer(payload);
    if (typeof payload !== "string" && !isBuffer) return payload;

    const original = isBuffer ? payload.toString("utf8") : payload;
    const { text, redactions } = redactText(original);
    if (redactions === 0) return payload;

    // Fastify recomputes content-length from what we return, but only for a
    // body it can measure — set it explicitly so a Buffer response stays
    // consistent after the byte length changes.
    reply.header("x-redactions", String(redactions));
    reply.header("content-length", String(Buffer.byteLength(text, "utf8")));
    return isBuffer ? Buffer.from(text, "utf8") : text;
  });

  app.get("/api/health", async (_request, reply) => {
    try {
      await extensions.checkDatabase?.();
    } catch (error) {
      app.log.error({ err: error }, "Health check could not reach the database");
      return reply.code(503).send({ ok: false, service: "volc-agent-launchpad", error: "The database is unavailable" });
    }
    return { ok: true, service: "volc-agent-launchpad" };
  });

  app.get("/api/auth", async () =>
    extensions.identity
      ? { required: true, method: "password" }
      : { required: config.authToken.length > 0, method: "token" },
  );

  if (extensions.runEvents) {
    registerRunEventStream(app, extensions.runEvents);
  }
  if (extensions.runs) {
    registerRunRoutes(app, extensions.runs, config.dataDirectory);
  }
  if (extensions.identity && extensions.memberDatabase) {
    registerMemberRoutes(app, extensions.memberDatabase);
    registerWorkspaceConfigRoutes(app, extensions.memberDatabase);
  }

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
