import type { FastifyRequest } from "fastify";

/**
 * Whether a request may proceed without a credential.
 *
 * Decided from the route the router matched, not only the raw URL. The router
 * decodes a path before matching it, so `/%61pi/agents` runs the `/api/agents`
 * handler although its raw URL does not start with `/api/`. The raw URL still
 * counts, so an unknown `/api/` path is refused rather than falling through to
 * the static files' wildcard route.
 */
export function isOpenRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url ?? "";
  if (route === "/api/health" || route === "/api/auth") return true;
  if (request.method === "POST" && route === "/api/auth/session") return true;
  return !route.startsWith("/api/") && !request.url.startsWith("/api/");
}
