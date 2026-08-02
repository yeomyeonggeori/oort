/**
 * The globals `@momo/core` assumes exist, installed before anything reads them.
 *
 * The core is pure — no imports of any platform API, mechanically enforced by
 * its purity gate. "Pure" does not mean "assumes nothing": it means every
 * platform fact arrives either as a parameter, through the host port, or as a
 * standard global that any reasonable JavaScript runtime provides. A browser
 * provides all of them. **React Native does not**, and each gap below is silent
 * rather than loud, which is why they are handled here and covered by tests.
 *
 * This file is imported FIRST in `index.js`. A module that captured `URL` at
 * import time would keep the broken one forever.
 */

// -----------------------------------------------------------------------------
// 1. WHATWG URL — spike #837 gate 2, measured on a physical iPhone 17.
//
// React Native ships its own `URL` (`react-native/Libraries/Blob/URL.js`). It is
// a set of regexes tuned for http and https, not a WHATWG parser, and it fails
// structurally on a custom scheme: its `hostname` and `pathname` getters both
// begin `^https?:\/\/`, so `oort://join?...` has no authority and no path, and
// `parseJoinDeepLink` returns null for every invite link the product mints.
//
// The gate ran one case table against both: 0/19 on the built-in, 19/19 on
// `react-native-url-polyfill@4.0.0` — and `deepLink.ts` itself needed no change.
// The fix is host bootstrap, never core logic.
//
// What makes this genuinely dangerous is that the built-in gets many http(s)
// cases RIGHT (`normalizeServerUrl` passes on it completely), so the failure
// looks like "deep links are broken" rather than "the URL parser is wrong".
// `__tests__/urlPolyfill.test.ts` pins both halves of that.
// -----------------------------------------------------------------------------
import 'react-native-url-polyfill/auto';

// -----------------------------------------------------------------------------
// 2. crypto — NOT part of the spike, found while wiring this client (goal RN-C2).
//
// React Native provides no `crypto` global at all: there is no reference to one
// anywhere in the `react-native` package, and Hermes does not supply it. The
// core calls `crypto.randomUUID()` in three places, and they are not obscure:
//
//   features/timeline/approvalDecision.ts:61   the approval flow — a v0 feature
//   lib/api.ts:2732-2733                       the send-routing capability probe
//
// So this would have thrown `ReferenceError: crypto is not defined` the first
// time someone approved anything. It is fixed here, in the host, for the same
// reason as the URL: the core is right to assume a standard global, and it is
// this file's job to make the assumption true. Putting a React Native import in
// the core to work around it would end the extraction.
//
// `react-native-get-random-values` supplies `crypto.getRandomValues` backed by
// the platform CSPRNG (`SecRandomCopyBytes` on iOS). It does NOT supply
// `randomUUID`, so that is composed on top — from real random bytes, with the
// RFC 4122 version and variant bits set, never from `Math.random`.
// -----------------------------------------------------------------------------
import 'react-native-get-random-values';

const HEX: string[] = [];
for (let i = 0; i < 256; i += 1) {
  HEX.push((i + 0x100).toString(16).slice(1));
}

/**
 * RFC 4122 v4, from `crypto.getRandomValues`.
 *
 * Exported because this — not the branch below — is the code that runs on a
 * device. Under Jest, Node already provides `crypto.randomUUID`, so the
 * `typeof` guard never fires and a test of the global would be testing Node.
 */
export function randomUUIDFromBytes(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 §4.4 specifies these two bytes by their bits, so the bitwise
  // rewrite is the specification rather than a micro-optimisation. Without them
  // the value has the right shape and is not a v4 UUID.
  /* eslint-disable no-bitwise */
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  /* eslint-enable no-bitwise */
  const h = HEX;
  return (
    `${h[bytes[0]]}${h[bytes[1]]}${h[bytes[2]]}${h[bytes[3]]}-` +
    `${h[bytes[4]]}${h[bytes[5]]}-` +
    `${h[bytes[6]]}${h[bytes[7]]}-` +
    `${h[bytes[8]]}${h[bytes[9]]}-` +
    `${h[bytes[10]]}${h[bytes[11]]}${h[bytes[12]]}${h[bytes[13]]}${h[bytes[14]]}${h[bytes[15]]}`
  );
}

if (typeof crypto.randomUUID !== 'function') {
  // Defined rather than assigned: `crypto` is a frozen-ish host object on some
  // runtimes, and a plain assignment fails silently in that case — which would
  // reproduce the exact bug this is here to prevent.
  Object.defineProperty(crypto, 'randomUUID', {
    value: randomUUIDFromBytes,
    writable: true,
    configurable: true,
  });
}

// -----------------------------------------------------------------------------
// Probes. Runtime checks rather than version assertions, because both failures
// above are silent: nothing throws until a person taps something, and by then
// the build has shipped.
// -----------------------------------------------------------------------------

/** Does the installed global `URL` actually parse a custom scheme? */
export function customSchemeUrlSupported(): boolean {
  try {
    const url = new URL('oort://join?server=https%3A%2F%2Fa.example.com&code=x');
    return (
      url.protocol === 'oort:' &&
      url.hostname === 'join' &&
      url.searchParams.get('code') === 'x'
    );
  } catch {
    return false;
  }
}

/** Can the core mint the ids it needs (`approvalDecision`, send routing)? */
export function randomUuidSupported(): boolean {
  try {
    const value = crypto.randomUUID();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    );
  } catch {
    return false;
  }
}
