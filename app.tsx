// bb-github-pr-dashboard — frontend entry: the "My PRs" page in the nav rail.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, definePluginApp, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { matchesSearch, type Pr, type PrList } from "./prs";
import "./tokens.css";
import { PrDetailView, type ListPosition } from "./detail";
import { AlertListener, AlertsStrip, NotificationSettings, useAlertBadge } from "./alerts";
import {
  EmptyState,
  Kbd,
  Pill,
  Segmented,
  Skeleton,
  TONE_TEXT,
  ago,
  blockerTone,
  prState,
  Spine,
  type Tone,
  reducedMotion,
  useArrive,
} from "./parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Tab = "open" | "review" | "assigned" | "merged" | "closed";

const EMPTY: Record<Tab, string> = {
  open: "You have no open pull requests.",
  review: "No reviews are waiting on you or your teams.",
  assigned: "No open pull requests are assigned to you.",
  merged: "No merged pull requests yet.",
  closed: "No closed pull requests.",
};

// Survives remounts (bb remounts the page on resize or when you come back to
// it), so the last result shows at once while a refresh runs.
let cachedLists: Partial<Record<Tab, PrList>> = {};
let cachedCounts: Record<Tab, number> | null = null;
let cachedAt: string | null = null;
let lastTab: Tab = "open";
let lastQuery = "";
// The list as last shown (filters and folds applied), for Previous and Next on a PR.
let listOrder: { repo: string; number: number }[] = [];
// Where you were in the list, and the row you opened, so coming back lands there.
let listScroll = 0;
let lastOpened: string | null = null;

// Repos you chose not to see, on every tab; kept across restarts. A hide list, so a new repo shows up.
const HIDDEN_KEY = "bb-github-pr-dashboard:hidden-repos";
// Repo groups you folded, as "tab:owner/name", so each tab keeps its own.
const COLLAPSED_KEY = "bb-github-pr-dashboard:collapsed-repos";
function loadList(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}
function saveList(key: string, values: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // storage can be unavailable; the choice then lasts for this visit
  }
}

// With a search or hidden repos, this many matches show at most.
const MATCHES_SHOWN = 100;

type HistoryTab = "merged" | "closed";
const cachedHistory: Partial<Record<HistoryTab, PrList>> = {};

/**
 * On Merged and Closed, every PR (prs_list has only the latest 30), so Repos and search reach them all.
 * Loaded only once `wanted`: Repos is open, a search is typed, or a repo is hidden.
 */
function useHistory(tab: Tab, wanted: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const state: HistoryTab | null = tab === "merged" || tab === "closed" ? tab : null;
  const [lists, setLists] = useState({ ...cachedHistory });
  const [busy, setBusy] = useState<HistoryTab | null>(null);
  const [failed, setFailed] = useState<HistoryTab | null>(null);
  const load = useCallback(
    (s: HistoryTab) => {
      setBusy(s);
      rpc
        .call("prs_history", { state: s })
        .then(
          (r) => {
            cachedHistory[s] = r;
            setLists({ ...cachedHistory });
            setFailed(null);
          },
          () => setFailed(s), // the latest 30 from prs_list stay on screen
        )
        .finally(() => setBusy((b) => (b === s ? null : b)));
    },
    [rpc],
  );
  useEffect(() => {
    // A failure is not retried on its own (Refresh does), so a GitHub outage never loops.
    if (state && wanted && !cachedHistory[state] && busy !== state && failed !== state) load(state);
  }, [state, wanted, load, busy, failed]);
  return {
    history: state ? lists[state] : undefined,
    loading: state !== null && busy === state,
    failed: state !== null && failed === state,
    reload: () => {
      if (state && (cachedHistory[state] || failed === state)) load(state);
    },
  };
}

/** A tab's PRs load when the tab is first opened (and again when My PRs opens); each request also brings every tab's count. */
function usePrs(tab: Tab) {
  const rpc = useRpc<typeof rpcContract>();
  const [lists, setLists] = useState(cachedLists);
  const [counts, setCounts] = useState(cachedCounts);
  const [fetchedAt, setFetchedAt] = useState(cachedAt);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (t: Tab, { forgetOthers = false } = {}) => {
      setLoading(true);
      rpc
        .call("prs_list", { tab: t })
        .then(
          (r) => {
            cachedLists = forgetOthers ? { [t]: r.list } : { ...cachedLists, [t]: r.list };
            cachedCounts = r.counts;
            cachedAt = r.fetchedAt;
            setLists(cachedLists);
            setCounts(r.counts);
            setFetchedAt(r.fetchedAt);
            setError(null);
          },
          (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc],
  );
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current || !cachedLists[tab]) load(tab);
    opened.current = true;
  }, [tab, load]);
  return {
    lists,
    counts,
    fetchedAt,
    error,
    loading,
    refetch: () => load(tab),
    /** After closing or reopening a PR: it moved tabs, so the others reload when next opened. */
    refetchAll: () => load(tab, { forgetOthers: true }),
  };
}

