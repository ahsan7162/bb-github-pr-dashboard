// The detail view for one PR: CI checks, changed files (with line comments and
// review submission), review threads (with replies), the conversation (with a
// comment box), and closing or reopening the PR.
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Markdown, UrlLink, experimental_useCodeTheme, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { PatchDiff, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import type { rpcContract } from "./server";
import {
  canSubmitReview,
  findingsPrompt,
  fixPrompt,
  jiraHref,
  jiraPrefixes,
  jiraSite,
  linkJira,
  prPrompts,
  fullPatch,
  parsePatch,
  rangeFromSelection,
  reviewEvents,
  toViewerSide,
  threadStatus,
  type CommentRange,
  type FixSubject,
  type ReviewEvent,
  type CheckDetail, type Comment, type Pr, type PrCommit, type PrDetail, type Reviewer, type PrFile, type Thread, type TimelineEntry } from "./prs";
import {
  Avatar,
  EmptyState,
  Kbd,
  LineCount,
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
// `owner/name#123` of PRs just opened from a GitHub link elsewhere in bb; if one cannot load, it goes to GitHub instead.
export const openedFromLink = new Set<string>();

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
  const jira = useContext(JiraContext);
  return (
    <div className="min-w-0 overflow-x-auto break-words text-sm [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
      <Markdown content={jira ? linkJira(content, jira.prefixes, jira.href, jira.plugin) : content} />
    </div>
  );
}

/** How this PR's Jira keys link: to My Jira when it runs, else to the Jira site. Null until known. */
interface JiraLinker {
  prefixes: ReadonlySet<string>;
  href: (key: string) => string | null;
  plugin: boolean;
}
const JiraContext = createContext<JiraLinker | null>(null);
let cachedJira: { plugin: boolean; siteUrl: string | null } | null = null;

/** A title with its Jira keys as links. */
function JiraTitle({ title }: { title: string }) {
  const jira = useContext(JiraContext);
  if (!jira || jira.prefixes.size === 0) return <>{title}</>;
  const parts = title.split(new RegExp(`((?:${[...jira.prefixes].join("|")})-\\d+)`));
  return (
    <>
      {parts.map((part, i) => {
        const to = i % 2 === 1 ? jira.href(part) : null;
        return to ? (
          <UrlLink key={i} href={to} className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground">
            {part}
          </UrlLink>
        ) : (
          part
        );
      })}
    </>
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

// ---- Fix with agent ----

/** The PR on screen, for "Fix with agent" buttons deep in the tabs. */
const PrContext = createContext<PrDetail | null>(null);

/** Sends a comment or failed job to the bb thread on this PR's branch, else opens a new thread prefilled with it. */
/**
 * Hands a prompt to bb: `fix` goes to the thread already on the PR's branch (queued if busy), else opens New thread;
 * `compose` always opens New thread. Either way the PR's project is preselected when one matches.
 */
function useHandOff() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const nav = useBbNavigate();
  const target = (pr: PrDetail) => rpc.call("pr_agent_target", { repo: pr.repo, number: pr.number, headRefName: pr.headRefName });
  const send = async (threadId: string, title: string, prompt: string) => {
    await sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }] });
    toast.success(`Sent to ${title}`, { action: { label: "Open", onClick: () => nav.toThread(threadId) } });
  };
  const handOff = async (pr: PrDetail, prompt: string, mode: "fix" | "compose") => {
    let projectId: string | null = null;
    try {
      const t = await target(pr);
      projectId = t.projectId;
      if (mode === "fix" && t.thread) return await send(t.thread.id, t.thread.title, prompt);
    } catch (cause) {
      if (mode === "fix") {
        toast.error("Could not send it to the PR's thread, so starting a new one", {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    nav.toCompose({ ...(projectId ? { projectId } : {}), initialPrompt: prompt, focusPrompt: true });
  };
  return { handOff, target, send };
}

function FixWithAgent({ subject }: { subject: FixSubject }) {
  const pr = useContext(PrContext);
  const { handOff } = useHandOff();
  const [busy, setBusy] = useState(false);
  if (!pr) return null;
  const run = async () => {
    setBusy(true);
    try {
      await handOff(pr, fixPrompt(pr, subject), "fix");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={run} disabled={busy}>
      <Glyph name="fix" className="size-3.5" />
      Fix with agent
    </Button>
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
      {failing || check.url ? (
      <div className="flex flex-wrap items-center gap-2">
        {failing ? <FixWithAgent subject={{ kind: "check", check }} /> : null}
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
                <CommentBlock key={ci} comment={c} onDeleted={review.onSaved}>
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

function CommentBlock({ comment, onDeleted, children }: { comment: Comment; onDeleted?: () => void; children?: ReactNode }) {
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
          {onDeleted ? <DeleteComment comment={comment} kind="review" onDeleted={onDeleted} /> : null}
        </div>
        {comment.body.trim() ? <Body content={comment.body} /> : null}
      </div>
    </div>
  );
}

/** Delete one of your own comments, after a confirm step. */
function DeleteComment({ comment, kind, onDeleted }: { comment: Comment; kind: "issue" | "review"; onDeleted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const viewer = useContext(PrContext)?.viewer;
  // Write access lets GitHub delete anyone's comment; only offer it on your own.
  if (!comment.canDelete || !comment.id || !viewer || comment.author !== viewer) return null;
  const run = async () => {
    setBusy(true);
    try {
      await rpc.call("pr_delete_comment", { id: comment.id, kind });
      toast.success("Comment deleted");
      onDeleted();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      setConfirming(false);
    }
  };
  return confirming ? (
    <span className="ml-auto inline-flex items-center gap-1">
      <span className="text-muted-foreground">Delete this comment?</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run()}>
        {busy ? "Deleting…" : "Delete"}
      </Button>
    </span>
  ) : (
    <button
      type="button"
      aria-label="Delete comment"
      title="Delete comment"
      onClick={() => setConfirming(true)}
      className="ml-auto inline-flex size-6 items-center justify-center rounded-[var(--prd-radius-control)] text-muted-foreground transition-colors duration-[var(--prd-hover)] hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18" />
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      </svg>
    </button>
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
  const [toggling, setToggling] = useState(false);
  const toggleResolved = async () => {
    setToggling(true);
    try {
      const { resolved } = await rpc.call("pr_resolve_thread", { threadId: thread.id, resolved: !thread.isResolved });
      toast.success(resolved ? "Thread resolved" : "Thread reopened");
      onPosted();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };
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
          <CommentBlock key={i} comment={c} onDeleted={onPosted} />
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
            {thread.id && !thread.isPending && thread.canToggleResolved ? (
              <Button size="sm" variant="outline" disabled={toggling} onClick={() => void toggleResolved()}>
                <Icon name={thread.isResolved ? "RotateCcw" : "CircleCheck"} className="size-3.5" />
                {toggling ? (thread.isResolved ? "Unresolving…" : "Resolving…") : thread.isResolved ? "Unresolve" : "Resolve"}
              </Button>
            ) : null}
            {!thread.isResolved ? <FixWithAgent subject={{ kind: "thread", thread }} /> : null}
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

// ---- Overview: the description, then comments and reviews ----

function ConversationTab({
  timeline,
  prUrl,
  subjectId,
  body,
  canEdit,
  onPosted,
}: {
  timeline: TimelineEntry[];
  prUrl: string;
  subjectId: string;
  body: string;
  canEdit: boolean;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [subjectId]);
  const description = timeline.find((e) => e.url === prUrl);
  const activity = timeline.filter((e) => e !== description);
  return (
    // A conversation is prose: keep its lines readable on wide tabs.
    <div className="max-w-4xl space-y-8">
      {editing ? (
        <section aria-label="Edit the description" className="rounded-[var(--prd-radius-panel)] border border-border bg-muted/30 p-5">
          <InlineEdit
            key={subjectId}
            value={body}
            label="Description"
            multiline
            placeholder="Describe the change (Markdown)"
            onCancel={() => setEditing(false)}
            onSave={async (next) => {
              await rpc.call("pr_edit", { prId: subjectId, body: next });
              toast.success("Description updated");
              setEditing(false);
              onPosted();
            }}
          />
        </section>
      ) : description ? (
        <section aria-label="Description" className="relative space-y-3 overflow-hidden rounded-[var(--prd-radius-panel)] border border-border bg-muted/30 p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Avatar login={description.author} url={description.avatarUrl} size={20} />
            <span className="font-semibold">{description.author}</span>
            <span className="text-muted-foreground">opened this pull request</span>
            <UrlLink href={description.url} className="text-muted-foreground hover:underline">
              {ago(description.createdAt)}
            </UrlLink>
            {canEdit && subjectId ? (
              <span className="ml-auto">
                <EditButton label="Edit description" onClick={() => setEditing(true)} />
              </span>
            ) : null}
          </div>
          <Body content={description.body} />
        </section>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          No description.
          {canEdit && subjectId ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Add one
            </Button>
          ) : null}
        </div>
      )}
      <section aria-label="Activity" className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
        {activity.length === 0 ? (
          <EmptyState icon="MessageSquare">No comments or reviews yet.</EmptyState>
        ) : (
          <Timeline timeline={activity} onDeleted={onPosted} />
        )}
      </section>
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

function Timeline({ timeline, onDeleted }: { timeline: TimelineEntry[]; onDeleted: () => void }) {
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
                  <span className="text-muted-foreground">commented</span>
                )}
                <UrlLink href={entry.url} className="text-muted-foreground hover:underline">
                  {ago(entry.createdAt)}
                </UrlLink>
                {review ? null : <DeleteComment comment={entry} kind="issue" onDeleted={onDeleted} />}
              </div>
              {entry.body.trim() ? <Body content={entry.body} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Newest first; the commits after your latest review are marked, since they are what a re-review covers. */
function CommitsTab({ commits, total, prUrl, myReviewOid }: { commits: PrCommit[]; total: number; prUrl: string; myReviewOid: string | null }) {
  if (commits.length === 0) return <EmptyState icon="GitBranch">No commits.</EmptyState>;
  const reviewed = myReviewOid ? commits.findIndex((c) => c.oid === myReviewOid) : -1;
  return (
    <div className="max-w-4xl space-y-3">
      {total > commits.length ? (
        <p className="text-xs text-muted-foreground">
          The latest {commits.length} of {total} commits.{" "}
          <UrlLink href={`${prUrl}/commits`} className="hover:underline">
            All on GitHub
          </UrlLink>
        </p>
      ) : null}
      <ol className="space-y-1">
        {commits.map((c, i) => (
          <li key={c.oid}>
            {i === reviewed ? (
              <p className={cn("mb-1 mt-3 flex items-center gap-2 text-xs font-medium", i > 0 ? TONE_TEXT.warn : "text-muted-foreground")}>
                <Icon name="Eye" className="size-3.5" aria-hidden />
                {i > 0 ? `Your latest review was here; ${i} new ${i === 1 ? "commit" : "commits"} above` : "Your latest review was on this commit"}
              </p>
            ) : null}
            <div className="relative flex items-center gap-3 rounded-[var(--prd-radius-control)] px-3 py-2 hover:bg-muted/60">
              {reviewed > 0 && i < reviewed ? <Spine tone="warn" /> : null}
              <Avatar login={c.author} url={c.avatarUrl} size={24} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={c.headline}>
                  {c.headline}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.author} committed {ago(c.committedDate)}
                </p>
              </div>
              {c.ci ? (
                <Icon name={STATUS[c.ci].icon} className={cn("size-4 shrink-0", TONE_TEXT[STATUS[c.ci].tone])} aria-label={`CI ${c.ci}`} />
              ) : null}
              <UrlLink
                href={`${prUrl}/commits/${c.oid}`}
                className="shrink-0 rounded-[var(--prd-radius-control)] border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {c.shortOid}
              </UrlLink>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- Page ----

/** Close an open PR (with a confirm step) or reopen a closed one; merged PRs stay merged. */
/** Reopen a closed PR; for an open one, the confirm step after "Close pull request" in the menu. */
function StateButton({
  prId,
  state,
  confirming,
  setConfirming,
  onDone,
}: {
  prId: string;
  state: string;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
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
  ) : null;
}

const GLYPHS: Record<string, ReactNode> = {
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  ask: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  explain: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
  fix: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  out: (
    <>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </>
  ),
  hash: (
    <>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3 8 21" />
      <path d="M16 3l-2 18" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
};
/** Lucide outlines bb's icon set lacks, drawn inline. */
function Glyph({ name, className }: { name: keyof typeof GLYPHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4", className)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPHS[name]}
    </svg>
  );
}

type MenuItem =
  | { label: string; detail?: string; icon: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | "separator";

/** A small menu: arrows move, Enter picks, Esc or a click outside closes. */
function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    root.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };
  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <Button ref={trigger} variant="ghost" size="icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Glyph name="more" />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-50 mt-1 w-80 rounded-[var(--prd-radius-panel)] border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={i} role="separator" className="my-1.5 h-px bg-border" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-[var(--prd-radius-control)] px-2.5 py-2 text-left text-sm outline-none transition-colors duration-[var(--prd-hover)] hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
                  item.danger && "text-destructive",
                )}
              >
                <span className={cn("mt-0.5 shrink-0", item.danger ? "text-destructive" : "text-muted-foreground")}>{item.icon}</span>
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  {item.detail ? <span className="block text-xs text-muted-foreground">{item.detail}</span> : null}
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

type LinkThread = { id: string; title: string; project: string; updatedAt: number };

/** Pick a bb thread to give this PR as context; its branch thread and its project's threads come first. */
function LinkToThread({ pr, onClose }: { pr: PrDetail; onClose: () => void }) {
  const { target, send } = useHandOff();
  const [threads, setThreads] = useState<LinkThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    target(pr).then(
      (t) => setThreads(t.threads),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (threads ?? []).filter((t) => words.every((w) => `${t.title} ${t.project}`.toLowerCase().includes(w)));
  const choose = async (t: LinkThread) => {
    setBusy(true);
    try {
      await send(t.id, t.title, prPrompts.link(pr));
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link this pull request to a thread"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-full max-w-lg space-y-3 rounded-[var(--prd-radius-panel)] border border-border bg-background p-4 shadow-xl"
      >
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Link to thread</h3>
          <p className="text-xs text-muted-foreground">Sends the pull request's link, branch and title to the thread you pick (queued if it is busy).</p>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0] && !busy) void choose(shown[0]);
          }}
          placeholder="Search threads by title or project"
          aria-label="Search threads"
          className="block w-full rounded-[var(--prd-radius-control)] border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : threads === null ? (
          <Skeleton rows={3} />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No threads match.</p>
        ) : (
          <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void choose(t)}
                  className="flex w-full items-center gap-3 rounded-[var(--prd-radius-control)] px-2.5 py-2 text-left outline-none transition-colors duration-[var(--prd-hover)] hover:bg-accent focus-visible:bg-accent disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{t.title}</span>
                    {t.project ? <span className="block truncate text-xs text-muted-foreground">{t.project}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(new Date(t.updatedAt).toISOString())}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The PR's ⋯ menu: hand it to a thread, ask or explain it, fix what blocks it, copy it, close it. */
function PrMenu({ pr, onRefresh, onClose, onLink }: { pr: PrDetail; onRefresh: () => void; onClose: () => void; onLink: () => void }) {
  const { handOff } = useHandOff();
  const subjects: FixSubject[] = [
    ...pr.threads.filter((t) => !!t.id && !t.isResolved && !t.isPending).map((thread) => ({ kind: "thread" as const, thread })),
    ...pr.checks.filter((c) => c.status === "failing").map((check) => ({ kind: "check" as const, check })),
  ];
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error(`Could not copy the ${what}`),
    );
  const items: MenuItem[] = [
    { label: "Link to thread", icon: <Glyph name="link" />, onSelect: onLink },
    { label: "Refresh", icon: <Icon name="RotateCcw" className="size-4" />, onSelect: onRefresh },
    {
      label: "Ask a question",
      detail: "Opens a thread that knows which pull request you mean.",
      icon: <Glyph name="ask" />,
      onSelect: () => void handOff(pr, prPrompts.ask(pr), "compose"),
    },
    {
      label: "Explain this PR",
      detail: "A walk through the diff and what to read closely.",
      icon: <Glyph name="explain" />,
      onSelect: () => void handOff(pr, prPrompts.explain(pr), "compose"),
    },
    {
      label: "Fix findings in a thread",
      detail:
        subjects.length > 0
          ? `${subjects.length} unresolved ${subjects.length === 1 ? "comment or failed job" : "comments and failed jobs"}, to the branch's thread or a new one.`
          : "Nothing unresolved or failing.",
      icon: <Glyph name="fix" />,
      disabled: subjects.length === 0,
      onSelect: () => void handOff(pr, findingsPrompt(pr, subjects), "fix"),
    },
    "separator",
    { label: "Open on GitHub", icon: <Glyph name="out" />, onSelect: () => window.open(pr.url, "_blank", "noopener") },
    { label: "Copy link", icon: <Icon name="Copy" className="size-4" />, onSelect: () => void copy(pr.url, "link") },
    { label: "Copy PR number", icon: <Glyph name="hash" />, onSelect: () => void copy(`#${pr.number}`, "PR number") },
    ...(pr.state === "OPEN"
      ? (["separator", { label: "Close pull request", icon: <Icon name="GitPullRequestClosed" className="size-4" />, danger: true, onSelect: onClose }] as MenuItem[])
      : []),
  ];
  return <Menu label="Pull request actions" items={items} />;
}

/** Draft to Ready for review and back, on your own open PRs only. */
function DraftButton({ prId, state, isDraft, onDone }: { prId: string; state: string; isDraft: boolean; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  if (!prId || state !== "OPEN") return null;
  const run = async () => {
    setBusy(true);
    try {
      await rpc.call("pr_set_state", { prId, action: isDraft ? "ready" : "draft" });
      toast.success(isDraft ? "Ready for review" : "Converted to draft");
      onDone();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return isDraft ? (
    <Button size="sm" disabled={busy} onClick={() => void run()}>
      <Icon name="Eye" className="size-3.5" />
      {busy ? "Marking…" : "Ready for review"}
    </Button>
  ) : (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run()}>
      <Icon name="GitPullRequestDraft" className="size-3.5" />
      {busy ? "Converting…" : "Convert to draft"}
    </Button>
  );
}

/** A small pencil button; bb's icon set has no pencil, so it is drawn here. */
function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--prd-radius-control)] text-muted-foreground transition-colors duration-[var(--prd-hover)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
        <path d="m15 5 4 4" />
      </svg>
    </button>
  );
}

/** Edit one text in place; nothing is sent until Save. onSave throws to keep the editor open with the error. */
function InlineEdit({
  value,
  label,
  multiline,
  placeholder,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = multiline ? draft : draft.trim();
  const canSave = next !== value && (multiline || next !== "") && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };
  const field =
    "block w-full rounded-[var(--prd-radius-control)] border border-input bg-background px-3 py-2 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      {multiline ? (
        <textarea
          aria-label={label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          autoFocus
          placeholder={placeholder}
          rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
          className={cn(field, "resize-y font-mono text-xs leading-relaxed")}
        />
      ) : (
        <input aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} autoFocus className={cn(field, "text-base font-semibold")} />
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {multiline ? "Markdown, ⌘↵ to save" : "↵ to save"}, Esc to cancel. Saves to GitHub as you.
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

const REVIEWER: Record<string, { label: string; icon: string; tone: Tone }> = {
  REQUESTED: { label: "review requested", icon: "Clock", tone: "warn" },
  APPROVED: { label: "approved", icon: "CircleCheck", tone: "good" },
  CHANGES_REQUESTED: { label: "requested changes", icon: "CircleX", tone: "bad" },
  COMMENTED: { label: "commented", icon: "MessageSquare", tone: "neutral" },
  DISMISSED: { label: "review dismissed", icon: "Minus", tone: "neutral" },
};

function ReviewerChip({ reviewer }: { reviewer: Reviewer }) {
  const s = REVIEWER[reviewer.state] ?? REVIEWER.COMMENTED!;
  return (
    <span className="inline-flex items-center gap-1.5" title={`${reviewer.name}: ${s.label}`}>
      <Avatar login={reviewer.name} url={reviewer.avatarUrl} size={18} />
      <span className="font-medium text-foreground">{reviewer.team ? `@${reviewer.name}` : reviewer.name}</span>
      <Icon name={s.icon} className={cn("size-3.5", TONE_TEXT[s.tone])} aria-label={s.label} />
    </span>
  );
}

/** A branch name that copies itself on click. */
function BranchName({ name }: { name: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy branch ${name}`}
      onClick={() =>
        navigator.clipboard.writeText(name).then(
          () => toast.success(`Copied ${name}`),
          () => toast.error("Could not copy the branch name"),
        )
      }
      className="group/branch inline-flex max-w-[16rem] items-center gap-1 rounded-[var(--prd-radius-control)] px-1 font-mono transition-colors duration-[var(--prd-hover)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate">{name}</span>
      <Icon name="Copy" className="size-3 shrink-0 opacity-0 transition-opacity group-hover/branch:opacity-100 group-focus-visible/branch:opacity-100" aria-hidden />
    </button>
  );
}

type DetailTab = "checks" | "files" | "commits" | "threads" | "conversation";

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
              {/* The whole name on its own line; the folder under it loses its start, not its end. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 font-mono text-xs">
                <span className="break-all">{f.path.slice(slash + 1)}</span>
                {slash > 0 ? (
                  <span dir="rtl" className="truncate text-left text-[11px] text-muted-foreground">
                    <bdi dir="ltr">{f.path.slice(0, slash)}</bdi>
                  </span>
                ) : null}
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
  const navNow = useBbNavigate();
  // A ref, as useBbNavigate() changes with the route and load must not refetch on that.
  const nav = useRef(navNow);
  nav.current = navNow;
  const [detail, setDetail] = useState<PrDetail | null>(cachedDetails.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<DetailTab | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [linking, setLinking] = useState(false);
  const [jira, setJira] = useState(cachedJira);
  useEffect(() => {
    if (cachedJira) return;
    rpc.call("jira_link", {}).then(
      (r) => {
        cachedJira = r;
        setJira(r);
      },
      () => {},
    );
  }, [rpc]);
  // Previous and Next keep this view mounted: never carry an open editor to another PR.
  useEffect(() => {
    setEditing(false);
    setConfirmClose(false);
    setLinking(false);
  }, [repo, number]);
  const load = useCallback(() => {
    setLoading(true);
    rpc
      .call("pr_detail", { repo, number })
      .then(
        (result) => {
          openedFromLink.delete(key);
          cachedDetails.set(key, result);
          setDetail(result);
          setError(null);
        },
        (cause: unknown) => {
          // Opened from a link and nothing to show: open it on GitHub as bb would have, and go back to the link.
          if (openedFromLink.delete(key) && !cachedDetails.has(key)) {
            nav.current.openUrl(`https://github.com/${repo}/pull/${number}`);
            history.back();
            return;
          }
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => setLoading(false));
  }, [rpc, repo, number, key]);
  useEffect(load, [load]);
  // Leaving before it loads: a late failure must not send you anywhere.
  useEffect(() => () => void openedFromLink.delete(key), [key]);

  const state = prState(detail ?? summary ?? { isDraft: false });
  // The stack line below the title already says "Stacked on #N", with a link.
  const blockers = (summary?.blockers ?? []).filter((b) => !b.startsWith("Stacked on"));
  const activeTab = tab ?? (detail ? firstTab(detail) : "checks");
  const { files, error: filesError } = usePrFiles(repo, number, activeTab === "files");
  const failing = detail?.checks.filter((c) => c.status === "failing").length ?? 0;
  const unresolved = detail?.threads.filter((t) => !t.isResolved && !t.isPending).length ?? 0;
  const drafts = detail?.threads.filter((t) => t.isPending).length ?? 0;
  const comments = detail?.timeline.filter((e) => e.url !== detail.url).length ?? 0;
  // Commits since your latest review, when that review is on one of the commits loaded.
  const reviewedAt = detail?.myReviewOid ? detail.commits.findIndex((c) => c.oid === detail.myReviewOid) : -1;
  // Not found (a force-push, or older than the last 100): everything loaded came after it.
  const newCommits = detail?.state !== "OPEN" || !detail.myReviewOid ? 0 : reviewedAt === -1 ? detail.commits.length : reviewedAt;
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

  const jiraLinker = useMemo<JiraLinker | null>(() => {
    if (!detail || !jira) return null;
    const target = { plugin: jira.plugin, siteUrl: jira.siteUrl ?? jiraSite(detail.body) };
    return { prefixes: jiraPrefixes(detail.title, detail.headRefName, detail.body), href: (k) => jiraHref(k, target), plugin: target.plugin };
  }, [detail, jira]);

  return (
    <JiraContext.Provider value={jiraLinker}>
    {linking && detail ? <LinkToThread pr={detail} onClose={() => setLinking(false)} /> : null}
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
            {detail && detail.viewer === detail.author ? (
              <DraftButton
                prId={detail.id}
                state={detail.state}
                isDraft={detail.isDraft}
                onDone={() => {
                  load();
                  onStateChanged();
                }}
              />
            ) : null}
            {detail ? (
              <StateButton
                prId={detail.id}
                state={detail.state}
                confirming={confirmClose}
                setConfirming={setConfirmClose}
                onDone={() => {
                  load();
                  onStateChanged();
                }}
              />
            ) : null}
            {loading ? <Icon name="RotateCcw" className="size-4 animate-spin text-muted-foreground" aria-label="Refreshing" /> : null}
            <UrlLink
              href={`https://github.com/${repo}/pull/${number}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--prd-radius-control)] border border-border px-3 text-xs font-medium transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent"
            >
              <Icon name="Github" className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Open on GitHub</span>
              <span className="sm:hidden">GitHub</span>
            </UrlLink>
            {detail ? <PrMenu pr={detail} onRefresh={load} onClose={() => setConfirmClose(true)} onLink={() => setLinking(true)} /> : null}
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
        {detail && editing ? (
          <InlineEdit
            key={detail.id}
            value={detail.title}
            label="Title"
            onCancel={() => setEditing(false)}
            onSave={async (title) => {
              await rpc.call("pr_edit", { prId: detail.id, title });
              toast.success("Title updated");
              setEditing(false);
              load();
              onStateChanged();
            }}
          />
        ) : (
          <div className="flex items-start gap-1.5">
            <h2 className="min-w-0 text-[length:var(--prd-text-title)] font-semibold leading-snug">
              <JiraTitle title={detail?.title ?? summary?.title ?? key} />
            </h2>
            {detail?.canEdit ? <EditButton label="Edit title" onClick={() => setEditing(true)} /> : null}
          </div>
        )}
        {detail ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Avatar login={detail.author} url={detail.authorAvatarUrl} size={18} />
              <span className="font-medium text-foreground">{detail.author}</span>
            </span>
            <span>
              {state.label === "Merged" ? "merged" : state.label === "Closed" ? "wanted to merge" : "wants to merge"}
            </span>
            <BranchName name={detail.headRefName} />
            <Icon name="ArrowRight" className="size-3" aria-hidden />
            <BranchName name={detail.baseRefName} />
            <span className="ml-1 inline-flex items-center gap-1.5">
              <LineCount additions={detail.additions} deletions={detail.deletions} />
              <span>
                in {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
              </span>
            </span>
          </div>
        ) : null}
        {detail && (detail.reviewers.length > 0 || detail.labels.length > 0) ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {detail.reviewers.length > 0 ? (
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span>Reviewers</span>
                {detail.reviewers.map((r) => (
                  <ReviewerChip key={r.name} reviewer={r} />
                ))}
              </span>
            ) : null}
            {detail.labels.length > 0 ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="mr-0.5">Labels</span>
                {detail.labels.map((l) => (
                  <span key={l.name} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-foreground">
                    <span className="size-2 shrink-0 rounded-full bg-muted-foreground" style={l.color ? { background: `#${l.color}` } : undefined} aria-hidden />
                    {l.name}
                  </span>
                ))}
              </span>
            ) : null}
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
              { id: "conversation", label: "Overview", icon: "FileText", count: comments },
              { id: "checks", label: "Checks", icon: "CircleCheck", count: detail.checks.length, countTone: failing > 0 ? "bad" : "neutral" },
              { id: "files", label: "Files", icon: "FileDiff", count: detail.changedFiles, countTone: drafts > 0 ? "warn" : "neutral" },
              { id: "commits", label: "Commits", icon: "GitBranch", count: detail.commitCount, countTone: newCommits > 0 ? "warn" : "neutral" },
              { id: "threads", label: "Comments", icon: "MessageSquare", count: unresolved, countTone: unresolved > 0 ? "bad" : "neutral" },
            ]}
          />
          <div
            ref={arrive}
            className={cn("min-w-0", activeTab === "files" && files && files.length > 1 && "grid gap-8 @4xl:grid-cols-[18rem_minmax(0,1fr)]")}
          >
            {activeTab === "files" && files && files.length > 1 ? (
              <nav
                aria-label="Changed files"
                className="hidden @4xl:sticky @4xl:top-3 @4xl:block @4xl:max-h-[calc(100dvh-6rem)] @4xl:self-start @4xl:overflow-y-auto"
              >
                <FileList files={files} threads={detail.threads} currentFile={currentFile} onJump={(path) => jump(path, "files")} />
              </nav>
            ) : null}
            <PrContext.Provider value={detail}>
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
            {activeTab === "commits" ? (
              <CommitsTab commits={detail.commits} total={detail.commitCount} prUrl={detail.url} myReviewOid={detail.myReviewOid} />
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
              <ConversationTab timeline={detail.timeline} prUrl={detail.url} subjectId={detail.id} body={detail.body} canEdit={detail.canEdit} onPosted={load} />
            ) : null}
            </div>
            </PrContext.Provider>
          </div>
        </div>
      )}
    </div>
    </JiraContext.Provider>
  );
}
