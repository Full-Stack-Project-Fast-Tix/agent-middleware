import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { encodeResyncFrame, encodeRunEventFrame } from "@launchpad/shared";
import { HttpError } from "./errors.js";
import { redactText } from "./redaction/index.js";
import type { RunEventHub } from "./run-events.js";

export interface RunEventStreamOptions {
  hub: RunEventHub;
  /**
   * Whether the Run exists and this caller may read it. Until Run persistence
   * and RBAC exist this is `hub.has(runId)`; it should then check the Run
   * repository and the caller's workspace role.
   */
  canReadRun: (runId: string, request: FastifyRequest) => boolean | Promise<boolean>;
  /** Comment sent on idle connections so proxies do not close them. */
  heartbeatMs?: number;
  /**
   * A client whose unsent backlog grows past this is disconnected. It
   * reconnects with Last-Event-ID and catches up from the replay buffer,
   * instead of the server holding an unbounded queue for it.
   */
  maxBufferedBytes?: number;
}

const params = z.object({ id: z.uuid() });
const seqSchema = z.coerce.number().int().nonnegative();
const query = z.object({ after: seqSchema.optional() });

/**
 * GET /api/runs/:id/events — live RunEvents as Server-Sent Events.
 *
 * Resume position comes from the Last-Event-ID header (sent automatically on
 * reconnect), or `?after=` for the first connection after loading a
 * RunSnapshot. Each frame is redacted before it is written, because the
 * global onSend redaction hook never sees a streamed body.
 */
export function registerRunEventStream(app: FastifyInstance, options: RunEventStreamOptions): void {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
  const open = new Set<ServerResponse>();

  // Open streams never finish on their own, so end them or close() would wait forever.
  app.addHook("preClose", async () => {
    for (const response of open) response.end();
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    const { id } = params.parse(request.params);
    const lastEventId = request.headers["last-event-id"];
    const afterSeq =
      lastEventId === undefined ? (query.parse(request.query).after ?? 0) : seqSchema.parse(lastEventId);
    if (!(await options.canReadRun(id, request))) {
      throw new HttpError(404, "Run not found");
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      // Keep headers other hooks already set (CORS, for one).
      ...Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, value]) => value !== undefined)),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");

    const send = (frame: string) => {
      if (response.writableEnded) return;
      response.write(redactText(frame).text);
      if (response.writableLength > maxBufferedBytes) response.destroy();
    };

    const subscription = options.hub.subscribe(id, afterSeq, {
      onEvent: (event) => send(encodeRunEventFrame(event)),
      onResync: () => {
        if (!response.writableEnded) response.end(encodeResyncFrame());
      },
    });
    if (subscription.status === "resync") {
      response.end(encodeResyncFrame());
      return reply;
    }

    open.add(response);
    const heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
    response.on("close", () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      open.delete(response);
    });
    return reply;
  });
}
