// The detail view for one PR: CI checks, review threads and the conversation.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Markdown, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { CheckDetail, Comment, Pr, PrDetail, Thread, TimelineEntry } from "./prs";
import {
  Avatar,
  EmptyState,
  Pill,
  Segmented,
  Skeleton,
  TONE_TEXT,
  ago,
  blockerTone,
  prState,
  type Tone,
} from "./parts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Survives remounts so a resize or coming back shows the last result at once.
const cachedDetails = new Map<string, PrDetail>();

const CONCLUSION: Record<string, string> = {
  FAILURE: "Failed",
  TIMED_OUT: "Timed out",
  CANCELLED: "Cancelled",
  ACTION_REQUIRED: "Action required",
  STARTUP_FAILURE: "Startup failure",
  ERROR: "Error",
};
const STATUS: Record<CheckDetail["status"], { icon: string; tone: Tone; bar: string }> = {
  failing: { icon: "CircleX", tone: "bad", bar: "bg-destructive" },
  pending: { icon: "Clock", tone: "warn", bar: "bg-warning" },
  passing: { icon: "CircleCheck", tone: "good", bar: "bg-success" },
  skipped: { icon: "Minus", tone: "neutral", bar: "bg-muted-foreground/30" },
};
const REVIEW: Record<string, { verb: string; tone: Tone; icon: string }> = {
  APPROVED: { verb: "approved these changes", tone: "good", icon: "CircleCheck" },
  CHANGES_REQUESTED: { verb: "requested changes", tone: "bad", icon: "FileDiff" },
  COMMENTED: { verb: "reviewed", tone: "neutral", icon: "Eye" },
  DISMISSED: { verb: "had a review dismissed", tone: "neutral", icon: "Eye" },
};

/** Markdown from GitHub, kept inside its column (wide code blocks scroll). */
function Body({ content }: { content: string }) {
  return (
    <div className="min-w-0 overflow-x-auto break-words text-sm [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
      <Markdown content={content} />
    </div>
  );
}

// ---- Checks ----

function checkName(c: CheckDetail) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium">{c.name}</span>
      {c.workflow ? <span className="block truncate text-xs text-muted-foreground">{c.workflow}</span> : null}
    </span>
  );
}

