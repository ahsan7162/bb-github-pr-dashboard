// bb-github-pr-dashboard — frontend entry: the "My PRs" page in the nav rail.
import { useCallback, useEffect, useState } from "react";
import { UrlLink, definePluginApp, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Pr, PrList } from "./prs";
import { PrDetailView } from "./detail";
import { AlertListener, AlertsStrip, NotificationSettings, useAlertBadge } from "./alerts";
import {
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

type Tab = "open" | "review" | "assigned" | "merged" | "closed";
type Lists = Record<Tab, PrList> & { fetchedAt: string };
const EMPTY: Record<Tab, string> = {
  open: "You have no open pull requests.",
  review: "No reviews are waiting on you or your teams.",
  assigned: "No open pull requests are assigned to you.",
  merged: "No merged pull requests yet.",
  closed: "No closed pull requests.",
};

// Survives remounts (bb remounts the page on resize or when you come back to
// it), so the last result shows at once while a refresh runs.
let cachedLists: Lists | null = null;
let lastTab: Tab = "open";

function usePrs() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Lists | null>(cachedLists);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refetch = useCallback(() => {
    setLoading(true);
    rpc
      .call("prs_list")
      .then(
        (result) => {
          cachedLists = result;
          setData(result);
          setError(null);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  return { data, error, loading, refetch };
}

const CI: Record<Pr["ci"], { icon: string; tone: Tone; label: string } | null> = {
  passing: { icon: "CircleCheck", tone: "good", label: "CI passing" },
  failing: { icon: "CircleX", tone: "bad", label: "CI failing" },
  pending: { icon: "Clock", tone: "warn", label: "CI running" },
  none: null,
};

function PrRow({ pr, onOpen, showAuthor }: { pr: Pr; onOpen: () => void; showAuthor: boolean }) {
  const state = prState(pr);
  const isOpen = state.label === "Open" || state.label === "Draft";
  const ci = isOpen ? CI[pr.ci] : null;
  // CI has its own coloured status in the meta line; pills carry the rest.
  const pills = pr.blockers.filter((b) => !b.startsWith("CI "));
  const when = pr.mergedAt
    ? `merged ${ago(pr.mergedAt)}`
    : pr.closedAt
      ? `closed ${ago(pr.closedAt)}`
      : `updated ${ago(pr.updatedAt)}`;
  return (
    <li className="group flex items-start gap-1 transition-colors hover:bg-accent/40">
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon
          name={state.icon}
          className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[state.tone])}
          aria-label={state.label}
        />
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline">{pr.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">#{pr.number}</span>
            {showAuthor ? (
              <>
                <span aria-hidden>·</span>
                <span>by {pr.author}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{when}</span>
            {ci ? (
              <>
                <span aria-hidden>·</span>
                <span className={cn("inline-flex items-center gap-1", TONE_TEXT[ci.tone])}>
                  <Icon name={ci.icon} className="size-3.5" aria-hidden />
                  {ci.label}
                </span>
              </>
            ) : null}
          </span>
          {isOpen && (pills.length > 0 || pr.blockers.length === 0) ? (
            <span className="flex flex-wrap gap-1.5">
              {pr.blockers.length === 0 ? (
                <Pill tone="good" icon="CircleCheck">
                  {pr.reviewDecision === "APPROVED" ? "Approved · ready to merge" : "Nothing blocking"}
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
            <span className="block space-y-0.5 text-xs text-destructive">
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
        </span>
        <Icon
          name="ChevronRight"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </button>
      <UrlLink
        href={pr.url}
        aria-label={`Open #${pr.number} on GitHub`}
        className="mr-2 mt-2.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name="ExternalLink" className="size-3.5" />
      </UrlLink>
    </li>
  );
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone: Tone; icon: string }) {
  const active = value > 0;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className={cn("size-3.5", active && TONE_TEXT[tone])} aria-hidden />
        {label}
      </div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", active ? TONE_TEXT[tone] : "text-muted-foreground")}>
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

function RepoHeader({ repo, count }: { repo: string; count: number }) {
  const [owner, name] = repo.split("/");
  return (
    <h3 className="flex min-w-0 items-center gap-1.5 px-1 text-xs">
      <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">
        <span className="text-muted-foreground">{owner}/</span>
        <span className="font-semibold">{name}</span>
      </span>
      <span className="rounded-full bg-muted px-1.5 tabular-nums text-muted-foreground">{count}</span>
    </h3>
  );
}

function ListView({
  prs: { data, error, loading, refetch },
  tab,
  setTab,
  onOpen,
}: {
  prs: ReturnType<typeof usePrs>;
  tab: Tab;
  setTab: (tab: Tab) => void;
  onOpen: (pr: Pr) => void;
}) {
  const list = data?.[tab];
  const pluginId = experimental_usePluginId();
  // Wide tabs, Open tab: alerts and totals move to a right column beside the PRs.
  const side = tab === "open" && !!list && list.items.length > 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Pull request state"
          value={tab}
          onChange={setTab}
          options={[
            { id: "open", label: "Open", icon: "GitPullRequest", count: data?.open.total },
            {
              id: "review",
              label: "Review requested",
              icon: "Eye",
              count: data?.review.total,
              countTone: data && data.review.total > 0 ? "warn" : "neutral",
            },
            { id: "assigned", label: "Assigned", icon: "UserRound", count: data?.assigned.total },
            { id: "merged", label: "Merged", icon: "GitMerge", count: data?.merged.total },
            { id: "closed", label: "Closed", icon: "GitPullRequestClosed", count: data?.closed.total },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          {data ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">Updated {ago(data.fetchedAt)}</span>
          ) : null}
          <UrlLink
            href={`/settings/plugins/${pluginId}`}
            aria-label="Notification settings"
            title="Notification settings"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="BellDot" className="size-4" />
          </UrlLink>
          <Button variant="ghost" size="icon" aria-label="Refresh" disabled={loading} onClick={refetch}>
            <Icon name="RotateCcw" className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {/* Same tree on every tab, so the alerts strip never remounts (it marks alerts seen on mount). */}
      <div className={cn("grid gap-4", side && "@6xl:grid-cols-[minmax(0,1fr)_22rem] @6xl:items-start")}>
        <aside className={cn("min-w-0 space-y-4 empty:hidden", side && "@6xl:sticky @6xl:top-3 @6xl:col-start-2 @6xl:row-start-1")}>
          <AlertsStrip />
          {side ? <OpenStats items={list.items} /> : null}
        </aside>
        <div className={cn("min-w-0 space-y-4", side && "@6xl:col-start-1 @6xl:row-start-1")}>
      {list === undefined ? (
        error ? null : <Skeleton rows={4} />
      ) : (
        <>
          {list.items.length === 0 ? (
            <EmptyState icon="GitPullRequest">{EMPTY[tab]}</EmptyState>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,30rem),1fr))] items-start gap-4">
            {groupByRepo(list.items).map(([repo, prs]) => (
              <section key={repo} className="min-w-0 space-y-1.5">
                <RepoHeader repo={repo} count={prs.length} />
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {prs.map((pr) => (
                    <PrRow
                      key={pr.id}
                      pr={pr}
                      onOpen={() => onOpen(pr)}
                      showAuthor={tab === "review" || tab === "assigned"}
                    />
                  ))}
                </ul>
              </section>
            ))}
            </div>
          )}
          {list.total > list.items.length ? (
            <p className="text-center text-xs text-muted-foreground">
              Showing the {list.items.length} most recently updated of {list.total}.
            </p>
          ) : null}
        </>
      )}
        </div>
      </div>
    </>
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
  const prs = usePrs();
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (next: Tab) => {
    lastTab = next;
    setTabState(next);
  };
  const nav = useBbNavigate();
  const route = parseRoute(subPath);
  // A PR can be in two lists (e.g. review requested and assigned); keep one copy.
  const all = [
    ...new Map(
      (prs.data ? (["open", "review", "assigned", "merged", "closed"] as const).flatMap((t) => prs.data![t].items) : []).map(
        (p) => [p.id, p],
      ),
    ).values(),
  ];
  const openPr = (repo: string, number: number) => nav.toPluginPanel("prs", { subPath: `${repo}/${number}` });
  return (
    // Keyed by route so opening a PR starts at the top.
    <div key={route ? subPath : "list"} className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="@container mx-auto box-border w-full max-w-[100rem] space-y-4 px-3 pb-6 pt-3 sm:px-4 md:px-5 md:pt-4">
        {route ? (
          <PrDetailView
            repo={route.repo}
            number={route.number}
            summary={all.find((p) => p.repo === route.repo && p.number === route.number)}
            // Only from the lists already loaded; GitHub has no cheap "PRs based on this branch" field here.
            stackedAbove={all.filter((p) => p.repo === route.repo && p.stackedOn?.number === route.number && !p.mergedAt && !p.closedAt)}
            onOpenPr={openPr}
            onStateChanged={prs.refetch}
            onBack={() => nav.toPluginPanel("prs")}
          />
        ) : (
          <ListView
            prs={prs}
            tab={tab}
            setTab={setTab}
            onOpen={(pr) => openPr(pr.repo, pr.number)}
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
