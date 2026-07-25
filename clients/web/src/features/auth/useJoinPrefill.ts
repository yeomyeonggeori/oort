import { useEffect, useState } from "react";
import { IS_TAURI } from "@/lib/env";
import {
  CMD_DEEP_LINK_CURRENT,
  DEEP_LINK_EVENT,
  invokeTauri,
  listenTauri,
  toDeepLinkUrls,
} from "@/lib/tauri";
import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
  type JoinPrefill,
} from "./deepLink";

/**
 * The invite prefill this launch carries, from either entrance:
 *
 *   desktop  the shell reports the opened `momo://join` URL. A cold start has
 *            no event to report (the app was launched BY the link), so the
 *            current URL is asked for once as well.
 *   browser  the same parameters ride the page URL, and are stripped from the
 *            address bar the moment they are read: the invite code is a bearer
 *            secret and does not belong in history or in a screenshot.
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
    const apply = (urls: string[]) => {
      for (const url of urls) {
        const parsed = parseJoinDeepLink(url);
        if (parsed) {
          setPrefill(parsed);
          return;
        }
      }
    };
    invokeTauri<string[] | null>(CMD_DEEP_LINK_CURRENT)
      .then((urls) => apply(urls ?? []))
      .catch(() => {
        // No deep-link plugin in this shell build: the form stays as typed.
      });
    return listenTauri(DEEP_LINK_EVENT, (payload) =>
      apply(toDeepLinkUrls(payload))
    );
  }, []);

  return prefill;
}
