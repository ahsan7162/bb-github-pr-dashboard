
 # bb-github-pr-dashboard
 
https://github.com/user-attachments/assets/14e2303b-f8a5-4c6f-998b-6c0431eae648



A 60-second tour: the dashboard and its filters, CI failures down to the test,
alerts, comment threads, syntax-highlighted diffs and code review, all inside bb.

<sub>Sample data only. Music: "Happy Beats & Business Moves Vol. 1" by Sascha Ende,
[ende.app](https://ende.app/en/song/12866-happy-beats-business-moves-vol-1),
[CC BY 4.0](https://ende.app/en/standard-license). Sound effects:
[Kenney](https://kenney.nl), CC0.</sub>

A **My PRs** page in the bb navigation rail: your open, merged and closed
GitHub pull requests grouped by repository, and for each open one why it is
not merged yet (draft, conflicts, failing CI with the failing pipeline and
job, CI running, changes requested, unresolved review comments, awaiting
review). Search the list by title, #number, repo or author, hide the repos
you don't want to see, and fold a repo's group on any tab (both remembered across
restarts); on Merged and Closed, search and the repo choices cover your whole
history, up to the 1,000 GitHub search returns. Collapse all or Expand all folds every
group on a tab. Keys: j and k move between PRs, Enter opens one and / jumps to search; on a
PR, j and k move between files, n and p between unresolved comments, and [ and ] open the
previous or next PR in the list. Coming back to the list lands where you left it. Click a PR for its detail view: CI checks with annotations and log
links, review threads (unresolved first, with replies and who has the last
word), and the conversation. Review requested (you or your teams) and
Assigned tabs cover other people's PRs. The detail view also shows changed
files (bb's diff viewer, inline or side by side, with syntax highlighting;
published comments under their lines; press + or select line numbers, Shift-click
or drag for a range, to comment; start a review, then submit it as Comment,
Approve or Request changes, or discard it), where the PR sits in a stack, and lets you reply
to threads, comment, or close and reopen the PR.
A background watcher alerts you (toast, rail badge, desktop notification) when
CI starts failing or someone comments.

- `server.ts` — the `prs_list`, `prs_history`, `pr_detail` and `pr_files` RPCs; the writes
  `pr_reply`, `pr_comment`, `pr_line_comment`, `pr_submit_review`,
  `pr_discard_review` and `pr_set_state`, each sent only on an explicit click; the `watch` background
  service; and the `alerts_*` RPCs. Gets a token from the
  `token` setting, else from `gh auth token`, and sends GraphQL to GitHub.
- `prs.ts` — the pure mapping to rows, blockers, checks, threads and the
  timeline; `queries.ts` holds the GraphQL text (server only).
- `prs.test.ts` — tests for that mapping and the alert diff (`npm test`).
- `alerts.tsx` — the alert listener (toasts, desktop notifications), the My PRs
  badge, the "New since you last looked" strip, and the Notifications section
  on the plugin settings page.
- `app.tsx` — the page (`app.slots.navPanel`); `/plugins/bb-github-pr-dashboard/prs/<owner>/<repo>/<number>`
  opens a PR's detail view (`detail.tsx`). `parts.tsx` holds shared bits.
- `MASTER.md` — the design system (theses, tokens, components, navigation);
  `tokens.css` holds its values as CSS variables.
- `PLUGIN_OVERVIEW.md` — the store listing text; keep it in step with
  `bb.description` in `package.json`.

## Auth

Each user's own GitHub connection is used:

1. If the `token` setting is set, that token.
2. Otherwise the GitHub CLI login on the machine running bb (`gh auth login`).

```
bb plugin config bb-github-pr-dashboard set token <token>   # optional
```

A classic token needs `repo`; a fine-grained one needs Pull requests read
and write (write only for comments, replies, reviews, close and reopen) and
Checks read. Authorize it for SAML SSO orgs, or their PRs are left out.

## Alerts

The `watch` service polls your open PRs every `checkEveryMinutes` (default 5)
and stores an alert when a job's latest run starts failing or someone else
comments or reviews. The first poll for an account only records a baseline. The bell button on
My PRs opens these settings.

```
bb plugin config bb-github-pr-dashboard set notifyCi false
bb plugin config bb-github-pr-dashboard set notifyComments false
bb plugin config bb-github-pr-dashboard set showToasts false    # no bb toasts
bb plugin config bb-github-pr-dashboard set showDesktop false   # no desktop banners
bb plugin config bb-github-pr-dashboard set showBadge false     # no count on My PRs
bb plugin config bb-github-pr-dashboard set ignoreAuthors "some-review-bot, ci-helper"
bb plugin config bb-github-pr-dashboard set checkEveryMinutes 10
bb plugin rpc call bb-github-pr-dashboard alerts_test   # send a test alert
```

## Develop

```
npm install
npm test
bb plugin install .
bb plugin dev          # rebuild and reload on save
echo '{"tab":"open"}' > tab.json   # open, review, assigned, merged or closed
bb plugin rpc call bb-github-pr-dashboard prs_list --input-file tab.json
echo '{"repo":"owner/name","number":1}' > in.json
bb plugin rpc call bb-github-pr-dashboard pr_detail --input-file in.json
```

## Install and release

Install from Git (bb builds it on install):

```
bb plugin install git:https://github.com/ahsan7162/bb-github-pr-dashboard.git@^0.3.0
```

To release: bump `version` in `package.json`, run `npm test` and
`bb plugin build`, commit, then tag `vX.Y.Z` and push the tag. Never move a
published tag; bb refuses a tag that points at a different commit.

Keep media out of git: bb runs a full `git clone` of this repository on every
install, so every branch and tag ships. Add README media by dragging it into
the README in GitHub's web editor, which stores it as an attachment outside
git. `npm test` fails if a media file or anything over 1 MB is reachable from
any branch or tag.
