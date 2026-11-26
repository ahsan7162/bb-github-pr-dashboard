
# GitHub PR Dashboard for bb

See why each pull request is stuck, and get it unstuck, without leaving [bb](https://getbb.app).



https://github.com/user-attachments/assets/fffbf9cf-a736-4072-aa56-5df9be84210c


```
bb plugin install git:https://github.com/ahsan7162/bb-github-pr-dashboard.git@^0.3.0
```

Or install **GitHub PR Dashboard** from bb's plugin store. It uses your GitHub CLI
login (`gh auth login`) or a token; see [Requirements](#requirements).

## What you get

- **Every pull request you are part of, in one tab.** A **My PRs** page in the bb
  rail with **Open**, **Review requested** (you or your teams), **Reviewed**,
  **Assigned**, **Merged** and **Closed**, grouped by repository, newest first.
- **Know when a review needs redoing.** **Reviewed** keeps the open pull requests you
  reviewed with your verdict, and turns amber when the author pushes after your
  review or it was dismissed.
- **Why each one is not merged yet.** Every open pull request leads with its
  blockers: draft, stacked on another pull request, merge conflicts, failing CI
  with the failing jobs named, CI running, changes requested, unresolved comments,
  or waiting on a review. A coloured stripe shows the worst one at a glance.
- **Fix it from bb.** Read the failing checks, walk the changed files with review
  threads under their lines, reply, comment on a line or a range, submit a review,
  mark it ready for review, and close or reopen it. Or pick review comments and failed
  jobs with **Fix with agent** and send them to an agent as one prompt.
- **Find anything in a long queue.** Search, hide repositories, fold groups, and
  reach your whole Merged and Closed history.
- **Move by keyboard.** From the list to a pull request, between its files and
  comments, and on to the next pull request.
- **Hear about changes.** Alerts when CI starts failing or someone comments.
- **PR links open here.** Click a github.com pull request link anywhere in bb (an
  agent's message, the PR link beside the composer or in the Info tab) and it opens
  in My PRs, or on GitHub if My PRs cannot load it. Cmd/Ctrl-click and "Open on
  GitHub" links still go to GitHub.

<img width="3200" height="2000" alt="01-list" src="https://github.com/user-attachments/assets/9654333c-5e06-46e5-8cb6-268c24bf320f" />



## The list

- Each row shows the title, its blockers, the failing jobs, lines added and removed,
  and when it was last updated. A pull request with nothing blocking it says so.
- **Search** by title, #number, repository or author. It matches every word you type.
- **Repos** filters each tab to the repositories you pick, with Select all and
  Deselect all. Hidden repositories are remembered across restarts.
- **Fold** a repository's group from its heading, or **Collapse all** and **Expand
  all**. Folds are remembered per tab.
- On **Merged** and **Closed**, search and Repos cover your whole history (up to the
  1,000 results GitHub search returns), not only the latest 30.
- The Open tab adds totals (CI failing, unresolved comments, changes requested,
  ready to merge) and a "New since you last looked" list of alerts.
- Coming back from a pull request returns you to where you were in the list.

<img width="3200" height="2000" alt="02-reviewed" src="https://github.com/user-attachments/assets/d5df8139-4a4f-464d-833c-487274b13271" />



## A pull request

The header shows its state, its branches (click one to copy its name), lines added
and removed, its reviewers with each one's verdict (or that a review is still
requested), its labels, where it sits in a stack, and its blockers as the headline. A pencil
beside the title edits it, when GitHub lets you. **Previous** and **Next** step through the list as you left it.

<img width="3200" height="2000" alt="03-overview" src="https://github.com/user-attachments/assets/0847ae85-e2aa-4369-8f75-b3118b17cf46" />


- **Overview** (first): the description in its own panel, with a pencil to edit it,
  then the comments and reviews in order, as Markdown, with a box for your own comment.
- **Checks**: every check by pipeline and job, failing first, with the error
  annotations from the run and a link to the logs.
- **Files**: a file list beside the diff, bb's syntax-highlighted diff viewer inline
  or side by side, and every review thread as a band under its line.
- **Commits**: every commit, newest first, with its CI result and a link to it on
  GitHub. If you reviewed before, the commits pushed since your latest review are
  marked, so a re-review knows where to start.
- **Comments**: unresolved threads first, each with its diff, every reply, who it
  waits on, and **Show in diff** to jump to its line.
- On your own pull request, mark a draft **Ready for review** or **Convert to draft**; **close** an open pull
  request (with a confirm step) or **reopen** a closed one.
- Once every check is green, **Merge** an open pull request (with a confirm step), using the repo's
  default merge method. The merge is refused if new commits landed after the checks you saw.

<img width="3200" height="2000" alt="04-files" src="https://github.com/user-attachments/assets/802b360d-9aed-48ba-b7b4-925fba29c856" />

<img width="3200" height="2000" alt="05-commits" src="https://github.com/user-attachments/assets/5f73b296-e2b9-4dba-8a7d-5fb24f0557a4" />



### Fix with agent

Every unresolved review thread (in Comments and under its line in Files) and every
failed job in Checks has a **Fix with agent** button. A click picks that finding (the
button shows a tick; click again to unpick it). While anything is picked, a bar under
every tab reads "3 to fix" with **Send to agent** and **Clear**. Picks stay while you
switch tabs, and clear when you send them or move to another pull request.

**Send to agent** writes one prompt with the pull request's link, repository and branch,
then each picked finding in the pull request's order: for a review comment, the file,
line or range and the comment with every reply and who wrote each; for a failed job, its
name, its error annotations and its log link. The agent is asked to work through them in
order, say why if a comment is wrong instead of changing the code, and finish with a
short summary. A thread in your pending review can't be picked, so its button sends it
at once.

- If a bb thread is working on the pull request's branch in its repository, the prompt
  goes to that thread (queued if it is busy) and a toast links to it. The newest such
  thread wins. bb's GitHub PR Status confirms the environment's pull request when it
  knows it; otherwise the project's git remote has to match the repository.
- Otherwise bb's New thread screen opens with the prompt filled in, in the
  pull request's project (see below), so you choose where it runs.
  
<img width="3200" height="2000" alt="06-checks" src="https://github.com/user-attachments/assets/fbbc60b4-01e5-4f69-9b5b-a5ab973db71f" />

<img width="3200" height="2000" alt="07-batch" src="https://github.com/user-attachments/assets/e04d9a52-2727-49df-a1f9-5c36a68fc4f1" />



### The ⋯ menu

- **Link to thread**: pick any bb thread (the PR's branch thread and its project's threads come first) and send it
  the pull request's link, title and branches as context.
- **Ask a question** and **Explain this PR** open New thread with the pull request filled in.
- **Fix findings in a thread** sends every unresolved review thread and failed job at once, the way Send to agent
  sends the ones you picked.
- **Open on GitHub**, **Copy link**, **Copy PR number**, and **Close pull request** (with a confirm step).

New threads start in the pull request's project: the one whose git remote is the repository, else one named like it
(`Billing API` for `acme/billing-api`), but never a guess between two.

<img width="3200" height="2000" alt="08-menu" src="https://github.com/user-attachments/assets/f4bace6a-e0b5-4a8f-8e7a-212a6f5c23b8" />



### Jira

Jira issue keys in the title and Markdown (only for projects the pull request names in its title, branch or a Jira
link, so `UTF-8` never becomes one) and Jira issue links open in bb's **My Jira** plugin when it is installed and
running, or on your Jira site otherwise.

### Reviewing

Press **+** on a line, or select line numbers (Shift-click or drag for a range), to
comment. Post a single comment, or start a review that only you can see until you
finish it as **Comment**, **Approve** or **Request changes**, or discard it. Reply to
any thread where it is, **Resolve** or **Unresolve** it when GitHub lets you, and delete your own comments and replies (after a confirm
step) from the trash button beside them. Nothing is written to GitHub until you click.

![Uploading 09-comments.png…]()



## Keyboard

| Key | Where | What it does |
|---|---|---|
| `j` `k` | List | Next and previous pull request |
| `Enter` | List | Open the focused pull request |
| `/` | List | Search |
| `j` `k` | Pull request | Next and previous file |
| `n` `p` | Pull request | Next and previous unresolved comment |
| `[` `]` | Pull request | Previous and next pull request in the list |

The keys never fire while you type, in a dialog, or inside the diff viewer's own
controls.

## Alerts

Every 5 minutes, the plugin checks your open pull requests and alerts you when a CI
job starts failing, or when someone else comments or reviews. Each alert shows as a
bb toast, adds a count to the My PRs icon, and waits in the "New since you last
looked" list. Each check also sends one desktop notification through bb's built-in
Push notifications plugin (several alerts become one summary), to the channels turned
on there: desktop, web and registered phones. Clicking it opens bb; the toast's
**Open** goes to the pull request. If Push notifications is disabled, the toast and
badge still work and the plugin log says why nothing was sent. GitHub bot accounts
are skipped. The bell on My PRs opens the settings, where **Send test notification**
checks delivery:

```
bb plugin config bb-github-pr-dashboard set notifyCi false
bb plugin config bb-github-pr-dashboard set notifyComments false
bb plugin config bb-github-pr-dashboard set showToasts false    # no bb toasts
bb plugin config bb-github-pr-dashboard set showDesktop false   # no desktop notifications
bb plugin config bb-github-pr-dashboard set showBadge false     # no count on My PRs
bb plugin config bb-github-pr-dashboard set ignoreAuthors "some-review-bot, ci-helper"
bb plugin config bb-github-pr-dashboard set checkEveryMinutes 10
bb plugin rpc call bb-github-pr-dashboard alerts_test   # send a test alert and notification
```

The first check for an account only records a baseline. Hiding a repository in the
list does not mute its alerts.

## Requirements

- A GitHub account on github.com (GitHub Enterprise Server is not supported yet).
- By default, the [GitHub CLI](https://cli.github.com) login on the machine running bb
  (`gh auth login`), so each user sees their own pull requests. If gh has more than
  one github.com account, a picker on My PRs chooses which one the plugin uses; gh's
  own active account is left alone.
- Or a personal access token:

  ```
  bb plugin config bb-github-pr-dashboard set token <token>
  ```

  A classic token needs `repo`. A fine-grained one needs Pull requests read and
  write (write only for comments, replies, resolving threads, deletes, reviews, edits, ready or draft, close and reopen) and Checks read.
  For organizations that enforce SAML SSO, authorize the token for them, or their
  pull requests are left out.
- Alerts run while the bb server runs. Desktop notifications need bb's Push
  notifications plugin enabled; its desktop and web banners appear while a bb window
  is open (any page, not only My PRs), and registered phones get them regardless.

## What it sends

Requests go to GitHub only for what you open, all from the bb server: one GraphQL
request for the tab you open (with every tab's count), one for a pull request, one
REST request when you open its Files tab, the Merged or Closed history only when you
search or filter it, and one per alert check. **Send to agent** asks bb, not GitHub, which thread is on the
branch (bb's GitHub PR Status may check with GitHub). Alerts and their state stay in this
plugin's storage on your bb server. Desktop notifications hand each alert's headline
(repository, number, who) and pull request title to bb's Push notifications plugin,
which forwards them to registered phones through its push relay (Expo by default);
turn `showDesktop` off to keep them on the server. The page loads 105 KB of script and 131 KB of CSS
(32 KB and 10 KB gzipped); an install takes about 11 MB on disk.

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

- `server.ts`: `accounts` and `account_select` (which gh login to use), the `prs_list`, `prs_history`, `pr_detail` and `pr_files` RPCs; the
  writes `pr_reply`, `pr_comment`, `pr_line_comment`, `pr_submit_review`,
  `pr_discard_review`, `pr_delete_comment`, `pr_edit` (title and description) and `pr_set_state` (close,
  reopen, ready, draft), each sent only on an explicit click;
  `pr_agent_target`, which finds the bb thread on a pull request's branch, its project and the threads to link;
  `jira_link`, which asks My Jira whether it runs; the `watch` background service, which sends desktop notifications through
  push-notifications' `notifications.send`; and the `alerts_*` RPCs. Gets a token
  from the `token` setting, else from `gh auth token`.
- `queries.ts`: the GraphQL text (server only). `prs.ts`: the pure mapping to rows,
  blockers, checks, threads and the timeline. `prs.test.ts`: its tests and the alert
  diff's.
- `app.tsx`: the list page (`app.slots.navPanel`); `prs/<owner>/<repo>/<number>`
  opens a pull request (`detail.tsx`). `parts.tsx` holds shared pieces, `alerts.tsx`
  the alert listener, badge, strip and settings section.
- `MASTER.md`: the design system; `tokens.css` holds its values as CSS variables.
- `PLUGIN_OVERVIEW.md`: the store listing text; keep it in step with
  `bb.description` in `package.json`.

## Release

Bump `version` in `package.json`, run `npm test` and `bb plugin build`, commit, then
tag `vX.Y.Z` and push the tag. Never move a published tag; bb refuses a tag that
points at a different commit. A new 0.x minor (0.3 to 0.4) also needs the install
range above and the store entry's range raised, since `^0.3.0` does not reach 0.4.

Keep media out of git: bb runs a full `git clone` of this repository on every
install, so every branch and tag ships. Add README media by dragging it into the
README in GitHub's web editor, which stores it as an attachment outside git.
`npm test` fails if a media file or anything over 1 MB is reachable from any branch
or tag.
