// Run: node --test prs.test.ts   (Node 22.18+ strips the types itself)
import assert from "node:assert/strict";
import { test } from "node:test";
import { canSubmitReview, checkOf, matchesSearch, commentRange, commentTarget, fullPatch, rangeFromSelection, diffWatch, latestChecks, parsePatch, reviewEvents, stackOf, threadStatus, toDetail, toFiles, toList, toPr, toWatched, type RawDetail, type RawPr, type RawWatchPr, type Watched } from "./prs.ts";

const base: RawPr = {
  id: "PR_1",
  number: 7,
  title: "Fix it",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  repository: { nameWithOwner: "o/r" },
};

function rollup(state: string, nodes: object[] = []) {
  return { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes } } } }] };
}

test("an approved PR with green CI has no blockers", () => {
  const pr = toPr({ ...base, reviewDecision: "APPROVED", mergeable: "MERGEABLE", commits: rollup("SUCCESS") });
  assert.equal(pr.ci, "passing");
  assert.deepEqual(pr.blockers, []);
});

test("every reason an open PR is stuck is listed, in order", () => {
  const pr = toPr({
    ...base,
    isDraft: true,
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
    commits: rollup("FAILURE", [
      { __typename: "CheckRun", name: "build", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
      { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", detailsUrl: null },
      { __typename: "StatusContext", context: "jenkins", state: "ERROR", targetUrl: null },
    ]),
  });
  assert.deepEqual(pr.failingChecks, [
    { name: "build", workflow: null, url: "https://ci/1" },
    { name: "jenkins", workflow: null, url: null },
  ]);
  assert.equal(pr.unresolvedThreads, 2);
  assert.deepEqual(pr.blockers, [
    "Draft",
    "Merge conflicts",
    "CI failing (2 checks)",
    "Changes requested",
    "2 unresolved comments",
  ]);
});

test("UNKNOWN mergeable, missing checks and pending CI", () => {
  assert.deepEqual(toPr({ ...base, mergeable: "UNKNOWN" }).blockers, []);
  assert.equal(toPr(base).ci, "none");
  const pending = toPr({ ...base, reviewDecision: "REVIEW_REQUIRED", commits: rollup("PENDING") });
  assert.deepEqual(pending.blockers, ["CI running", "Awaiting review"]);
});

test("merged PRs have no blockers and non-PR search nodes are dropped", () => {
  const list = toList({ issueCount: 2, nodes: [{ ...base, mergedAt: "2026-10-03T00:00:00Z", isDraft: true }, {}] });
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0]!.blockers, []);
});

test("a check names its pipeline: the Actions workflow, else the CI app", () => {
  const run = checkOf({
    __typename: "CheckRun",
    name: "test / unit",
    status: "COMPLETED",
    conclusion: "CANCELLED",
    detailsUrl: "https://ci/9",
    checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } },
    annotations: { nodes: [{ message: "boom", path: "a.go", annotationLevel: "FAILURE", location: { start: { line: 3 } } }] },
  });
  assert.equal(run.workflow, "CI");
  assert.equal(run.status, "failing");
  assert.deepEqual(run.annotations, [{ path: "a.go", line: 3, level: "FAILURE", message: "boom" }]);
  const jenkins = checkOf({ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null,
    checkSuite: { app: { name: "Jenkins" }, workflowRun: null } });
  assert.equal(jenkins.workflow, "Jenkins");
  assert.equal(jenkins.status, "pending");
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }).status, "skipped");
});

