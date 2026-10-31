import { api, ApiError, setAuthToken } from "./api";

// What this browser keeps about the signed-in person between page loads. The
// next person to sign in here must not inherit it.
const PER_USER_STORAGE = ["agentguard.currentWorkspace", "agentguard.recentRuns"];

export const SESSION_NOT_ENDED_NOTICE =
  "You are signed out of this browser, but the server did not confirm that your session ended. It stays valid until it expires, within 12 hours.";

/**
 * End the session and forget it locally, whatever the server says. A 401 means
 * the session was already over. Any other failure leaves it possibly alive, so
 * the answer is the notice to show rather than a claim that it ended.
 */
export async function signOut(): Promise<string | null> {
  let notice: string | null = null;
  try {
    await api.signOut();
  } catch (reason) {
    if (!(reason instanceof ApiError && reason.status === 401)) notice = SESSION_NOT_ENDED_NOTICE;
  }
  setAuthToken("");
  try {
    for (const key of PER_USER_STORAGE) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept there.
  }
  return notice;
}
