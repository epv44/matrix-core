# Frontend Style Guide

Use this guide for changes under `frontend/`. Existing shared components are the source of truth; extend
them when a pattern is missing instead of copying Tailwind class strings between screens.

## Visual language

- Use the zinc palette for neutral surfaces, borders, and text. Reserve emerald, amber, red, and blue for
  semantic status and feedback.
- Use `Card` for grouped page content, `StatCard` for a labeled metric, and the shared form controls for
  buttons, text inputs, and selects.
- Use the shared `Tabs` component for switching views. Tabs use the bottom-border navigation with an
  active dark underline; do not introduce pill or segmented-control variants without updating the shared
  component and this guide.
- Keep page sections separated with `space-y-4`. Prefer responsive grids and wrapping flex layouts over
  fixed widths. Tables may scroll horizontally when their columns cannot collapse safely.
- Use the existing type scale: page titles at `text-2xl`, card titles at `text-sm font-semibold`, body copy
  at `text-sm`, and supporting text at `text-xs` or `text-[11px]`.

## View headers

- Keep the global page header limited to context and controls that apply across every tab on the page.
  Put a tab-specific title, filters, and actions inside the associated tab panel.
- Use a wrapping flex row for tab-panel headers: a `text-xl` heading, adjacent shared selectors, and
  right-aligned actions that wrap below the title and filters on narrow screens.
- Use shared form controls and `ButtonLink` for links presented as actions instead of copying control
  styles into individual views.

## Financial simulations

- Group related assumptions into titled `Card` sections and show units next to every numeric input.
  Explain ambiguous values, such as cash available after non-housing expenses, directly below the field.
- Use explicit Run and Reset actions for multi-field simulations. Keep the previous result visible with a
  compact updating state while a revised scenario runs.
- Label modeled returns, inflation, taxes, appreciation, and adjustable rates as assumptions. Place the
  financial-advice disclaimer with the results rather than repeating it beside every input.
- Prefer percentile bands and a small number of comparison lines over dense collections of simulated
  paths. Give every chart an accessible name, legend, and adjacent numeric summary or table.

## Interaction and accessibility

- Use semantic elements before adding ARIA. Every icon-only or visually ambiguous control needs an
  accessible name.
- Associate tabs with tab panels and preserve keyboard navigation. Use native labels for inputs and
  expose validation next to the affected control.
- Keep destructive actions visually distinct, admin-gated where required, and protected by the existing
  confirmation patterns.
- Preserve visible focus behavior and verify layouts at narrow and wide viewport sizes.
- Keep high-frequency scope and period controls visible. Put lower-frequency multi-field options in an
  accessible filter disclosure with an active-filter count and visible applied-filter chips.
- Use draft state plus explicit Apply and Reset actions when changing several filters would otherwise
  issue a request for every checkbox or select interaction.

## Server state and tab lifecycle

- Use TanStack Query for API-backed server state. Do not use mount-only effects to fetch view data.
- Include every request input in its query key, including environment, household owner, period, filters,
  and pagination. Pass owner identifiers explicitly to the API client instead of relying on mutable
  module state.
- Treat tab visibility as presentation only. Mounting a tab must not start Plaid synchronization,
  benchmark downloads, imports, or other external side effects.
- Use the shared five-minute stale policy and session-long cache. Display cached data while stale data
  revalidates, and keep cached results visible if a background refresh fails.
- Use previous cached data for parameter changes that affect an entire analytical view. Show a compact
  updating status and replace the result atomically instead of clearing the page or independently
  refreshing interdependent financial totals.
- Use mutations for writes and explicitly invalidate every affected query family. External refreshes
  belong in an application coordinator or an explicit user action, not a view component.
- Local UI state may remain in a component. Lift it into a parent or URL state when it must survive
  navigation. Authentication and initial session bootstrap are exempt from the query requirement.

## TypeScript and JSX

- Prettier is the canonical source formatter: two-space indentation, double quotes, semicolons, trailing
  commas, and a 100-character print width.
- Keep imports at module scope and use typed props and domain interfaces. Put repeated option lists and
  display mappings in named module-level constants.
- Break nested or conditional JSX across lines. Extract a component when a repeated visual pattern or a
  large independent interaction would otherwise make the parent difficult to scan.
- Keep event handlers focused. Move multi-step data or business behavior into named functions rather than
  embedding it in markup.
- Tailwind class ordering is enforced by ESLint. Do not add formatter or lint suppression comments.

## Formatting workflow

Adoption is incremental to avoid unrelated diffs. Format and check only the frontend files changed by the
current task:

```bash
npm --prefix frontend run format -- <changed-files>
npm --prefix frontend run format:check -- <changed-files>
```

Do not reformat untouched legacy files as part of a scoped change. Run `npm --prefix frontend run check`
and the relevant Playwright tests after formatting.
