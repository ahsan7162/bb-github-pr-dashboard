// GitHub GraphQL text, used by the server only: kept out of prs.ts so none of it ships in the page bundle.

const CHECK_RUN = `name status conclusion detailsUrl startedAt
  checkSuite { app { name } workflowRun { workflow { name } } }`;

const BASE = `
  id number title url isDraft createdAt updatedAt mergedAt closedAt
  author { login } baseRefName
  repository { nameWithOwner defaultBranchRef { name } }`;

// The PR whose head branch is this PR's base: the PR below it in a stack.
const STACK = "baseRef { associatedPullRequests(first: 1, states: OPEN) { nodes { number title url } } }";

// shortcut: only the first 100 review threads and check contexts per PR are
// read; paginate them if a PR ever needs more for an exact count.
const OPEN_DETAILS = `
  reviewDecision mergeable ${STACK}
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { state } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { ${CHECK_RUN} }
      ... on StatusContext { context state description targetUrl createdAt }
    } }
  } } } }`;

const MINE = "is:pr author:@me archived:false sort:updated-desc";
const OPEN_PRS = "is:pr is:open archived:false sort:updated-desc";

export type ListTab = "open" | "review" | "assigned" | "merged" | "closed";

const TABS: Record<ListTab, { q: string; first: number; fields: string }> = {
  open: { q: `${MINE} is:open`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  review: { q: `${OPEN_PRS} review-requested:@me`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  assigned: { q: `${OPEN_PRS} assignee:@me`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  merged: { q: `${MINE} is:merged`, first: 30, fields: BASE },
  closed: { q: `${MINE} is:closed is:unmerged`, first: 30, fields: BASE },
};
export const LIST_TABS = Object.keys(TABS) as ListTab[];

/** One tab's PRs, and only the count of every other tab (for the tab badges), in one request. */
export function listQuery(tab: ListTab): string {
  const searches = LIST_TABS.map((t) =>
    t === tab
      ? `${t}: search(query: "${TABS[t].q}", type: ISSUE, first: ${TABS[t].first}) { issueCount nodes { ... on PullRequest { ${TABS[t].fields} } } }`
      : `${t}: search(query: "${TABS[t].q}", type: ISSUE, first: 1) { issueCount }`,
  );
  return `query {\n  ${searches.join("\n  ")}\n}`;
}

/** Every merged or closed PR of yours, newest first, 100 a page, for the Repos filter and search on those tabs. */
export const HISTORY_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${BASE} } }
  }
}`;
export const historyQuery = (state: "merged" | "closed") => TABS[state].q;

const COMMENT = "author { login avatarUrl(size: 64) } body createdAt url";

// shortcut: first 100 threads, 50 comments per thread, last 100 comments and
// 50 reviews; paginate if a PR ever outgrows that.
export const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id number title url isDraft state createdAt body changedFiles additions deletions
    author { login avatarUrl(size: 64) } headRefName baseRefName reviewDecision mergeable
    repository { nameWithOwner defaultBranchRef { name } } ${STACK}
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated path line originalLine startLine diffSide resolvedBy { login }
      comments(first: 50) { nodes { ${COMMENT} diffHunk state } }
    } }
    pendingReview: reviews(states: PENDING, first: 1) { nodes { id } }
    comments(last: 100) { nodes { ${COMMENT} } }
    reviews(last: 50) { nodes { author { login avatarUrl(size: 64) } state body submittedAt url } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { ${CHECK_RUN} title summary
        annotations(first: 20) { nodes { message path annotationLevel location { start { line } } } } }
      ... on StatusContext { context state description targetUrl createdAt }
    } } } } } }
  } }
}`;

const WHO = "author { __typename login } createdAt url";

// Open PRs only, with the latest few comments from every source so an
// ignored bot posting last cannot hide a person's comment.
export const WATCH_QUERY = `query {
  viewer { login }
  open: search(query: "${MINE} is:open", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      id number title url author { login } repository { nameWithOwner }
      comments(last: 5) { nodes { ${WHO} } }
      reviews(last: 5) { nodes { author { __typename login } submittedAt url } }
      reviewThreads(first: 100) { nodes { comments(last: 5) { nodes { ${WHO} } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { ${CHECK_RUN} }
        ... on StatusContext { context state description targetUrl createdAt }
      } } } } } }
    } }
  }
}`;

// ---- Writes: only ever sent from an explicit click ----

export const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { url state }
  }
}`;

export const COMMENT_MUTATION = `mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { url } } }
}`;

// A range adds startLine/startSide; they are left out entirely for one line.
const thread = (range: boolean) =>
  "path: $path, line: $line, side: $side, body: $body" + (range ? ", startLine: $startLine, startSide: $startSide" : "");
const threadVars = (range: boolean) =>
  "$path: String!, $line: Int!, $side: DiffSide!, $body: String!" + (range ? ", $startLine: Int!, $startSide: DiffSide!" : "");

/** A new pending review holding its first line comment (or, with $event, posted at once). */
export const reviewStartMutation = (range: boolean) => `mutation($prId: ID!, ${threadVars(range)}, $event: PullRequestReviewEvent) {
  addPullRequestReview(input: { pullRequestId: $prId, event: $event, threads: [{ ${thread(range)} }] }) {
    pullRequestReview { id state }
  }
}`;

export const reviewAddThreadMutation = (range: boolean) => `mutation($reviewId: ID!, ${threadVars(range)}) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, ${thread(range)} }) { thread { id } }
}`;

export const REVIEW_DISCARD_MUTATION = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) { pullRequestReview { id } }
}`;

export const REVIEW_SUBMIT_PENDING_MUTATION = `mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { url state }
  }
}`;

export const REVIEW_SUBMIT_NEW_MUTATION = `mutation($prId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $prId, event: $event, body: $body }) {
    pullRequestReview { url state }
  }
}`;

export const CLOSE_PR_MUTATION = `mutation($prId: ID!) {
  closePullRequest(input: { pullRequestId: $prId }) { pullRequest { state } }
}`;

export const REOPEN_PR_MUTATION = `mutation($prId: ID!) {
  reopenPullRequest(input: { pullRequestId: $prId }) { pullRequest { state } }
}`;
