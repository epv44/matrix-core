# Frontend Style Guide

Consistency is enforced **by construction**: the recurring visual patterns live in `src/components/ui/` primitives and `@theme` tokens in `src/app/globals.css`. New views compose these — they do not hand-write raw class strings for shared patterns.

## Design tokens (`src/app/globals.css` `@theme`)

| Token              | Value                           | Use                                |
| ------------------ | ------------------------------- | ---------------------------------- |
| `--color-surface`  | `#ffffff`                       | card / panel background            |
| `--color-canvas`   | `#fafafa`                       | page background                    |
| `--color-ink`      | `#18181b`                       | primary text                       |
| `--color-ink-soft` | `#3f3f46`                       | strong secondary text              |
| `--color-muted`    | `#71717a`                       | secondary text                     |
| `--color-faint`    | `#a1a1aa`                       | hints / captions                   |
| `--color-line`     | `#e4e4e7`                       | borders / dividers                 |
| `--color-positive` | `#059669`                       | positive (income / savings / pass) |
| `--color-negative` | `#dc2626`                       | negative (loss / fail)             |
| `--color-warn`     | `#d97706`                       | warning / needs attention          |
| `--radius-card`    | `0.75rem`                       | card radius                        |
| `--radius-control` | `0.5rem`                        | input / button radius              |
| `--shadow-card`    | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | card shadow                        |

Use semantic aliases (`text-positive`, `border-line`, `bg-surface`) instead of raw zinc/emerald/red values where they express meaning. Category chips in the spreadsheet keep their per-category colors (defined in `DashboardSpreadsheet`).

## UI primitives (`src/components/ui/`)

| Primitive                                                      | Purpose                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Card` (`title`, `hint`, `padded`)                             | the rounded-xl card + optional gradient header                                  |
| `StatCard` (`label`, `value`, `hint`, `tone`, `extra`)         | dashboard stat card                                                             |
| `Button` (`variant`: primary / secondary / ghost)              | actions; never style raw `<button>`                                             |
| `TextInput`                                                    | text inputs (focus ring included)                                               |
| `Select`                                                       | dropdowns                                                                       |
| `Th` / `Td` / `TdMoney` + `ROW_EVEN` / `ROW_ODD` / `ROW_TOTAL` | table header/cells and zebra rows; money cells are `tabular-nums` right-aligned |
| `TONE_TEXT` (`positive`/`negative`/`warn`)                     | tone text classes                                                               |

Rules:

- Use the primitives. If a class string repeats more than ~twice, it belongs in a primitive or a `ui/` export.
- Table headers: uppercase tracking label via `Th`; rows alternate `ROW_EVEN`/`ROW_ODD`; summary rows use `ROW_TOTAL`.
- Money: always `money(n)` (with `$`) or `fmtMoney(n)` (bare) from `src/lib/format.ts`. Never `toFixed(2)` in JSX.
- Tone: use `TONE_TEXT.positive/negative/warn` or the `tone` prop — not hardcoded `text-red-600` etc.

## Layout

- Page body: `space-y-4 w-full max-w-full min-w-0 overflow-x-clip` for stacked content.
- Stat rows: `grid grid-cols-5 gap-3` of `StatCard`.
- Tables live inside `Card padded={false}` with `overflow-auto max-h-[...]`.
- Overlays/dialogs: fixed inset overlay with a rounded-2xl white panel (see `TransactionDetailDialog`).

## Enforcement

- `eslint-plugin-tailwindcss` (`classnames-order`, `no-contradicting-classname`, `enforces-shorthand`) — run `npm run lint` (ESLint) and `tsc --noEmit`.
- Code review: new class strings only inside `components/ui/`; anything else goes through a primitive or token.