function CheckBar({ checks }: { checks: CheckDetail[] }) {
  const order: CheckDetail["status"][] = ["failing", "pending", "passing", "skipped"];
  const counts = order.map((s) => [s, checks.filter((c) => c.status === s).length] as const);
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {counts.map(([s, n]) =>
          n > 0 ? <div key={s} className={STATUS[s].bar} style={{ width: `${(n / checks.length) * 100}%` }} /> : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {counts.map(([s, n]) => (
          <span key={s} className={cn("inline-flex items-center gap-1", n > 0 ? TONE_TEXT[STATUS[s].tone] : "text-muted-foreground")}>
            <Icon name={STATUS[s].icon} className="size-3.5" aria-hidden />
            {n} {s === "pending" ? "running" : s === "passing" ? "passed" : s}
          </span>
        ))}
      </div>
    </div>
  );
}

function AttentionCheck({ check }: { check: CheckDetail }) {
  const failing = check.status === "failing";
  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-border border-l-4 bg-card p-3",
        failing ? "border-l-destructive" : "border-l-warning",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          name={STATUS[check.status].icon}
          className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[STATUS[check.status].tone])}
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">{checkName(check)}</div>
        <Pill tone={failing ? "bad" : "warn"}>
          {failing ? (CONCLUSION[check.conclusion ?? ""] ?? "Failed") : "Running"}
        </Pill>
      </div>
      {check.title ? <p className="text-sm text-muted-foreground">{check.title}</p> : null}
      {check.annotations.length > 0 ? (
        <ul className="space-y-1.5 rounded-lg bg-muted/50 p-2.5 font-mono text-xs">
          {check.annotations.map((a, i) => (
            <li key={i} className="flex gap-2">
              <Icon
                name={a.level === "WARNING" ? "AlertTriangle" : "CircleX"}
                className={cn("mt-0.5 size-3 shrink-0", a.level === "WARNING" ? "text-warning-text" : "text-destructive")}
                aria-hidden
              />
              <span className="min-w-0 break-words">
                <span className="text-muted-foreground">
                  {a.path}
                  {a.line ? `:${a.line}` : ""}
                </span>{" "}
                {a.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {check.summary ? (
        <details className="group">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
            Show summary
          </summary>
          <div className="mt-2">
            <Body content={check.summary} />
          </div>
        </details>
      ) : null}
      {check.url ? (
        <UrlLink
          href={check.url}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
        >
          View logs
          <Icon name="ExternalLink" className="size-3" aria-hidden />
        </UrlLink>
      ) : null}
    </div>
  );
}

function ChecksTab({ checks }: { checks: CheckDetail[] }) {
  if (checks.length === 0) return <EmptyState icon="CircleCheck">No CI checks reported for this PR.</EmptyState>;
  const attention = checks.filter((c) => c.status === "failing" || c.status === "pending");
  const rest = checks.filter((c) => c.status === "passing" || c.status === "skipped");
  return (
    <div className="space-y-3">
      <CheckBar checks={checks} />
      {attention.map((c, i) => (
        <AttentionCheck key={`${c.workflow}-${c.name}-${i}`} check={c} />
      ))}
      {rest.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rest.map((c, i) => (
            <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-sm">
              <Icon name={STATUS[c.status].icon} className={cn("size-4 shrink-0", TONE_TEXT[STATUS[c.status].tone])} aria-hidden />
              <div className="min-w-0 flex-1">{checkName(c)}</div>
              {c.url ? (
                <UrlLink href={c.url} aria-label={`Open ${c.name}`} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Icon name="ExternalLink" className="size-3.5" />
                </UrlLink>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- Review threads ----

function CommentBlock({ comment, children }: { comment: Comment; children?: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <Avatar login={comment.author} url={comment.avatarUrl} size={24} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          <span className="font-semibold">{comment.author}</span>
          {children}
          <UrlLink href={comment.url} className="text-muted-foreground hover:underline">
            {ago(comment.createdAt)}
          </UrlLink>
        </div>
        {comment.body.trim() ? <Body content={comment.body} /> : null}
      </div>
    </div>
  );
}

function Hunk({ hunk }: { hunk: string }) {
  return (
    <pre className="overflow-x-auto border-b border-border bg-muted/30 py-1 font-mono text-xs leading-5">
      {hunk.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3",
            line.startsWith("+") && "bg-success/10",
            line.startsWith("-") && "bg-destructive/10",
            line.startsWith("@@") && "text-muted-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function ThreadCard({ thread, me }: { thread: Thread; me: string }) {
  const parts = thread.path.split("/");
  const file = parts.pop();
  const status = thread.isResolved ? (
    <Pill tone="good" icon="CircleCheck">
      Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy === me ? "you" : thread.resolvedBy}` : ""}
    </Pill>
  ) : thread.awaitingReply ? (
    <Pill tone="warn" icon="Clock">
      Waiting on your reply
    </Pill>
  ) : (
    <Pill tone="neutral" icon="ArrowTurnBackward">
      You replied
    </Pill>
  );
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <Icon name="File" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {/* The folder gives way first so the file name and line stay readable. */}
        <span className="flex min-w-[10rem] flex-1 font-mono text-xs" title={thread.path}>
          <span className="min-w-0 shrink-[100] truncate text-muted-foreground">
            {parts.length > 0 ? `${parts.join("/")}/` : ""}
          </span>
          <span className="min-w-0 truncate font-semibold">{file}</span>
          {thread.line ? <span className="shrink-0 text-muted-foreground">:{thread.line}</span> : null}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {thread.isOutdated ? <Pill tone="neutral">Outdated</Pill> : null}
          {status}
        </span>
      </header>
      {thread.diffHunk ? <Hunk hunk={thread.diffHunk} /> : null}
      <div className="space-y-4 p-3">
        {thread.comments.map((c, i) => (
          <CommentBlock key={i} comment={c} />
        ))}
        {thread.comments[0] ? (
          <UrlLink
            href={thread.comments[0].url}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            Reply on GitHub
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        ) : null}
      </div>
    </article>
  );
}

type ThreadFilter = "unresolved" | "resolved";

function ThreadsTab({ threads, me }: { threads: Thread[]; me: string }) {
  const open = threads.filter((t) => !t.isResolved);
  const resolved = threads.filter((t) => t.isResolved);
  const [filter, setFilter] = useState<ThreadFilter>(open.length > 0 ? "unresolved" : "resolved");
  if (threads.length === 0) return <EmptyState icon="MessageSquare">No review comments on this PR.</EmptyState>;
  const shown = filter === "unresolved" ? open : resolved;
  const waiting = open.filter((t) => t.awaitingReply).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Thread status"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "unresolved", label: "Unresolved", count: open.length, countTone: open.length > 0 ? "bad" : "neutral" },
            { id: "resolved", label: "Resolved", count: resolved.length },
          ]}
        />
        {waiting > 0 ? (
          <span className="text-xs text-warning-text">
            {waiting} waiting on your reply
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState icon="CircleCheck">{filter === "unresolved" ? "Every thread is resolved." : "No resolved threads yet."}</EmptyState>
      ) : (
        shown.map((t, i) => <ThreadCard key={`${filter}-${i}`} thread={t} me={me} />)
      )}
    </div>
  );
}

// ---- Conversation ----

function ConversationTab({ timeline, prUrl }: { timeline: TimelineEntry[]; prUrl: string }) {
  if (timeline.length === 0) return <EmptyState icon="MessageSquare">No comments yet.</EmptyState>;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-border">
      {timeline.map((entry, i) => {
        const review = entry.reviewState ? REVIEW[entry.reviewState] : undefined;
        return (
          <li key={i} className="relative flex gap-3">
            <span className="relative z-10 rounded-full ring-4 ring-background">
              <Avatar login={entry.author} url={entry.avatarUrl} size={32} />
            </span>
            <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border bg-muted/40 px-3 py-2 text-xs">
                <span className="font-semibold">{entry.author}</span>
                {review ? (
                  <span className={cn("inline-flex items-center gap-1", TONE_TEXT[review.tone])}>
                    <Icon name={review.icon} className="size-3.5" aria-hidden />
                    {review.verb}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{entry.url === prUrl ? "opened this pull request" : "commented"}</span>
                )}
                <UrlLink href={entry.url} className="text-muted-foreground hover:underline">
                  {ago(entry.createdAt)}
                </UrlLink>
              </div>
              {entry.body.trim() ? (
                <div className="p-3">
                  <Body content={entry.body} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---- Page ----

type DetailTab = "checks" | "threads" | "conversation";

function firstTab(d: PrDetail): DetailTab {
  if (d.checks.some((c) => c.status === "failing" || c.status === "pending")) return "checks";
  if (d.threads.some((t) => !t.isResolved)) return "threads";
  return "conversation";
}

export function PrDetailView({
  repo,
  number,
  summary,
  onBack,
}: {
  repo: string;
  number: number;
  /** The row from the list, for its blockers; absent on a cold deep link. */
  summary: Pr | undefined;
  onBack: () => void;
}) {
  const key = `${repo}#${number}`;
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<PrDetail | null>(cachedDetails.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<DetailTab | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    rpc
      .call("pr_detail", { repo, number })
      .then(
        (result) => {
          cachedDetails.set(key, result);
          setDetail(result);
          setError(null);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false));
  }, [rpc, repo, number, key]);
  useEffect(load, [load]);

  const state = prState(detail ?? summary ?? { isDraft: false });
  const blockers = summary?.blockers ?? [];
  const activeTab = tab ?? (detail ? firstTab(detail) : "checks");
  const failing = detail?.checks.filter((c) => c.status === "failing").length ?? 0;
  const unresolved = detail?.threads.filter((t) => !t.isResolved).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <Icon name="ArrowLeft" className="size-4" />
          All PRs
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Refresh" disabled={loading} onClick={load}>
            <Icon name="RotateCcw" className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <UrlLink
            href={`https://github.com/${repo}/pull/${number}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
          >
            <Icon name="Github" className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Open on GitHub</span>
            <span className="sm:hidden">GitHub</span>
          </UrlLink>
        </div>
      </div>

      <header className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill tone={state.tone} icon={state.icon}>
            {state.label}
          </Pill>
          <span className="truncate">
            {repo}
            <span className="tabular-nums">#{number}</span>
          </span>
        </div>
        <h2 className="text-lg font-semibold leading-snug">{detail?.title ?? summary?.title ?? key}</h2>
        {detail ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Avatar login={detail.author} url={detail.authorAvatarUrl} size={18} />
              <span className="font-medium text-foreground">{detail.author}</span>
            </span>
            <span>
              {state.label === "Merged" ? "merged" : state.label === "Closed" ? "wanted to merge" : "wants to merge"}
            </span>
            <code className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title={detail.headRefName}>
              {detail.headRefName}
            </code>
            <Icon name="ArrowRight" className="size-3" aria-hidden />
            <code className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title={detail.baseRefName}>
              {detail.baseRefName}
            </code>
          </div>
        ) : null}
        {blockers.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {blockers.map((b) => (
              <Pill key={b} tone={blockerTone(b)}>
                {b}
              </Pill>
            ))}
          </div>
        ) : null}
      </header>

      {error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {detail === null ? (
        error ? null : <Skeleton rows={3} />
      ) : (
        <>
          <Segmented
            label="Pull request details"
            value={activeTab}
            onChange={setTab}
            options={[
              { id: "checks", label: "Checks", icon: "CircleCheck", count: detail.checks.length, countTone: failing > 0 ? "bad" : "neutral" },
              { id: "threads", label: "Comments", icon: "MessageSquare", count: unresolved, countTone: unresolved > 0 ? "bad" : "neutral" },
              { id: "conversation", label: "Conversation", icon: "UserRound", count: detail.timeline.length },
            ]}
          />
          {activeTab === "checks" ? <ChecksTab checks={detail.checks} /> : null}
          {activeTab === "threads" ? <ThreadsTab threads={detail.threads} me={detail.author} /> : null}
          {activeTab === "conversation" ? <ConversationTab timeline={detail.timeline} prUrl={detail.url} /> : null}
        </>
      )}
    </div>
  );
}
