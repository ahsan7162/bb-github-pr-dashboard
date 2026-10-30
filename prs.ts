// The shapes GitHub returns and the pure mapping from them to what the page shows
// (the GraphQL text itself is in queries.ts). No I/O here, so prs.test.ts can
// exercise it directly.

export type CiState = "passing" | "failing" | "pending" | "none";

export interface FailingCheck {
  name: string;
  /** GitHub Actions workflow (the pipeline) the failing job belongs to. */
  workflow: string | null;
  url: string | null;
}

/** The open PR whose branch this one is based on. */
export interface StackRef {
  number: number;
  title: string;
  url: string;
}

export interface Pr {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  baseRefName: string;
  /** False when the PR targets another branch rather than the repo's default. */
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
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
  author?: { login: string } | null;
  baseRefName?: string;
  repository: { nameWithOwner: string; defaultBranchRef?: { name: string } | null };
  baseRef?: { associatedPullRequests: { nodes: StackRef[] } } | null;
  reviewDecision?: string | null;
  mergeable?: string;
  reviewThreads?: { nodes: { isResolved: boolean; comments?: { nodes: { state?: string }[] } }[] };
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
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
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

/** Stacked when the base is not the default branch; the parent PR may be gone if its branch was deleted. */
export function stackOf(raw: Pick<RawPr, "baseRefName" | "repository" | "baseRef">): {
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
} {
  // GitHub links the default branch to unrelated PRs, so never treat it as a parent.
  const onDefaultBranch = !raw.baseRefName || raw.baseRefName === raw.repository.defaultBranchRef?.name;
  return { onDefaultBranch, stackedOn: onDefaultBranch ? null : (raw.baseRef?.associatedPullRequests.nodes[0] ?? null) };
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
    author: raw.author?.login ?? "ghost",
    baseRefName: raw.baseRefName ?? "",
    ...stackOf(raw),
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    ci: ciState(rollup?.state, checks),
    failingChecks,
    // Threads still in your unsubmitted review are drafts, not open conversations.
    unresolvedThreads:
      raw.reviewThreads?.nodes.filter((t) => !t.isResolved && t.comments?.nodes[0]?.state !== "PENDING").length ?? 0,
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
  if (pr.stackedOn) out.push(`Stacked on #${pr.stackedOn.number}`);
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

/** Whether a row matches every word of a search, in its title, #number, repo, author, base branch or blockers. */
export function matchesSearch(pr: Pr, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [pr.title, `#${pr.number}`, pr.repo, pr.author, pr.baseRefName, ...pr.blockers].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
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
  /** GraphQL node id, used to reply. */
  id: string;
  path: string;
  /** Which side of the diff the line number refers to. */
  side: "LEFT" | "RIGHT";
  /** First line of a multi-line comment; null for a single line. */
  startLine: number | null;
  /** Part of your unsubmitted review: only you can see it. */
  isPending: boolean;
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
  /** GraphQL node id, used to comment. */
  id: string;
  /** The signed-in GitHub user looking at the PR. */
  viewer: string;
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
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** Your unsubmitted review on this PR, if you started one. */
  pendingReviewId: string | null;
  reviewDecision: string | null;
  conflicts: boolean;
  /** Description first, then comments and reviews, oldest first. */
  timeline: TimelineEntry[];
  /** Unresolved first, in GitHub's order within each group. */
  threads: Thread[];
  /** Failing first, then running, passing, skipped. */
  checks: CheckDetail[];
}


type RawAuthor = { login: string; avatarUrl?: string } | null;
interface RawComment {
  author: RawAuthor;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string;
  state?: string;
}
export interface RawDetail {
  id?: string;
  pendingReview?: { nodes: { id: string }[] };
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  baseRef?: { associatedPullRequests: { nodes: StackRef[] } } | null;
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
  repository: { nameWithOwner: string; defaultBranchRef?: { name: string } | null };
  reviewThreads: {
    nodes: {
      id?: string;
      diffSide?: string;
      startLine?: number | null;
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

export function toDetail(raw: RawDetail, viewer = ""): PrDetail {
  const author = login(raw.author);
  const threads: Thread[] = raw.reviewThreads.nodes.map((t) => {
    const comments = t.comments.nodes.map(comment);
    const hunk = t.comments.nodes[0]?.diffHunk;
    return {
      id: t.id ?? "",
      path: t.path,
      side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      startLine: t.startLine ?? null,
      isPending: t.comments.nodes[0]?.state === "PENDING",
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
    id: raw.id ?? "",
    viewer,
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
    ...stackOf(raw),
    changedFiles: raw.changedFiles ?? 0,
    pendingReviewId: raw.pendingReview?.nodes[0]?.id ?? null,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    reviewDecision: raw.reviewDecision,
    conflicts: raw.mergeable === "CONFLICTING",
    timeline,
    // Array sort is stable, so GitHub's order survives within each group.
    threads: threads.sort((a, b) => Number(a.isResolved) - Number(b.isResolved)),
    checks: latestChecks(contexts).sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]),
  };
}

// ---- Watcher: what changed since the last poll ----

/** Realtime channels: new alerts, and alerts marked seen. */
export const ALERTS_NEW = "pr-alerts";
export const ALERTS_SEEN = "pr-alerts-seen";


interface RawWho {
  author: { __typename?: string; login: string } | null;
  createdAt?: string;
  submittedAt?: string | null;
  url: string;
}
export interface RawWatchPr {
  id: string;
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  comments: { nodes: RawWho[] };
  reviews: { nodes: RawWho[] };
  reviewThreads: { nodes: { comments: { nodes: RawWho[] } }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}

export interface Watched {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Latest-run failing jobs as "workflow › job". */
  failing: string[];
  /** Newest comment or review by someone other than you, bots and ignored people. */
  lastComment: { author: string; at: string; url: string } | null;
}

export function toWatched(raw: RawWatchPr, ignore: Set<string>): Watched {
  const me = raw.author?.login;
  const contexts = raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const candidates = [
    ...raw.comments.nodes,
    ...raw.reviews.nodes,
    ...raw.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
  ].flatMap((w) => {
    const at = w.createdAt ?? w.submittedAt;
    const who = w.author;
    if (!who || !at || who.login === me || who.__typename === "Bot" || ignore.has(who.login.toLowerCase())) return [];
    return [{ author: who.login, at, url: w.url }];
  });
  return {
    id: raw.id,
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    failing: latestChecks(contexts)
      .filter((c) => c.status === "failing")
      .map((c) => (c.workflow ? `${c.workflow} › ${c.name}` : c.name)),
    lastComment: candidates.reduce<Watched["lastComment"]>((a, b) => (a && a.at >= b.at ? a : b), null),
  };
}

export interface WatchState {
  failing: string[];
  lastCommentAt: string | null;
}

export interface Alert {
  id: string;
  kind: "ci" | "comment" | "test";
  repo: string;
  number: number;
  url: string;
  headline: string;
  detail: string;
  at: string;
  seen: boolean;
}

/**
 * Alerts for what changed since `prev`. A null `prev` (first poll, or a new
 * GitHub account) only records a baseline, so installing never floods you.
 */
export function diffWatch(
  prev: Record<string, WatchState> | null,
  prs: Watched[],
  now: string,
  notify: { ci: boolean; comments: boolean },
): { alerts: Alert[]; next: Record<string, WatchState> } {
  const next: Record<string, WatchState> = {};
  const alerts: Alert[] = [];
  for (const pr of prs) {
    next[pr.id] = { failing: pr.failing, lastCommentAt: pr.lastComment?.at ?? null };
    if (prev === null) continue;
    // A PR first seen now: its CI counts from clean, its old comments do not.
    const was = prev[pr.id] ?? { failing: [], lastCommentAt: pr.lastComment?.at ?? null };
    const ref = { repo: pr.repo, number: pr.number, seen: false };
    const newlyFailing = pr.failing.filter((f) => !was.failing.includes(f));
    if (notify.ci && newlyFailing.length > 0) {
      alerts.push({
        ...ref,
        id: `${pr.id}:ci:${newlyFailing.join("|")}:${now}`,
        kind: "ci",
        url: pr.url,
        headline: `CI failing · ${pr.repo}#${pr.number}`,
        detail: `${newlyFailing.join(", ")} — ${pr.title}`,
        at: now,
      });
    }
    const c = pr.lastComment;
    if (notify.comments && c && (was.lastCommentAt === null || c.at > was.lastCommentAt)) {
      alerts.push({
        ...ref,
        id: `${pr.id}:comment:${c.at}`,
        kind: "comment",
        url: c.url,
        headline: `${c.author} commented · ${pr.repo}#${pr.number}`,
        detail: pr.title,
        at: c.at,
      });
    }
  }
  return { alerts, next };
}

/** Who a thread is waiting on, from the point of view of whoever is looking. */
export type ThreadStatus = "resolved" | "waiting-on-you" | "you-replied" | "waiting-on-author" | "author-replied";

export function threadStatus(t: Thread, viewer: string, author: string): ThreadStatus {
  if (t.isResolved) return "resolved";
  // awaitingReply: the last word is not the PR author's.
  if (viewer === author) return t.awaitingReply ? "waiting-on-you" : "you-replied";
  return t.awaitingReply ? "waiting-on-author" : "author-replied";
}

// ---- Changed files (REST /pulls/{n}/files) ----

export interface RestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  /** added, removed, modified, renamed, copied, changed, unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Null for binary files, files GitHub will not diff, or very large patches. */
  patch: string | null;
}

const MAX_PATCH = 200_000;

export function toFiles(files: RestFile[]): PrFile[] {
  return files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch && f.patch.length <= MAX_PATCH ? f.patch : null,
  }));
}


// ---- Reviewing: line comments and submitting a review ----

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** GitHub's per-file REST patch, as rows with the line numbers a comment needs. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop(); // a trailing newline is not a context line
  for (const row of rows) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: "hunk", text: row, oldLine: null, newLine: null });
    } else if (row.startsWith("\\")) {
      continue; // "\ No newline at end of file" belongs to neither side
    } else if (row.startsWith("+")) {
      out.push({ kind: "add", text: row.slice(1), oldLine: null, newLine: newLine++ });
    } else if (row.startsWith("-")) {
      out.push({ kind: "del", text: row.slice(1), oldLine: oldLine++, newLine: null });
    } else {
      out.push({ kind: "ctx", text: row.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return out;
}

/** Where GitHub anchors a comment on this row: removed lines on the old side, the rest on the new. */
export function commentTarget(row: DiffLine): { side: "LEFT" | "RIGHT"; line: number } | null {
  if (row.kind === "hunk") return null;
  return row.kind === "del" ? { side: "LEFT", line: row.oldLine! } : { side: "RIGHT", line: row.newLine! };
}

export interface CommentRange {
  side: "LEFT" | "RIGHT";
  line: number;
  /** Set only when the comment spans more than one line. */
  start: { side: "LEFT" | "RIGHT"; line: number } | null;
}

/**
 * The comment for rows `a`..`b` (either order), anchored on the lower row like
 * GitHub. Null when a hunk header sits between them: GitHub only accepts a
 * range inside one hunk.
 */
export function commentRange(rows: DiffLine[], a: number, b: number): CommentRange | null {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const end = rows[to] ? commentTarget(rows[to]!) : null;
  const begin = rows[from] ? commentTarget(rows[from]!) : null;
  if (!end || !begin) return null;
  if (rows.slice(from, to + 1).some((r) => r.kind === "hunk")) return null;
  return { ...end, start: from === to ? null : begin };
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** GitHub refuses Approve and Request changes on your own pull request. */
export function reviewEvents(viewer: string, author: string): ReviewEvent[] {
  return viewer === author ? ["COMMENT"] : ["COMMENT", "APPROVE", "REQUEST_CHANGES"];
}

/** Mirrors GitHub: changes need a reason, a comment review needs a body or line comments. */
export function canSubmitReview(event: ReviewEvent, body: string, pendingComments: number): boolean {
  if (event === "APPROVE") return true;
  if (event === "REQUEST_CHANGES") return body.trim() !== "";
  return body.trim() !== "" || pendingComments > 0;
}


// ---- Mapping the diff viewer's line selection to a GitHub comment ----

/** @pierre/diffs names the old side "deletions" and the new side "additions". */
export type ViewerSide = "deletions" | "additions";
export const toViewerSide = (side: "LEFT" | "RIGHT"): ViewerSide => (side === "LEFT" ? "deletions" : "additions");

/**
 * The comment range for a selection in the diff viewer, or null when a line is
 * not in the patch or the selection crosses a hunk (GitHub would refuse it).
 */
export function rangeFromSelection(
  rows: DiffLine[],
  selection: { start: number; side?: ViewerSide; end: number; endSide?: ViewerSide },
): CommentRange | null {
  const rowOf = (side: ViewerSide, line: number) =>
    rows.findIndex((r) => (side === "deletions" ? r.kind !== "add" && r.oldLine === line : r.kind !== "del" && r.newLine === line));
  const side = selection.side ?? "additions";
  const a = rowOf(side, selection.start);
  const b = rowOf(selection.endSide ?? side, selection.end);
  return a < 0 || b < 0 ? null : commentRange(rows, a, b);
}

/**
 * GitHub's REST patch is only the hunks; the diff viewer needs one complete
 * file patch, so add the git headers it expects.
 */
export function fullPatch(file: Pick<PrFile, "path" | "previousPath" | "status" | "patch">): string {
  const before = file.previousPath ?? file.path;
  return [
    `diff --git a/${before} b/${file.path}`,
    file.status === "added" ? "--- /dev/null" : `--- a/${before}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.path}`,
    file.patch ?? "",
  ].join("\n");
}