const me = { login: "me" };
const c = (login: string, at: string) => ({ author: { login }, body: `${login} says`, createdAt: at, url: `u/${at}` });
const rawDetail: RawDetail = {
  number: 1, title: "T", url: "https://github.com/o/r/pull/1", isDraft: false, state: "OPEN",
  createdAt: "2026-10-01T00:00:00Z", body: "Description", author: me, headRefName: "feat", baseRefName: "main",
  reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", repository: { nameWithOwner: "o/r" },
  reviewThreads: { nodes: [
    { isResolved: true, isOutdated: false, path: "a.go", line: 1, originalLine: 1, resolvedBy: me,
      comments: { nodes: [c("rev", "2026-10-02T00:00:00Z"), c("me", "2026-10-03T00:00:00Z")] } },
    { isResolved: false, isOutdated: true, path: "b.go", line: null, originalLine: 7, resolvedBy: null,
      comments: { nodes: [c("rev", "2026-10-02T00:00:00Z"), c("me", "2026-10-03T00:00:00Z")] } },
    { isResolved: false, isOutdated: false, path: "c.go", line: 4, originalLine: 4, resolvedBy: null,
      comments: { nodes: [{ ...c("rev", "2026-10-02T00:00:00Z"), diffHunk: "@@ x\n-a\n+b" }] } },
  ] },
  comments: { nodes: [c("bot", "2026-10-05T00:00:00Z")] },
  reviews: { nodes: [
    { author: { login: "rev" }, state: "COMMENTED", body: "", submittedAt: "2026-10-02T00:00:00Z", url: "r1" },
    { author: { login: "rev" }, state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-10-04T00:00:00Z", url: "r2" },
  ] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "StatusContext", context: "ok", state: "SUCCESS" },
    { __typename: "StatusContext", context: "bad", state: "FAILURE", description: "tests failed" },
  ] } } } }] },
};

test("detail: unresolved threads first, who has the last word, and the timeline", () => {
  const d = toDetail(rawDetail);
  assert.deepEqual(d.threads.map((t) => [t.path, t.isResolved, t.awaitingReply]), [
    ["b.go", false, false], // I replied last
    ["c.go", false, true], // reviewer is waiting on me
    ["a.go", true, false],
  ]);
  assert.equal(d.threads[0]!.line, 7); // outdated: falls back to the original line
  assert.equal(d.threads[1]!.diffHunk, "@@ x\n-a\n+b");
  // Description, the CHANGES_REQUESTED review, then the comment; the bare COMMENTED review is dropped.
  assert.deepEqual(d.timeline.map((t) => [t.author, t.reviewState]), [
    ["me", null],
    ["rev", "CHANGES_REQUESTED"],
    ["bot", null],
  ]);
  assert.deepEqual(d.checks.map((k) => [k.name, k.status, k.title]), [
    ["bad", "failing", "tests failed"],
    ["ok", "passing", null],
  ]);
});

test("a run cancelled by a newer, passing run of the same job is not a failure", () => {
  const suite = { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } };
  const contexts = [
    { __typename: "CheckRun", name: "test / unit", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T00:00:00Z", checkSuite: suite },
    { __typename: "CheckRun", name: "test / unit", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-01T00:00:00Z", checkSuite: suite },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T00:00:00Z", checkSuite: suite },
  ];
  assert.deepEqual(latestChecks(contexts).map((c) => [c.name, c.status]), [
    ["test / unit", "passing"],
    ["lint", "failing"],
  ]);
  const pr = toPr({ ...base, commits: rollup("FAILURE", contexts.slice(0, 2)) });
  assert.equal(pr.ci, "passing");
  assert.deepEqual(pr.failingChecks, []);
});

// ---- watcher ----

const who = (login: string, at: string, type = "User") => ({ author: { __typename: type, login }, createdAt: at, url: `c/${login}/${at}` });
const run = (name: string, conclusion: string, startedAt: string) => ({
  __typename: "CheckRun", name, status: "COMPLETED", conclusion, startedAt,
  checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } },
});
const rawWatch = (over: Partial<RawWatchPr> = {}): RawWatchPr => ({
  id: "PR_9", number: 9, title: "Add retries", url: "https://github.com/o/r/pull/9", author: { login: "me" },
  repository: { nameWithOwner: "o/r" }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }, ...over,
});

test("watch: newest comment by someone else, skipping me, bots and ignored people", () => {
  const w = toWatched(rawWatch({
    comments: { nodes: [who("sam", "2026-10-02T00:00:00Z"), who("me", "2026-10-05T00:00:00Z")] },
    reviews: { nodes: [{ author: { __typename: "User", login: "priya" }, submittedAt: "2026-10-03T00:00:00Z", url: "r" }] },
    reviewThreads: { nodes: [{ comments: { nodes: [who("ci-helper", "2026-10-06T00:00:00Z"), who("dependabot", "2026-10-07T00:00:00Z", "Bot")] } }] },
  }), new Set(["ci-helper"]));
  assert.deepEqual(w.lastComment, { author: "priya", at: "2026-10-03T00:00:00Z", url: "r" });
});

