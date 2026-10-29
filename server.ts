// bb-github-pr-dashboard — backend entry.
//
// `prs_list` runs one GitHub GraphQL query for the user's open,
// merged and closed PRs; `pr_detail` fetches one PR's threads, conversation and
// checks. Auth comes from the optional `token` setting, else
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
  PRS_QUERY,
  PR_DETAIL_QUERY,
  toDetail,
  toList,
  type RawDetail,
  type RawSearch,
} from "./prs";

const prSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
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
  reviewDecision: z.string().nullable(),
  conflicts: z.boolean(),
  timeline: z.array(commentSchema.extend({ reviewState: z.string().nullable() })),
  threads: z.array(
    z.object({
      path: z.string(),
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

export const rpcContract = defineRpcContract({
  prs_list: {
    input: z.null(),
    output: z.object({
      open: listSchema,
      merged: listSchema,
      closed: listSchema,
      fetchedAt: z.string(),
    }),
  },
  pr_detail: {
    input: z
      .object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name"),
        number: z.number().int().positive(),
      })
      .strict(),
    output: detailSchema,
  },
});

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
        "Leave empty to use the GitHub CLI login on this machine. Otherwise a token with `repo` scope (classic) or Pull requests + Checks read (fine-grained); authorize it for SSO orgs.",
      secret: true,
    },
  });

  async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const configured = (await settings.get()).token;
    const fromSetting = typeof configured === "string" && configured.trim() !== "";
    const token = fromSetting ? configured.trim() : await ghToken();
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "bb-github-pr-dashboard",
      },
      body: JSON.stringify({ query, variables }),
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
    const body = (await res.json()) as GraphqlResponse<T>;
    // Partial errors (e.g. an SSO org the token cannot see) still return data.
    if (body.data == null) {
      throw new Error(body.errors?.[0]?.message ?? "GitHub returned no data");
    }
    if (body.errors?.length) bb.log.warn(`GitHub partial result: ${body.errors[0]!.message}`);
    return body.data;
  }

  bb.rpc.register(rpcContract, {
    prs_list: async () => {
      const data = await graphql<{ open: RawSearch; merged: RawSearch; closed: RawSearch }>(PRS_QUERY);
      return {
        open: toList(data.open),
        merged: toList(data.merged),
        closed: toList(data.closed),
        fetchedAt: new Date().toISOString(),
      };
    },
    pr_detail: async ({ repo, number }) => {
      const [owner, name] = repo.split("/");
      const data = await graphql<{ repository: { pullRequest: RawDetail | null } | null }>(
        PR_DETAIL_QUERY,
        { owner, name, number },
      );
      const pr = data.repository?.pullRequest;
      if (!pr) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: `${repo}#${number} not found` });
      }
      return toDetail(pr);
    },
  });
}
