# AgentGuard interface

How the console looks and how to build a page in it. The goal is clean, sleek and
sharp. The console is where developers and security reviewers supervise autonomous
coding agents, so its job is to show what agents tried to do, what the middleware
decided, and what needs a human decision now.

To see every primitive with sample content, run the dev server and open `/design`.
That page does not exist in production builds.

## The two ideas

Everything else stays quiet so these two read clearly.

### The gate line

The product's principle is that enforcement sits outside the agent. The Run Detail
timeline draws that literally: one continuous 2px graphite line. Left of it is what
the agent proposed, right of it is what the middleware decided.

Nothing else in the app gets this much visual force. When a live event arrives, its
mark draws onto the line once, in about 180ms. That and a running status's moving
segment are the only motion that nobody asked for.

### Two inks: trusted and foreign

The repo treats tool output, commands, diffs, agent narration and repository content
as untrusted evidence. The interface makes that visible at a glance.

- **Trusted facts** (status, policy reasons, timestamps, the user's own prompt): the
  UI sans, on cold surfaces.
- **Foreign material** (anything an agent or repository wrote, including an agent's
  final report, commands, paths, diffs and handoff text): `<Foreign>`, in Spline Sans
  Mono on the only warm surface in the interface, with a hatched left edge.

Never let foreign text look like a system statement, and never hand-roll the surface.
A finished agent turn is the agent's report, not proof. Result panels are labelled
"Agent's report" with the trusted note "Not verified by AgentGuard".

## Decision marks

Shapes are always paired with a word, so colour is never the only signal.

| Contract outcome | Word | Shape | Colour |
| --- | --- | --- | --- |
| `allow` | Allowed | tick | `--passed` |
| `steer` | Steered | chevron | `--steered` |
| `require_approval` | Held | hollow square | `--held` |
| `block` | Blocked | solid bar | `--blocked` |

Statuses reuse the same family through `StatusBadge`. `completed` reads "Finished",
because it means the agent's turn ended and is no evidence the code is correct. Do
not change what a status means to make a screen read better.

## Tokens

All colour comes from `src/ui/tokens.css`, by semantic name.

| Token | Value | Use |
| --- | --- | --- |
| `--graphite` | `#15191E` | top bar, primary text, primary buttons, gate line |
| `--canvas` | `#F5F7F8` | page background |
| `--surface` | `#FFFFFF` | working surfaces only |
| `--steel` | `#56616B` | secondary text |
| `--rule` | `#D6DCE1` | structural rules |
| `--cobalt` | `#1638E0` | focus, current selection and text links, nothing else |
| `--foreign`, `--hatch` | `#F6F2E6`, `#B9AE8F` | foreign material, nothing else |
| `--passed`, `--steered`, `--held`, `--blocked` | see file | decisions, each with a `-tint` |

`--selection-tint`, `--control-edge`, `--hover` and `--focus` are derived helpers. The
top bar sets `--focus` to white, because cobalt on graphite does not reach 3:1.

Rules that still use `--ink`, `--muted`, `--line`, `--paper`, `--purple*`, `--green` or
`--red` predate this system. They are aliases; do not use them in new code.

**Type.** Archivo for the interface: body 14px/1.5, page titles 24px weight 600 at
width 112%, section headings 15px weight 600, metadata 13px steel. The scale is 13, 14,
15, 18, 24, 32. Times and counts use tabular numerals. Spline Sans Mono is only for
foreign material, not for small labels or trusted ids. Both are self-hosted, so the
console makes no third-party font requests.

**Shape and depth.** Radius 0 on structure, 2px on controls, badges and foreign blocks,
nothing rounder and no pills. No drop shadows, except a hard 1px ring on menus and
dialogs. No gradients and no card grids: group with whitespace and rules. Spacing sits
on a 4px grid. Controls are 32px high, and the one main action of a page is 40px.

**Layout.** One 48px graphite bar, no sidebar. Content is left aligned, up to 1440px
wide, with a 24px gutter (16px on phones). Tables and timelines are the main forms:
13-14px text, 40px rows, rules between rows only.

## Building a page

1. Add the route: extend `Route`, `parseRoute` and `paths` in `src/router.tsx`, with a
   test in `src/runs/routes.test.ts`. Validate ids in `parseRoute`, so a malformed one
   never reaches an API path.
2. Render it from `CurrentPage` in `src/App.tsx`, and add a `navItems` entry if it is a
   main view. Only link to views that exist. Hide entries the current auth mode cannot
   use, but remember the server is the check, not the menu.
3. Build the page from the primitives, using `.page` for the frame:

```tsx
import { Link, paths } from "../router";
import { ButtonLink, DataTable, EmptyState, ErrorState, Loading, PageHeader, StatusBadge } from "../ui";

export function Members() {
  // ...fetch with the shared Zod contract...
  return (
    <div className="page">
      <PageHeader
        title="Members"
        description="People who can open this workspace."
        actions={<ButtonLink to={paths.newRun} variant="primary" page>Add a member</ButtonLink>}
      />
      {error !== null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : members === null ? (
        <Loading label="Loading members" />
      ) : members.length === 0 ? (
        <EmptyState title="No members yet">Add someone to give them access.</EmptyState>
      ) : (
        <DataTable caption="Workspace members">
          <thead><tr><th>Email</th><th>Role</th></tr></thead>
          <tbody>{/* rows */}</tbody>
        </DataTable>
      )}
    </div>
  );
}
```

Every data view needs loading, empty and error states. Put page-specific CSS in its own
file with plain class names and import it from `src/main.tsx` before `primitives.css`,
so primitives win by order. Use tokens, never raw colours. Use `Link` or `navigate` for
in-app links, never `window.location`.

## Primitives

From `src/ui`:

| Primitive | Props | Use |
| --- | --- | --- |
| `Button` | `variant` (`secondary`, `primary`, `ghost`, `danger`), `page`, `busy`, plus button attributes | Graphite is the primary colour. Defaults to `type="button"`. |
| `ButtonLink` | `to`, `variant`, `page` | Navigation that looks like a button. |
| `PageHeader` | `title`, `description`, `actions` | The top of every page. |
| `DecisionMark` | `decision`, `label`, `size` | Shape and word for a middleware decision. |
| `DecisionGlyph` | `decision`, `size` | The shape alone. Keep a word nearby. |
| `StatusBadge` | `status`, `live` | Run, Task, Execution or Approval status. Pass `live` while updates are flowing. For an approval, pass `approvalBadgeStatus(status)`, so pending reads Held. |
| `SeverityBadge` | `severity` | A finding's severity. |
| `Foreign` | `label`, `note`, `preformatted`, `maxHeight` | Foreign material. `label` and `note` are trusted; only the children are foreign. Render through text or `MessageContent`, never raw HTML. |
| `ForeignInline` | children | A foreign path or command inside a trusted sentence. |
| `DataTable` | `caption` | Frame for an ordinary table. Use `num` on times and counts, and `cell-prompt` on long text that should truncate. Wide tables scroll inside themselves. |
| `Loading` | `label` | |
| `EmptyState` | `title`, `action`, children | Say what to do next and offer the action. |
| `ErrorState` | `title`, `message`, `onRetry`, `retryLabel` | Say what happened and how to fix it. |
| `GateLine` | `label`, `proposalHeading`, `decisionHeading` | Wraps `GateRow`s, oldest first. |
| `GateRow` | `proposal`, `caption`, `decision`, `decisionLabel`, `reason`, `time`, `fresh`, `selected`, `onSelect`, `selectLabel`, `actions` | One entry. `decision={null}` is a non-decision entry such as a task starting. Set `fresh` only on a row that just arrived live. `proposal` renders as foreign material. |
| `AppShell` | `nav`, `heldCount`, `workspace`, `account` | The frame, used once in `App.tsx`. `heldCount={null}` hides the count: never show "Held 0" unless the app has actually counted. |

Helper classes: `.page`, `.page-section`, `.cluster` (a wrapping row with a gap), `.meta`
(13px steel), `.tabular`, `.sr-only`.

## Writing

Sentence case and plain verbs. An action keeps its name through the flow: "Approve" and
"Deny" give "Approved" and "Denied". Errors say what happened and what to do, and do not
apologise. Empty states say what to do next.

Do not use:

- All-caps labels or tracked-out eyebrows.
- Meta strings joined with middle dots. Lay facts out with space or a real table.
- Spaced em dashes in labels, arrows appended to links, or emoji.
- Pills, rounded cards, soft shadows, gradients, fade-and-slide-up entrances, or hover
  transitions on rows.
- Inter, Manrope or `ui-rounded`.

## Product truth

These outrank looks.

- Every enforcement and authorization decision stays on the server. The UI may hide an
  action a role cannot use, but the server remains the check.
- Do not imply prevention guarantees. This is a proof of concept.
- Never present a completed Codex turn as proof the code is correct.
- No secrets or raw trace content in new API or SSE payloads.

## Quality floor

Responsive down to 360px with no horizontal page scroll; wide tables and foreign blocks
scroll inside themselves. Keyboard reachable with visible focus, AA contrast, and
`prefers-reduced-motion` respected.

## Migration status

The Playground, Safety and sign-in pages are rebuilt on the primitives, with their rules
in `src/playground.css`, `src/safety.css` and `src/auth.css`. `src/styles.css` holds only
what pages share: labels, tabs (`.tab-row`, `.tab`), forms (`.form-stack`, `.form-grid`,
`.form-actions`) and `.error-banner`, plus a few rules marked for the run pages. Those run
pages are in `src/runs/runs.css`, swept mechanically onto the tokens. When one is rebuilt,
delete its old rules.
