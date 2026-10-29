Stop opening GitHub tab by tab to find out why a pull request is still open.
This plugin adds a **My PRs** page to the BB navigation rail that answers it
at a glance.

## What you get

- **Open**, **Merged** and **Closed** tabs with counts, listing the pull
  requests you authored across every repository you can see, grouped by
  repository, most recently updated first.
- For each open pull request, the reasons it is not merged yet: draft,
  merge conflicts, failing CI (with each failing check linked), CI still
  running, changes requested, unresolved review comments, or waiting on a
  review. A pull request with nothing blocking it says so.
- A detail view for each pull request:
  - **CI checks** named by pipeline and job (for example
    `CI › test / unit`), with the failure reason, error annotations and
    a link to the logs.
  - **Review comments**, unresolved first, each with the diff it is on, who
    asked, every reply, and whether it is waiting on your reply. Resolved
    threads show who resolved them.
  - The **conversation**: the description, comments and reviews in order,
    rendered as Markdown.
- Refresh buttons, and links that open the pull request, a comment or a
  check's logs in your browser.

## How it works

One GitHub GraphQL request on each refresh of the list, and one when you
open a pull request, sent from the BB server. Nothing is stored, and no data
leaves your machine except those requests to GitHub.

## Requirements

- A GitHub account. By default the plugin uses the
  [GitHub CLI](https://cli.github.com) login on the machine running BB
  (`gh auth login`), so each user sees their own pull requests.
- Or set a personal access token in the plugin settings: `repo` scope for a
  classic token, or Pull requests and Checks read access for a fine-grained
  one. For organizations that enforce SAML SSO, authorize the token for that
  organization, or its pull requests will be missing.
- github.com only; GitHub Enterprise Server is not supported yet.
