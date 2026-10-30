// Presentational pieces shared by the list (app.tsx) and detail.tsx.
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export type Tone = "bad" | "warn" | "good" | "merged" | "neutral";
/** Text colour per tone; soft fills are derived from the same theme tokens. */
export const TONE_TEXT: Record<Tone, string> = {
  bad: "text-destructive",
  warn: "text-warning-text",
  good: "text-success",
  merged: "text-[var(--prd-merged)]",
  neutral: "text-muted-foreground",
};
const TONE_FILL: Record<Tone, string> = {
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-warning/15 text-warning-text",
  good: "bg-success/10 text-success",
  merged: "bg-[var(--prd-merged)]/10 text-[var(--prd-merged)]",
  neutral: "bg-muted text-muted-foreground",
};

const TONE_SPINE: Record<Tone, string> = {
  bad: "bg-destructive",
  warn: "bg-warning",
  good: "bg-success",
  merged: "bg-[var(--prd-merged)]",
  neutral: "bg-muted-foreground/40",
};

/**
 * The status spine on a PR or thread's left edge (MASTER.md). Drawn 5px wide at 3/5 scale so it
 * widens with a transform, never a width change: on hover of the nearest `group`, or while `wide`.
 * The parent needs `relative`.
 */
export function Spine({ tone, wide = false }: { tone: Tone; wide?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-3 left-0 w-[var(--prd-spine-wide)] origin-left rounded-full transition-transform group-hover:scale-x-100",
        wide
          ? "scale-x-100 duration-[var(--prd-expand)] ease-[var(--prd-spring)]"
          : "scale-x-[0.6] duration-[var(--prd-hover)] ease-[var(--prd-ease-out)]", // 0.6 = --prd-spine / --prd-spine-wide (3px of 5px)
        TONE_SPINE[tone],
      )}
    />
  );
}

/** A motion token in ms, read from tokens.css (0 under reduced motion). */
export function motionMs(token: "--prd-hover" | "--prd-arrive" | "--prd-expand"): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith("ms") ? n : n * 1000) : 0;
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Plays the "arrive" motion (fade and rise 4px) whenever `key` changes; `--prd-expand` for a file opening. */
export function useArrive<T extends HTMLElement>(key: unknown, token: "--prd-arrive" | "--prd-expand" = "--prd-arrive") {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const ms = motionMs(token);
    if (!ref.current || ms === 0) return;
    const ease = getComputedStyle(document.documentElement).getPropertyValue("--prd-spring").trim() || "ease-out";
    ref.current.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: ms, easing: ease });
  }, [key, token]);
  return ref;
}

/** A key hint, e.g. j or /. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid min-w-5 place-items-center rounded-[var(--prd-radius-control)] border border-border px-1 text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

export function Pill({ tone, icon, children }: { tone: Tone; icon?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_FILL[tone],
      )}
    >
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function blockerTone(blocker: string): Tone {
  if (/conflict|failing|changes requested|unresolved/i.test(blocker)) return "bad";
  if (/running|awaiting/i.test(blocker)) return "warn";
  return "neutral";
}

/** GitHub's PR state glyphs and colours, from a list row or a detail. */
export function prState(pr: {
  isDraft: boolean;
  state?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
}): { icon: string; tone: Tone; label: string } {
  if (pr.mergedAt || pr.state === "MERGED") return { icon: "GitMerge", tone: "merged", label: "Merged" };
  if (pr.closedAt || pr.state === "CLOSED") return { icon: "GitPullRequestClosed", tone: "bad", label: "Closed" };
  if (pr.isDraft) return { icon: "GitPullRequestDraft", tone: "neutral", label: "Draft" };
  return { icon: "GitPullRequest", tone: "good", label: "Open" };
}

export function Avatar({ login, url, size = 24 }: { login: string; url: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  // The name is always printed beside it, so the image itself is decorative.
  return url && !failed ? (
    <img
      src={url}
      alt=""
      style={style}
      className="shrink-0 rounded-full bg-muted object-cover"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      aria-hidden
      style={style}
      className="grid shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
    >
      {login.slice(0, 2)}
    </span>
  );
}

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  icon?: string;
  count?: number;
  /** Colours the count, e.g. red for failing checks. */
  countTone?: Tone;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[var(--prd-radius-control)] bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-[calc(var(--prd-radius-control)-2px)] px-2.5 py-1 text-sm outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] focus-visible:ring-2 focus-visible:ring-ring",
            value === o.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {/* Icons give way on compact screens so every option stays visible. */}
          {o.icon ? <Icon name={o.icon} className="hidden size-3.5 sm:block" aria-hidden /> : null}
          {o.label}
          {o.count !== undefined ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-xs tabular-nums",
                o.countTone && o.countTone !== "neutral" ? TONE_FILL[o.countTone] : "bg-foreground/5",
              )}
            >
              {o.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-[var(--prd-radius-panel)] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {icon ? <Icon name={icon} className="size-5 opacity-60" aria-hidden /> : null}
      {children}
    </div>
  );
}

/** Skeleton rows while the first load is in flight. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-[var(--prd-radius-panel)] bg-muted/60" />
      ))}
    </div>
  );
}
