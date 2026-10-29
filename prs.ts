// GitHub GraphQL query and the pure mapping from its response to the rows the
// page shows. No I/O here, so prs.test.ts can exercise it directly.

export type CiState = "passing" | "failing" | "pending" | "none";

export interface FailingCheck {
  name: string;
  /** GitHub Actions workflow (the pipeline) the failing job belongs to. */
  workflow: string | null;
  url: string | null;
}

export interface Pr {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  ci: CiState;
  failingChecks: FailingCheck[];
  unresolvedThreads: number;
  reviewDecision: string | null;
  conflicts: boolean;
  /** Why an open PR is not merged yet; empty means nothing is blocking it. */
  blockers: string[];
}

export interface PrList {
  total: number;
  items: Pr[];
}

const CHECK_RUN = `name status conclusion detailsUrl startedAt
  checkSuite { app { name } workflowRun { workflow { name } } }`;

const BASE = `
  id number title url isDraft createdAt updatedAt mergedAt closedAt
  repository { nameWithOwner }`;

// shortcut: only the first 100 review threads and check contexts per PR are
// read; paginate them if a PR ever needs more for an exact count.
const OPEN_DETAILS = `
  reviewDecision mergeable
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { ${CHECK_RUN} }
      ... on StatusContext { context state description targetUrl createdAt }
    } }
  } } } }`;

const MINE = "is:pr author:@me archived:false sort:updated-desc";

export const PRS_QUERY = `query {
  open: search(query: "${MINE} is:open", type: ISSUE, first: 50) {
    issueCount nodes { ... on PullRequest { ${BASE} ${OPEN_DETAILS} } }
  }
  merged: search(query: "${MINE} is:merged", type: ISSUE, first: 30) {
    issueCount nodes { ... on PullRequest { ${BASE} } }
  }
  closed: search(query: "${MINE} is:closed is:unmerged", type: ISSUE, first: 30) {
    issueCount nodes { ... on PullRequest { ${BASE} } }
  }
}`;

// Loose shape of what the query returns; GitHub omits fields it skipped.
interface RawContext {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  title?: string | null;
  summary?: string | null;
  checkSuite?: {
    app: { name: string } | null;
    workflowRun: { workflow: { name: string } } | null;
  } | null;
  annotations?: {
    nodes: {
      message: string;
      path: string;
      annotationLevel: string | null;
      location: { start: { line: number } } | null;
    }[];
  };
  startedAt?: string | null;
  context?: string;
  createdAt?: string;
  state?: string;
  description?: string | null;
  targetUrl?: string | null;
}
export interface RawPr {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  repository: { nameWithOwner: string };
  reviewDecision?: string | null;
  mergeable?: string;
  reviewThreads?: { nodes: { isResolved: boolean }[] };
  commits?: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: RawContext[] };
        } | null;
      };
    }[];
  };
}
export interface RawSearch {
  issueCount: number;
  nodes: (RawPr | Record<string, never>)[];
}

const FAILED_RUN = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const FAILED_STATUS = new Set(["FAILURE", "ERROR"]);

function ciState(rollup: string | undefined, checks: CheckDetail[]): CiState {
  if (rollup === undefined) return "none";
  // GitHub's rollup counts superseded runs, so judge by the latest runs when we have them.
  if (checks.some((c) => c.status === "failing")) return "failing";
  if (checks.some((c) => c.status === "pending")) return "pending";
  if (checks.length > 0) return "passing";
  if (rollup === "SUCCESS") return "passing";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failing";
  return "pending"; // PENDING, EXPECTED
}

export function toPr(raw: RawPr): Pr {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks = latestChecks(rollup?.contexts.nodes ?? []);
  const failingChecks: FailingCheck[] = checks
    .filter((c) => c.status === "failing")
    .map(({ name, workflow, url }) => ({ name, workflow, url }));
  const pr: Pr = {
    id: raw.id ?? raw.url,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: raw.repository.nameWithOwner,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    ci: ciState(rollup?.state, checks),
    failingChecks,
    unresolvedThreads:
      raw.reviewThreads?.nodes.filter((t) => !t.isResolved).length ?? 0,
    reviewDecision: raw.reviewDecision ?? null,
    // UNKNOWN means GitHub has not computed it yet; only CONFLICTING is a conflict.
    conflicts: raw.mergeable === "CONFLICTING",
    blockers: [],
  };
  pr.blockers = blockersOf(pr);
  return pr;
}

