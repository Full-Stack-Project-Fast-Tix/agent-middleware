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
    return window.sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

// Only until this tab closes, and only for a signed-in session: a shared token
// stays in memory, because it does not expire.
let authToken = savedSession();

export function setAuthToken(token: string, options: { remember?: boolean } = {}): void {
  authToken = token.trim();
  try {
    if (options.remember && authToken !== "") window.sessionStorage.setItem(SESSION_KEY, authToken);
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: reloading the page then signs out.
  }
}

/** Whether this tab holds a session from before a reload, which may have expired. */
export const hasSavedSession = (): boolean => authToken !== "";

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
