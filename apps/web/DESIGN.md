# AgentGuard interface

How the console looks and how to build a page in it. The goal is clean, sleek and
pleasant to spend time in: crisp and refined, never hard-edged. The console is where
developers and security reviewers supervise autonomous coding agents, so its job is to
show what agents tried to do, what the middleware decided, and what needs a human
decision now.

To see every primitive with sample content, run the dev server and open `/design`.
That page does not exist in production builds.

## The direction

A quiet, cool page in petrol ink. White surfaces on a soft grey-green canvas, hairlines
instead of rules, one brand colour used sparingly, and generous space. Colour is kept
for what means something: a decision, the current selection, the main action.

Boldness goes in one place, the gate line. Everything else stays out of its way.

## The two ideas

### The gate line

The product's principle is that enforcement sits outside the agent. The Run Detail
timeline draws that literally: what the agent proposed on the left, what AgentGuard
decided on the right, one fine continuous line between them, and a decision mark on it.

The short link that joins a proposal to its verdict says what happened at the line:

| Decision | The link | The mark |
| --- | --- | --- |
| Allowed | runs through the line | a tick on a plain ring |
| Steered | runs through the line | a bending arrow on a soft violet ring |
| Held | reaches the line, then waits, dashed | pause bars on a soft amber ring |
| Blocked | stops at the line | a solid no-entry sign, the one filled mark |

On a phone the line runs down the left, with each mark beside its verdict. The sign-in
screen shows three sample rows of the real `GateLine`, restyled only by redefining tokens
inside the panel.

When a live event arrives, its mark arrives on the line once, in about 220ms. That, a
running status's turning arc, and the sign-in sample's single reveal are the only motion
nobody asked for. Motion that answers a person (a menu opening, a hover) is short, about
120ms. All of it stops under `prefers-reduced-motion`.

### Two inks: trusted and foreign

The repo treats tool output, commands, diffs, agent narration and repository content as
untrusted evidence. The interface makes that visible, quietly.

