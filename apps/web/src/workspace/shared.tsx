import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentCapabilities, Page, WorkspaceSummary } from "@launchpad/shared";
import { EmptyState, ErrorState, Loading, PageHeader } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";

/** A page that needs a workspace. Keyed by workspace: a slow answer about the last one goes to a page that is gone. */
export function WorkspacePage({ title, description, children }: {
  title: string;
  description: string;
  children: (workspace: WorkspaceSummary) => ReactNode;
}) {
  const { workspaces, current, error, reload } = useCurrentWorkspace();
  return (
    <div className="page">
      <PageHeader title={title} description={description} />
      {error !== null ? (
        <ErrorState message={`The list of workspaces did not load: ${error}`} onRetry={reload} />
      ) : workspaces === null ? (
        <Loading label="Loading workspaces" />
      ) : current === null ? (
        <EmptyState title="You are not in a workspace yet">Ask a security admin to add you to their workspace.</EmptyState>
      ) : (
        <div key={current.id} className="workspace-page">{children(current)}</div>
      )}
    </div>
  );
}

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Loads when `key` changes; a newer load wins over a slower older one. */
export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const current = useRef(load);
  current.current = load;

  const refresh = useCallback(async () => {
    const attempt = ++latest.current;
    try {
      const next = await current.current();
      if (attempt !== latest.current) return;
      setData(next);
      setError(null);
    } catch (reason) {
      if (attempt === latest.current) setError(messageOf(reason));
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      latest.current += 1;
    };
  }, [key, refresh]);

  return { data, error, refresh };
}

/** A cursor-paged list that starts over when `key` changes. */
export function usePaged<T>(key: string, fetchPage: (cursor: string | undefined) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const latest = useRef(0);
  const current = useRef(fetchPage);
  current.current = fetchPage;

  const reload = useCallback(async () => {
    const attempt = ++latest.current;
    try {
      const page = await current.current(undefined);
      if (attempt !== latest.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (reason) {
      if (attempt === latest.current) setError(messageOf(reason));
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [key, reload]);

  const loadMore = async () => {
    if (cursor === null) return;
    const attempt = latest.current;
    setLoadingMore(true);
    try {
      const page = await current.current(cursor);
      if (attempt !== latest.current) return;
      setItems((before) => [...(before ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (reason) {
      if (attempt === latest.current) setError(messageOf(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  return { items, hasMore: cursor !== null, loadingMore, error, reload, loadMore };
}

/** Runs one change at a time, and keeps its error to show. */
export function useChange(onDone: () => void | Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onDone();
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, clearError: () => setError(null), run };
}

export function ChangeError({ message }: { message: string | null }) {
  return message === null ? null : <p className="notice notice-blocked" role="alert">{message}</p>;
}

const CAPABILITY_WORDS: Record<keyof Omit<AgentCapabilities, "maxDelegationDepth">, string> = {
  write: "Write files",
  shell: "Run commands",
  network: "Use the network",
  delegate: "Delegate",
};
export const CAPABILITIES = Object.keys(CAPABILITY_WORDS) as Array<keyof typeof CAPABILITY_WORDS>;
export const capabilityWord = (capability: keyof typeof CAPABILITY_WORDS) => CAPABILITY_WORDS[capability];

export function CapabilityList({ capabilities }: { capabilities: AgentCapabilities }) {
  const allowed = CAPABILITIES.filter((capability) => capabilities[capability]).map(capabilityWord);
  return <>{allowed.length === 0 ? "Read only" : allowed.join(", ")}</>;
}
