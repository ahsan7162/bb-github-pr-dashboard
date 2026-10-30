// The detail view for one PR: CI checks, changed files (with line comments and
// review submission), review threads (with replies), the conversation (with a
// comment box), and closing or reopening the PR.
import { Component, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Markdown, UrlLink, experimental_useCodeTheme, useRpc } from "@get-bb/plugin-sdk/app";
import { PatchDiff, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import type { rpcContract } from "./server";
import {
  canSubmitReview,
  fullPatch,
  parsePatch,
  rangeFromSelection,
  reviewEvents,
  toViewerSide,
  threadStatus,
  type CommentRange,
  type ReviewEvent,
  type CheckDetail, type Comment, type Pr, type PrDetail, type PrFile, type Thread, type TimelineEntry } from "./prs";
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
/** "12" for one line, "10–12" for a multi-line comment. */
const lineLabel = (t: Thread) => (t.startLine && t.startLine !== t.line ? `${t.startLine}–${t.line}` : t.line);

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

/** A file path whose folder gives way first, so the file name stays readable. */
function PathLabel({ path, line, className }: { path: string; line?: number | string | null; className?: string }) {
  const parts = path.split("/");
  const file = parts.pop();
  return (
    <span className={cn("flex min-w-0 font-mono text-xs", className)} title={path}>
      <span className="min-w-0 shrink-[100] truncate text-muted-foreground">{parts.length > 0 ? `${parts.join("/")}/` : ""}</span>
      <span className="min-w-0 truncate font-semibold">{file}</span>
      {line ? <span className="shrink-0 text-muted-foreground">:{line}</span> : null}
    </span>
  );
}

/** A comment box: keeps the draft until GitHub confirms, and blocks double sends. */
interface ComposerAction {
  label: string;
  onSubmit: (body: string) => Promise<void>;
}

/** A comment box: keeps the draft until GitHub confirms, and blocks double sends. ⌘↵ runs the first action. */
function Composer({
  label,
  placeholder,
  actions,
  onCancel,
  autoFocus,
}: {
  label: string;
  placeholder: string;
  actions: ComposerAction[];
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (action: ComposerAction) => {
    const body = draft.trim();
    if (body === "" || sending) return;
    setSending(action.label);
    setError(null);
    try {
      await action.onSubmit(body);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="space-y-2">
      <textarea
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(actions[0]!);
          }
        }}
        placeholder={placeholder}
        rows={3}
        autoFocus={autoFocus}
        disabled={sending !== null}
        className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Markdown · ⌘↵ to send · posts as you on GitHub</span>
        <div className="ml-auto flex gap-2">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={sending !== null}>
              Cancel
            </Button>
          ) : null}
          {actions.map((a, i) => (
            <Button
              key={a.label}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              onClick={() => void send(a)}
              disabled={sending !== null || draft.trim() === ""}
            >
              {sending === a.label ? "Saving…" : a.label}
            </Button>
          ))}
        </div>
      </div>
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

// ---- Changed files ----

const FILE_ICON: Record<string, { name: string; className: string }> = {
  added: { name: "DiffAdded", className: "text-success" },
  removed: { name: "DiffRemoved", className: "text-destructive" },
  renamed: { name: "DiffRenamed", className: "text-muted-foreground" },
};
const cachedFiles = new Map<string, PrFile[]>();

/** What a file needs to take line comments into your review. */
interface ReviewContext {
  prId: string;
  prUrl: string;
  pendingReviewId: string | null;
  /** All review threads: published ones and your drafts both show under their lines. */
  threads: Thread[];
  viewer: string;
  author: string;
  onSaved: () => void;
}

export type DiffView = "inline" | "split";

const VIEW_KEY = "bb-github-pr-dashboard:diff-view";
const savedView = (): DiffView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
};


