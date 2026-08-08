import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
} from '@momo/core/features/auth/deepLink';
import {normalizeServerUrl} from '@momo/core/lib/serverUrl';
import {
  customSchemeUrlSupported,
  randomUUIDFromBytes,
  randomUuidSupported,
} from '../src/boot/polyfills';

// =============================================================================
// Spike #837 gate 2, reproduced as a standing regression test.
//
// The spike measured the same deep-link cases against React Native's built-in
// `URL` and against `react-native-url-polyfill`: 0/19 and 19/19. That result is
// the reason `src/boot/polyfills.ts` exists, and it is invisible from the code —
// nothing throws, links simply never open. So the comparison is re-run here,
// against the real built-in implementation pulled straight out of the React
// Native package, and the test fails if the polyfill ever stops being what makes
// the difference.
//
// The cases themselves are lifted from `clients/web/src/features/auth/*` via the
// spike's `cases.ts`. Inputs and expectations are unchanged on purpose: altering
// them is how a test like this quietly stops proving anything.
//
// Importing `../src/boot/polyfills` above is what installs the polyfill, exactly
// as `index.js` does at startup.
// =============================================================================

// A deep import, deliberately. This is the ONLY way to reach React Native's
// built-in `URL`: it is not re-exported from the package root, and the point of
// the comparison below is to run the core's parsers against the real
// implementation rather than a description of it.
// eslint-disable-next-line @react-native/no-deep-imports
const ReactNativeBuiltinURL = require('react-native/Libraries/Blob/URL');

/** Swap the globals the core reads at call time, run `body`, then restore. */
function withUrlImplementation<T>(
  impl: {URL: unknown; URLSearchParams: unknown},
  body: () => T,
): T {
  const savedURL = globalThis.URL;
  const savedParams = globalThis.URLSearchParams;
  Object.assign(globalThis, {
    URL: impl.URL,
    URLSearchParams: impl.URLSearchParams,
  });
  try {
    return body();
  } finally {
    Object.assign(globalThis, {URL: savedURL, URLSearchParams: savedParams});
  }
}

describe('the polyfill is installed', () => {
  it('parses a custom scheme, which the built-in cannot', () => {
    expect(customSchemeUrlSupported()).toBe(true);
  });
});

describe('oort://join deep links, under the installed global URL', () => {
  it('parses a standard link and percent-decodes server', () => {
    expect(
      parseJoinDeepLink(
        'oort://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x',
      ),
    ).toEqual({serverUrl: 'https://api.example.com', inviteCode: 'Ab3-_x'});
  });

  it('ignores parameter order and unknown parameters', () => {
    expect(
      parseJoinDeepLink(
        'oort://join?code=abc&utm=mail&server=http%3A%2F%2Fmacbook.local%3A28180',
      ),
    ).toEqual({serverUrl: 'http://macbook.local:28180', inviteCode: 'abc'});
  });

  it('accepts the authority-less form, as the mac parser does', () => {
    expect(parseJoinDeepLink('oort:join?code=abc')).toEqual({
      serverUrl: '',
      inviteCode: 'abc',
    });
  });

  it('keeps the code when the server is unusable', () => {
    expect(
      parseJoinDeepLink('oort://join?server=not%20a%20url&code=abc'),
    ).toEqual({serverUrl: '', inviteCode: 'abc'});
  });

  it('still opens links minted under the old momo:// scheme (B13)', () => {
    expect(
      parseJoinDeepLink(
        'momo://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x',
      ),
    ).toEqual({serverUrl: 'https://api.example.com', inviteCode: 'Ab3-_x'});
    expect(parseJoinDeepLink('momo:join?code=abc')).toEqual({
      serverUrl: '',
      inviteCode: 'abc',
    });
  });

  it.each([
    ['https://join?code=abc'],
    ['oort://open?code=abc'],
    ['oort://join'],
    ['not a url'],
  ])('ignores %s', input => {
    expect(parseJoinDeepLink(input)).toBeNull();
  });

  it('reads the query a router left in the hash', () => {
    expect(parseJoinFromPageUrl('https://momo.example.com/#/?code=abc')).toEqual(
      {serverUrl: '', inviteCode: 'abc'},
    );
  });

  it('unwraps a whole link passed as ?join=', () => {
    expect(
      parseJoinFromPageUrl(
        'https://momo.example.com/?join=oort%3A%2F%2Fjoin%3Fserver%3Dhttps%253A%252F%252Fapi.example.com%26code%3Dabc',
      ),
    ).toEqual({serverUrl: 'https://api.example.com', inviteCode: 'abc'});
  });

  it('strips only the invite parameters', () => {
    expect(
      urlWithoutJoinParams(
        'https://momo.example.com/?stress=40&code=secret&server=https%3A%2F%2Fapi.example.com#/inbox?code=secret&tab=all',
      ),
    ).toBe('https://momo.example.com/?stress=40#/inbox?tab=all');
  });

  it('validates server addresses the way every other client does', () => {
    expect(normalizeServerUrl('http://macbook.local:28000')).toEqual({
      ok: true,
      base: 'http://macbook.local:28000',
    });
    expect(normalizeServerUrl('momo.example.com')).toEqual({
      ok: true,
      base: 'https://momo.example.com',
    });
    expect(normalizeServerUrl('  https://momo.example.com/  ')).toEqual({
      ok: true,
      base: 'https://momo.example.com',
    });
    expect(normalizeServerUrl('https://team.example.com/momo/')).toEqual({
      ok: true,
      base: 'https://team.example.com/momo',
    });
    expect(normalizeServerUrl('https://momo.example.com/?a=b#c')).toEqual({
      ok: true,
      base: 'https://momo.example.com',
    });
    expect(normalizeServerUrl('ws://momo.example.com').ok).toBe(false);
    expect(normalizeServerUrl('   ').ok).toBe(false);
    expect(normalizeServerUrl('https://').ok).toBe(false);
  });
});

