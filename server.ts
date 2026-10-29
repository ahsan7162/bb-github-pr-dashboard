// bb-github-pr-dashboard — backend entry.
//
// `prs_list` runs one GitHub GraphQL query for the user's open,
// merged and closed PRs; `pr_detail` fetches one PR's threads, conversation and
// checks. A background service polls open PRs and stores an alert when CI
// starts failing or someone comments; the page shows them as toasts, desktop
// notifications and a badge. Auth comes from the optional `token` setting, else
// from the GitHub CLI already logged in on the machine (`gh auth token`), so
// every user of a published copy sees their own PRs.
import { execFile } from "node:child_process";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CLOSE_PR_MUTATION,
  COMMENT_MUTATION,
  REOPEN_PR_MUTATION,
  REVIEW_DISCARD_MUTATION,
  reviewAddThreadMutation,
  reviewStartMutation,
  REVIEW_SUBMIT_NEW_MUTATION,
  REVIEW_SUBMIT_PENDING_MUTATION,
  canSubmitReview,
  PRS_QUERY,
  PR_DETAIL_QUERY,
  REPLY_MUTATION,
  ALERTS_NEW,
  ALERTS_SEEN,
  WATCH_QUERY,
  diffWatch,
  toDetail,
  toFiles,
  toList,
  toWatched,
  type Alert,
  type RawDetail,
  type RawSearch,
  type RestFile,
  type RawWatchPr,
  type WatchState,
} from "./prs";

const stackSchema = z.object({ number: z.number(), title: z.string(), url: z.string() }).nullable();
const prSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
  author: z.string(),
  baseRefName: z.string(),
  onDefaultBranch: z.boolean(),
  stackedOn: stackSchema,
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  ci: z.enum(["passing", "failing", "pending", "none"]),
  failingChecks: z.array(
    z.object({ name: z.string(), workflow: z.string().nullable(), url: z.string().nullable() }),
  ),
  unresolvedThreads: z.number(),
  reviewDecision: z.string().nullable(),
  conflicts: z.boolean(),
  blockers: z.array(z.string()),
});
const listSchema = z.object({ total: z.number(), items: z.array(prSchema) });

const commentSchema = z.object({
  author: z.string(),
  avatarUrl: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
const detailSchema = z.object({
  id: z.string(),
  viewer: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string().nullable(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  onDefaultBranch: z.boolean(),
  stackedOn: stackSchema,
  changedFiles: z.number(),
  additions: z.number(),
  deletions: z.number(),
  pendingReviewId: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  conflicts: z.boolean(),
  timeline: z.array(commentSchema.extend({ reviewState: z.string().nullable() })),
  threads: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      side: z.enum(["LEFT", "RIGHT"]),
      startLine: z.number().nullable(),
      isPending: z.boolean(),
      line: z.number().nullable(),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      resolvedBy: z.string().nullable(),
      diffHunk: z.string().nullable(),
      comments: z.array(commentSchema),
      awaitingReply: z.boolean(),
    }),
  ),
  checks: z.array(
    z.object({
      name: z.string(),
      workflow: z.string().nullable(),
      status: z.enum(["failing", "pending", "passing", "skipped"]),
      conclusion: z.string().nullable(),
      url: z.string().nullable(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
      annotations: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable(),
          level: z.string().nullable(),
          message: z.string(),
        }),
      ),
    }),
  ),
});

const alertSchema = z.object({
  id: z.string(),
  kind: z.enum(["ci", "comment", "test"]),
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  headline: z.string(),
  detail: z.string(),
  at: z.string(),
  seen: z.boolean(),
});
const alertsSchema = z.object({ alerts: z.array(alertSchema), unread: z.number() });

const prRef = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name"),
    number: z.number().int().positive(),
  })
  .strict();
// GitHub GraphQL node ids are short base64-ish strings.
const nodeId = z.string().regex(/^[A-Za-z0-9_=-]{1,100}$/, "Expected a GitHub node id");
const commentBody = z.string().trim().min(1, "Write something first").max(65_000, "GitHub comments are limited to about 65,000 characters");