test("watch: failing jobs use the latest run, so a superseded failure is ignored", () => {
  const w = toWatched(rawWatch({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    run("unit", "CANCELLED", "2026-10-01T00:00:00Z"), run("unit", "SUCCESS", "2026-10-02T00:00:00Z"), run("lint", "FAILURE", "2026-10-02T00:00:00Z"),
  ] } } } }] } }), new Set());
  assert.deepEqual(w.failing, ["CI › lint"]);
});

const pr = (over: Partial<Watched> = {}): Watched => ({ id: "PR_9", repo: "o/r", number: 9, title: "Add retries", url: "u", failing: [], lastComment: null, ...over });
const on = { ci: true, comments: true };
const T = "2026-10-10T00:00:00Z";

test("watch: the first poll only records a baseline", () => {
  const { alerts, next } = diffWatch(null, [pr({ failing: ["CI › unit"], lastComment: { author: "sam", at: T, url: "c" } })], T, on);
  assert.deepEqual(alerts, []);
  assert.deepEqual(next, { PR_9: { failing: ["CI › unit"], lastCommentAt: T } });
});

test("watch: alerts once when a job starts failing, and again only for a new job", () => {
  const first = diffWatch({ PR_9: { failing: [], lastCommentAt: null } }, [pr({ failing: ["CI › unit"] })], T, on);
  assert.deepEqual(first.alerts.map((a) => [a.kind, a.headline, a.detail]), [["ci", "CI failing · o/r#9", "CI › unit — Add retries"]]);
  assert.deepEqual(diffWatch(first.next, [pr({ failing: ["CI › unit"] })], T, on).alerts, []);
  const more = diffWatch(first.next, [pr({ failing: ["CI › unit", "CI › lint"] })], T, on);
  assert.deepEqual(more.alerts.map((a) => a.detail), ["CI › lint — Add retries"]);
});

test("watch: a newer comment alerts; an old one, a disabled kind or a brand-new PR's history does not", () => {
  const prev = { PR_9: { failing: [], lastCommentAt: "2026-10-01T00:00:00Z" } };
  const c = { author: "sam", at: "2026-10-02T00:00:00Z", url: "c" };
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: c })], T, on).alerts.map((a) => a.headline), ["sam commented · o/r#9"]);
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: { ...c, at: "2026-10-01T00:00:00Z" } })], T, on).alerts, []);
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: c, failing: ["CI › unit"] })], T, { ci: false, comments: false }).alerts, []);
  // A PR not in the previous snapshot: CI counts, its existing comments do not.
  const fresh = diffWatch({}, [pr({ lastComment: c, failing: ["CI › unit"] })], T, on);
  assert.deepEqual(fresh.alerts.map((a) => a.kind), ["ci"]);
});

// ---- stacks, thread status, files ----

test("stacks: a PR based on another PR's branch is stacked; the default branch never is", () => {
  const parent = { number: 2284, title: "Usecase", url: "u" };
  const repo = { nameWithOwner: "o/r", defaultBranchRef: { name: "master" } };
  assert.deepEqual(stackOf({ baseRefName: "feat/usecase", repository: repo, baseRef: { associatedPullRequests: { nodes: [parent] } } }),
    { onDefaultBranch: false, stackedOn: parent });
  // GitHub links master to an unrelated PR (seen live as #393); it must not count as a parent.
  assert.deepEqual(stackOf({ baseRefName: "master", repository: repo, baseRef: { associatedPullRequests: { nodes: [{ ...parent, number: 393 }] } } }),
    { onDefaultBranch: true, stackedOn: null });
  // Parent merged and its branch deleted: still not on the default branch, but no parent PR.
  assert.deepEqual(stackOf({ baseRefName: "feat/usecase", repository: repo, baseRef: null }), { onDefaultBranch: false, stackedOn: null });
  const stacked = toPr({ ...base, baseRefName: "feat/usecase", repository: repo, baseRef: { associatedPullRequests: { nodes: [parent] } } });
  assert.deepEqual(stacked.blockers, ["Stacked on #2284"]);
});

