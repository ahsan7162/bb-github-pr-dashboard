// The detail view for one PR: CI checks, changed files (with line comments and
// review submission), review threads (with replies), the conversation (with a
// comment box), and closing or reopening the PR.
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Kbd,
  Pill,
  Segmented,
  Skeleton,
  Spine,
  TONE_TEXT,
  ago,
  blockerTone,
  motionMs,
  prState,
  reducedMotion,
  useArrive,
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

/** One button of a comment box and what it sends. */
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
        className="block w-full resize-y rounded-[var(--prd-radius-control)] border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Markdown, ⌘↵ to send. Posts as you on GitHub.</span>
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
    <div className="space-y-3 rounded-[var(--prd-radius-panel)] border border-border p-4">
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
    <div className="group relative space-y-3 rounded-[var(--prd-radius-panel)] border border-border py-4 pl-6 pr-4">
      <Spine tone={failing ? "bad" : "warn"} />
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
        <ul className="space-y-2 rounded-[var(--prd-radius-control)] bg-muted/50 p-3 text-xs">
          {check.annotations.map((a, i) => (
            <li key={i} className="flex gap-2">
              <Icon
                name={a.level === "WARNING" ? "AlertTriangle" : "CircleX"}
                className={cn("mt-0.5 size-3 shrink-0", a.level === "WARNING" ? "text-warning-text" : "text-destructive")}
                aria-hidden
              />
              <span className="min-w-0 break-words">
                <span className="font-mono text-muted-foreground">
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
          className="inline-flex items-center gap-1 rounded-[var(--prd-radius-control)] border border-border px-2 py-1 text-xs font-medium transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent"
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
    <div className="space-y-6">
      <CheckBar checks={checks} />
      {attention.length > 0 ? (
        <div className="space-y-2">
          {attention.map((c, i) => (
            <AttentionCheck key={`${c.workflow}-${c.name}-${i}`} check={c} />
          ))}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--prd-radius-panel)] border border-border">
          {rest.map((c, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Icon name={STATUS[c.status].icon} className={cn("size-4 shrink-0", TONE_TEXT[STATUS[c.status].tone])} aria-hidden />
              <div className="min-w-0 flex-1">{checkName(c)}</div>
              {c.url ? (
                <UrlLink href={c.url} aria-label={`Open ${c.name}`} className="rounded-[var(--prd-radius-control)] p-1 text-muted-foreground transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent hover:text-foreground">
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
  target,
  flash,
}: {
  file: PrFile;
  defaultOpen: boolean;
  review: ReviewContext;
  view: DiffView;
  codeTheme: { name: string; mode: "dark" | "light" };
  /** What a jump is heading for: this file opens when it is the file or holds the thread. */
  target: string | null;
  flash: string | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(defaultOpen);
  const [range, setRange] = useState<CommentRange | null>(null);
  const rows = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const fileThreads = review.threads.filter((t) => t.path === file.path && (t.isPending || !t.isOutdated));
  const draftCount = fileThreads.filter((t) => t.isPending).length;
  const openCount = fileThreads.filter((t) => !t.isPending && !t.isResolved).length;
  const icon = FILE_ICON[file.status] ?? { name: "DiffModified", className: "text-warning-text" };
  const body = useArrive<HTMLDivElement>(open, "--prd-expand");
  const holdsTarget = target !== null && (target === file.path || fileThreads.some((t) => t.id === target));
  useEffect(() => {
    if (holdsTarget) setOpen(true);
  }, [holdsTarget, target]);

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

  const card = (t: Thread) => (
    <ThreadCard inline thread={t} viewer={review.viewer} author={review.author} onPosted={review.onSaved} wide={flash === t.id} />
  );
  // Under its line, a thread is a tinted band with its status spine: one border deep, not a card in the diff's card.
  const renderNote = (note: DiffLineAnnotation<LineNote>) => {
    const threads = note.metadata.threadIds.map((id) => fileThreads.find((t) => t.id === id)).filter((t): t is Thread => !!t);
    return (
      <div className="font-sans text-sm">
        {threads.map((t) =>
          t.isPending ? (
            <div key={t.id} className="relative space-y-3 border-y border-border bg-muted/30 py-4 pl-6 pr-4">
              <Spine tone="warn" />
              {t.startLine && t.startLine !== t.line ? <p className="text-xs text-muted-foreground">Lines {lineLabel(t)}</p> : null}
              {t.comments.map((c, ci) => (
                <CommentBlock key={ci} comment={c}>
                  <Pill tone="warn">Pending</Pill>
                </CommentBlock>
              ))}
            </div>
          ) : t.isResolved ? (
            <details key={t.id} className="border-y border-border bg-muted/30 px-4 py-3">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground transition-colors duration-[var(--prd-hover)] hover:text-foreground">
                Resolved conversation · {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
                {t.comments[0] ? ` from ${t.comments[0].author}` : ""}
              </summary>
              <div className="-mx-4 -mb-3 mt-3">{card(t)}</div>
            </details>
          ) : (
            <div key={t.id}>{card(t)}</div>
          ),
        )}
        {note.metadata.composer && range ? (
          <div className="border-y border-border bg-muted/30 p-4">
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
    <article data-jump={file.path} data-file={file.path} className="scroll-mt-4 overflow-hidden rounded-[var(--prd-radius-panel)] border border-border">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
          <div ref={body} className="border-t border-border">
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
    <section aria-label="Your review" className={cn("rounded-[var(--prd-radius-panel)] border", pendingReviewId ? "border-warning/50" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
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
        <div className="space-y-3 border-t border-border p-4">
          <textarea
            aria-label="Review summary"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Leave a summary (optional for Approve)…"
            rows={3}
            disabled={sending}
            className="block w-full resize-y rounded-[var(--prd-radius-control)] border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
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

/** The PR's changed files, fetched the first time the Files tab opens (the file list and the diffs share them). */
function usePrFiles(repo: string, number: number, enabled: boolean) {
  const key = `${repo}#${number}`;
  const rpc = useRpc<typeof rpcContract>();
  const [files, setFiles] = useState<PrFile[] | null>(cachedFiles.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;
    rpc.call("pr_files", { repo, number }).then(
      (r) => {
        cachedFiles.set(key, r.files);
        setFiles(r.files);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [enabled, rpc, repo, number, key]);
  return { files, error };
}

function FilesTab({
  repo,
  number,
  prId,
  viewer,
  author,
  pendingReviewId,
  threads,
  files,
  error,
  target,
  flash,
  onChanged,
}: {
  repo: string;
  number: number;
  prId: string;
  viewer: string;
  author: string;
  pendingReviewId: string | null;
  threads: Thread[];
  files: PrFile[] | null;
  error: string | null;
  target: string | null;
  flash: string | null;
  onChanged: () => void;
}) {
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
      <div role="alert" className="rounded-[var(--prd-radius-panel)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!files) return <Skeleton rows={3} />;
  if (files.length === 0) return <EmptyState icon="FileDiff">No changed files.</EmptyState>;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="space-y-4">
      {bar}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed,{" "}
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
        <FileDiff
          key={f.path}
          file={f}
          view={view}
          codeTheme={codeTheme}
          defaultOpen={i < 3 || threads.some((t) => t.path === f.path)}
          review={review}
          target={target}
          flash={flash}
        />
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
    <pre className="overflow-x-auto rounded-[var(--prd-radius-control)] border border-border bg-muted/30 py-1 font-mono text-xs leading-5">
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

/** A thread's status colour: amber while a reply is owed, green once resolved. */
function threadTone(thread: Thread, viewer: string, author: string): Tone {
  const status = threadStatus(thread, viewer, author);
  if (status === "resolved") return "good";
  return status === "waiting-on-you" || status === "author-replied" ? "warn" : "neutral";
}

function ThreadCard({
  thread,
  viewer,
  author,
  onPosted,
  inline = false,
  wide = false,
  onShowInDiff,
}: {
  thread: Thread;
  viewer: string;
  author: string;
  onPosted: () => void;
  /** Under its line in the Files view: a tinted band, without the file path or diff snippet the diff already shows. */
  inline?: boolean;
  /** Just jumped to: the spine widens for a moment. */
  wide?: boolean;
  /** In the Comments view, when the thread's line is in the current diff. */
  onShowInDiff?: () => void;
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
    <article
      data-jump={thread.id || undefined}
      className={cn(
        "group relative scroll-mt-24 space-y-4",
        inline ? "border-y border-border bg-muted/30 py-4 pl-6 pr-4" : "py-6 pl-6",
      )}
    >
      <Spine tone={threadTone(thread, viewer, author)} wide={wide} />
      <header className="flex flex-wrap items-center gap-2">
        {inline ? (
          <span className="text-xs text-muted-foreground">
            {thread.startLine && thread.startLine !== thread.line ? `Lines ${lineLabel(thread)}` : `Line ${thread.line}`}
          </span>
        ) : (
          <PathLabel path={thread.path} line={lineLabel(thread)} className="min-w-[10rem] flex-1" />
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {thread.isOutdated ? <Pill tone="neutral">Outdated</Pill> : null}
          {pill}
          {onShowInDiff ? (
            <Button size="sm" variant="outline" onClick={onShowInDiff}>
              <Icon name="FileDiff" className="size-3.5" />
              Show in diff
            </Button>
          ) : null}
        </span>
      </header>
      {thread.diffHunk && !inline ? <Hunk hunk={thread.diffHunk} /> : null}
      <div className="space-y-4">
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
  flash,
  onShowInDiff,
}: {
  threads: Thread[];
  viewer: string;
  author: string;
  onPosted: () => void;
  flash: string | null;
  onShowInDiff: (threadId: string) => void;
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
    <div className="space-y-2">
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
        <div className="divide-y divide-border">
          {shown.map((t, i) => (
            <ThreadCard
              key={t.id || `${filter}-${i}`}
              thread={t}
              viewer={viewer}
              author={author}
              onPosted={onPosted}
              wide={flash === t.id}
              onShowInDiff={t.id && t.line && !t.isOutdated ? () => onShowInDiff(t.id) : undefined}
            />
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
    <div className="max-w-4xl space-y-8">
      {timeline.length === 0 ? <EmptyState icon="MessageSquare">No comments yet.</EmptyState> : <Timeline timeline={timeline} prUrl={prUrl} />}
      {subjectId ? (
        <section aria-label="Add a comment" className="space-y-3 rounded-[var(--prd-radius-panel)] border border-border p-4">
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
    <ol className="relative space-y-6 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-border">
      {timeline.map((entry, i) => {
        const review = entry.reviewState ? REVIEW[entry.reviewState] : undefined;
        return (
          <li key={i} className="relative flex gap-3">
            <span className="relative z-10 rounded-full ring-4 ring-background">
              <Avatar login={entry.author} url={entry.avatarUrl} size={32} />
            </span>
            <div className="min-w-0 flex-1 space-y-2 pt-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
              {entry.body.trim() ? <Body content={entry.body} /> : null}
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

/** A thread n and p can land on: published, unresolved, and anchored to a line of the current diff. */
const inDiff = (t: Thread) => !!t.id && !t.isPending && !t.isResolved && !!t.line && !t.isOutdated;

const navItem = (current: boolean) =>
  cn(
    "relative flex w-full min-w-0 items-center gap-2 rounded-[var(--prd-radius-control)] px-2 py-1.5 text-left outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] focus-visible:ring-2 focus-visible:ring-ring",
    current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );

/** Beside the diff in the Files tab: every file one click away, with its open comments and the keys. */
function FileList({
  files,
  threads,
  currentFile,
  onJump,
}: {
  files: PrFile[];
  threads: Thread[];
  currentFile: string | null;
  onJump: (path: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {files.map((f) => {
          const slash = f.path.lastIndexOf("/");
          const open = threads.filter((t) => t.path === f.path && !t.isPending && !t.isResolved).length;
          return (
            <button
              key={f.path}
              title={f.path}
              onClick={() => onJump(f.path)}
              aria-current={currentFile === f.path ? "location" : undefined}
              className={navItem(currentFile === f.path)}
            >
              {/* The file name first: in a 15rem column the directory is what gives way. */}
              <span className="flex min-w-0 flex-1 items-baseline gap-2 font-mono text-xs">
                <span className="truncate">{f.path.slice(slash + 1)}</span>
                {slash > 0 ? <span className="min-w-0 shrink-[100] truncate text-[11px] text-muted-foreground">{f.path.slice(0, slash)}</span> : null}
              </span>
              {open > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" aria-label={`${open} unresolved`}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  {open}
                </span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-success">+{f.additions}</span>
            </button>
          );
        })}
      </div>
      <div className="space-y-2 px-2 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          <span className="ml-1">next and previous file</span>
        </p>
        <p className="flex items-center gap-1.5">
          <Kbd>n</Kbd>
          <Kbd>p</Kbd>
          <span className="ml-1">next and previous comment</span>
        </p>
      </div>
    </div>
  );
}

/** Where this PR sits in the list you came from, for Previous and Next. */
export interface ListPosition {
  index: number;
  total: number;
  prev: { repo: string; number: number } | null;
  next: { repo: string; number: number } | null;
}

export function PrDetailView({
  repo,
  number,
  summary,
  stackedAbove,
  position,
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
  /** Null when the PR is not in the list as last shown (a deep link, a folded repo). */
  position: ListPosition | null;
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
  // The stack line below the title already says "Stacked on #N", with a link.
  const blockers = (summary?.blockers ?? []).filter((b) => !b.startsWith("Stacked on"));
  const activeTab = tab ?? (detail ? firstTab(detail) : "checks");
  const { files, error: filesError } = usePrFiles(repo, number, activeTab === "files");
  const failing = detail?.checks.filter((c) => c.status === "failing").length ?? 0;
  const unresolved = detail?.threads.filter((t) => !t.isResolved && !t.isPending).length ?? 0;
  const drafts = detail?.threads.filter((t) => t.isPending).length ?? 0;
  const headTone: Tone = blockers.some((b) => blockerTone(b) === "bad")
    ? "bad"
    : blockers.some((b) => blockerTone(b) === "warn")
      ? "warn"
      : state.label === "Merged"
        ? "merged"
        : state.label === "Open" && summary
          ? "good"
          : "neutral";

  // ---- Jumps: a file from the file list, a comment from Show in diff, or the keys ----
  const page = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ id: string; at: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const lastThread = useRef<string | null>(null);
  // While a jump is under way (path ""), or its file still sits where the jump left it, the file list
  // keeps the jump's file: a short PR cannot always scroll its target to the top.
  const pin = useRef<{ path: string; top: number } | null>(null);
  const arrive = useArrive<HTMLDivElement>(activeTab);
  // Opening a PR takes focus from the row that opened it (now gone), so j/k/n/p work straight away.
  useEffect(() => {
    if (document.activeElement === document.body) page.current?.focus({ preventScroll: true });
  }, [key]);
  const jump = useCallback((id: string, view: DetailTab) => {
    setTab(view);
    setTarget({ id, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!target) return;
    const { id } = target;
    if (detail?.threads.some((t) => t.id === id)) lastThread.current = id;
    const timers: number[] = [];
    let cancelled = false;
    pin.current = { path: "", top: NaN };
    const widen = () => {
      if (cancelled) return;
      setFlash(id);
      timers.push(window.setTimeout(() => setFlash((f) => (f === id ? null : f)), motionMs("--prd-expand")));
    };
    // The target can need a render or two (a view switch, a file opening, the diff laying out).
    let tries = 0;
    const find = () => {
      const el = page.current?.querySelector<HTMLElement>(`[data-jump="${CSS.escape(id)}"]`);
      if (!el) {
        if (tries++ < 60) timers.push(window.setTimeout(find, 50));
        return;
      }
      settle(el, NaN, 0);
    };
    // bb's diff viewer lays files out a beat after they mount; scroll once the target stops moving.
    const settle = (el: HTMLElement, last: number, n: number) => {
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - last) < 1 || n >= 12) return go(el);
      timers.push(window.setTimeout(() => settle(el, top, n + 1), 50));
    };
    const go = (el: HTMLElement) => {
      const file = el.closest<HTMLElement>("article[data-file]");
      if (file?.dataset.file) setCurrentFile(file.dataset.file);
      const land = () => {
        pin.current = file?.dataset.file ? { path: file.dataset.file, top: file.getBoundingClientRect().top } : null;
        widen();
      };
      const r = el.getBoundingClientRect();
      const visible = r.top >= 0 && r.bottom <= window.innerHeight;
      const smooth = !reducedMotion();
      el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: el.dataset.file ? "start" : "center" });
      if (visible || !smooth) return land();
      // Widen once the scroll lands, so the eye arrives before the spine moves.
      const done = () => {
        document.removeEventListener("scrollend", done, true);
        land();
      };
      document.addEventListener("scrollend", done, true);
      timers.push(window.setTimeout(done, 700));
    };
    timers.push(window.setTimeout(find, 0));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      if (pin.current && !pin.current.path) pin.current = null;
    };
  }, [target]); // once per jump, not on every detail refresh

  // Which file is on screen, for the file list: the last one whose top has passed a quarter of the way down.
  useEffect(() => {
    if (activeTab !== "files" || !files || !page.current) return;
    let frame = 0;
    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const held = pin.current;
        if (held) {
          if (!held.path) return;
          const el = page.current?.querySelector(`article[data-file="${CSS.escape(held.path)}"]`);
          if (el && Math.abs(el.getBoundingClientRect().top - held.top) < 2) return;
          pin.current = null;
        }
        const line = window.innerHeight / 4;
        let current: string | null = null;
        for (const a of Array.from(page.current?.querySelectorAll<HTMLElement>("article[data-file]") ?? [])) {
          if (current === null || a.getBoundingClientRect().top <= line) current = a.dataset.file ?? null;
        }
        setCurrentFile(current);
      });
    };
    track();
    document.addEventListener("scroll", track, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", track, true);
      cancelAnimationFrame(frame);
    };
  }, [activeTab, files]);

  // j/k files, n/p unresolved comments. Only while focus is on this page (or nowhere), never in a text
  // field, the diff's own controls or a dialog, and never with a modifier or Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !["j", "k", "n", "p", "[", "]"].includes(e.key)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && t !== document.body && !page.current?.contains(t)) return;
      if (t?.closest("input, textarea, select, [contenteditable], diffs-container, [role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      if (e.key === "[" || e.key === "]") {
        const to = e.key === "[" ? position?.prev : position?.next;
        if (to) {
          e.preventDefault();
          onOpenPr(to.repo, to.number);
        }
        return;
      }
      if (!detail) return;
      // Stops at the first and last item rather than wrapping round.
      const step = <T,>(list: T[], at: number, forward: boolean) =>
        list.length ? list[at < 0 ? (forward ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + (forward ? 1 : -1)))]! : null;
      if (e.key === "j" || e.key === "k") {
        if (!files) {
          e.preventDefault();
          return setTab("files"); // the file list loads; the next press moves
        }
        if (!files.length) return;
        e.preventDefault();
        const next = step(files, files.findIndex((f) => f.path === currentFile), e.key === "j");
        if (next) jump(next.path, "files");
      } else {
        const order = new Map((files ?? []).map((f, i) => [f.path, i]));
        const list = detail.threads
          .filter(inDiff)
          .sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9) || (a.line ?? 0) - (b.line ?? 0));
        if (!list.length) return;
        e.preventDefault();
        const next = step(list, list.findIndex((x) => x.id === lastThread.current), e.key === "n");
        if (next) jump(next.id, "files");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, files, currentFile, jump, position, onOpenPr]);

  return (
    <div ref={page} tabIndex={-1} className="space-y-6 outline-none">
      {/* The header band: the blocker is the headline. */}
      <header className="group relative space-y-3 border-b border-border pb-6 pl-6">
        <Spine tone={headTone} />
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
            <Icon name="ArrowLeft" className="size-4" />
            All PRs
          </Button>
          {position ? (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous PR in the list ( [ )"
                disabled={!position.prev}
                onClick={() => position.prev && onOpenPr(position.prev.repo, position.prev.number)}
              >
                <Icon name="ChevronUp" className="size-4" />
              </Button>
              <span className="tabular-nums">
                {position.index + 1} of {position.total}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next PR in the list ( ] )"
                disabled={!position.next}
                onClick={() => position.next && onOpenPr(position.next.repo, position.next.number)}
              >
                <Icon name="ChevronDown" className="size-4" />
              </Button>
            </span>
          ) : null}
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
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--prd-radius-control)] border border-border px-3 text-xs font-medium transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent"
            >
              <Icon name="Github" className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Open on GitHub</span>
              <span className="sm:hidden">GitHub</span>
            </UrlLink>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill tone={state.tone} icon={state.icon}>
            {state.label}
          </Pill>
          <span className="truncate tabular-nums">
            {repo}#{number}
          </span>
        </div>
        <h2 className="text-[length:var(--prd-text-title)] font-semibold leading-snug">{detail?.title ?? summary?.title ?? key}</h2>
        {detail ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Avatar login={detail.author} url={detail.authorAvatarUrl} size={18} />
              <span className="font-medium text-foreground">{detail.author}</span>
            </span>
            <span>
              {state.label === "Merged" ? "merged" : state.label === "Closed" ? "wanted to merge" : "wants to merge"}
            </span>
            <code className="max-w-[16rem] truncate font-mono" title={detail.headRefName}>
              {detail.headRefName}
            </code>
            <Icon name="ArrowRight" className="size-3" aria-hidden />
            <code className="max-w-[16rem] truncate font-mono" title={detail.baseRefName}>
              {detail.baseRefName}
            </code>
          </div>
        ) : null}
        {detail && (detail.stackedOn || !detail.onDefaultBranch || stackedAbove.length > 0) ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
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
          <div className="flex flex-wrap items-center gap-2">
            {state.label === "Open" || state.label === "Draft" ? (
              <span className={cn("text-xs font-medium", TONE_TEXT[headTone])}>Not mergeable yet:</span>
            ) : null}
            {blockers.map((b) => (
              <Pill key={b} tone={blockerTone(b)}>
                {b}
              </Pill>
            ))}
          </div>
        ) : null}
      </header>

      {error ? (
        <div role="alert" className="rounded-[var(--prd-radius-panel)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {detail === null ? (
        error ? null : <Skeleton rows={3} />
      ) : (
        <div className="space-y-6">
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
          <div
            ref={arrive}
            className={cn("min-w-0", activeTab === "files" && files && files.length > 1 && "grid gap-8 @4xl:grid-cols-[15rem_minmax(0,1fr)]")}
          >
            {activeTab === "files" && files && files.length > 1 ? (
              <nav
                aria-label="Changed files"
                className="hidden @4xl:sticky @4xl:top-3 @4xl:block @4xl:max-h-[calc(100dvh-6rem)] @4xl:self-start @4xl:overflow-y-auto"
              >
                <FileList files={files} threads={detail.threads} currentFile={currentFile} onJump={(path) => jump(path, "files")} />
              </nav>
            ) : null}
            <div className="min-w-0">
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
                files={files}
                error={filesError}
                target={target?.id ?? null}
                flash={flash}
                onChanged={load}
              />
            ) : null}
            {activeTab === "threads" ? (
              <ThreadsTab
                threads={detail.threads}
                viewer={detail.viewer}
                author={detail.author}
                onPosted={load}
                flash={flash}
                onShowInDiff={(id) => jump(id, "files")}
              />
            ) : null}
            {activeTab === "conversation" ? (
              <ConversationTab timeline={detail.timeline} prUrl={detail.url} subjectId={detail.id} onPosted={load} />
            ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