export function blockersOf(pr: Pr): string[] {
  if (pr.mergedAt !== null || pr.closedAt !== null) return [];
  const out: string[] = [];
  if (pr.isDraft) out.push("Draft");
  if (pr.conflicts) out.push("Merge conflicts");
  if (pr.ci === "failing") {
    const n = pr.failingChecks.length;
    out.push(n > 0 ? `CI failing (${n} check${n === 1 ? "" : "s"})` : "CI failing");
  }
  if (pr.ci === "pending") out.push("CI running");
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push("Changes requested");
  if (pr.unresolvedThreads > 0) {
    const n = pr.unresolvedThreads;
    out.push(`${n} unresolved comment${n === 1 ? "" : "s"}`);
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") out.push("Awaiting review");
  return out;
}

export function toList(search: RawSearch): PrList {
  return {
    total: search.issueCount,
    // Search can return non-PR nodes as {} when the fragment does not match.
    items: search.nodes.filter((n): n is RawPr => "url" in n).map(toPr),
  };
}

// ---- CI checks (shared by the list and the detail view) ----

export type CheckStatus = "failing" | "pending" | "passing" | "skipped";

export interface Annotation {
  path: string;
  line: number | null;
  level: string | null;
  message: string;
}

export interface CheckDetail {
  /** Job name for GitHub Actions, context name for commit statuses. */
  name: string;
  /** The pipeline: the Actions workflow, else the CI app (e.g. Jenkins). */
  workflow: string | null;
  status: CheckStatus;
  conclusion: string | null;
  url: string | null;
  title: string | null;
  summary: string | null;
  annotations: Annotation[];
}

export function checkOf(c: RawContext): CheckDetail {
  if (c.__typename === "StatusContext") {
    const state = c.state ?? "";
    return {
      name: c.context ?? "status",
      workflow: null,
      status: FAILED_STATUS.has(state) ? "failing" : state === "SUCCESS" ? "passing" : "pending",
      conclusion: state || null,
      url: c.targetUrl ?? null,
      title: c.description ?? null,
      summary: null,
      annotations: [],
    };
  }
  const conclusion = c.conclusion ?? null;
  const status: CheckStatus = FAILED_RUN.has(conclusion ?? "")
    ? "failing"
    : c.status !== undefined && c.status !== "COMPLETED"
      ? "pending"
      : conclusion === "SUCCESS"
        ? "passing"
        : "skipped"; // SKIPPED, NEUTRAL, STALE
  return {
    name: c.name ?? "check",
    workflow:
      c.checkSuite?.workflowRun?.workflow.name ?? c.checkSuite?.app?.name ?? null,
    status,
    conclusion,
    url: c.detailsUrl ?? null,
    title: c.title || null,
    summary: c.summary || null,
    annotations: (c.annotations?.nodes ?? []).map((a) => ({
      path: a.path,
      line: a.location?.start.line ?? null,
      level: a.annotationLevel,
      message: a.message,
    })),
  };
}

/**
 * One check per pipeline job: the commit keeps every run of a job (re-runs,
 * runs cancelled by a newer one), and only the latest decides, as in branch
 * protection.
 */
export function latestChecks(contexts: RawContext[]): CheckDetail[] {
  const latest = new Map<string, { at: string; check: CheckDetail }>();
  for (const c of contexts) {
    const check = checkOf(c);
    const key = `${check.workflow ?? ""}|${check.name}`;
    const at = c.startedAt ?? c.createdAt ?? "";
    if ((latest.get(key)?.at ?? "") <= at) latest.set(key, { at, check });
  }
  return [...latest.values()].map((v) => v.check);
}

// ---- Detail view ----

export interface Comment {
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface Thread {
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  /** Last lines of the diff the thread is attached to. */
  diffHunk: string | null;
  comments: Comment[];
  /** Unresolved and the last word is not the PR author's. */
  awaitingReply: boolean;
}

export interface TimelineEntry extends Comment {
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED; null for a plain comment. */
  reviewState: string | null;
}

export interface PrDetail {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  authorAvatarUrl: string | null;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  conflicts: boolean;
  /** Description first, then comments and reviews, oldest first. */
  timeline: TimelineEntry[];
  /** Unresolved first, in GitHub's order within each group. */
  threads: Thread[];
  /** Failing first, then running, passing, skipped. */
  checks: CheckDetail[];
}

const COMMENT = "author { login avatarUrl(size: 64) } body createdAt url";

// shortcut: first 100 threads, 50 comments per thread, last 100 comments and
// 50 reviews; paginate if a PR ever outgrows that.
export const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    number title url isDraft state createdAt body
    author { login avatarUrl(size: 64) } headRefName baseRefName reviewDecision mergeable
    repository { nameWithOwner }
    reviewThreads(first: 100) { nodes {
      isResolved isOutdated path line originalLine resolvedBy { login }
      comments(first: 50) { nodes { ${COMMENT} diffHunk } }
    } }
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

type RawAuthor = { login: string; avatarUrl?: string } | null;
interface RawComment {
  author: RawAuthor;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string;
}
export interface RawDetail {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: string;
  createdAt: string;
  body: string;
  author: RawAuthor;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  repository: { nameWithOwner: string };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      resolvedBy: RawAuthor;
      comments: { nodes: RawComment[] };
    }[];
  };
  comments: { nodes: RawComment[] };
  reviews: {
    nodes: {
      author: RawAuthor;
      state: string;
      body: string;
      submittedAt: string | null;
      url: string;
    }[];
  };
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[];
  };
}

