import { useState } from "react";
import { ApiError } from "./api";
import { Button, DecisionGlyph, Loading } from "./ui";

export type AuthMethod = "token" | "password";

/** "in 40 seconds" or "in 15 minutes", rounded up so the wait is never too short. */
function waitWords(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, Math.ceil(seconds))} second${seconds <= 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * The same words whether or not the account exists, because the server answers
 * both the same way. This screen must not add a difference it cannot see.
 */
function refusalMessage(reason: unknown, method: AuthMethod): string {
  if (reason instanceof ApiError && reason.status === 429) {
    return `Too many sign-in attempts. Try again ${reason.retryAfter === null ? "later" : waitWords(reason.retryAfter)}.`;
  }
  if (reason instanceof ApiError && reason.status === 401) {
    return method === "password" ? "The email or password is not right." : "The access token is not valid.";
  }
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The first screen anyone sees. The wordmark sits across the gate line, and the
 * mark on it answers the person: held until they get through, blocked if refused.
 */
function AuthFrame({ refused, attempt = 0, children }: { refused: boolean; attempt?: number; children: React.ReactNode }) {
  return (
    <main className="auth-screen">
      <div className="auth-agent-side">
        <span className="auth-word">Agent</span>
        <div className="auth-pitch">
          <p>See what your coding agents try, what was decided, and what is waiting on you.</p>
          <p>Proof of concept.</p>
        </div>
      </div>
      <div className="auth-guard-side">
        <span className={refused ? "auth-mark auth-mark-refused" : "auth-mark"} key={attempt} aria-hidden="true">
          <DecisionGlyph decision={refused ? "block" : "require_approval"} size={24} />
        </span>
        <span className="auth-word">Guard</span>
      </div>
      <div className="auth-body">{children}</div>
    </main>
  );
}

export function ConnectingScreen({ error }: { error: string | null }) {
  return (
    <AuthFrame refused={error !== null}>
      <h1>Connecting to the server</h1>
      {error === null ? <Loading label="Checking how to sign in" /> : (
        <div className="state-error" role="alert">
          <strong>The server did not answer</strong>
          <div>{error}</div>
          <div>Check that it is running, then reload this page.</div>
        </div>
      )}
    </AuthFrame>
  );
}

export function AuthScreen({ method, onUnlock }: {
  method: AuthMethod;
  /** Signs in. A rejection is shown here, and the form stays open. */
  onUnlock: (credentials: { email: string; secret: string }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const password = method === "password";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onUnlock({ email, secret });
      setSecret("");
    } catch (reason) {
      setError(refusalMessage(reason, method));
      setAttempt((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame refused={error !== null} attempt={attempt}>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <div className="auth-heading">
          <h1>{password ? "Sign in" : "Enter the access token"}</h1>
          <p className="meta">
            {password
              ? "Use the account your platform operator set up for you."
              : "Your platform operator has this token."}
          </p>
        </div>
        {error !== null && <div className="state-error" role="alert">{error}</div>}
        {password && (
          <label>
            Email
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
        )}
        <label>
          {password ? "Password" : "Access token"}
          <input
            autoFocus={!password}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <Button type="submit" variant="primary" page busy={busy} disabled={!secret.trim()}>
          {password ? "Sign in" : "Open AgentGuard"}
        </Button>
      </form>
    </AuthFrame>
  );
}
