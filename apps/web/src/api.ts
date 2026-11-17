export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const SESSION_KEY = "agentguard.session";

function savedSession(): string {
  try {
    return window.localStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

// Shared by this browser's tabs until the session expires or ends, and only for
// a signed-in session: a shared token stays in memory, because it does not expire.
let authToken = savedSession();

export function setAuthToken(token: string, options: { remember?: boolean } = {}): void {
  authToken = token.trim();
  try {
    if (options.remember && authToken !== "") window.localStorage.setItem(SESSION_KEY, authToken);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: reloading the page then signs out.
  }
}

/** Whether this browser holds a session from an earlier page load, which may have expired. */
export const hasSavedSession = (): boolean => authToken !== "";

/**
 * Reload when another tab signs in or out, so that no tab keeps working as
 * someone who has left. Returns how to stop.
 */
export function followSessionInOtherTabs(reload: () => void = () => window.location.reload()): () => void {
  const onStorage = (event: StorageEvent) => {
    // A null key means the other tab cleared all of storage.
    if ((event.key === SESSION_KEY || event.key === null) && savedSession() !== authToken) reload();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** For requests that cannot go through `request`, such as the event stream. */
export function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: "Bearer " + authToken } : {};
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...authHeaders(),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean; method: "token" | "password" }>("/api/auth"),
  signIn: (email: string, password: string) =>
    request<{ token: string }>("/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  signOut: () => request<unknown>("/api/auth/session", { method: "DELETE" }),
  /** Whether a shared token is accepted. A server with no Run routes answers 404 only once it is. */
  checkToken: () =>
    request<unknown>("/api/workspaces").catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }),
};
