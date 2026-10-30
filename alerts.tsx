// PR alerts on the client: toasts and desktop notifications as they arrive,
// the My PRs badge, the "new since you last looked" strip, and the
// notification controls on the plugin's settings page.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useBbNavigate, useRealtime, useRpc, useSettings, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { ALERTS_NEW, ALERTS_SEEN, type Alert } from "./prs";
import { ago } from "./parts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const ICON: Record<Alert["kind"], { name: string; className: string }> = {
  ci: { name: "CircleX", className: "text-destructive" },
  comment: { name: "MessageSquare", className: "text-warning-text" },
  test: { name: "BellDot", className: "text-muted-foreground" },
};

/** Realtime payloads come from our server, but check the shape before use. */
function alertsIn(payload: unknown): Alert[] {
  const alerts = (payload as { alerts?: unknown } | null)?.alerts;
  return Array.isArray(alerts)
    ? alerts.filter((a): a is Alert => typeof a?.id === "string" && typeof a?.headline === "string")
    : [];
}

function useOpenAlert() {
  const nav = useBbNavigate();
  return useCallback(
    (a: Alert) => nav.toPluginPanel("prs", a.number > 0 ? { subPath: `${a.repo}/${a.number}` } : undefined),
    [nav],
  );
}

const canNotify = () => typeof Notification !== "undefined" && Notification.permission === "granted";

/** How alerts may reach you, from the plugin settings; everything is on until settings load. */
function useAlertPrefs() {
  const values = useSettings().values;
  return {
    toasts: values?.showToasts !== false,
    desktop: values?.showDesktop !== false,
    badge: values?.showBadge !== false,
  };
}

/** Mounted once per window: shows each new alert as it lands. */
export function AlertListener() {
  const open = useOpenAlert();
  // A ref, so a realtime handler registered earlier still sees the latest settings.
  const current = useAlertPrefs();
  const prefs = useRef(current);
  prefs.current = current;
  useRealtime(ALERTS_NEW, (payload) => {
    for (const a of alertsIn(payload)) {
      if (prefs.current.toasts) {
        toast(a.headline, { description: a.detail, action: { label: "Open", onClick: () => open(a) } });
      }
      if (prefs.current.desktop && canNotify()) {
        // The tag makes several open windows share one banner.
        const n = new Notification(a.headline, { body: a.detail, tag: a.id });
        n.onclick = () => {
          window.focus();
          open(a);
        };
      }
    }
  });
  return null;
}

function useAlerts() {
  const rpc = useRpc<typeof rpcContract>();
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    rpc.call("alerts_list").then((r) => setUnread(r.unread), () => {});
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime(ALERTS_NEW, refresh);
  useRealtime(ALERTS_SEEN, refresh);
  return unread;
}

/** The red count on the My PRs rail icon. */
export function useAlertBadge(): ExperimentalBadge | null {
  const unread = useAlerts();
  const { badge } = useAlertPrefs();
  return badge && unread > 0
    ? { count: unread, tone: "critical", label: `${unread} new PR alert${unread === 1 ? "" : "s"}` }
    : null;
}

/** What arrived since you last opened My PRs; opening the page marks it seen. */
export function AlertsStrip() {
  const rpc = useRpc<typeof rpcContract>();
  const open = useOpenAlert();
  const [shown, setShown] = useState<Alert[]>([]);
  const catchUp = useCallback(() => {
    rpc.call("alerts_list").then((r) => {
      const unread = r.alerts.filter((a) => !a.seen);
      if (unread.length === 0) return;
      setShown((prev) => [...unread, ...prev.filter((p) => !unread.some((u) => u.id === p.id))]);
      void rpc.call("alerts_mark_seen").catch(() => {});
    }, () => {});
  }, [rpc]);
  useEffect(catchUp, [catchUp]);
  useRealtime(ALERTS_NEW, catchUp);
  if (shown.length === 0) return null;
  return (
    <section aria-label="New alerts" className="overflow-hidden rounded-[var(--prd-radius-panel)] border border-border">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs">
        <Icon name="BellDot" className="size-3.5 text-destructive" aria-hidden />
        <span className="font-semibold">New since you last looked</span>
        <span className="rounded-full bg-destructive/10 px-1.5 tabular-nums text-destructive">{shown.length}</span>
        <button
          onClick={() => setShown([])}
          className="ml-auto rounded-[var(--prd-radius-control)] px-1.5 py-0.5 text-muted-foreground outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dismiss
        </button>
      </header>
      <ul className="divide-y divide-border">
        {shown.slice(0, 6).map((a) => (
          <li key={a.id}>
            <button
              onClick={() => open(a)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors duration-[var(--prd-hover)] ease-[var(--prd-ease-out)] hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon name={ICON[a.kind].name} className={cn("mt-0.5 size-4 shrink-0", ICON[a.kind].className)} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.headline}</span>
                <span className="block truncate text-xs text-muted-foreground">{a.detail}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(a.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Plugin settings page: desktop permission and a test alert. */
export function NotificationSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  const [sending, setSending] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Alerts show as bb toasts and a badge on My PRs. Desktop notifications also appear while a bb window is open.
        The watcher runs on the bb server, so it pauses when bb is not running.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {permission === "granted" ? (
          <span className="inline-flex items-center gap-1.5 text-success">
            <Icon name="CircleCheck" className="size-4" aria-hidden />
            Desktop notifications are on in this window
          </span>
        ) : permission === "denied" ? (
          <span className="text-muted-foreground">
            Desktop notifications are blocked here. Allow them for bb in your system or browser settings.
          </span>
        ) : (
          <Button size="sm" onClick={() => void Notification.requestPermission().then(setPermission)}>
            <Icon name="BellDot" className="size-4" />
            Enable desktop notifications
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={sending}
          onClick={() => {
            setSending(true);
            rpc.call("alerts_test").then(
              () => setSending(false),
              (cause: unknown) => {
                setSending(false);
                toast.error(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        >
          Send test alert
        </Button>
      </div>
    </div>
  );
}
