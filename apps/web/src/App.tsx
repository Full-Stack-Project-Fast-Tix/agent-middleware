import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { Admin } from "./Admin";
import { Playground } from "./Playground";
import { navigate, paths, useRoute, type Route } from "./router";
import { RunsHome, RunsPage } from "./runs/RunsPage";
import { AppShell, ButtonLink, EmptyState, Loading, type NavItem } from "./ui";
import { usePlayground, type PlaygroundState } from "./usePlayground";

// The primitives gallery is a development aid, left out of production builds.
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import("./ui/DesignPreview").then((module) => ({ default: module.DesignPreview })))
  : null;

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function navItems(route: Route): NavItem[] {
  return [
    { to: paths.dashboard, label: "Dashboard", current: route.page === "dashboard" },
    { to: paths.runs, label: "Runs", current: route.page === "runs" || route.page === "new-run" || route.page === "run" },
    { to: paths.playground, label: "Playground", current: route.page === "playground" },
    { to: paths.safety, label: "Safety", current: route.page === "safety" },
  ];
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState
        title="This page does not exist"
        action={<ButtonLink to={paths.dashboard}>Go to the dashboard</ButtonLink>}
      >
        Check the link. A run link needs the full run id.
      </EmptyState>
    </div>
  );
}

function CurrentPage({ route, playground }: { route: Route; playground: PlaygroundState }) {
  switch (route.page) {
    case "dashboard":
      return <RunsHome title="Dashboard" />;
    case "runs":
    case "new-run":
    case "run":
      return <RunsPage route={route} />;
    case "playground":
      return <Playground state={playground} />;
    case "safety":
      return (
        <>
          {playground.error && (
            <div className="error-banner" role="alert">
              <span>{playground.error}</span>
              <button onClick={() => playground.setError(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          <Admin
            overview={playground.adminOverview}
            agents={playground.agents}
            agentId={playground.adminAgentId}
            onSelectAgent={playground.setAdminAgentId}
            onReturnToChat={(agentId) => {
              playground.setSelectedId(agentId);
              playground.setAdminAgentId(null);
              navigate(paths.playground);
            }}
            onViewRun={(agentId, runId) => {
              playground.setSelectedId(agentId);
              void api.run(runId).then(({ run }) => playground.setActiveRun(run));
              navigate(paths.playground);
            }}
          />
        </>
      );
    case "design":
      if (DesignPreview === null) return <NotFound />;
      return <Suspense fallback={<Loading />}><DesignPreview /></Suspense>;
    case "not-found":
      return <NotFound />;
  }
}

export default function App() {
  const route = useRoute();
  const playground = usePlayground();
  const { bootstrap, openAdmin } = playground;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [authMethod, setAuthMethod] = useState<"token" | "password">("token");
  const [emailInput, setEmailInput] = useState("");

  useEffect(() => {
    let mounted = true;
    void api
      .auth()
      .then(async ({ required, method }) => {
        if (!mounted) return;
        setAuthMethod(method);
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mounted = false;
    };
  }, [bootstrap]);

  const onSafetyPage = route.page === "safety" && authRequired === false;
  useEffect(() => {
    if (onSafetyPage) openAdmin();
  }, [onSafetyPage, openAdmin]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setAuthToken(authMethod === "password" ? (await api.signIn(emailInput, authInput)).token : authInput);
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError(authMethod === "password" ? "The email or password is not right." : "The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="auth-wordmark">Agent<span aria-hidden="true" />Guard</div>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="auth-wordmark">Agent<span aria-hidden="true" />Guard</div>
          <h1>{authMethod === "password" ? "Sign in" : "Enter the access token"}</h1>
          <p>
            {authMethod === "password"
              ? "Use the account your platform operator set up for you."
              : "This shared demo token is configured by the platform operator."}
          </p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {authMethod === "password" && (
            <label>
              Email
              <input
                autoFocus
                type="email"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
          )}
          <label>
            {authMethod === "password" ? "Password" : "Access token"}
            <input
              autoFocus={authMethod !== "password"}
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary button-page" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : authMethod === "password" ? "Sign in" : "Open AgentGuard"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <AppShell nav={navItems(route)} heldCount={null}>
      <CurrentPage route={route} playground={playground} />
    </AppShell>
  );
}
