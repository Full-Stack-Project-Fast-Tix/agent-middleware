import { useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

// A small History API router: enough for real URLs and the back button without
// a dependency. Add a page by extending Route and parseRoute.

export type Route =
  | { page: "dashboard" }
  | { page: "runs" }
  | { page: "new-run" }
  | { page: "run"; runId: string }
  | { page: "playground" }
  | { page: "safety" }
  | { page: "members" }
  | { page: "design" }
  | { page: "not-found" };

export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const paths = {
  dashboard: "/",
  runs: "/runs",
  newRun: "/runs/new",
  run: (runId: string): string => `/runs/${runId}`,
  playground: "/playground",
  safety: "/safety",
  members: "/members",
  design: "/design",
} as const;

export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  switch (path) {
    case "":
    case "/":
      return { page: "dashboard" };
    case paths.runs:
      return { page: "runs" };
    case paths.newRun:
      return { page: "new-run" };
    case paths.playground:
      return { page: "playground" };
    case paths.safety:
      return { page: "safety" };
    case paths.members:
      return { page: "members" };
    case paths.design:
      return { page: "design" };
  }
  // A malformed id must not reach an API path.
  const match = /^\/runs\/([^/]+)$/.exec(path);
  if (match && RUN_ID.test(match[1]!)) return { page: "run", runId: match[1]! };
  return { page: "not-found" };
}

/**
 * Where a link from before real URLs now lives, or null if the hash is not one.
 * Those links looked like #/runs/<id>; #/runs and #/runs/new opened the new-run
 * page. A malformed id goes to the runs list, so it never reaches an API path.
 */
export function legacyHashTarget(hash: string): string | null {
  const path = hash.replace(/^#/, "");
  if (path === "/runs" || path === "/runs/" || path === paths.newRun) return paths.newRun;
  if (!path.startsWith("/runs/")) return null;
  const route = parseRoute(path);
  return route.page === "run" ? paths.run(route.runId) : paths.runs;
}

const LOCATION_CHANGED = "agentguard:location";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === path) return;
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(LOCATION_CHANGED));
  if (!options.replace) window.scrollTo(0, 0);
}

/**
 * Swap an old hash link for its real URL. It replaces the history entry, so the
 * back button leaves the page rather than bouncing through the redirect.
 */
export function followLegacyHash(): void {
  const target = legacyHashTarget(window.location.hash);
  if (target !== null) navigate(target, { replace: true });
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_CHANGED, onChange);
  };
}

export function useRoute(): Route {
  // main.tsx follows a hash present at load, before the first render.
  useEffect(() => {
    window.addEventListener("hashchange", followLegacyHash);
    return () => window.removeEventListener("hashchange", followLegacyHash);
  }, []);
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return useMemo(() => parseRoute(pathname), [pathname]);
}

/** An in-app link. New-tab clicks and other modified clicks stay with the browser. */
export function Link({ to, onClick, ...rest }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={follow} />;
}