describe("React Native's built-in URL — why the polyfill is not optional", () => {
  it('cannot parse a custom scheme at all', () => {
    withUrlImplementation(ReactNativeBuiltinURL, () => {
      expect(customSchemeUrlSupported()).toBe(false);
    });
  });

  it('turns every invite link into null', () => {
    // The exact production symptom: an invite that is valid everywhere else is
    // silently ignored, with no error anywhere to notice.
    withUrlImplementation(ReactNativeBuiltinURL, () => {
      expect(
        parseJoinDeepLink(
          'oort://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x',
        ),
      ).toBeNull();
      expect(parseJoinDeepLink('oort:join?code=abc')).toBeNull();
      expect(parseJoinDeepLink('momo://join?code=abc')).toBeNull();
    });
  });

  it('corrupts a URL it is asked to rewrite', () => {
    withUrlImplementation(ReactNativeBuiltinURL, () => {
      // The built-in's `hash` getter is `/#([^/]*)/`, which stops at the first
      // slash, so rewriting the URL discards the entire hash route. The invite
      // code does come out — and the destination the person was going to goes
      // with it.
      expect(
        urlWithoutJoinParams(
          'https://momo.example.com/?stress=40&code=secret&server=https%3A%2F%2Fapi.example.com#/inbox?code=secret&tab=all',
        ),
      ).toBe('https://momo.example.com/?stress=40#');
    });
  });

  it('gets several http(s) cases right by accident, which is the trap', () => {
    // Measured, and recorded because it is the reason this failure survives
    // casual testing: the built-in is a set of regexes tuned for http and https,
    // so anything http-shaped tends to work. `normalizeServerUrl` passes on it
    // completely. Only the custom scheme — the one thing an invite link is —
    // fails, and it fails silently.
    withUrlImplementation(ReactNativeBuiltinURL, () => {
      expect(normalizeServerUrl('http://macbook.local:28000')).toEqual({
        ok: true,
        base: 'http://macbook.local:28000',
      });
      expect(normalizeServerUrl('https://team.example.com/momo/')).toEqual({
        ok: true,
        base: 'https://team.example.com/momo',
      });
    });
  });

  it('restores the working implementation afterwards', () => {
    // Guards the harness itself: a leaked global would make every later suite
    // pass or fail for the wrong reason.
    expect(customSchemeUrlSupported()).toBe(true);
  });
});

describe('crypto.randomUUID — React Native supplies no crypto at all', () => {
  // Found while wiring this client, not by the spike. `@momo/core` calls
  // `crypto.randomUUID()` in `features/timeline/approvalDecision.ts` (the
  // approval flow — a v0 feature) and in `lib/api.ts`. React Native has no
  // `crypto` global anywhere, so this would have thrown `ReferenceError` the
  // first time anyone approved anything.
  //
  // `randomUUIDFromBytes` is asserted directly rather than through the global,
  // because Node provides `crypto.randomUUID` under Jest and testing the global
  // here would only be testing Node.

  it('produces a valid RFC 4122 v4 uuid', () => {
    const value = randomUUIDFromBytes();
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sets the version and variant bits, not just the shape', () => {
    for (let i = 0; i < 200; i += 1) {
      const value = randomUUIDFromBytes();
      expect(value[14]).toBe('4');
      expect('89ab').toContain(value[19]);
    }
  });

  it('does not repeat', () => {
    // A `Math.random` implementation would still pass the shape assertions
    // above. This one is drawn from `crypto.getRandomValues`, which on a device
    // is `SecRandomCopyBytes`.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(randomUUIDFromBytes());
    }
    expect(seen.size).toBe(1000);
  });

  it('reports itself available through the probe', () => {
    expect(randomUuidSupported()).toBe(true);
  });
});