const login = (a: RawAuthor) => a?.login ?? "ghost";
const comment = (c: RawComment): Comment => ({
  author: login(c.author),
  avatarUrl: c.author?.avatarUrl ?? null,
  body: c.body,
  createdAt: c.createdAt,
  url: c.url,
});
const CHECK_ORDER: Record<CheckStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 };

export function toDetail(raw: RawDetail): PrDetail {
  const author = login(raw.author);
  const threads: Thread[] = raw.reviewThreads.nodes.map((t) => {
    const comments = t.comments.nodes.map(comment);
    const hunk = t.comments.nodes[0]?.diffHunk;
    return {
      path: t.path,
      line: t.line ?? t.originalLine,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      resolvedBy: t.resolvedBy ? login(t.resolvedBy) : null,
      diffHunk: hunk ? hunk.split("\n").slice(-8).join("\n") : null,
      comments,
      awaitingReply: !t.isResolved && comments.at(-1)?.author !== author,
    };
  });
  const timeline: TimelineEntry[] = [
    ...(raw.body.trim() === ""
      ? []
      : [{ ...comment(raw), reviewState: null }]),
    ...raw.comments.nodes.map((c) => ({ ...comment(c), reviewState: null })),
    ...raw.reviews.nodes
      // A bare COMMENTED review only wraps thread comments, shown under threads.
      .filter((r) => r.submittedAt !== null && (r.body.trim() !== "" || r.state !== "COMMENTED"))
      .map((r) => ({
        author: login(r.author),
        avatarUrl: r.author?.avatarUrl ?? null,
        body: r.body,
        createdAt: r.submittedAt!,
        url: r.url,
        reviewState: r.state,
      })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const contexts = raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: raw.repository.nameWithOwner,
    author,
    authorAvatarUrl: raw.author?.avatarUrl ?? null,
    state: raw.state,
    isDraft: raw.isDraft,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    reviewDecision: raw.reviewDecision,
    conflicts: raw.mergeable === "CONFLICTING",
    timeline,
    // Array sort is stable, so GitHub's order survives within each group.
    threads: threads.sort((a, b) => Number(a.isResolved) - Number(b.isResolved)),
    checks: latestChecks(contexts).sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]),
  };
}