/** "line 5", "lines 3–6", or GitHub's "lines −24 to +24" when a range crosses from old to new. */
function rangeText(range: CommentRange): string {
  if (!range.start) return `line ${range.line}`;
  if (range.start.side === range.side) return `lines ${range.start.line}–${range.line}`;
  const mark = (side: "LEFT" | "RIGHT", line: number) => `${side === "LEFT" ? "−" : "+"}${line}`;
  return `lines ${mark(range.start.side, range.start.line)} to ${mark(range.side, range.line)}`;
}

/** Keeps one unrenderable diff from taking down the whole page. */
class DiffBoundary extends Component<{ children: ReactNode; url: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        This diff could not be shown here.{" "}
        <UrlLink href={this.props.url} className="underline">
          Open it on GitHub
        </UrlLink>
        .
      </p>
    );
  }
}

/** What an annotation under one line carries: the threads anchored there, and whether the comment box is open. */
interface LineNote {
  threadIds: string[];
  composer: boolean;
}

function FileDiff({
  file,
  defaultOpen,
  review,
  view,
  codeTheme,
}: {
  file: PrFile;
  defaultOpen: boolean;
  review: ReviewContext;
  view: DiffView;
  codeTheme: { name: string; mode: "dark" | "light" };
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(defaultOpen);
  const [range, setRange] = useState<CommentRange | null>(null);
  const rows = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const fileThreads = review.threads.filter((t) => t.path === file.path && (t.isPending || !t.isOutdated));
  const draftCount = fileThreads.filter((t) => t.isPending).length;
  const openCount = fileThreads.filter((t) => !t.isPending && !t.isResolved).length;
  const icon = FILE_ICON[file.status] ?? { name: "DiffModified", className: "text-warning-text" };

  // Clicking the gutter +, or selecting line numbers (click, Shift-click, drag), opens the comment box.
  const pick = (selection: SelectedLineRange | null) => {
    if (!selection) return;
    const next = rangeFromSelection(rows, selection);
    if (next) setRange(next);
    else toast.error("A comment can only cover lines inside one hunk of the diff.");
  };
  const save = (target: CommentRange, mode: "review" | "single") => async (body: string) => {
    const result = await rpc.call("pr_line_comment", {
      prId: review.prId,
      reviewId: review.pendingReviewId,
      path: file.path,
      side: target.side,
      line: target.line,
      ...(target.start ? { startLine: target.start.line, startSide: target.start.side } : {}),
      body,
      mode,
    });
    setRange(null);
    if (result.pending) toast.success("Added to your review", { description: "Only you can see it until you finish your review." });
    else toast.success("Comment posted");
    review.onSaved();
  };

  const notes = useMemo(() => {
    const byLine = new Map<string, DiffLineAnnotation<LineNote>>();
    const at = (side: "LEFT" | "RIGHT", line: number) => {
      const key = `${side}:${line}`;
      if (!byLine.has(key)) byLine.set(key, { side: toViewerSide(side), lineNumber: line, metadata: { threadIds: [], composer: false } });
      return byLine.get(key)!.metadata;
    };
    for (const t of fileThreads) if (t.line) at(t.side, t.line).threadIds.push(t.id);
    if (range) at(range.side, range.line).composer = true;
    return [...byLine.values()];
  }, [fileThreads, range]);

  const card = (t: Thread) => <ThreadCard inline thread={t} viewer={review.viewer} author={review.author} onPosted={review.onSaved} />;
  const renderNote = (note: DiffLineAnnotation<LineNote>) => {
    const threads = note.metadata.threadIds.map((id) => fileThreads.find((t) => t.id === id)).filter((t): t is Thread => !!t);
    return (
      <div className="space-y-2 px-3 py-2 font-sans text-sm">
        {threads.map((t) =>
          t.isPending ? (
            <div key={t.id} className="space-y-2 rounded-xl border border-warning/50 bg-card p-3">
              {t.startLine && t.startLine !== t.line ? <p className="text-xs text-muted-foreground">Lines {lineLabel(t)}</p> : null}
              {t.comments.map((c, ci) => (
                <CommentBlock key={ci} comment={c}>
                  <Pill tone="warn">Pending</Pill>
                </CommentBlock>
              ))}
            </div>
          ) : t.isResolved ? (
            <details key={t.id}>
              <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                Resolved conversation · {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
                {t.comments[0] ? ` from ${t.comments[0].author}` : ""}
              </summary>
              <div className="mt-2">{card(t)}</div>
            </details>
          ) : (
            <div key={t.id}>{card(t)}</div>
          ),
        )}
        {note.metadata.composer && range ? (
          <div className="rounded-xl border border-border bg-card p-3">
            <Composer
              key={`${range.start?.side}${range.start?.line}-${range.side}${range.line}`}
              label={`Comment on ${file.path} ${rangeText(range)}`}
              placeholder={
                range.start
                  ? `Comment on ${rangeText(range)}…`
                  : `Comment on ${rangeText(range)}… (select several line numbers to cover a range)`
              }
              autoFocus
              onCancel={() => setRange(null)}
              actions={
                review.pendingReviewId
                  ? [{ label: "Add review comment", onSubmit: save(range, "review") }]
                  : [
                      { label: "Start a review", onSubmit: save(range, "review") },
                      { label: "Add single comment", onSubmit: save(range, "single") },
                    ]
              }
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left hover:bg-muted/70"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Icon name={icon.name} className={cn("size-3.5 shrink-0", icon.className)} aria-label={file.status} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          {file.previousPath ? <PathLabel path={file.previousPath} className="max-w-[40%] opacity-70" /> : null}
          {file.previousPath ? <Icon name="ArrowRight" className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <PathLabel path={file.path} />
        </span>
        {openCount > 0 ? (
          <Pill tone="neutral" icon="MessageSquare">
            {openCount}
          </Pill>
        ) : null}
        {draftCount > 0 ? <Pill tone="warn">{draftCount} pending</Pill> : null}
        <span className="shrink-0 font-mono text-xs tabular-nums text-success">+{file.additions}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-destructive">−{file.deletions}</span>
      </button>
      {open ? (
        file.patch ? (
          <div className="border-t border-border">
            <DiffBoundary url={`${review.prUrl}/files`}>
            <PatchDiff<LineNote>
              patch={fullPatch(file)}
              options={{
                diffStyle: view === "split" ? "split" : "unified",
                overflow: view === "split" ? "wrap" : "scroll",
                theme: codeTheme.name,
                themeType: codeTheme.mode,
                disableFileHeader: true,
                enableGutterUtility: true,
                onGutterUtilityClick: pick,
                enableLineSelection: true,
                controlledSelection: true,
                onLineSelectionEnd: pick,
              }}
              selectedLines={
                range
                  ? {
                      start: range.start?.line ?? range.line,
                      side: toViewerSide(range.start?.side ?? range.side),
                      end: range.line,
                      endSide: toViewerSide(range.side),
                    }
                  : null
              }
              lineAnnotations={notes}
              renderAnnotation={renderNote}
            />
            </DiffBoundary>
          </div>
        ) : (
          <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
            No diff to show: a binary file, or too large for GitHub to diff.
          </p>
        )
      ) : null}
    </article>
  );
}

const REVIEW_CHOICE: Record<ReviewEvent, { title: string; detail: string }> = {
  COMMENT: { title: "Comment", detail: "General feedback, without approving." },
  APPROVE: { title: "Approve", detail: "Approve merging these changes." },
  REQUEST_CHANGES: { title: "Request changes", detail: "Feedback that must be addressed before merging." },
};

/** "Finish your review": a summary plus Comment, Approve or Request changes. */
function ReviewBar({
  prId,
  pendingReviewId,
  draftCount,
  viewer,
  author,
  onSubmitted,
}: {
  prId: string;
  pendingReviewId: string | null;
  draftCount: number;
  viewer: string;
  author: string;
  onSubmitted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const events = reviewEvents(viewer, author);
  const discard = async () => {
    if (!pendingReviewId) return;
    setSending(true);
    setError(null);
    try {
      await rpc.call("pr_discard_review", { reviewId: pendingReviewId });
      toast.success("Pending review discarded");
      setConfirmDiscard(false);
      setOpen(false);
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      await rpc.call("pr_submit_review", { prId, reviewId: pendingReviewId, event, body });
      toast.success(event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Changes requested" : "Review submitted");
      setOpen(false);
      setBody("");
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return (
    <section aria-label="Your review" className={cn("rounded-xl border bg-card", pendingReviewId ? "border-warning/50" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <Icon name="Eye" className={cn("size-4 shrink-0", pendingReviewId ? "text-warning-text" : "text-muted-foreground")} aria-hidden />
        {pendingReviewId ? (
          <span>
            <span className="font-medium">Review in progress</span>
            <span className="text-muted-foreground">
              {" "}· {draftCount} pending comment{draftCount === 1 ? "" : "s"}, visible only to you
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            Press + on a line, or click line numbers (Shift-click or drag for several), to comment, or review the whole PR.
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {pendingReviewId ? (
            confirmDiscard ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Delete {draftCount} pending comment{draftCount === 1 ? "" : "s"}?
                </span>
                <Button size="sm" variant="ghost" disabled={sending} onClick={() => setConfirmDiscard(false)}>
                  Keep
                </Button>
                <Button size="sm" variant="destructive" disabled={sending} onClick={() => void discard()}>
                  {sending ? "Discarding…" : "Discard"}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)}>
                Discard review
              </Button>
            )
          ) : null}
          {confirmDiscard ? null : (
            <Button size="sm" variant={pendingReviewId ? "default" : "outline"} onClick={() => setOpen(!open)}>
              {pendingReviewId ? "Finish your review" : "Review changes"}
            </Button>
          )}
        </span>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border p-3">
          <textarea
            aria-label="Review summary"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Leave a summary (optional for Approve)…"
            rows={3}
            disabled={sending}
            className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <fieldset className="space-y-2">
            <legend className="sr-only">Review type</legend>
            {events.map((e) => (
              <label key={e} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`review-${prId}`}
                  value={e}
                  checked={event === e}
                  onChange={() => setEvent(e)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{REVIEW_CHOICE[e].title}</span>
                  <span className="block text-xs text-muted-foreground">{REVIEW_CHOICE[e].detail}</span>
                </span>
              </label>
            ))}
            {viewer === author ? (
              <p className="text-xs text-muted-foreground">GitHub does not let you approve or request changes on your own pull request.</p>
            ) : null}
          </fieldset>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={sending || !canSubmitReview(event, body, draftCount)}>
              {sending ? "Submitting…" : "Submit review"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FilesTab({
  repo,
  number,
  prId,
  viewer,
  author,
  pendingReviewId,
  threads,
  onChanged,
}: {
  repo: string;
  number: number;
  prId: string;
  viewer: string;
  author: string;
  pendingReviewId: string | null;
  threads: Thread[];
  onChanged: () => void;
}) {
  const key = `${repo}#${number}`;
  const rpc = useRpc<typeof rpcContract>();
  const [files, setFiles] = useState<PrFile[] | null>(cachedFiles.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("pr_files", { repo, number }).then(
      (r) => {
        cachedFiles.set(key, r.files);
        setFiles(r.files);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, repo, number, key]);
  const [view, setViewState] = useState<DiffView>(savedView);
  // bb's live code theme, so diffs match the rest of the app and follow light/dark switches.
  const codeTheme = experimental_useCodeTheme();
  const setView = (next: DiffView) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // storage can be unavailable; the choice then lasts for this visit
    }
  };
  const drafts = threads.filter((t) => t.isPending);
  const review: ReviewContext = { prId, prUrl: `https://github.com/${repo}/pull/${number}`, pendingReviewId, threads, viewer, author, onSaved: onChanged };
  const bar = prId ? (
    <ReviewBar
      prId={prId}
      pendingReviewId={pendingReviewId}
      draftCount={drafts.length}
      viewer={viewer}
      author={author}
      onSubmitted={onChanged}
    />
  ) : null;
  if (error && !files) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!files) return <Skeleton rows={3} />;
  if (files.length === 0) return <EmptyState icon="FileDiff">No changed files.</EmptyState>;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="space-y-2">
      {bar}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed ·{" "}
          <span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span>
        </p>
        <div className="ml-auto">
          <Segmented
            label="Diff layout"
            value={view}
            onChange={setView}
            options={[
              { id: "inline", label: "Inline", icon: "Rows2" },
              { id: "split", label: "Side by side", icon: "Columns2" },
            ]}
          />
        </div>
      </div>
      {files.map((f, i) => (
        <FileDiff key={f.path} file={f} view={view} codeTheme={codeTheme} defaultOpen={i < 3 || threads.some((t) => t.path === f.path)} review={review} />
      ))}
      {files.length === 100 ? (
        <p className="text-center text-xs text-muted-foreground">Showing the first 100 files; open GitHub for the rest.</p>
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

function ThreadCard({
  thread,
  viewer,
  author,
  onPosted,
  inline = false,
}: {
  thread: Thread;
  viewer: string;
  author: string;
  onPosted: () => void;
  /** Under its line in the Files tab: no file path or diff snippet, which the diff already shows. */
  inline?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [replying, setReplying] = useState(false);
  const pill = {
    resolved: (
      <Pill tone="good" icon="CircleCheck">
        Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy === viewer ? "you" : thread.resolvedBy}` : ""}
      </Pill>
    ),
    "waiting-on-you": (
      <Pill tone="warn" icon="Clock">
        Waiting on your reply
      </Pill>
    ),
    "you-replied": (
      <Pill tone="neutral" icon="ArrowTurnBackward">
        You replied
      </Pill>
    ),
    "waiting-on-author": (
      <Pill tone="neutral" icon="Clock">
        Waiting on {author}
      </Pill>
    ),
    "author-replied": (
      <Pill tone="warn" icon="ArrowTurnBackward">
        {author} replied
      </Pill>
    ),
  }[threadStatus(thread, viewer, author)];
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        {inline ? (
          <span className="flex-1 text-xs text-muted-foreground">
            {thread.startLine && thread.startLine !== thread.line ? `Lines ${lineLabel(thread)}` : `Line ${thread.line}`}
          </span>
        ) : (
          <>
            <Icon name="File" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <PathLabel path={thread.path} line={lineLabel(thread)} className="min-w-[10rem] flex-1" />
          </>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {thread.isOutdated ? <Pill tone="neutral">Outdated</Pill> : null}
          {pill}
        </span>
      </header>
      {thread.diffHunk && !inline ? <Hunk hunk={thread.diffHunk} /> : null}
      <div className="space-y-4 p-3">
        {thread.comments.map((c, i) => (
          <CommentBlock key={i} comment={c} />
        ))}
        {replying ? (
          <Composer
            label={`Reply on ${thread.path}`}
            placeholder="Write a reply…"
            autoFocus
            onCancel={() => setReplying(false)}
            actions={[
              {
                label: "Reply",
                onSubmit: async (body) => {
                  const result = await rpc.call("pr_reply", { threadId: thread.id, body });
                  setReplying(false);
                  if (result.pending) {
                    toast.warning("Reply added to your pending review", {
                      description: "It stays hidden from others until you finish your review.",
                    });
                  } else {
                    toast.success("Reply posted");
                  }
                  onPosted();
                },
              },
            ]}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {thread.id ? (
              <Button size="sm" variant="outline" onClick={() => setReplying(true)}>
                <Icon name="ArrowTurnBackward" className="size-3.5" />
                Reply
              </Button>
            ) : null}
            {thread.comments[0] ? (
              <UrlLink
                href={thread.comments[0].url}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Open on GitHub
                <Icon name="ExternalLink" className="size-3" aria-hidden />
              </UrlLink>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

type ThreadFilter = "unresolved" | "resolved";

function ThreadsTab({
  threads,
  viewer,
  author,
  onPosted,
}: {
  threads: Thread[];
  viewer: string;
  author: string;
  onPosted: () => void;
}) {
  // Your unsubmitted review's drafts live in the Files tab until you finish the review.
  const published = threads.filter((t) => !t.isPending);
  const open = published.filter((t) => !t.isResolved);
  const resolved = published.filter((t) => t.isResolved);
  const [filter, setFilter] = useState<ThreadFilter>(open.length > 0 ? "unresolved" : "resolved");
  if (published.length === 0) return <EmptyState icon="MessageSquare">No review comments on this PR.</EmptyState>;
  const shown = filter === "unresolved" ? open : resolved;
  const yours = viewer === author;
  // On your PR: threads waiting on you. On someone else's: threads the author answered.
  const waiting = open.filter((t) => threadStatus(t, viewer, author) === (yours ? "waiting-on-you" : "author-replied")).length;
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
            {yours ? `${waiting} waiting on your reply` : `${waiting} answered by ${author}`}
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState icon="CircleCheck">{filter === "unresolved" ? "Every thread is resolved." : "No resolved threads yet."}</EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,34rem),1fr))] items-start gap-3">
          {shown.map((t, i) => (
            <ThreadCard key={t.id || `${filter}-${i}`} thread={t} viewer={viewer} author={author} onPosted={onPosted} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Conversation ----

function ConversationTab({
  timeline,
  prUrl,
  subjectId,
  onPosted,
}: {
  timeline: TimelineEntry[];
  prUrl: string;
  subjectId: string;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  return (
    // A conversation is prose: keep its lines readable on wide tabs.
    <div className="max-w-4xl space-y-4">
      {timeline.length === 0 ? <EmptyState icon="MessageSquare">No comments yet.</EmptyState> : <Timeline timeline={timeline} prUrl={prUrl} />}
      {subjectId ? (
        <section aria-label="Add a comment" className="space-y-2 rounded-xl border border-border bg-card p-3">
          <h4 className="text-xs font-semibold">Add a comment</h4>
          <Composer
            label="Comment on this pull request"
            placeholder="Leave a comment…"
            actions={[
              {
                label: "Comment",
                onSubmit: async (body) => {
                  await rpc.call("pr_comment", { subjectId, body });
                  toast.success("Comment posted");
                  onPosted();
                },
              },
            ]}
          />
        </section>
      ) : null}
    </div>
  );
}

function Timeline({ timeline, prUrl }: { timeline: TimelineEntry[]; prUrl: string }) {
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

/** Close an open PR (with a confirm step) or reopen a closed one; merged PRs stay merged. */
function StateButton({ prId, state, onDone }: { prId: string; state: string; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!prId || (state !== "OPEN" && state !== "CLOSED")) return null;
  const action = state === "OPEN" ? "close" : "reopen";
  const run = async () => {
    setBusy(true);
    try {
      await rpc.call("pr_set_state", { prId, action });
      toast.success(action === "close" ? "Pull request closed" : "Pull request reopened");
      onDone();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  if (action === "reopen") {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
        <Icon name="GitPullRequest" className="size-3.5" />
        {busy ? "Reopening…" : "Reopen"}
      </Button>
    );
  }
  return confirming ? (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run()}>
        {busy ? "Closing…" : "Confirm close"}
      </Button>
    </>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
      <Icon name="GitPullRequestClosed" className="size-3.5" />
      Close PR
    </Button>
  );
}

type DetailTab = "checks" | "files" | "threads" | "conversation";

function firstTab(d: PrDetail): DetailTab {
  if (d.checks.some((c) => c.status === "failing" || c.status === "pending")) return "checks";
  if (d.threads.some((t) => !t.isResolved)) return "threads";
  return "conversation";
}

export function PrDetailView({
  repo,
  number,
  summary,
  stackedAbove,
  onOpenPr,
  onStateChanged,
  onBack,
}: {
  repo: string;
  number: number;
  /** The row from the list, for its blockers; absent on a cold deep link. */
  summary: Pr | undefined;
  /** Loaded PRs whose base is this PR's branch. */
  stackedAbove: Pr[];
  onOpenPr: (repo: string, number: number) => void;
  /** After closing or reopening, so the lists move the PR to the right tab. */
  onStateChanged: () => void;
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
  // The stack bar below the title already says "Stacked on #N", with a link.
  const blockers = (summary?.blockers ?? []).filter((b) => !b.startsWith("Stacked on"));
  const activeTab = tab ?? (detail ? firstTab(detail) : "checks");
  const failing = detail?.checks.filter((c) => c.status === "failing").length ?? 0;
  const unresolved = detail?.threads.filter((t) => !t.isResolved && !t.isPending).length ?? 0;
  const drafts = detail?.threads.filter((t) => t.isPending).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <Icon name="ArrowLeft" className="size-4" />
          All PRs
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {detail ? (
            <StateButton
              prId={detail.id}
              state={detail.state}
              onDone={() => {
                load();
                onStateChanged();
              }}
            />
          ) : null}
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

      {/* Wide tabs: the summary moves to a sticky right column; it stays first in the markup for narrow tabs and screen readers. */}
      <div className="grid gap-4 @6xl:grid-cols-[minmax(0,1fr)_22rem] @6xl:items-start">
      <header className="space-y-3 rounded-xl border border-border bg-card p-4 @6xl:sticky @6xl:top-3 @6xl:col-start-2 @6xl:row-start-1">
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
        {detail && (detail.stackedOn || !detail.onDefaultBranch || stackedAbove.length > 0) ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
            <Icon name="Layers" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {detail.stackedOn ? (
              <span className="min-w-0">
                Stacked on{" "}
                <button onClick={() => onOpenPr(repo, detail.stackedOn!.number)} className="font-medium hover:underline">
                  #{detail.stackedOn.number} {detail.stackedOn.title}
                </button>
              </span>
            ) : !detail.onDefaultBranch ? (
              <span>
                Based on <code className="font-mono">{detail.baseRefName}</code>, not the default branch
              </span>
            ) : null}
            {stackedAbove.map((p) => (
              <button key={p.id} onClick={() => onOpenPr(p.repo, p.number)} className="text-muted-foreground hover:text-foreground hover:underline">
                #{p.number} is stacked on this
              </button>
            ))}
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

      <div className="min-w-0 space-y-4 @6xl:col-start-1 @6xl:row-start-1">
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
              { id: "files", label: "Files", icon: "FileDiff", count: detail.changedFiles, countTone: drafts > 0 ? "warn" : "neutral" },
              { id: "threads", label: "Comments", icon: "MessageSquare", count: unresolved, countTone: unresolved > 0 ? "bad" : "neutral" },
              { id: "conversation", label: "Conversation", icon: "UserRound", count: detail.timeline.length },
            ]}
          />
          {activeTab === "checks" ? <ChecksTab checks={detail.checks} /> : null}
          {activeTab === "files" ? (
            <FilesTab
              repo={repo}
              number={number}
              prId={detail.id}
              viewer={detail.viewer}
              author={detail.author}
              pendingReviewId={detail.pendingReviewId}
              threads={detail.threads}
              onChanged={load}
            />
          ) : null}
          {activeTab === "threads" ? (
            <ThreadsTab threads={detail.threads} viewer={detail.viewer} author={detail.author} onPosted={load} />
          ) : null}
          {activeTab === "conversation" ? (
            <ConversationTab timeline={detail.timeline} prUrl={detail.url} subjectId={detail.id} onPosted={load} />
          ) : null}
        </>
      )}
      </div>
      </div>
    </div>
  );
}
