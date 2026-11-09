import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { paths } from "../router";
import { AppShell, type NavItem } from "./AppShell";

const nav: NavItem[] = [
  { to: paths.dashboard, label: "Dashboard", current: false },
  { to: paths.runs, label: "Runs", current: false },
  { to: paths.approvals, label: "Approvals", current: false },
  { to: paths.agents, label: "Agents", current: true },
  { to: paths.policies, label: "Policies", current: false },
  { to: paths.security, label: "Security", current: false },
  { to: paths.benchmarks, label: "Benchmarks", current: false },
  { to: paths.members, label: "Members", current: false },
  { to: paths.credentials, label: "Credentials", current: false },
];

function renderShell(items = nav) {
  return renderToStaticMarkup(
    <AppShell nav={items} heldCount={0}>
      <p>Page content</p>
    </AppShell>,
  );
}

describe("AppShell navigation", () => {
  it("keeps the primary links visible and groups workspace links with the current page identified", () => {
    const html = renderShell();
    const primaryEnd = html.indexOf("<details class=\"topnav-group topnav-group-current\">");
    const desktopNav = html.slice(html.indexOf("<nav class=\"topnav\""), primaryEnd);

    expect(desktopNav).toContain('href="/"');
    expect(desktopNav).toContain('href="/runs"');
    expect(desktopNav).toContain('href="/approvals"');
    expect(desktopNav).not.toContain('href="/agents"');
    expect(html).toContain('<summary aria-label="Workspace navigation, current page: Agents">Workspace<span class="topnav-group-page">Agents</span></summary>');
    expect(html).toContain('<a aria-current="page" href="/agents">Agents</a>');
  });

  it("keeps every destination directly listed in the mobile menu", () => {
    const html = renderShell();
    const mobileMenu = html.slice(html.indexOf('<div class="topbar-menu"'));

    for (const item of nav) {
      expect(mobileMenu).toContain(`href="${item.to}"`);
    }
    expect(mobileMenu).not.toContain("<details");
  });

  it("does not render an empty workspace group in token mode", () => {
    const html = renderShell(nav.slice(0, 2));

    expect(html).not.toContain("<details");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/runs"');
  });
});
