// Run: node --test prs.test.ts   (Node 22.18+ strips the types itself)
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOf, latestChecks, toDetail, toList, toPr, type RawDetail, type RawPr } from "./prs.ts";

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
