import {parseJoinDeepLink, type JoinPrefill} from '@momo/core/features/auth/deepLink';
import {useEffect, useState} from 'react';
import {Linking} from 'react-native';

// =============================================================================
// Invite deep links on iOS (`oort://join?server=…&code=…`).
//
// The parser is the core's and is not touched: spike #837 gate 2 confirmed
// `deepLink.ts` passes unmodified once the URL polyfill is installed, so the
// same file that serves the browser and the mac client serves this one. What
// belongs here is only the platform half — how a URL reaches the app.
//
// Two ways in, and BOTH are needed. Missing the first is the classic bug:
//
//   cold start   the link launched the app. There is no event to listen for
//                because it fired before this component existed;
//                `getInitialURL()` is the only way to see it.
//   warm         the app was already running. `Linking` emits 'url'.
//
// The invite code is a bearer secret. It is parsed and handed to the form, and
// it is never logged — including in the failure paths below, which report only
// that a link did not parse and not what it contained.
//
// NOT verified by the spike, and worth knowing when this is first run on a
// device: the OS-level round trip (tapping a link in Safari and having iOS hand
// it to this app) requires `CFBundleURLTypes` in `Info.plist`. That registration
// is now present for `oort` and `momo`, but the spike report is explicit that
// what it proved was the PARSER, not the hand-off. The hand-off is an
// orchestrator device check.
// =============================================================================

/** Parse a URL as a join link. Null when it is not one, or carries nothing. */
export function joinPrefillFromUrl(url: string | null): JoinPrefill | null {
  if (!url) {
    return null;
  }
  return parseJoinDeepLink(url);
}

/**
 * The prefill carried by the link that opened (or reached) the app.
 *
 * Returns null until a link arrives, so the connect screen renders its own state
 * immediately rather than waiting on `getInitialURL()` — which resolves on a
 * later tick even when there is no link at all.
 */
export function useJoinPrefill(): JoinPrefill | null {
  const [prefill, setPrefill] = useState<JoinPrefill | null>(null);

  useEffect(() => {
    let cancelled = false;

    Linking.getInitialURL()
      .then(url => {
        if (!cancelled) {
          const parsed = joinPrefillFromUrl(url);
          if (parsed) {
            setPrefill(parsed);
          }
        }
      })
      .catch(() => {
        // No initial URL, or the platform declined to answer. A person who did
        // not arrive by link is the normal case, not an error to report.
      });

    const subscription = Linking.addEventListener('url', ({url}) => {
      const parsed = joinPrefillFromUrl(url);
      if (parsed) {
        setPrefill(parsed);
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return prefill;
}
