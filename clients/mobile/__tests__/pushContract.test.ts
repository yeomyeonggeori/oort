import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  PUSH_ACTION,
  PUSH_CATEGORY,
  PUSH_ENVELOPE_SCHEMA,
  PUSH_FETCH_SESSION_ACCOUNT,
  PUSH_KEYCHAIN_SERVICE,
  PUSH_REASONS,
  PUSH_TOPIC,
} from '../src/push/contract';

// =============================================================================
// The app and the notification extension are two binaries with no shared types.
// They agree by string, or they do not agree at all — and when they do not, the
// extension fails OPEN: the notification still arrives, carrying the relay's
// placeholder instead of the message. Nothing throws, nothing logs, and the
// symptom ("pushes arrive but say 새 알림") looks like a server problem.
//
// So this suite reads the Swift source and compares. It is the only mechanism
// that can catch the drift, because no build step spans both sides.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const IOS = join(APP_ROOT, 'ios');
const SWIFT = readFileSync(join(IOS, 'MomoPushKit/PushNotification.swift'), 'utf8');

/** Pull `public static let <name> = "<value>"` out of the Swift source. */
function swiftConstant(name: string): string {
  const match = SWIFT.match(
    new RegExp(`static let ${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!match) throw new Error(`no Swift constant named ${name}`);
  return match[1];
}

/** Pull `case <name> = "<value>"` out of a Swift enum. */
function swiftCase(name: string): string {
  const match = SWIFT.match(new RegExp(`case ${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`no Swift case named ${name}`);
  return match[1];
}

describe('the JS push contract matches the Swift the extension runs', () => {
  it('addresses the same keychain item', () => {
    // These two are the handoff itself. A mismatch here is the single failure
    // the 2026-08-02 audit called the hardest to detect (§2.3).
    expect(PUSH_KEYCHAIN_SERVICE).toBe(swiftConstant('secureSessionService'));
    expect(PUSH_FETCH_SESSION_ACCOUNT).toBe(
      swiftConstant('pushFetchSessionAccount'),
    );
  });

  it('uses the same category identifiers', () => {
    expect(PUSH_CATEGORY.message).toBe(swiftCase('message'));
    expect(PUSH_CATEGORY.mention).toBe(swiftCase('mention'));
    expect(PUSH_CATEGORY.approval).toBe(swiftCase('approval'));
    expect(PUSH_CATEGORY.work).toBe(swiftCase('work'));
  });

  it('uses the same action identifiers', () => {
    // The identifiers RNFirebase could not deliver to JS, which is why
    // expo-notifications was chosen (ADR-0137 D7 정오 5항).
    expect(PUSH_ACTION.quickReply).toBe(swiftConstant('quickReply'));
    expect(PUSH_ACTION.approve).toBe(swiftConstant('approve'));
    expect(PUSH_ACTION.reject).toBe(swiftConstant('reject'));
  });

  it('gates on the same payload schema and reasons', () => {
    expect(SWIFT).toContain(`payload.schema == "${PUSH_ENVELOPE_SCHEMA}"`);
    for (const reason of PUSH_REASONS) {
      expect(SWIFT).toContain(`"${reason}"`);
    }
  });

  it('registers under the app bundle id, never the extension bundle id', () => {
    // The APNs topic is the APP's bundle id. Sending the extension's would make
    // every push undeliverable — APNs rejects a topic no certificate covers.
    expect(PUSH_TOPIC).toBe('app.momo.ios');
  });
});

describe('the inherited Swift has not drifted from the frozen kit', () => {
  it('passes scripts/verify_push_kit_inheritance.sh', () => {
    // Run here as well as in CI so the failure surfaces in the same command a
    // person runs locally (`npm test`), not only in a lane they may not run.
    expect(() =>
      execFileSync(
        'bash',
        [join(APP_ROOT, '../../scripts/verify_push_kit_inheritance.sh')],
        {stdio: 'pipe'},
      ),
    ).not.toThrow();
  });
});

describe('entitlements — the app/extension asymmetry is deliberate', () => {
  const appEnt = readFileSync(
    join(IOS, 'MomoMobile/MomoMobile.entitlements'),
    'utf8',
  );
  const nseEnt = readFileSync(
    join(IOS, 'NotificationService/MomoMobileNotificationService.entitlements'),
    'utf8',
  );

  it('shares the keychain access group verbatim', () => {
    const group = '$(AppIdentifierPrefix)app.momo.ios.shared';
    expect(appEnt).toContain(`<string>${group}</string>`);
    expect(nseEnt).toContain(`<string>${group}</string>`);
  });

  it('shares the App Group verbatim', () => {
    expect(appEnt).toContain('<string>group.app.momo.ios</string>');
    expect(nseEnt).toContain('<string>group.app.momo.ios</string>');
  });

  it('gives aps-environment to the app and NOT to the extension', () => {
    // An extension is woken to rewrite a notification the host registered for;
    // it is not itself an APNs client. Declaring the capability on it demands an
    // entitlement its App ID never needs.
    // Matches the DECLARATION, not the word: the extension's file explains in a
    // comment why the key is absent, and a test that fails on the explanation
    // teaches the next person to delete the explanation.
    expect(appEnt).toContain('<key>aps-environment</key>');
    expect(nseEnt).not.toContain('<key>aps-environment</key>');
  });
});

describe('Info.plist carries what the runtime reads', () => {
  const plist = readFileSync(join(IOS, 'MomoMobile/Info.plist'), 'utf8');
  const nsePlist = readFileSync(join(IOS, 'NotificationService/Info.plist'), 'utf8');
  const pbxproj = readFileSync(
    join(IOS, 'MomoMobile.xcodeproj/project.pbxproj'),
    'utf8',
  );

  it('moves MomoAPNSEnvironment across from the frozen kit', () => {
    // audit §7.2 #9. Without this key the environment can only be guessed from
    // __DEV__, and a Release build signed with a development profile guesses
    // wrong — silently, because APNs simply drops the notification.
    expect(plist).toContain('<key>MomoAPNSEnvironment</key>');
    expect(plist).toContain('<string>$(APS_ENVIRONMENT)</string>');
  });

  it('defines APS_ENVIRONMENT for both configurations', () => {
    // The key above is only as good as the build setting behind it.
    expect(pbxproj).toContain('APS_ENVIRONMENT = development;');
    expect(pbxproj).toContain('APS_ENVIRONMENT = production;');
  });

  it('gives BOTH processes the keychain access group key', () => {
    // PushNotification.swift reads this key from whichever bundle it is running
    // in. The extension without it silently loses its access group; the app
    // without it cannot tell JS where to write.
    const key = '<key>MomoKeychainAccessGroup</key>';
    expect(plist).toContain(key);
    expect(nsePlist).toContain(key);
  });

  it('declares the background mode the id-only design depends on', () => {
    // The relay sends content-available alongside mutable-content
    // (PushDispatch.swift:112-113); without this the former is dropped.
    expect(plist).toContain('<string>remote-notification</string>');
  });

  it('points the extension at the right principal class', () => {
    expect(nsePlist).toContain(
      '<string>$(PRODUCT_MODULE_NAME).NotificationService</string>',
    );
    expect(nsePlist).toContain(
      '<string>com.apple.usernotifications.service</string>',
    );
  });
});