test("thread status depends on who is looking", () => {
  const t = (awaitingReply: boolean, isResolved = false) => ({ ...toDetail(rawDetail).threads[0]!, awaitingReply, isResolved });
  assert.equal(threadStatus(t(true), "me", "me"), "waiting-on-you");
  assert.equal(threadStatus(t(false), "me", "me"), "you-replied");
  assert.equal(threadStatus(t(true), "rev", "me"), "waiting-on-author");
  assert.equal(threadStatus(t(false), "rev", "me"), "author-replied");
  assert.equal(threadStatus(t(true, true), "rev", "me"), "resolved");
  assert.equal(toDetail(rawDetail, "rev").viewer, "rev");
});

test("files: renames keep the old path; binary and huge patches have no diff", () => {
  assert.deepEqual(toFiles([
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    { filename: "big.json", status: "modified", additions: 9, deletions: 9, patch: "x".repeat(200_001) },
  ]).map((f) => [f.path, f.previousPath, f.patch === null ? null : "patch"]), [
    ["src/new.ts", "src/old.ts", "patch"],
    ["logo.png", null, null],
    ["big.json", null, null],
  ]);
});

// ---- reviewing ----

test("patch: line numbers across hunks, deletions, no-newline markers and a trailing newline", () => {
  const rows = parsePatch([
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old a",
    "-old b",
    "+new a",
    "\\ No newline at end of file",
    "@@ -10 +10,2 @@ fn()",
    " ctx",
    "+added",
    "",
  ].join("\n"));
  assert.deepEqual(rows.map((r) => [r.kind, r.oldLine, r.newLine]), [
    ["hunk", null, null],
    ["ctx", 1, 1],
    ["del", 2, null],
    ["del", 3, null],
    ["add", null, 2],
    ["hunk", null, null],
    ["ctx", 10, 10],
    ["add", null, 11],
  ]);
  assert.deepEqual(rows.map(commentTarget), [
    null, { side: "RIGHT", line: 1 }, { side: "LEFT", line: 2 }, { side: "LEFT", line: 3 }, { side: "RIGHT", line: 2 },
    null, { side: "RIGHT", line: 10 }, { side: "RIGHT", line: 11 },
  ]);
});

