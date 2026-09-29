import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {DEVICE_KEY_ACCESS_GROUP} from '../src/deviceKey/native';
import {
  APP_ONLY_KEYCHAIN_ACCESS_GROUP,
  appOnlyGroupFrom,
  NSE_KEYCHAIN_ACCESS_GROUP,
} from '../src/storage/keychainGroups';

// #3121 — what the notification extension can and cannot reach in the keychain.
// The extension is a separate binary; nothing but its entitlements and its code
// decides which groups it can read, so this suite reads both.

const APP_ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(APP_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^:]\/\/.*$/gm, '');
const declarations = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');
const groupsOf = (xml: string): string[] => {
  const body = declarations(xml).match(
    /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  return body ? [...body[1].matchAll(/<string>([^<]+)<\/string>/g)].map(m => m[1]) : [];
};

describe('the two groups', () => {
  it('app-only name is the device key group everywhere', () => {
    expect(APP_ONLY_KEYCHAIN_ACCESS_GROUP).toBe(DEVICE_KEY_ACCESS_GROUP);
    expect(APP_ONLY_KEYCHAIN_ACCESS_GROUP).toBe('app.momo.ios.devicekey');
    expect(NSE_KEYCHAIN_ACCESS_GROUP).toBe('app.momo.ios.shared');
  });

  it('derives the app-only group with the same team prefix', () => {
    expect(appOnlyGroupFrom('YWQQFQM38J.app.momo.ios.shared')).toBe(
      'YWQQFQM38J.app.momo.ios.devicekey',
    );
    expect(appOnlyGroupFrom(null)).toBeNull();
    expect(appOnlyGroupFrom('YWQQFQM38J.something.else')).toBeNull();
  });
});

describe('the extension can reach the shared group and only that', () => {
  const nse = read('ios/NotificationService/MomoMobileNotificationService.entitlements');
  const app = read('ios/MomoMobile/MomoMobile.entitlements');

  it('the extension declares the shared group alone', () => {
    expect(groupsOf(nse)).toEqual(['$(AppIdentifierPrefix)app.momo.ios.shared']);
  });

  it('the app declares the app-only group, which the extension does not', () => {
    expect(groupsOf(app)).toContain(`$(AppIdentifierPrefix)${APP_ONLY_KEYCHAIN_ACCESS_GROUP}`);
    expect(declarations(nse)).not.toContain(APP_ONLY_KEYCHAIN_ACCESS_GROUP);
  });
});

describe('no code path hands the extension a session credential', () => {
  const session = code(read('src/storage/secureSession.ts'));
  const fetchSession = code(read('src/push/pushFetchSession.ts'));
  const provider = code(read('src/push/PushProvider.tsx'));

  it('the refresh token is always written with an explicit group when one resolves', () => {
    expect(session).toMatch(/accessGroup: groups\.appOnly/);
    // The write helper never names the SHARED group.
    const store = session.match(/async function storeToken[\s\S]*?\n\}\n/);
    expect(store?.[0]).toBeDefined();
    expect(store?.[0]).not.toMatch(/shared/);
  });

  it('the push-fetch publish takes a minted token, not an access token', () => {
    expect(fetchSession).toMatch(/fetchToken: string/);
    expect(fetchSession).not.toMatch(/getAccessToken/);
    const input = fetchSession.match(/interface PushFetchSessionInput \{[^}]*\}/);
    expect(input?.[0]).toBeDefined();
    expect(input?.[0]).not.toMatch(/accessToken/);
  });

  it('PushProvider never passes the session access token to the publish', () => {
    // It may ask whether a session exists (`getAccessToken() !== null`); it may
    // not hand the value on.
    expect(provider).not.toMatch(/accessToken,?\s*\n?\s*\}\)/);
    expect(provider).toMatch(/fetchToken/);
    expect(provider).not.toMatch(/publishPushFetchSession\(\{[^}]*getAccessToken/);
  });
});
