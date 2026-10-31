import { lazy, Suspense, useEffect, useState } from "react";
import { api, setAuthToken } from "./api";
import { Admin } from "./Admin";
import { AuthScreen, ConnectingScreen } from "./AuthScreen";
import { Playground } from "./Playground";
import { navigate, paths, useRoute, type Route } from "./router";
import { RunsHome, RunsPage } from "./runs/RunsPage";
import { AppShell, ButtonLink, EmptyState, Loading, type NavItem } from "./ui";
import { CurrentWorkspaceProvider } from "./useCurrentWorkspace";
import { usePlayground, type PlaygroundState } from "./usePlayground";

// The primitives gallery is a development aid, left out of production builds.
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import("./ui/DesignPreview").then((module) => ({ default: module.DesignPreview })))
  : null;

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
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authMethod, setAuthMethod] = useState<"token" | "password">("token");

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

  const unlock = async ({ email, secret }: { email: string; secret: string }) => {
    setAuthToken(authMethod === "password" ? (await api.signIn(email, secret)).token : secret);
    await bootstrap();
    setAuthRequired(false);
  };

  if (authRequired === null) return <ConnectingScreen error={error} />;
  if (authRequired) return <AuthScreen method={authMethod} onUnlock={unlock} />;

  return (
    <CurrentWorkspaceProvider>
      <AppShell nav={navItems(route)} heldCount={null}>
        <CurrentPage route={route} playground={playground} />
      </AppShell>
    </CurrentWorkspaceProvider>
  );
}
