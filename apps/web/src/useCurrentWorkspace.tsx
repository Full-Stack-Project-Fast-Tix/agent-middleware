import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "./api";
import { runsApi, type WorkspaceSummary } from "./runs/runs-api";

const CURRENT_KEY = "agentguard.currentWorkspace";

export interface CurrentWorkspace {
  /** Null while the first load is running. */
  workspaces: WorkspaceSummary[] | null;
  current: WorkspaceSummary | null;
  /** Who the server says is signed in. Null until the first load finishes. */
  viewerId: string | null;
  error: string | null;
  select: (workspaceId: string) => void;
  reload: () => void;
}

const Context = createContext<CurrentWorkspace | null>(null);

/** Only hides what the server would refuse. Until the role is known, it still offers the action. */
export function useMayStartRuns(): boolean {
  return useCurrentWorkspace().current?.role !== "auditor";
}

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

/**
 * Which workspace the shell and its pages are looking at. The choice is only a
 * view preference: the server still checks access on every request.
 */
export function CurrentWorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readSaved);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    runsApi
      .workspaces()
      .then((response) => {
        if (!mounted) return;
        setWorkspaces(response.workspaces);
        setViewerId(response.viewerId);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!mounted) return;
        setWorkspaces([]);
        setError(
          reason instanceof ApiError && reason.status === 404
            ? "This server does not offer multi-agent runs. Start it with RUNS_DEMO=1 for the local demo, or in password mode with RUNTIME_PROVIDER=container."
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  const select = useCallback((workspaceId: string) => {
    setSelectedId(workspaceId);
    try {
      window.localStorage.setItem(CURRENT_KEY, workspaceId);
    } catch {
      // The choice then lasts only until the page reloads.
    }
  }, []);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const value = useMemo<CurrentWorkspace>(
    () => ({
      workspaces,
      current: workspaces?.find((workspace) => workspace.id === selectedId) ?? workspaces?.[0] ?? null,
      viewerId,
      error,
      select,
      reload,
    }),
    [error, reload, select, selectedId, viewerId, workspaces],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCurrentWorkspace(): CurrentWorkspace {
  const value = useContext(Context);
  if (value === null) throw new Error("useCurrentWorkspace needs a CurrentWorkspaceProvider");
  return value;
}
