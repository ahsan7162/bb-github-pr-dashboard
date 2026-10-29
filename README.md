# bb-github-pr-dashboard

A **My PRs** page in the bb navigation rail: your open, merged and closed
GitHub pull requests grouped by repository, and for each open one why it is
not merged yet (draft, conflicts, failing CI with the failing pipeline and
job, CI running, changes requested, unresolved review comments, awaiting
review). Click a PR for its detail view: CI checks with annotations and log
links, review threads (unresolved first, with replies and who has the last
word), and the conversation.

- `server.ts` — the `prs_list` and `pr_detail` RPCs. Gets a token from the
  `token` setting, else from `gh auth token`, and sends GraphQL to GitHub.
- `prs.ts` — the GraphQL queries and the pure mapping to rows, blockers,
  checks, threads and the timeline.
- `prs.test.ts` — tests for that mapping (`npm test`).
- `app.tsx` — the page (`app.slots.navPanel`); `/plugins/bb-github-pr-dashboard/prs/<owner>/<repo>/<number>`
  opens a PR's detail view (`detail.tsx`). `parts.tsx` holds shared bits.
- `PLUGIN_OVERVIEW.md` — the store listing text; keep it in step with
  `bb.description` in `package.json`.

## Auth

Each user's own GitHub connection is used:

1. If the `token` setting is set, that token.
2. Otherwise the GitHub CLI login on the machine running bb (`gh auth login`).

```
bb plugin config bb-github-pr-dashboard set token <token>   # optional
```

A classic token needs `repo`; a fine-grained one needs Pull requests and
Checks read. Authorize it for SAML SSO orgs, or their PRs are left out.

## Develop

```
npm install
npm test
bb plugin install .
bb plugin dev          # rebuild and reload on save
bb plugin rpc call bb-github-pr-dashboard prs_list
echo '{"repo":"owner/name","number":1}' > in.json
bb plugin rpc call bb-github-pr-dashboard pr_detail --input-file in.json
```

## Install and release

Install from Git (bb builds it on install):

```
bb plugin install git:https://github.com/ahsan7162/bb-github-pr-dashboard.git@^0.1.0
```

To release: bump `version` in `package.json`, run `npm test` and
`bb plugin build`, commit, then tag `vX.Y.Z` and push the tag. Never move a
published tag; bb refuses a tag that points at a different commit.
