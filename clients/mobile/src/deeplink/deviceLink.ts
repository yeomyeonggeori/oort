import {
  isDeviceLinkAction,
  parseDeviceLinkDeepLink,
  type DeviceLinkPrefill,
} from '@momo/core/features/auth/deepLink';
import {isDeviceLinkToken} from '@momo/core/features/auth/deviceLinkModel';
import {useEffect, useState} from 'react';
import {Linking} from 'react-native';

// =============================================================================
// Device-link deep links on iOS (`oort://link?server=…&token=…`).
//
// Twin of `joinLink.ts`: the parser is the core's; this file is only how a URL
// reaches the app (cold `getInitialURL`, warm `Linking` 'url'). The voucher is
// a bearer secret — it is parsed and handed to redeem, and it is never logged,
// including in the failure paths, which report only that a link did not parse.
// =============================================================================

export type DeviceLinkArrival =
  | {kind: 'prefill'; prefill: DeviceLinkPrefill}
  | {kind: 'malformed'};

export function arrivalFromDeviceLinkUrl(
  url: string | null,
): DeviceLinkArrival | null {
  if (!url) return null;
  const parsed = parseDeviceLinkDeepLink(url);
  if (parsed) {
    if (!isDeviceLinkToken(parsed.token)) return {kind: 'malformed'};
    return {kind: 'prefill', prefill: parsed};
  }
  if (isDeviceLinkAction(url)) return {kind: 'malformed'};
  return null;
}

export function useDeviceLinkArrival(): DeviceLinkArrival | null {
  const [arrival, setArrival] = useState<DeviceLinkArrival | null>(null);

  useEffect(() => {
    let cancelled = false;

    Linking.getInitialURL()
      .then(url => {
        if (cancelled) return;
        const next = arrivalFromDeviceLinkUrl(url);
        if (next) setArrival(next);
      })
      .catch(() => {
        // No initial URL is the normal case.
      });

    const subscription = Linking.addEventListener('url', ({url}) => {
      const next = arrivalFromDeviceLinkUrl(url);
      if (next) setArrival(next);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return arrival;
}
