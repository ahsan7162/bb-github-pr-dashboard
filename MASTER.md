# GitHub PR Dashboard: design system

The source of truth for how the plugin looks and moves. Values live in `tokens.css`; every
colour, radius, type step and duration in the UI comes from there or from bb's theme.

## Theses (validated 2026-10-30)

**Visual.** Keeping bb's palette, fonts and components, the plugin gets its own shape language: a
calm neutral ground where colour only ever means PR state, carried by a 3px status spine on every
PR and comment thread; bb's sans throughout with no new display face, PR titles a clear step up
(20px semibold on a PR, 15px in the list), monospace only for paths, branches and line numbers;
roomy spacing on a 4px base (16px inside rows, 24px between groups, 32px between sections) with
hairline dividers instead of boxes inside boxes; flat components one border deep, one radius scale
(6px controls, 10px panels, full for pills and avatars), no shadows at rest; and a PR page where
Checks, Files, Comments and Conversation are tabs, with a sticky file list beside the diff in
Files, so any file or comment is one click away.

*Amended 2026-10-30 at the user's request: the first build put checks, files, comments and the
conversation in one navigator column, which felt like everything in one place. Sections are tabs
again; only Files keeps a side column.*

**Interaction.** Quick and lightly springy: 120ms plain ease-out for hover, 180ms for things that
arrive and 220ms for files that expand, both on a damped spring ease
(cubic-bezier(0.34, 1.3, 0.64, 1), about 3% overshoot); a hovered row lifts 1px and its spine
widens from 3px to 5px; jumping to a file or comment scrolls smoothly and widens the target's spine
for 220ms; j and k move between files, n and p between unresolved comments, only when focus is not
in a text field or the diff's own controls, and never taking Esc; no scroll-triggered reveals, no
parallax, no looping animation except real loading, nothing animating layout; reduced motion makes
every change instant.

