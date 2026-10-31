import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { User } from "@launchpad/shared";
import { api, setAuthToken } from "./api";
import { AccountMenu } from "./AccountMenu";
import { Admin } from "./Admin";
import { AuthScreen, ConnectingScreen } from "./AuthScreen";
import { Members, MembersUnavailable } from "./members/Members";
import { AgentsPage, AuditPage, BenchmarksPage, PoliciesPage } from "./inspection/InspectionPages";
import { membersApi } from "./members/members-api";
import { Playground } from "./Playground";
import { navigate, paths, useRoute, type Route } from "./router";
import { Dashboard } from "./runs/Dashboard";
import { RunsPage } from "./runs/RunsPage";
import { useHeldCount } from "./runs/useRunList";
import { signOut } from "./sign-out";
import { AppShell, Button, ButtonLink, Loading, type NavItem } from "./ui";
import { CurrentWorkspaceProvider, useCurrentWorkspace } from "./useCurrentWorkspace";
import { usePlayground, type PlaygroundState } from "./usePlayground";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

// The primitives gallery is a development aid, left out of production builds.
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import("./ui/DesignPreview").then((module) => ({ default: module.DesignPreview })))
  : null;

function navItems(route: Route, authMethod: "token" | "password"): NavItem[] {
  return [
    { to: paths.dashboard, label: "Dashboard", current: route.page === "dashboard" },
    { to: paths.runs, label: "Runs", current: route.page === "runs" || route.page === "new-run" || route.page === "run" },
    { to: paths.playground, label: "Playground", current: route.page === "playground" },
    { to: paths.safety, label: "Safety", current: route.page === "safety" },
    ...(authMethod === "password" ? [
      { to: paths.agents, label: "Agents", current: route.page === "agents" },
      { to: paths.policies, label: "Policies", current: route.page === "policies" },
      { to: paths.audit, label: "Audit", current: route.page === "audit" },
      { to: paths.benchmarks, label: "Benchmarks", current: route.page === "benchmarks" },
    ] : []),
    // The member routes exist only in password mode.
    ...(authMethod === "password" ? [{ to: paths.members, label: "Members", current: route.page === "members" }] : []),
  ];
}

function NotFound() {
  return (
    <div className="page">
      <div className="state-empty">
        <h1>This page does not exist</h1>
        <p>Check the link. A run link needs the full run id.</p>
        <div className="state-empty-action"><ButtonLink to={paths.dashboard}>Go to the dashboard</ButtonLink></div>
      </div>
    </div>
  );
}

function CurrentPage({ route, playground, authMethod, viewer }: {
  route: Route;
  playground: PlaygroundState;
  authMethod: "token" | "password";
  viewer: User | null;
}) {
  switch (route.page) {
    case "dashboard":
      return <Dashboard />;
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
            <div className="notice notice-blocked page-banner" role="alert">
              <span>{playground.error}</span>
              <Button variant="ghost" onClick={() => playground.setError(null)}>Dismiss</Button>
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
    case "members":
      return authMethod === "password" ? <Members viewerId={viewer?.id ?? null} /> : <MembersUnavailable />;
    case "agents": return authMethod === "password" ? <AgentsPage /> : <NotFound />;
    case "policies": return authMethod === "password" ? <PoliciesPage /> : <NotFound />;
    case "audit": return authMethod === "password" ? <AuditPage /> : <NotFound />;
    case "benchmarks": return authMethod === "password" ? <BenchmarksPage /> : <NotFound />;
    case "design":
      if (DesignPreview === null) return <NotFound />;
      return <Suspense fallback={<Loading />}><DesignPreview /></Suspense>;
    case "not-found":
      return <NotFound />;
  }
}

/** The frame with what it needs from the current workspace. */
function Shell({ nav, account, children }: { nav: NavItem[]; account?: React.ReactNode; children: React.ReactNode }) {
  const { current } = useCurrentWorkspace();
  return (
    <AppShell nav={nav} heldCount={useHeldCount(current?.id ?? null)} workspace={<WorkspaceSwitcher />} account={account}>
      {children}
    </AppShell>
  );
}

/**
 * Signing out remounts the session, so nothing held for the signed-in person
 * survives: playground state, polling and open event streams all go with it.
 */
export default function App() {
  const [session, setSession] = useState<{ id: number; notice: string | null }>({ id: 0, notice: null });
  const onSignedOut = useCallback((notice: string | null) => {
    navigate(paths.dashboard, { replace: true });
    setSession((previous) => ({ id: previous.id + 1, notice }));
  }, []);
  return <AppSession key={session.id} notice={session.notice} onSignedOut={onSignedOut} />;
}

function AppSession({ notice, onSignedOut }: { notice: string | null; onSignedOut: (notice: string | null) => void }) {
  const route = useRoute();
  const playground = usePlayground();
  const { bootstrap, openAdmin } = playground;
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authMethod, setAuthMethod] = useState<"token" | "password">("token");
  const [viewer, setViewer] = useState<User | null>(null);

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

  const signedIn = authRequired === false && authMethod === "password";
  useEffect(() => {
    if (!signedIn) return;
    let mounted = true;
    membersApi
      .me()
      .then((user) => {
        if (mounted) setViewer(user);
      })
      .catch(() => {
        // The account menu still offers signing out without the name.
      });
    return () => {
      mounted = false;
    };
  }, [signedIn]);

  const unlock = async ({ email, secret }: { email: string; secret: string }) => {
    setAuthToken(authMethod === "password" ? (await api.signIn(email, secret)).token : secret);
    await bootstrap();
    setAuthRequired(false);
  };

  if (authRequired === null) return <ConnectingScreen error={error} />;
  if (authRequired) return <AuthScreen method={authMethod} notice={notice} onUnlock={unlock} />;

  return (
    <CurrentWorkspaceProvider>
      <Shell
        nav={navItems(route, authMethod)}
        account={authMethod === "password"
          ? <AccountMenu user={viewer} onSignOut={async () => onSignedOut(await signOut())} />
          : undefined}
      >
        <CurrentPage route={route} playground={playground} authMethod={authMethod} viewer={viewer} />
      </Shell>
    </CurrentWorkspaceProvider>
  );
}