test("review rules: no approving your own PR; changes need a reason; comment needs text or line comments", () => {
  assert.deepEqual(reviewEvents("me", "me"), ["COMMENT"]);
  assert.deepEqual(reviewEvents("me", "sam"), ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
  assert.equal(canSubmitReview("APPROVE", "", 0), true);
  assert.equal(canSubmitReview("REQUEST_CHANGES", "  ", 3), false);
  assert.equal(canSubmitReview("REQUEST_CHANGES", "Fix the cap", 0), true);
  assert.equal(canSubmitReview("COMMENT", "", 0), false);
  assert.equal(canSubmitReview("COMMENT", "", 2), true);
});

test("detail: your pending review and its draft threads are recognised", () => {
  const raw = structuredClone(rawDetail);
  raw.pendingReview = { nodes: [{ id: "PRR_pending" }] };
  raw.reviewThreads.nodes[2]!.diffSide = "LEFT";
  (raw.reviewThreads.nodes[2]!.comments.nodes[0] as { state?: string }).state = "PENDING";
  const d = toDetail(raw, "me");
  assert.equal(d.pendingReviewId, "PRR_pending");
  const draft = d.threads.find((t) => t.path === "c.go")!;
  assert.deepEqual([draft.isPending, draft.side], [true, "LEFT"]);
  assert.equal(d.threads.filter((t) => t.isPending).length, 1);
});


test("multi-line range: ordered, anchored on the last row, kept inside one hunk", () => {
  const rows = parsePatch(["@@ -1,3 +1,3 @@", " keep", "-old", "+new", "@@ -10 +10 @@", " later"].join("\n"));
  // rows: 0 hunk, 1 ctx(1/1), 2 del(old 2), 3 add(new 2), 4 hunk, 5 ctx(10/10)
  assert.deepEqual(commentRange(rows, 3, 1), { side: "RIGHT", line: 2, start: { side: "RIGHT", line: 1 } });
  assert.deepEqual(commentRange(rows, 2, 3), { side: "RIGHT", line: 2, start: { side: "LEFT", line: 2 } });
  assert.deepEqual(commentRange(rows, 1, 1), { side: "RIGHT", line: 1, start: null });
  assert.equal(commentRange(rows, 3, 5), null); // crosses a hunk header
  assert.equal(commentRange(rows, 0, 1), null); // a hunk header is not a line
});

test("detail: a multi-line thread keeps its first line", () => {
  const raw = structuredClone(rawDetail);
  raw.reviewThreads.nodes[1]!.startLine = 4;
  assert.equal(toDetail(raw).threads.find((t) => t.path === "b.go")!.startLine, 4);
});

test("viewer selection maps to a GitHub range, in either order, inside one hunk", () => {
  const rows = parsePatch(["@@ -1,3 +1,3 @@", " keep", "-old", "+new", "@@ -10 +10 @@", " later"].join("\n"));
  assert.deepEqual(rangeFromSelection(rows, { start: 2, side: "additions", end: 2 }), { side: "RIGHT", line: 2, start: null });
  assert.deepEqual(rangeFromSelection(rows, { start: 2, side: "deletions", end: 2, endSide: "additions" }),
    { side: "RIGHT", line: 2, start: { side: "LEFT", line: 2 } });
  // Dragged upward: still ordered top to bottom.
  assert.deepEqual(rangeFromSelection(rows, { start: 2, side: "additions", end: 1 }), { side: "RIGHT", line: 2, start: { side: "RIGHT", line: 1 } });
  // A context line picked on the old side still anchors where GitHub expects.
  assert.deepEqual(rangeFromSelection(rows, { start: 1, side: "deletions", end: 1 }), { side: "RIGHT", line: 1, start: null });
  assert.equal(rangeFromSelection(rows, { start: 1, side: "additions", end: 10 }), null); // crosses a hunk
  assert.equal(rangeFromSelection(rows, { start: 99, side: "additions", end: 99 }), null); // not in the patch
});

test("full patch: git headers for modified, added, removed and renamed files", () => {
  const hunk = "@@ -1 +1 @@\n-a\n+b";
  assert.equal(fullPatch({ path: "s/x.ts", previousPath: null, status: "modified", patch: hunk }),
    "diff --git a/s/x.ts b/s/x.ts\n--- a/s/x.ts\n+++ b/s/x.ts\n" + hunk);
  assert.match(fullPatch({ path: "n.ts", previousPath: null, status: "added", patch: hunk }), /^diff --git a\/n.ts b\/n.ts\n--- \/dev\/null\n\+\+\+ b\/n.ts\n/);
  assert.match(fullPatch({ path: "o.ts", previousPath: null, status: "removed", patch: hunk }), /\n--- a\/o.ts\n\+\+\+ \/dev\/null\n/);
  assert.match(fullPatch({ path: "new.ts", previousPath: "old.ts", status: "renamed", patch: hunk }), /^diff --git a\/old.ts b\/new.ts\n--- a\/old.ts\n\+\+\+ b\/new.ts\n/);
});

test("search matches every word across title, number, repo, author and blockers", () => {
  const pr = { ...toPr({ ...base, author: { login: "priya-n" } } as RawPr), blockers: ["CI failing (1 check)"] };
  assert.equal(matchesSearch(pr, ""), true);
  assert.equal(matchesSearch(pr, "  "), true);
  assert.equal(matchesSearch(pr, "fix"), true);
  assert.equal(matchesSearch(pr, "#7"), true);
  assert.equal(matchesSearch(pr, "o/r PRIYA"), true);
  assert.equal(matchesSearch(pr, "failing fix"), true);
  assert.equal(matchesSearch(pr, "fix #8"), false);
  assert.equal(matchesSearch(pr, "sam"), false);
});