const CI: Record<Pr["ci"], { icon: string; tone: Tone; label: string } | null> = {
  passing: { icon: "CircleCheck", tone: "good", label: "CI passing" },
  failing: { icon: "CircleX", tone: "bad", label: "CI failing" },
  pending: { icon: "Clock", tone: "warn", label: "CI running" },
  none: null,
};

/** The row's spine colour: its worst blocker, else its state. */
function rowTone(pr: Pr, isOpen: boolean): Tone {
  const state = prState(pr);
  if (!isOpen) return state.label === "Merged" ? "merged" : "neutral";
  if (pr.ci === "failing" || pr.blockers.some((b) => blockerTone(b) === "bad")) return "bad";
  if (pr.ci === "pending" || pr.blockers.some((b) => blockerTone(b) === "warn")) return "warn";
  return pr.blockers.length === 0 ? "good" : "neutral";
}

function PrRow({ pr, onOpen, showAuthor }: { pr: Pr; onOpen: () => void; showAuthor: boolean }) {
  const state = prState(pr);
  const isOpen = state.label === "Open" || state.label === "Draft";
  const ci = isOpen ? CI[pr.ci] : null;
  // A failing or running CI leads the blockers; a passing one sits in the meta line.
  const blocking = ci && pr.ci !== "passing" ? ci : null;
  const pills = pr.blockers.filter((b) => !b.startsWith("CI "));
  const when = pr.mergedAt
    ? `merged ${ago(pr.mergedAt)}`
    : pr.closedAt
      ? `closed ${ago(pr.closedAt)}`
      : `updated ${ago(pr.updatedAt)}`;
  return (
    <li className="group relative flex items-start gap-1 transition-[transform,background-color] duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:-translate-y-px hover:bg-muted/40 active:translate-y-0 active:bg-muted/60">
      <Spine tone={rowTone(pr, isOpen)} />
      <button
        onClick={onOpen}
        data-pr-row={pr.id}
        className="flex min-w-0 flex-1 items-start gap-3 py-4 pl-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 space-y-2">
          <span className="flex items-start gap-2">
            <Icon name={state.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[state.tone])} aria-label={state.label} />
            <span className="line-clamp-2 text-[length:var(--prd-text-row)] font-semibold leading-snug">{pr.title}</span>
          </span>
          {isOpen ? (
            <span className="flex flex-wrap gap-2">
              {blocking ? (
                <Pill tone={blocking.tone} icon={blocking.icon}>
                  {blocking.label}
                </Pill>
              ) : null}
              {pr.blockers.length === 0 ? (
                <Pill tone="good" icon="CircleCheck">
                  {pr.reviewDecision === "APPROVED" ? "Approved, ready to merge" : "Nothing blocking"}
                </Pill>
              ) : (
                pills.map((b) => (
                  <Pill key={b} tone={blockerTone(b)}>
                    {b}
                  </Pill>
                ))
              )}
            </span>
          ) : null}
          {isOpen && pr.failingChecks.length > 0 ? (
            <span className="block space-y-1 text-xs text-destructive">
              {pr.failingChecks.map((c, i) => (
                <span key={`${c.name}-${i}`} className="flex min-w-0 items-center gap-1">
                  <Icon name="CircleX" className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    {c.workflow ? <span className="opacity-75">{c.workflow} › </span> : null}
                    {c.name}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">#{pr.number}</span>
            {showAuthor ? <span>by {pr.author}</span> : null}
            <span>{when}</span>
            {ci && pr.ci === "passing" ? (
              <span className={cn("inline-flex items-center gap-1", TONE_TEXT[ci.tone])}>
                <Icon name={ci.icon} className="size-3.5" aria-hidden />
                {ci.label}
              </span>
            ) : null}
          </span>
        </span>
        <Icon
          name="ChevronRight"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-[var(--prd-hover)] group-hover:opacity-100"
          aria-hidden
        />
      </button>
      <UrlLink
        href={pr.url}
        aria-label={`Open #${pr.number} on GitHub`}
        className="mr-4 mt-3.5 rounded-[var(--prd-radius-control)] p-1 text-muted-foreground transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent hover:text-foreground"
      >
        <Icon name="ExternalLink" className="size-3.5" />
      </UrlLink>
    </li>
  );
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone: Tone; icon: string }) {
  const active = value > 0;
  return (
    <div className="rounded-[var(--prd-radius-panel)] border border-border px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className={cn("size-3.5", active && TONE_TEXT[tone])} aria-hidden />
        {label}
      </div>
      <div className={cn("mt-1 text-[length:var(--prd-text-title)] font-semibold tabular-nums", active ? TONE_TEXT[tone] : "text-muted-foreground")}>
        {value}
      </div>
    </div>
  );
}

function OpenStats({ items }: { items: Pr[] }) {
  const count = (test: (pr: Pr) => boolean) => items.filter(test).length;
  return (
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4 @6xl:grid-cols-2">
      <Stat label="CI failing" icon="CircleX" tone="bad" value={count((p) => p.ci === "failing")} />
      <Stat label="Unresolved comments" icon="MessageSquare" tone="bad" value={count((p) => p.unresolvedThreads > 0)} />
      <Stat
        label="Changes requested"
        icon="FileDiff"
        tone="warn"
        value={count((p) => p.reviewDecision === "CHANGES_REQUESTED")}
      />
      <Stat label="Ready to merge" icon="GitMerge" tone="good" value={count((p) => p.blockers.length === 0)} />
    </div>
  );
}

function groupByRepo(items: Pr[]): [string, Pr[]][] {
  const groups = new Map<string, Pr[]>();
  for (const pr of items) groups.set(pr.repo, [...(groups.get(pr.repo) ?? []), pr]);
  return [...groups]; // insertion order: the repo with the most recent update first
}

function RepoHeader({
  repo,
  count,
  collapsed,
  onToggle,
  onHide,
}: {
  repo: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onHide: () => void;
}) {
  const [owner, name] = repo.split("/");
  return (
    <h3 className="group/repo flex min-w-0 items-center gap-2 px-1 text-sm">
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Show the PRs in ${repo}` : `Fold the PRs in ${repo}`}
        className="-ml-1 flex min-w-0 items-center gap-2 rounded-[var(--prd-radius-control)] px-1 py-0.5 outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon
          name="ChevronDown"
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--prd-hover)] ease-[var(--prd-ease-out)]", collapsed && "-rotate-90")}
          aria-hidden
        />
        <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">
          <span className="text-muted-foreground">{owner}/</span>
          <span className="font-semibold">{name}</span>
        </span>
        <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{count}</span>
      </button>
      <button
        onClick={onHide}
        title={`Hide ${repo}`}
        className="ml-auto rounded-[var(--prd-radius-control)] px-2 py-0.5 text-xs text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/repo:opacity-100"
      >
        Hide repo
      </button>
    </h3>
  );
}

/** A repo's rows; they arrive (fade and rise) when the group opens. */
function RepoRows({ children }: { children: ReactNode }) {
  const ref = useArrive<HTMLUListElement>(null);
  return (
    <ul ref={ref} className="divide-y divide-border overflow-hidden rounded-[var(--prd-radius-panel)] border border-border">
      {children}
    </ul>
  );
}

function ListView({
  prs: { lists, counts, fetchedAt, error, loading, refetch },
  tab,
  setTab,
  onOpen,
}: {
  prs: ReturnType<typeof usePrs>;
  tab: Tab;
  setTab: (tab: Tab) => void;
  onOpen: (pr: Pr) => void;
}) {
  const list = lists[tab];
  const pluginId = experimental_usePluginId();
  const [query, setQueryState] = useState(lastQuery);
  const setQuery = (q: string) => {
    lastQuery = q;
    setQueryState(q);
  };
  const [hidden, setHiddenState] = useState<string[]>(() => loadList(HIDDEN_KEY));
  const setHidden = (repos: string[]) => {
    saveList(HIDDEN_KEY, repos);
    setHiddenState(repos);
  };
  const toggleRepo = (repo: string) => setHidden(hidden.includes(repo) ? hidden.filter((r) => r !== repo) : [...hidden, repo]);
  const [collapsed, setCollapsedState] = useState<string[]>(() => loadList(COLLAPSED_KEY));
  const toggleCollapsed = (repo: string) => {
    const key = `${tab}:${repo}`;
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    saveList(COLLAPSED_KEY, next);
    setCollapsedState(next);
  };
  const [reposOpen, setReposOpen] = useState(false);
  const wantHistory = reposOpen || query.trim() !== "" || !!list?.items.some((p) => hidden.includes(p.repo));
  const { history, loading: historyLoading, failed: historyFailed, reload: reloadHistory } = useHistory(tab, wantHistory);
  // Merged and Closed filter and search their whole history once it has loaded.
  const source = history ?? list;
  // The choices on each tab are the repos in that tab's list; the hide list itself is shared by every tab.
  const perRepo = new Map<string, number>();
  for (const p of source?.items ?? []) perRepo.set(p.repo, (perRepo.get(p.repo) ?? 0) + 1);
  const repos = [...perRepo.keys()].sort();
  const hiddenCount = repos.filter((r) => hidden.includes(r)).length;
  const showAll = () => setHidden(hidden.filter((r) => !repos.includes(r)));
  const hideAll = () => setHidden([...new Set([...hidden, ...repos])]);
  const filtering = query.trim() !== "" || hiddenCount > 0;
  const matches = source?.items.filter((p) => !hidden.includes(p.repo) && matchesSearch(p, query));
  // Unfiltered, a tab shows the page prs_list loaded; filtered, up to MATCHES_SHOWN matches from everything.
  const items = matches?.slice(0, filtering ? MATCHES_SHOWN : (list?.items.length ?? 0));
  const inHidden = source?.items.filter((p) => hidden.includes(p.repo)).length ?? 0;
  const groups = items ? groupByRepo(items) : [];
  const isFolded = (repo: string) => collapsed.includes(`${tab}:${repo}`);
  const allFolded = groups.length > 0 && groups.every(([repo]) => isFolded(repo));
  const foldAll = (fold: boolean) => {
    const keys = groups.map(([repo]) => `${tab}:${repo}`);
    const next = fold ? [...new Set([...collapsed, ...keys])] : collapsed.filter((k) => !keys.includes(k));
    saveList(COLLAPSED_KEY, next);
    setCollapsedState(next);
  };
  useEffect(() => {
    listOrder = groups.filter(([repo]) => !isFolded(repo)).flatMap(([, prs]) => prs.map((p) => ({ repo: p.repo, number: p.number })));
  });

  // Coming back from a PR: focus its row, so j/k and Enter carry on from there.
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!lastOpened) return;
    root.current?.querySelector<HTMLElement>(`[data-pr-row="${CSS.escape(lastOpened)}"]`)?.focus({ preventScroll: true });
    lastOpened = null;
  }, []);
  // j/k between PRs (Enter opens the focused one), / to search; never while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !["j", "k", "/"].includes(e.key)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && t !== document.body && !root.current?.contains(t)) return;
      if (t?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog]")) return;
      e.preventDefault();
      if (e.key === "/") return search.current?.focus();
      const rows = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-pr-row]") ?? []);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const forward = e.key === "j";
      const next = rows[at < 0 ? (forward ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (forward ? 1 : -1)))];
      next?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Wide tabs, Open tab: alerts and totals move to a right column beside the PRs.
  const side = tab === "open" && !!items && items.length > 0;
  return (
    <div ref={root} className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Pull request state"
          value={tab}
          onChange={setTab}
          options={[
            { id: "open", label: "Open", icon: "GitPullRequest", count: counts?.open },
            {
              id: "review",
              label: "Review requested",
              icon: "Eye",
              count: counts?.review,
              countTone: counts && counts.review > 0 ? "warn" : "neutral",
            },
            { id: "assigned", label: "Assigned", icon: "UserRound", count: counts?.assigned },
            { id: "merged", label: "Merged", icon: "GitMerge", count: counts?.merged },
            { id: "closed", label: "Closed", icon: "GitPullRequestClosed", count: counts?.closed },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          {fetchedAt ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">Updated {ago(fetchedAt)}</span>
          ) : null}
          <UrlLink
            href={`/settings/plugins/${pluginId}`}
            aria-label="Notification settings"
            title="Notification settings"
            className="inline-flex size-9 items-center justify-center rounded-[var(--prd-radius-control)] text-muted-foreground transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent hover:text-foreground"
          >
            <Icon name="BellDot" className="size-4" />
          </UrlLink>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            disabled={loading}
            onClick={() => {
              refetch();
              reloadHistory();
            }}
          >
            <Icon name="RotateCcw" className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>
      {repos.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-sm">
              <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={search}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, #number, repo or author"
                aria-label="Search pull requests"
                className="rounded-[var(--prd-radius-control)] pl-9 pr-9"
              />
              {query ? null : (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" aria-hidden>
                  <Kbd>/</Kbd>
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" aria-expanded={reposOpen} onClick={() => setReposOpen(!reposOpen)}>
              <Icon name="SlidersHorizontal" className="size-3.5" />
              Repos
              <span className="tabular-nums text-muted-foreground">
                {hiddenCount > 0 ? `${repos.length - hiddenCount} of ${repos.length}` : repos.length}
              </span>
            </Button>
            {inHidden > 0 ? (
              <span className="text-xs text-muted-foreground">
                {inHidden} PR{inHidden === 1 ? "" : "s"} on this tab in hidden repos
              </span>
            ) : null}
            {groups.length > 1 ? (
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => foldAll(!allFolded)}>
                <Icon name={allFolded ? "ChevronDown" : "ChevronUp"} className="size-3.5" />
                {allFolded ? "Expand all" : "Collapse all"}
              </Button>
            ) : null}
            {historyLoading ? (
              <span className="text-xs text-muted-foreground">Loading all {list?.total} for Repos and search…</span>
            ) : historyFailed ? (
              <span className="text-xs text-warning-text">Could not load the older ones; Repos and search cover the latest {list?.items.length}.</span>
            ) : null}
          </div>
          {reposOpen ? (
            <div role="group" aria-label="Repos to show" className="flex flex-wrap items-center gap-2 rounded-[var(--prd-radius-panel)] border border-border p-4">
              {repos.map((r) => {
                const shown = !hidden.includes(r);
                return (
                  <button
                    key={r}
                    aria-pressed={shown}
                    onClick={() => toggleRepo(r)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] focus-visible:ring-2 focus-visible:ring-ring",
                      shown
                        ? "border-border bg-muted text-foreground hover:bg-muted/60"
                        : "border-dashed border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon name={shown ? "CircleCheck" : "Circle"} className="size-3.5" aria-hidden />
                    {r}
                    <span className="tabular-nums text-muted-foreground">{perRepo.get(r)}</span>
                  </button>
                );
              })}
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" disabled={hiddenCount === 0} onClick={showAll}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" disabled={hiddenCount === repos.length} onClick={hideAll}>
                  Deselect all
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-[var(--prd-radius-panel)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {/* Same tree on every tab, so the alerts strip never remounts (it marks alerts seen on mount). */}
      <div className={cn("grid gap-6", side && "@6xl:grid-cols-[minmax(0,1fr)_22rem] @6xl:items-start @6xl:gap-8")}>
        <aside className={cn("min-w-0 space-y-6 empty:hidden", side && "@6xl:sticky @6xl:top-3 @6xl:col-start-2 @6xl:row-start-1")}>
          <AlertsStrip />
          {side ? <OpenStats items={items} /> : null}
        </aside>
        <div className={cn("min-w-0 space-y-6", side && "@6xl:col-start-1 @6xl:row-start-1")}>
      {source === undefined || matches === undefined || items === undefined ? (
        error ? null : <Skeleton rows={4} />
      ) : (
        <>
          {source.items.length === 0 ? (
            <EmptyState icon="GitPullRequest">{EMPTY[tab]}</EmptyState>
          ) : items.length === 0 ? (
            <EmptyState icon="Search">
              <span>No PRs on this tab match.</span>
              <span className="flex gap-2">
                {query.trim() ? (
                  <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : null}
                {inHidden > 0 ? (
                  <Button size="sm" variant="outline" onClick={showAll}>
                    Show hidden repos
                  </Button>
                ) : null}
              </span>
            </EmptyState>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,30rem),1fr))] items-start gap-6">
            {groups.map(([repo, prs]) => {
              const folded = isFolded(repo);
              return (
                <section key={repo} className="min-w-0 space-y-2">
                  <RepoHeader
                    repo={repo}
                    count={prs.length}
                    collapsed={folded}
                    onToggle={() => toggleCollapsed(repo)}
                    onHide={() => toggleRepo(repo)}
                  />
                  {folded ? null : (
                    <RepoRows>
                      {prs.map((pr) => (
                        <PrRow
                          key={pr.id}
                          pr={pr}
                          onOpen={() => onOpen(pr)}
                          showAuthor={tab === "review" || tab === "assigned"}
                        />
                      ))}
                    </RepoRows>
                  )}
                </section>
              );
            })}
            </div>
          )}
          {items.length > 0 ? (
            <p className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              <span className="mr-3">move between PRs,</span>
              <Kbd>↵</Kbd>
              <span className="mr-3">opens one,</span>
              <Kbd>/</Kbd>
              <span>searches</span>
            </p>
          ) : null}
          {items.length < (filtering ? matches.length : source.total) ? (
            <p className="text-center text-xs text-muted-foreground">
              {filtering
                ? `Showing the ${items.length} most recently updated of ${matches.length} matches.`
                : `Showing the ${items.length} most recently updated of ${source.total}.${history ? " Search or pick repos to reach the older ones." : ""}`}
              {history && history.total > history.items.length ? ` GitHub search goes back ${history.items.length} PRs.` : ""}
            </p>
          ) : null}
        </>
      )}
        </div>
      </div>
    </div>
  );
}

/** `owner/name/123` (each segment percent-encoded) → the PR it names. */
function parseRoute(subPath: string): { repo: string; number: number } | null {
  try {
    const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3 || !/^\d+$/.test(parts[2]!)) return null;
    return { repo: `${parts[0]}/${parts[1]}`, number: Number(parts[2]) };
  } catch {
    return null; // malformed % escape in a hand-typed URL
  }
}

function PrsPage({ subPath }: { subPath: string }) {
  // Owned here, not in ListView, so the list and tab survive a visit to a PR.
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (next: Tab) => {
    lastTab = next;
    setTabState(next);
  };
  const prs = usePrs(tab);
  const nav = useBbNavigate();
  const route = parseRoute(subPath);
  // A PR can be in two lists (e.g. review requested and assigned); keep one copy.
  const all = [...new Map(Object.values(prs.lists).flatMap((l) => l.items.map((p) => [p.id, p] as const))).values()];
  const openPr = (repo: string, number: number) => nav.toPluginPanel("prs", { subPath: `${repo}/${number}` });
  const at = route ? listOrder.findIndex((p) => p.repo === route.repo && p.number === route.number) : -1;
  const position: ListPosition | null =
    at < 0 ? null : { index: at, total: listOrder.length, prev: listOrder[at - 1] ?? null, next: listOrder[at + 1] ?? null };
  // Back on the list: where you left it.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!route && scroller.current) scroller.current.scrollTop = listScroll;
  }, [subPath]); // once per page change
  return (
    // Keyed by route so opening a PR starts at the top.
    <div
      key={route ? subPath : "list"}
      ref={scroller}
      onScroll={(e) => {
        if (!route) listScroll = e.currentTarget.scrollTop;
      }}
      className="h-full min-h-0 flex-1 overflow-y-auto"
    >
      <div className="@container mx-auto box-border w-full max-w-[100rem] space-y-4 px-3 pb-6 pt-3 sm:px-4 md:px-5 md:pt-4">
        {route ? (
          <PrDetailView
            repo={route.repo}
            number={route.number}
            summary={all.find((p) => p.repo === route.repo && p.number === route.number)}
            // Only from the lists already loaded; GitHub has no cheap "PRs based on this branch" field here.
            stackedAbove={all.filter((p) => p.repo === route.repo && p.stackedOn?.number === route.number && !p.mergedAt && !p.closedAt)}
            position={position}
            onOpenPr={openPr}
            onStateChanged={prs.refetchAll}
            onBack={() => nav.toPluginPanel("prs")}
          />
        ) : (
          <ListView
            prs={prs}
            tab={tab}
            setTab={setTab}
            onOpen={(pr) => {
              lastOpened = pr.id;
              openPr(pr.repo, pr.number);
            }}
          />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "prs",
    title: "My PRs",
    icon: "GitPullRequest",
    path: "prs",
    component: PrsPage,
    experimental_useBadge: useAlertBadge,
  });
  app.slots.experimental_appOverlay({ id: "pr-alerts", component: AlertListener });
  app.slots.settingsSection({
    id: "notifications",
    title: "Notifications",
    description: "Get told when CI starts failing or someone comments on one of your open PRs.",
    component: NotificationSettings,
  });
});