export const rpcContract = defineRpcContract({
  prs_list: {
    input: z.null(),
    output: z.object({
      open: listSchema,
      review: listSchema,
      assigned: listSchema,
      merged: listSchema,
      closed: listSchema,
      fetchedAt: z.string(),
    }),
  },
  pr_detail: { input: prRef, output: detailSchema },
  pr_files: {
    input: prRef,
    output: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          previousPath: z.string().nullable(),
          status: z.string(),
          additions: z.number(),
          deletions: z.number(),
          patch: z.string().nullable(),
        }),
      ),
    }),
  },
  pr_reply: {
    input: z.object({ threadId: nodeId, body: commentBody }).strict(),
    output: z.object({ url: z.string(), pending: z.boolean() }),
  },
  pr_comment: {
    input: z.object({ subjectId: nodeId, body: commentBody }).strict(),
    output: z.object({ url: z.string() }),
  },
  pr_line_comment: {
    input: z
      .object({
        prId: nodeId,
        reviewId: nodeId.nullable(),
        path: z.string().min(1).max(1000).regex(/^[^\u0000-\u001f\u007f]+$/, "Invalid file path"),
        line: z.number().int().positive(),
        side: z.enum(["LEFT", "RIGHT"]),
        // A multi-line comment: both ends together, the start above the end.
        startLine: z.number().int().positive().optional(),
        startSide: z.enum(["LEFT", "RIGHT"]).optional(),
        body: commentBody,
        mode: z.enum(["review", "single"]),
      })
      .strict()
      .refine((v) => (v.startLine === undefined) === (v.startSide === undefined), "Send both startLine and startSide, or neither")
      .refine((v) => v.startLine === undefined || v.startSide !== v.side || v.startLine < v.line, "A range must start above where it ends"),
    output: z.object({ pending: z.boolean() }),
  },
  pr_discard_review: {
    input: z.object({ reviewId: nodeId }).strict(),
    output: z.object({ discarded: z.boolean() }),
  },
  pr_submit_review: {
    input: z
      .object({
        prId: nodeId,
        reviewId: nodeId.nullable(),
        event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
        body: z.string().trim().max(65_000),
      })
      .strict(),
    output: z.object({ url: z.string(), state: z.string() }),
  },
  pr_set_state: {
    input: z.object({ prId: nodeId, action: z.enum(["close", "reopen"]) }).strict(),
    output: z.object({ state: z.string() }),
  },
  alerts_list: { input: z.null(), output: alertsSchema },
  alerts_mark_seen: { input: z.null(), output: alertsSchema },
  alerts_test: { input: z.null(), output: alertsSchema },
});

const MAX_ALERTS = 50;

