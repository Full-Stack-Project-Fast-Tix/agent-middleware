import { useEffect, useState, type ReactNode } from "react";
import { Link, paths } from "../router";
import { DecisionGlyph } from "./marks";

export interface NavItem {
  to: string;
  label: string;
  /** Whether this entry is the current view. */
  current: boolean;
}

function HeldCount({ count }: { count: number }) {
  const label = count === 0
    ? "Nothing is held for your approval"
    : count === 1
      ? "1 action is held for your approval"
      : `${count} actions are held for your approval`;
  return (
    <Link to={paths.dashboard} className={"held-count" + (count > 0 ? " held-count-active" : "")} aria-label={label}>
      {count > 0 && <DecisionGlyph decision="require_approval" size={14} />}
      Held {count}
    </Link>
  );
}

function NavLinks({ items }: { items: readonly NavItem[] }) {
  return (
    <nav className="topnav" aria-label="Main">
      {items.map((item) => (
        <Link key={item.to} to={item.to} aria-current={item.current ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The frame around every signed-in view: one graphite bar and the content.
 *
 * `heldCount` is null until the app can actually count held actions; the count
 * then stays visible at zero. Showing "Held 0" without knowing would be a false
 * statement on a security console, so null hides it instead.
 */
export function AppShell({ nav, heldCount, workspace, account, children }: {
  nav: readonly NavItem[];
  heldCount: number | null;
  /** The workspace switcher. */
  workspace?: ReactNode;
  /** The account menu. */
  account?: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const currentPath = nav.find((item) => item.current)?.to ?? null;

  useEffect(() => setMenuOpen(false), [currentPath]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="topbar-row">
          <Link to={paths.dashboard} className="wordmark" aria-label="AgentGuard dashboard">
            Agent<span className="wordmark-gate" aria-hidden="true" />Guard
          </Link>
          <NavLinks items={nav} />
          <div className="topbar-end">
            {heldCount !== null && <HeldCount count={heldCount} />}
            {workspace && <div className="topbar-slot">{workspace}</div>}
            {account && <div className="topbar-slot">{account}</div>}
            <button
              type="button"
              className="topbar-menu-button"
              aria-expanded={menuOpen}
              aria-controls="topbar-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        <div
          className="topbar-menu"
          id="topbar-menu"
          hidden={!menuOpen}
          onClick={(event) => {
            if ((event.target as Element).closest("a")) setMenuOpen(false);
          }}
        >
          <NavLinks items={nav} />
          {workspace && <div className="topbar-slot">{workspace}</div>}
          {account && <div className="topbar-slot">{account}</div>}
        </div>
      </header>
      <main className="app-main" id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