**Allowed patterns:** the 3px status spine (it carries the product's one truth: why a PR is
stuck), monospace for paths, branches and line numbers, hairline dividers, GitHub's violet for
merged (the one colour outside bb's theme), the spinner and pulsing skeleton during real loading.

The one truth the design serves: a personal queue, inside bb, that says what is blocking each PR
and taps you when that changes. The blocker is the headline of every PR, wherever it appears.

## Colour

bb's theme variables, unchanged, mapped to meaning. Nothing else carries colour.

| Meaning | Text | Spine and fills |
|---|---|---|
| Failing, conflicts, changes requested, unresolved | `text-destructive` | `bg-destructive`, fill `/10` |
| Waiting: CI running, awaiting review, waiting on you | `text-warning-text` | `bg-warning`, fill `/15` |
| Ready, passing, resolved | `text-success` | `bg-success`, fill `/10` |
| Merged | `text-[var(--prd-merged)]` | `bg-[var(--prd-merged)]`, fill `/10` |
| Neutral: draft, you replied, outdated | `text-muted-foreground` | `bg-muted-foreground/40`, fill `bg-muted` |

Ground and ink: `bg-background`, `bg-card` (avoid; panels are bordered, not filled),
`bg-muted` (selected nav item, code chips), `border-border` (every divider),
`text-foreground`, `text-muted-foreground`.

`--prd-merged` is GitHub's violet pulled 30% toward bb's foreground, so small text passes 4.5:1 in
both themes. Contrast measured on bb's background:

| Pair | Dark | Light |
|---|---|---|
| foreground | 18.1:1 | 15.6:1 |
| muted-foreground | 7.8:1 | 6.9:1 |
| destructive | 7.2:1 | 5.2:1 |
| warning-text | 12.8:1 | 4.8:1 |
| success | 12.1:1 | 4.7:1 |
| `--prd-merged` | 7.5:1 | 6.1:1 |
| raw violet-500 (replaced) | 4.6:1 | 4.0:1 |

## Type

bb's sans and mono; no other family.

| Step | Use | Classes |
|---|---|---|
| Title | PR title on its page | `text-[length:var(--prd-text-title)] font-semibold leading-snug` |
| Row | PR title in a list | `text-[length:var(--prd-text-row)] font-semibold leading-snug` |
| Body | comments, descriptions, check names | `text-sm` (14px) |
| Meta | times, counts, hints, section labels | `text-xs` (12px) |
| Code | file paths, branch names, line numbers | `font-mono text-xs` |

Weights: 600 for titles, 500 for labels and navigator headings, 400 for everything else.
Sentence case everywhere; no uppercase eyebrows. Mono stops there: repo names and `#123` stay in
bb's sans with `tabular-nums`.

## Spacing

Tailwind's 4px scale. Only these steps: `1` (4px), `2` (8px), `3` (12px), `4` (16px),
`6` (24px), `8` (32px).

- Inside a row or panel: 16px (`px-4 py-4`, `p-4`); wide rows `px-6`.
- Between items of one group: 8px. Between groups: 24px. Between sections: 32px.
- One container level: rows inside a group are split by `divide-y divide-border`, never boxed
  one by one. A comment thread under its diff line is a tinted band, not a card.

## Shape and elevation

| Token | Value | Use |
|---|---|---|
| `--prd-radius-control` | 6px | buttons we draw, nav items, inputs, kbd, code chips |
| `--prd-radius-panel` | 10px | groups, diff panels, the PR page frame |
| `rounded-full` | full | pills, avatars, the spine |
| `--prd-spine` / `--prd-spine-wide` | 3px / 5px | status spine at rest / hovered or jumped to |

No shadows at rest or on hover; elevation is a 1px lift. bb's own overlays keep theirs.
bb's `Button` keeps bb's radius: it is bb's component.

## Motion

| Token | Value | Use |
|---|---|---|
| `--prd-hover` | 120ms + `--prd-ease-out` | colour, background, 1px lift, spine widen on hover |
| `--prd-arrive` | 180ms + `--prd-spring` | a section's content appearing: fade + rise 4px |
| `--prd-expand` | 220ms + `--prd-spring` | a file's diff expanding, a jump target's spine |
| `--prd-ease-out` | cubic-bezier(0.25, 1, 0.5, 1) | hover |
| `--prd-spring` | cubic-bezier(0.34, 1.3, 0.64, 1) | arrive, expand; peaks 3% past target |

No stagger. Transform and opacity only. Under `prefers-reduced-motion` every duration is 0ms and
jumps scroll instantly. Loops only for real loading (refresh spinner, skeleton).

## Components and their states

| Component | Default | Hover | Focus | Active | Disabled |
|---|---|---|---|---|---|
| Nav item | muted text | `bg-muted/60`, foreground | ring-2 ring | current: `bg-muted`, foreground | n/a (never disabled) |
| PR row | spine 3px | lift 1px, `bg-muted/40`, spine 5px | inset ring-2 | pressed: no lift, `bg-muted/60` | n/a |
| Segmented | muted label | foreground | ring-2 ring | selected: `bg-background`, foreground | n/a |
| Spine | 3px, state colour | 5px (row hover) | follows its row | 5px for 220ms after a jump | n/a |
| Pill | tone fill + tone text | not interactive | not interactive | not interactive | not interactive |
| bb Button | bb's own five states | | | | |

## Navigation

- **PR page:** header band (back, state, `repo#n`, title, branches, blockers as the headline),
  then the tabs Checks, Files, Comments and Conversation at every width, each its own view.
- **Files tab:** from the `@4xl` container width, a sticky 15rem file list beside the diff (name
  first, directory muted, open-comment count, +lines), shown when the PR changes two or more files.
  Narrower, the diff takes the full width.
- **Jumps:** a file from the file list, Show in diff from Comments, j/k between files and n/p between
  unresolved comments (both open the Files tab). Each scrolls smoothly to the target once the diff
  has laid out, and widens a comment's spine for 220ms.
- **List:** search (`/` focuses it), Repos with Select all and Deselect all, a fold per repo
  group (kept per tab) and Collapse all / Expand all. j and k move focus between rows, Enter opens
  one; coming back from a PR restores the scroll position and focuses that row.
- **Between PRs:** Previous and Next in the PR header (and `[` `]`) walk the list as last shown,
  with its filters and folds.
- **Kept as is:** section names (Checks, Files, Comments, Conversation, All PRs), the route
  `prs/<owner>/<repo>/<number>`, the saved diff layout key, and landing on failing checks first,
  then unresolved comments, else the conversation.

## Never

Scroll-triggered reveals, parallax, glows, gradients, glass, blurred blobs, uppercase eyebrows,
middle-dot runs, a second display face, shadows on hover, animating width, height, top, left,
margin or padding, a loop that reports no live state.
