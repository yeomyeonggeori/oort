import { useEffect, useRef, useState } from "react";
import { PlugZap } from "lucide-react";
import { useSession } from "@/app/session";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import {
  connectionAlert,
  HEALED_MS,
  RETRY_WINDOW_MS,
  SUSTAINED_DOWN_MS,
} from "@momo/core/features/common/connectionAlert";

// =============================================================================
// The one line the shell shows when realtime is not working (goal B8 B2).
//
// It lives in the shell rather than in the channel because the fact it reports
// is true of every surface: an 인박스 that stops updating and a 활동 feed that
// stops updating look exactly like a quiet day. The 8px dot in the profile
// panel is a glance-level indicator; this banner is the sentence.
//
// The dwell (connectionAlert.ts) is why this can be a banner at all: without it
// every two-second blip would push the content down and pull it back up.
// =============================================================================

/**
 * True once the rail has been down for the whole dwell.
 *
 * The clock does NOT restart on every reconnect, which a naive
 * `useEffect([down])` does: a rail that comes up for two seconds and drops for
 * twelve, over and over, would reset the timer on each cycle and never reach
 * the threshold, while losing messages the entire time. That flapping session
 * is the same session the banner exists for.
 *
 * So a reconnect only counts as recovery once it HOLDS for `HEALED_MS`. Until
 * then the down-clock keeps its start, and the next drop reaches the threshold
 * immediately. Nothing is shown during that grace period regardless, because
 * `connectionAlert` answers null while the status is `connected`.
 */
function useSustainedDown(down: boolean): boolean {
  const [sustained, setSustained] = useState(false);
  const downSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (down) {
      if (downSinceRef.current === null) downSinceRef.current = Date.now();
      const elapsed = Date.now() - downSinceRef.current;
      const remaining = Math.max(0, SUSTAINED_DOWN_MS - elapsed);
      const timer = setTimeout(() => setSustained(true), remaining);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      downSinceRef.current = null;
      setSustained(false);
    }, HEALED_MS);
    return () => clearTimeout(timer);
  }, [down]);

  return sustained;
}

export function ConnectionBanner() {
  const { connStatus, realtime } = useSession();
  const browserOffline = useBrowserOffline();
  // `connecting` and `disconnected` are both "not connected"; which of the two
  // it is changes the sentence, not whether the clock runs.
  const sustained = useSustainedDown(connStatus !== "connected");
  const alert = connectionAlert({ browserOffline, connStatus, sustained });
  const [retry, setRetry] = useState<"idle" | "running" | "failed">("idle");

  // The retry state belongs to ONE incident, and this component never unmounts:
  // it is mounted unconditionally by the shell and returns null from render,
  // which is not the same thing. Without this reset a press whose dial actually
  // SUCCEEDED left `failed` latched, and the next unrelated outage minutes later
  // opened with "다시 연결하지 못했습니다" about a failure that never happened.
  // The alert's kind is the incident's identity: it goes null the moment the
  // rail recovers, and changes when the reason changes.
  const alertKind = alert?.kind ?? null;
  useEffect(() => setRetry("idle"), [alertKind]);

  useEffect(() => {
    if (retry !== "running") return;
    const timer = setTimeout(() => setRetry("failed"), RETRY_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [retry]);

  if (alert === null) return null;

  const canRetry = alert.canRetry && realtime !== null;
  // Only where there is a button to press again. The browser-offline branch
  // offers no retry, so telling that reader to "다시 시도하세요" would point at
  // nothing, and it would cost them the sentence that is actually load-bearing
  // there: the cached content they are looking at is the last confirmed state.
  const message =
    retry === "failed" && canRetry
      ? "다시 연결하지 못했습니다. 네트워크와 서버 상태를 확인한 뒤 다시 시도하세요."
      : alert.message;

  return (
    <InlineBanner
      tone="neutral"
      // Neutral keeps the banner from reading as an alarm, and the warn-toned
      // icon keeps it from reading as chrome. Without it this line sat directly
      // above the channel header at the same value, with nothing to catch an
      // eye that was looking somewhere else when the socket died.
      icon={<PlugZap className="size-4 text-warn" />}
      message={message}
      testId="connection-banner"
      {...(canRetry
        ? {
            actionLabel: retry === "running" ? "연결하는 중" : "다시 연결",
            actionBusy: retry === "running",
            onAction: () => {
              // A second press during a dial in flight would tear down the
              // handshake it is waiting on and restart the backoff from zero.
              if (retry === "running") return;
              setRetry("running");
              realtime?.reconnect();
            },
          }
        : {})}
    />
  );
}
