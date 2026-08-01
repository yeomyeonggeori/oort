import { useEffect, useState } from "react";
import { useSession } from "@/app/session";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import {
  connectionAlert,
  SUSTAINED_DOWN_MS,
} from "@/features/common/connectionAlert";

// =============================================================================
// The one line the shell shows when realtime is not working (goal B8 B2).
//
// It lives in the shell rather than in the channel because the fact it reports
// is true of every surface: an 인박스 that stops updating and a 활동 feed that
// stops updating look exactly like a quiet day. The workspace rail's 8px dot
// stays where it is; it is a glance-level indicator and this is the sentence.
//
// The dwell (connectionAlert.ts) is why this can be a banner at all: without it
// every two-second blip would push the content down and pull it back up.
// =============================================================================

/** True once the rail has been not-connected for the whole dwell. */
function useSustainedDown(down: boolean): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!down) {
      setSustained(false);
      return;
    }
    const timer = setTimeout(() => setSustained(true), SUSTAINED_DOWN_MS);
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
  const [retrying, setRetrying] = useState(false);

  // A retry that lands puts the rail back to `connected` and unmounts this
  // whole banner, so the only state to clear is the one where it did not.
  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => setRetrying(false), 4_000);
    return () => clearTimeout(timer);
  }, [retrying]);

  if (alert === null) return null;

  const canRetry = alert.canRetry && realtime !== null;
  return (
    <InlineBanner
      tone="neutral"
      message={alert.message}
      testId="connection-banner"
      {...(canRetry
        ? {
            actionLabel: retrying ? "연결하는 중" : "다시 연결",
            onAction: () => {
              setRetrying(true);
              realtime?.reconnect();
            },
          }
        : {})}
    />
  );
}
