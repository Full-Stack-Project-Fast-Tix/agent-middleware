import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { User } from "@launchpad/shared";
import { api, hasSavedSession, setAuthToken } from "./api";
import { AccountMenu } from "./AccountMenu";
import { AgentsPage } from "./workspace/AgentsPage";
import { ApprovalsPage } from "./workspace/ApprovalsPage";
import { BenchmarksPage } from "./workspace/BenchmarksPage";
import { PoliciesPage } from "./workspace/PoliciesPage";
import { SecurityPage } from "./workspace/SecurityPage";
import { AuthScreen, ConnectingScreen } from "./AuthScreen";
import { Members, MembersUnavailable } from "./members/Members";
import { membersApi } from "./members/members-api";
import { navigate, paths, useRoute, type Route } from "./router";
import { Dashboard } from "./runs/Dashboard";
import { RunsPage } from "./runs/RunsPage";
import { useHeldCount } from "./runs/useRunList";
import { signOut } from "./sign-out";
import { AppShell, ButtonLink, Loading, type NavItem } from "./ui";
import { CurrentWorkspaceProvider, useCurrentWorkspace } from "./useCurrentWorkspace";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

// The primitives gallery is a development aid, left out of production builds.
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import("./ui/DesignPreview").then((module) => ({ default: module.DesignPreview })))
  : null;

function navItems(route: Route, authMethod: "token" | "password"): NavItem[] {
  return [
    { to: paths.dashboard, label: "Dashboard", current: route.page === "dashboard" },
    { to: paths.runs, label: "Runs", current: route.page === "runs" || route.page === "new-run" || route.page === "run" },
    // These read Postgres, which the shared-token mode does not have.
    ...(authMethod === "token"
      ? []
      : [
          { to: paths.approvals, label: "Approvals", current: route.page === "approvals" },
          { to: paths.agents, label: "Agents", current: route.page === "agents" },
          { to: paths.policies, label: "Policies", current: route.page === "policies" },
          { to: paths.security, label: "Security", current: route.page === "security" },
          { to: paths.benchmarks, label: "Benchmarks", current: route.page === "benchmarks" },
          { to: paths.members, label: "Members", current: route.page === "members" },
        ]),
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

function CurrentPage({ route, authMethod, viewer }: {
  route: Route;
  authMethod: "token" | "password";
  viewer: User | null;
}) {
  // These read Postgres, which the shared-token mode does not have.
  if (authMethod === "token" && ["agents", "policies", "approvals", "security", "benchmarks"].includes(route.page)) return <NotFound />;
  switch (route.page) {
    case "dashboard":
      return <Dashboard />;
    case "runs":
    case "new-run":
    case "run":
      return <RunsPage route={route} />;
    case "agents":
      return <AgentsPage />;
    case "policies":
      return <PoliciesPage />;
    case "approvals":
      return <ApprovalsPage />;
    case "security":
      return <SecurityPage />;
    case "benchmarks":
      return <BenchmarksPage />;
    case "members":
      return authMethod === "password" ? <Members viewerId={viewer?.id ?? null} /> : <MembersUnavailable />;
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
 * survives: polling and open event streams all go with it.
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
        if (required && method === "password" && hasSavedSession()) {
          const valid = await membersApi.me().then(() => true, () => false);
          if (!mounted) return;
          if (valid) {
            setAuthRequired(false);
            return;
          }
          setAuthToken("");
        }
        setAuthRequired(required);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mounted = false;
    };
  }, []);

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
    if (authMethod === "password") {
      setAuthToken((await api.signIn(email, secret)).token, { remember: true });
    } else {
      setAuthToken(secret);
      await api.checkToken();
    }
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
        <CurrentPage route={route} authMethod={authMethod} viewer={viewer} />
      </Shell>
    </CurrentWorkspaceProvider>
  );
}