/** Resolves after `ms`, or at once when the service is told to stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const GH_MISSING =
  "GitHub CLI (gh) was not found. Install it from https://cli.github.com and run `gh auth login`, or set a GitHub token in this plugin's settings.";
const GH_LOGGED_OUT =
  "GitHub CLI is not logged in. Run `gh auth login` (or `gh auth refresh -h github.com`), or set a GitHub token in this plugin's settings.";

function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        timeout: 10_000,
        // bb.app launched from the Dock may not have Homebrew on PATH.
        env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` },
      },
      (error, stdout) => {
        const token = stdout.trim();
        if (error === null && token !== "") return resolve(token);
        const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
        reject(new experimental_PluginRpcRefusal({
          code: "forbidden",
          message: missing ? GH_MISSING : GH_LOGGED_OUT,
        }));
      },
    );
  });
}

interface GraphqlResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    token: {
      type: "string",
      label: "GitHub token (optional)",
      description:
        "Leave empty to use the GitHub CLI login on this machine. Otherwise a token with `repo` scope (classic), or Pull requests read and write plus Checks read (fine-grained); authorize it for SSO orgs. Write access is only used when you comment, reply, review, close or reopen.",
      secret: true,
    },
    notifyCi: {
      type: "boolean",
      label: "Notify when CI starts failing",
      description: "Once per job that turns red on one of your open PRs.",
      default: true,
    },
    notifyComments: {
      type: "boolean",
      label: "Notify on new comments and reviews",
      description: "From anyone but you; GitHub bot accounts are skipped.",
      default: true,
    },
    showToasts: {
      type: "boolean",
      label: "Show alerts as bb toasts",
      default: true,
    },
    showDesktop: {
      type: "boolean",
      label: "Show desktop notifications",
      description: "Also needs this window's permission: use Enable desktop notifications below.",
      default: true,
    },
    showBadge: {
      type: "boolean",
      label: "Show the unread count on My PRs",
      default: true,
    },
    ignoreAuthors: {
      type: "string",
      label: "Never notify for comments from",
      description: "Comma-separated GitHub logins, for review bots that use normal accounts.",
      default: "",
    },
    checkEveryMinutes: {
      type: "number",
      label: "Check every (minutes)",
      experimental_schema: z.number().int().min(1).max(60),
      default: 5,
    },
  });

  async function auth(): Promise<{ token: string; fromSetting: boolean }> {
    const configured = (await settings.get()).token;
    const fromSetting = typeof configured === "string" && configured.trim() !== "";
    return { token: fromSetting ? configured.trim() : await ghToken(), fromSetting };
  }

  /** Every GitHub call, REST or GraphQL, goes through here so auth and errors stay in one place. */
  async function github(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const { token, fromSetting } = await auth();
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "bb-github-pr-dashboard",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) {
      throw new experimental_PluginRpcRefusal({
        code: "forbidden",
        message: fromSetting
          ? "GitHub rejected the token in this plugin's settings. Update or clear it."
          : GH_LOGGED_OUT,
      });
    }
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    return res;
  }

  async function graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    { mutation = false }: { mutation?: boolean } = {},
  ): Promise<T> {
    const res = await github("/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
    const body = (await res.json()) as GraphqlResponse<T>;
    // A failed write often still returns data ({ addComment: null }), so any error fails a mutation.
    const message = body.errors?.[0]?.message ?? "GitHub returned no data";
    // An expected refusal (locked thread, no permission) is not a plugin failure.
    if (mutation && body.errors?.length) throw new experimental_PluginRpcRefusal({ code: "invalid", message });
    if (body.data == null) throw new Error(message);
    // Partial errors on reads (e.g. an SSO org the token cannot see) still return data.
    if (body.errors?.length) bb.log.warn(`GitHub partial result: ${body.errors[0]!.message}`);
    return body.data;
  }

  async function readAlerts(): Promise<Alert[]> {
    return (await bb.storage.kv.get<Alert[]>("alerts")) ?? [];
  }
  const summary = (alerts: Alert[]) => ({ alerts, unread: alerts.filter((a) => !a.seen).length });

  // kv is the source of truth: a closed window catches up from it on next open.
  async function addAlerts(alerts: Alert[]) {
    const stored = await readAlerts();
    const known = new Set(stored.map((a) => a.id));
    const fresh = alerts.filter((a) => !known.has(a.id));
    if (fresh.length === 0) return;
    await bb.storage.kv.set("alerts", [...fresh, ...stored].slice(0, MAX_ALERTS));
    bb.realtime.publish(ALERTS_NEW, { alerts: fresh });
  }

  async function pollOnce() {
    const s = await settings.get();
    if (!s.notifyCi && !s.notifyComments) {
      await bb.storage.kv.delete("watch"); // turning back on starts from a fresh baseline
      return;
    }
    const ignore = new Set(s.ignoreAuthors.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
    const data = await graphql<{ viewer: { login: string }; open: { nodes: (RawWatchPr | Record<string, never>)[] } }>(WATCH_QUERY);
    const prs = data.open.nodes.filter((n): n is RawWatchPr => "url" in n).map((n) => toWatched(n, ignore));
    // Keyed by account: switching gh accounts must not look like new failures.
    const saved = await bb.storage.kv.get<{ login: string; state: Record<string, WatchState> }>("watch");
    const prev = saved?.login === data.viewer.login ? saved.state : null;
    const { alerts, next } = diffWatch(prev, prs, new Date().toISOString(), { ci: s.notifyCi, comments: s.notifyComments });
    await bb.storage.kv.set("watch", { login: data.viewer.login, state: next });
    if (prev === null) bb.log.info(`Watching ${prs.length} open PRs for ${data.viewer.login} (new baseline)`);
    if (alerts.length > 0) bb.log.info(`${alerts.length} new PR alert(s)`);
    await addAlerts(alerts);
  }

  bb.background.service("watch", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await pollOnce();
        } catch (cause) {
          // Logged, not thrown: a logged-out gh must not disable the plugin.
          bb.log.warn(`PR watch skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        await sleep((await settings.get()).checkEveryMinutes * 60_000, signal);
      }
    },
  });

  bb.rpc.register(rpcContract, {
    prs_list: async () => {
      const data = await graphql<Record<"open" | "review" | "assigned" | "merged" | "closed", RawSearch>>(PRS_QUERY);
      return {
        open: toList(data.open),
        review: toList(data.review),
        assigned: toList(data.assigned),
        merged: toList(data.merged),
        closed: toList(data.closed),
        fetchedAt: new Date().toISOString(),
      };
    },
    pr_detail: async ({ repo, number }) => {
      const [owner, name] = repo.split("/");
      const data = await graphql<{ viewer: { login: string }; repository: { pullRequest: RawDetail | null } | null }>(
        PR_DETAIL_QUERY,
        { owner, name, number },
      );
      const pr = data.repository?.pullRequest;
      if (!pr) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: `${repo}#${number} not found` });
      }
      return toDetail(pr, data.viewer.login);
    },
    pr_files: async ({ repo, number }) => {
      // shortcut: first 100 files (one REST page); paginate if PRs this large need it.
      const res = await github(`/repos/${repo}/pulls/${number}/files?per_page=100`);
      return { files: toFiles((await res.json()) as RestFile[]) };
    },
    pr_reply: async ({ threadId, body }) => {
      const data = await graphql<{ addPullRequestReviewThreadReply: { comment: { url: string; state: string } | null } | null }>(
        REPLY_MUTATION,
        { threadId, body },
        { mutation: true },
      );
      const comment = data.addPullRequestReviewThreadReply?.comment;
      if (!comment) throw new Error("GitHub did not post the reply");
      // With an unsubmitted review open, the reply joins it and stays hidden until submitted.
      return { url: comment.url, pending: comment.state === "PENDING" };
    },
    pr_comment: async ({ subjectId, body }) => {
      const data = await graphql<{ addComment: { commentEdge: { node: { url: string } } | null } | null }>(
        COMMENT_MUTATION,
        { subjectId, body },
        { mutation: true },
      );
      const url = data.addComment?.commentEdge?.node.url;
      if (!url) throw new Error("GitHub did not post the comment");
      return { url };
    },
    pr_line_comment: async ({ prId, reviewId, path, line, side, startLine, startSide, body, mode }) => {
      const range = startLine !== undefined && startSide !== undefined;
      const thread = { path, line, side, body, ...(range ? { startLine, startSide } : {}) };
      if (mode === "single" && reviewId) {
        // GitHub allows one pending review per PR; a single comment would need a second.
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Finish your pending review first, or add this as a review comment." });
      }
      if (reviewId) {
        await graphql(reviewAddThreadMutation(range), { reviewId, ...thread }, { mutation: true });
        return { pending: true };
      }
      const data = await graphql<{ addPullRequestReview: { pullRequestReview: { state: string } | null } | null }>(
        reviewStartMutation(range),
        { prId, ...thread, event: mode === "single" ? "COMMENT" : null },
        { mutation: true },
      );
      const review = data.addPullRequestReview?.pullRequestReview;
      if (!review) throw new Error("GitHub did not save the comment");
      return { pending: review.state === "PENDING" };
    },
    pr_submit_review: async ({ prId, reviewId, event, body }) => {
      if (!canSubmitReview(event, body, reviewId ? 1 : 0)) {
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message: event === "REQUEST_CHANGES" ? "Say what needs to change." : "Write a comment or add line comments first.",
        });
      }
      const data = await graphql<Record<string, { pullRequestReview: { url: string; state: string } | null } | null>>(
        reviewId ? REVIEW_SUBMIT_PENDING_MUTATION : REVIEW_SUBMIT_NEW_MUTATION,
        reviewId ? { reviewId, event, body: body || null } : { prId, event, body: body || null },
        { mutation: true },
      );
      const review = Object.values(data)[0]?.pullRequestReview;
      if (!review) throw new Error("GitHub did not submit the review");
      return { url: review.url, state: review.state };
    },
    pr_discard_review: async ({ reviewId }) => {
      const data = await graphql<{ deletePullRequestReview: { pullRequestReview: { id: string } | null } | null }>(
        REVIEW_DISCARD_MUTATION,
        { reviewId },
        { mutation: true },
      );
      if (!data.deletePullRequestReview?.pullRequestReview) throw new Error("GitHub did not discard the review");
      return { discarded: true };
    },
    pr_set_state: async ({ prId, action }) => {
      const data = await graphql<Record<string, { pullRequest: { state: string } | null } | null>>(
        action === "close" ? CLOSE_PR_MUTATION : REOPEN_PR_MUTATION,
        { prId },
        { mutation: true },
      );
      const pr = Object.values(data)[0]?.pullRequest;
      if (!pr) throw new Error(`GitHub did not ${action} the pull request`);
      return { state: pr.state };
    },
    alerts_list: async () => summary(await readAlerts()),
    alerts_mark_seen: async () => {
      const alerts = (await readAlerts()).map((a) => ({ ...a, seen: true }));
      await bb.storage.kv.set("alerts", alerts);
      bb.realtime.publish(ALERTS_SEEN, {});
      return summary(alerts);
    },
    alerts_test: async () => {
      const at = new Date().toISOString();
      await addAlerts([{
        id: `test:${at}`, kind: "test", repo: "", number: 0, url: "", seen: false, at,
        headline: "Test alert from GitHub PR Dashboard",
        detail: "This is how CI failures and new comments on your PRs will reach you.",
      }]);
      return summary(await readAlerts());
    },
  });
}