- **Trusted facts** (status, policy reasons, timestamps, the user's own prompt): Instrument
  Sans, on cool surfaces.
- **Foreign material** (anything an agent or repository wrote, including an agent's final
  report, commands, paths, diffs and handoff text): `<Foreign>`, in Red Hat Mono on the only
  warm surface in the interface, with a hairline edge.
- **Foreign words inside a trusted sentence**: `<ForeignInline>`, the mono face in a warm ink
  with no tile, so captions and tables stay calm.

Never let foreign text look like a system statement, and never hand-roll the surface. A
delegated task's title and objective come from the planning agent, so they count as foreign
wherever they sit next to a decision. Task names in the graph stay readable, with a line
saying the plan wrote them.

A proposal that was not saved is a trusted statement, not foreign text: `proposalMissing`
renders "The command text was not saved." in the sans on a cool surface.

A finished agent turn is the agent's report, not proof. Result panels are labelled
"Agent's report" with the trusted note "Not verified by AgentGuard". A run's outcome sits
above its timeline, with that label.

## Decision marks

Shapes are always paired with a word, so colour is never the only signal.

| Contract outcome | Word | Shape | Colour |
| --- | --- | --- | --- |
| `allow` | Allowed | tick | `--passed` |
| `steer` | Steered | bending arrow | `--steered` |
| `require_approval` | Held | pause bars | `--held` |
| `block` | Blocked | no-entry sign | `--blocked` |

Statuses reuse the same family through `StatusBadge`. Waiting statuses are a dashed ring,
working ones a ring with a turning arc, stopped ones a dash. `completed` reads "Finished",
in neutral rather than green, because it means the agent's turn ended and is no evidence
the code is correct. Do not change what a status means to make a screen read better.

## Tokens

All colour, radius and shadow comes from `src/ui/tokens.css`, by semantic name.

| Token | Value | Use |
| --- | --- | --- |
| `--ink`, `--ink-soft`, `--ink-faint` | `#14262C`, `#4B5E65`, `#5E7076` | primary text, secondary text, placeholders and times. All meet AA on the canvas and on surfaces |
| `--canvas` | `#F3F5F5` | page background |
| `--surface`, `--surface-sunk` | `#FFFFFF`, `#F6F8F8` | working surfaces, and a quieter fill inside one |
| `--hover`, `--press` | `#EDF1F1`, `#E4E9E9` | hover fills, and the track behind tabs |
| `--line`, `--line-strong` | `#E1E7E7`, `#C9D3D4` | hairlines, and the gate line and button edges |
| `--control-edge` | `#86959A` | input and select borders, which keep 3:1 against a surface |
| `--petrol`, `--petrol-deep` | `#0E5E6A`, `#0A4B55` | primary buttons, focus, the brand mark, links |
| `--petrol-soft`, `--petrol-wash`, `--petrol-line` | see file | current nav item and focus halo, selected rows, selected edges |
| `--night` | `#0F2C33` | the sign-in panel |
| `--foreign`, `--foreign-ink`, `--foreign-edge` | `#F6F4EF`, `#4A463B`, `#ECE8DE` | foreign material, nothing else |
| `--passed`, `--steered`, `--held`, `--blocked` | see file | decisions, each with a `-tint`, and a `-line` where a mark or panel needs an edge |

**Type.** Instrument Sans for the interface: body 14.5px/1.55, page titles 26px weight 600,
a run's prompt 22px, section headings 16px weight 600, metadata 13px in `--ink-soft`. Times
and counts use tabular numerals. Red Hat Mono is only for foreign material, at 12.5px on
blocks and 0.9em inline, and not for small labels or trusted ids. Both are self-hosted
through `@fontsource-variable`, so the console makes no third-party font requests.

**Shape and depth.** A radius scale, chosen by size rather than one value everywhere:
`--radius-inline` 4 (small inline things), `--radius-badge` 6 (badges, list options),
`--radius-control` 7 (buttons, inputs, select triggers), `--radius-block` 9 (foreign blocks,
popovers, notices), `--radius-surface` 12 (tables, timeline, panels) and `--radius-panel` 18
(the sign-in panel, phone sheets). Depth comes from surface against canvas with a hairline.
`--shadow-pop` is for things that float, popovers and dialogs, and nothing else. Spacing sits
on a 4px grid with room to breathe. Controls are 34-36px high, and the one main action of a
page is 38px.

**States.** Hover is a soft fill or a darker edge. Selected is a petrol wash with a petrol
edge, never a thick box. Disabled primary keeps its colour at low opacity, not a grey block;
disabled inputs drop to a sunk fill. Focus is a 2px petrol outline with a 2px offset, and text
inputs and open selects also get a soft 3px halo.

**Layout.** One 56px light bar, no sidebar: the wordmark, the workspace beside it, the views,
then the Held count and the account. Below 960px the views, workspace and account move into a
menu. Content is left aligned in a centred column up to 1360px, with a 32px gutter (16px on
phones). Forms use the narrower `.page-narrow`. Tables and the timeline are the main forms:
one surface with hairlines between rows, 48px rows, and a long prompt that takes the room
left over and truncates. A run's row is one big target for its link.

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

Every data view needs loading, empty and error states. Put page-specific CSS in its own file
with plain class names and import it from `src/main.tsx` after `primitives.css`, so a page can
adjust a primitive with one class. Keep selectors at one class where you can; primitives use
`:where()` on their structural parts for the same reason. Use tokens, never raw colours. Use
`Link` or `navigate` for in-app links, never `window.location`. A page that belongs to a
workspace reads it from `useCurrentWorkspace()`, which the top bar's switcher controls. The
choice is a view preference; the server still checks access on every request.

## Primitives

From `src/ui`:

| Primitive | Props | Use |
| --- | --- | --- |
| `Button` | `variant` (`secondary`, `primary`, `ghost`, `danger`), `page`, `busy`, plus button attributes | Petrol is the primary colour. Defaults to `type="button"`. |
| `ButtonLink` | `to`, `variant`, `page` | Navigation that looks like a button. |
| `Select` | `value`, `onChange`, `options` (`value`, `label`, `hint`, `disabled`), `label` or `aria-label`, `inlineLabel`, `quiet`, `id`, `disabled`, `placeholder` | The only dropdown. See below. |
| `PageHeader` | `title`, `description`, `actions` | The top of every page. |
| `DecisionMark` | `decision`, `label`, `size` | Shape and word for a middleware decision. |
| `DecisionGlyph` | `decision`, `size` | The shape alone. Keep a word nearby. |
| `StatusBadge` | `status`, `live` | Run, Task, Execution or Approval status. Pass `live` while updates are flowing. For an approval, pass `approvalBadgeStatus(status)`, so pending reads Held. |
| `SeverityBadge` | `severity` | A finding's severity. |
| `Foreign` | `label`, `note`, `preformatted`, `maxHeight` | Foreign material. `label` and `note` are trusted; only the children are foreign. Render through text or `MessageContent`, never raw HTML. |
| `ForeignInline` | children | A foreign path, command or plan-written task name inside a trusted sentence. Run pages use `TaskName` from `runs/format.tsx`, which applies it only to a delegated task's title. |
| `DataTable` | `caption` | Frame for an ordinary table. Use `num` on times and counts, and `cell-prompt` on long text that should truncate. Wide tables scroll inside themselves. |
| `Loading` | `label` | |
| `EmptyState` | `title`, `action`, children | Say what to do next and offer the action. |
| `ErrorState` | `title`, `message`, `onRetry`, `retryLabel` | Say what happened and how to fix it. |
| `GateLine` | `label`, `proposalHeading`, `decisionHeading` | Wraps `GateRow`s, oldest first. |
| `GateRow` | `proposal`, `proposalMissing`, `caption`, `decision`, `decisionLabel`, `reason`, `time`, `fresh`, `selected`, `onSelect`, `selectLabel`, `actions` | One entry. `decision={null}` is a non-decision entry such as a task starting. Set `fresh` only on a row that just arrived live. `proposal` renders as foreign material. When it was not saved, say so with `proposalMissing`, never a blank. |
| `AppShell` | `nav`, `heldCount`, `workspace`, `account` | The frame, used once in `App.tsx`. `heldCount={null}` hides the count: never show "Held 0" unless the app has actually counted. |
| `Wordmark`, `BrandMark` | `size` on the mark | The name and the gate-line mark. |

Helper classes: `.page`, `.page-narrow`, `.page-section`, `.section-copy`, `.cluster` (a wrapping
row with a gap), `.meta` (13px secondary), `.tabular`, `.sr-only`, `.text-button`, `.notice` with
`.notice-blocked`, `.notice-held` or `.notice-passed` (a line of news, optionally dismissible), and
`.page-banner` (a notice above a page's content). From `styles.css`: labels, `.tab-row` and `.tab`,
`.form-stack`, `.form-grid`, `.form-actions`.

### The Select

Do not use a native `<select>`. `Select` follows the WAI-ARIA select-only combobox: focus stays on
the trigger and `aria-activedescendant` names the option in reach. Arrows, Home, End, Page Up and
Down, Enter, Space, Tab, Escape and typeahead all work; a printable key opens it. The list is
portalled to the body, so a scrolling table cannot clip it, flips above near the bottom of the
window, and is pulled back in at the window's edges. Below 640px it opens as a sheet from the bottom
edge with 46px options. The logic is pure and tested in `ui/select-logic.ts`.

Give it a visible `label` in a form, or `aria-label` where a table header already names it. It renders
a button, so do not wrap it in a `<label>`. `id` goes on the trigger, so a page can return focus to it.
`quiet` drops the resting border, for a toolbar or the top bar. `hint` is a second line in the list; the
trigger only shows `label`.

## Writing

Sentence case and plain verbs. An action keeps its name through the flow: "Approve" and
"Deny" give "Approved" and "Denied". Errors say what happened and what to do, and do not
apologise. Empty states say what to do next.

Do not use:

- All-caps labels or tracked-out eyebrows.
- Meta strings joined with middle dots. Lay facts out with space or a real table.
- Spaced em dashes in labels, arrows appended to links, or emoji.
- Soft grey shadows on resting cards, gradient washes, fade-and-slide-up entrances, or a single
  radius on everything.
- Native selects, or chips and hatching on agent text.
- Inter, Manrope or `ui-rounded`.

## Product truth

These outrank looks.

- Every enforcement and authorization decision stays on the server. The UI may hide an
  action a role cannot use, but the server remains the check.
- Do not imply prevention guarantees. This is a proof of concept.
- Never present a completed agent turn as proof the code is correct. Keep "Agent's report" with
  "Not verified by AgentGuard".
- Keep the honest wording at the gate: "Allowed by the gate" does not mean applied, "The command text
  was not saved" is never a blank, and held, denied and "did not run" stay distinct.
- Unknown stays unknown: a Run with no saved final review, or a diff with no baseline, is never shown as
  aligned or as zero changes. An aligned final review is a model's judgment of scope, not correctness.
- Offer Approve only when the saved proposal can be shown; Deny stays available. A per-file download is a
  "text preview", never the file; the ZIP is the full-byte path and says what it left out.
- No secrets or raw trace content in new API or SSE payloads.

## Quality floor

Responsive down to 360px with no horizontal page scroll; wide tables and foreign blocks scroll inside
themselves. Keyboard reachable with visible focus, AA contrast for text, 3:1 for control edges and marks,
and `prefers-reduced-motion` respected.

## Where the CSS lives

`src/ui/tokens.css`, then `src/ui/base.css` (element defaults, including radios, checkboxes and
disclosures), then `src/ui/primitives.css`, then `src/styles.css`, then page rules:
`src/topbar-controls.css`, `src/auth.css`, `src/runs/runs.css`
and `src/members/members.css`. That is the order they load in, set in `src/main.tsx`.
