import { useEffect, useState } from "react";
import { IS_TAURI } from "@/lib/env";
import { onDeepLink, takePendingDeepLinks, type DeepLinkJoin } from "@/lib/tauri";
import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
  type JoinPrefill,
} from "@momo/core/features/auth/deepLink";

/**
 * The invite prefill this launch carries, from either entrance:
 *
 *   desktop  the shell reports the opened `oort://join` URL. A cold start has
 *            no event to report (the app was launched BY the link, and macOS
 *            delivers the URL long before React mounts), so the shell buffers
 *            those and hands them over on the drain call below.
 *   browser  the same parameters ride the page URL, and are stripped from the
 *            address bar the moment they are read: the invite code is a bearer
 *            secret and does not belong in history or in a screenshot.
 *
 * The link is re-parsed here from its raw `url` rather than trusting the
 * shell's split `server`/`code`: the shell deliberately does not validate the
 * server (clients/desktop/README.md), so validation keeps a single owner in
 * ./deepLink.ts — the same rule the mac client follows.
 *
 * A new value means a new link arrived; the connect screen re-applies it and
 * moves focus to the first field the link could not fill.
 */
export function useJoinPrefill(): JoinPrefill | null {
  const [prefill, setPrefill] = useState<JoinPrefill | null>(() =>
    typeof window === "undefined"
      ? null
      : parseJoinFromPageUrl(window.location.href)
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stripped = urlWithoutJoinParams(window.location.href);
    if (stripped !== window.location.href) {
      window.history.replaceState(null, "", stripped);
    }
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const apply = (links: DeepLinkJoin[]) => {
      for (const link of links) {
        const parsed = parseJoinDeepLink(link.url);
        if (parsed) {
          if (!cancelled) setPrefill(parsed);
          return;
        }
      }
    };

    // Contract (clients/desktop/README.md, "Bridge contract"): SUBSCRIBE, then
    // DRAIN EXACTLY ONCE. Draining first would release the cold-start buffer to
    // nobody; draining twice returns nothing the second time.
    onDeepLink((link) => apply([link]))
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        takePendingDeepLinks()
          .then(apply)
          .catch(() => {
            // No deep-link plugin in this shell build: the form stays as typed.
          });
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return prefill;
}
