Stop opening GitHub tab by tab to find out why a pull request is still open.
This plugin adds a **My PRs** page to the BB navigation rail that answers it
at a glance.

## What you get

- **Open**, **Merged** and **Closed** tabs with counts, listing the pull
  requests you authored across every repository you can see, grouped by
  repository, most recently updated first.
- **Review requested** (from you or any team you are on) and **Assigned**
  tabs for other people's pull requests, with each author shown.
- For each open pull request, the reasons it is not merged yet: draft,
  stacked on another pull request, merge conflicts, failing CI (with each failing check linked), CI still
  running, changes requested, unresolved review comments, or waiting on a
  review. A pull request with nothing blocking it says so.
- A detail view for each pull request:
  - Where it sits in a stack: the pull request it is based on, and any
    loaded pull request based on it, each one click away.
  - **Changed files**, inline or side by side with syntax highlighting, with
    review comments under their lines. Press + or select line numbers (Shift-
    click or drag for a range) to comment. Start a private review or post a single comment, then finish it
    as Comment, Approve or Request changes, or discard it.
  - **CI checks** by pipeline and job, with error annotations and logs.
  - **Review comments**, unresolved first, each with the diff it is on, who
    asked, every reply, and who it is waiting on. Reply to a thread right
    there. Resolved threads show who resolved them.
  - The **conversation**: the description, comments and reviews in order,
    rendered as Markdown, with a box to add your own comment.
- Close an open pull request (with a confirm step) or reopen a closed one.

## Alerts

- Every 5 minutes (you can change this), the plugin checks your open pull
  requests and alerts you when a CI job starts failing, or when someone else
  comments or reviews.
- Each alert shows as a bb toast, adds a red count to the **My PRs** icon,
  and waits in a "New since you last looked" list on the page. Allow desktop
  notifications in the plugin settings to also get a system banner.
- In the plugin settings (the bell button on My PRs), choose what alerts you
  (CI failures, comments, or both) and how (toasts, desktop notifications,
  the unread count), change the interval, or list review bots to ignore.
  GitHub bot accounts are skipped already.

## How it works

One GitHub GraphQL request on each refresh of the list, one when you open a
pull request (plus one REST request when you open its Files tab), and one per
alert check, all sent from the BB server. Nothing is written to GitHub except
what you send: comments, replies, reviews, and closing or reopening. Alerts and
the state they compare against stay in this plugin's storage on your BB
server. No data leaves your machine except those requests to GitHub.

## Requirements

- A GitHub account. By default the plugin uses the
  [GitHub CLI](https://cli.github.com) login on the machine running BB
  (`gh auth login`), so each user sees their own pull requests.
- Or set a personal access token in the plugin settings: `repo` scope for a
  classic token, or Pull requests read and write plus Checks read for a
  fine-grained one. Write access is used only when you comment, reply,
  review, close or reopen, all under your GitHub name and only when you click. For organizations that enforce SAML SSO, authorize the token for that
  organization, or its pull requests will be missing.
- Alerts run only while the BB server runs, and desktop banners appear only
  while a BB window is open. Alerts do not reach your phone.
- github.com only; GitHub Enterprise Server is not supported yet.
