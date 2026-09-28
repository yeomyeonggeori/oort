import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEVICE_KEY_ACCESS_GROUP } from '../src/deviceKey/native';

// =============================================================================
// #3026 / ADR-0146 개정 2026-09-28 D-2: the device key lives in a keychain group
// that ONLY the app declares. The notification extension must not declare it
// (then it can neither read the enclave handle nor raise Face ID for it), and
// the provisioning profiles will not stop it — they grant the team wildcard
// `YWQQFQM38J.*` to both App IDs (measured 2026-09-28). So the extension's
// .entitlements file is the whole defence, and this suite is its declared-side
// gate; ios/ci_scripts/ci_post_xcodebuild.sh §4b is the signed-side one.
//
// The Swift source is read as text for the properties no simulator can execute
// (the enclave path); modules/momo-device-key-native/sim-check runs the rest.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const IOS = join(APP_ROOT, 'ios');
const MODULE = join(APP_ROOT, 'modules/momo-device-key-native/ios');

const read = (p: string) => readFileSync(p, 'utf8');
const appEnt = read(join(IOS, 'MomoMobile/MomoMobile.entitlements'));
const nseEnt = read(
  join(IOS, 'NotificationService/MomoMobileNotificationService.entitlements'),
);
const appPlist = read(join(IOS, 'MomoMobile/Info.plist'));
const nsePlist = read(join(IOS, 'NotificationService/Info.plist'));
const store = read(join(MODULE, 'MomoDeviceKeyStore.swift'));
const wrapper = read(join(MODULE, 'MomoDeviceKeyNativeModule.swift'));

/** XML comments explain the group by name; only declarations count. */
const declarations = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');
/** Swift comments name the forbidden types to explain why they are absent. */
const swiftCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The `<string>`s inside the keychain-access-groups array, in order. */
function keychainGroups(xml: string): string[] {
  const body = declarations(xml).match(
    /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!body) return [];
  return [...body[1].matchAll(/<string>([^<]+)<\/string>/g)].map(m => m[1]);
}

const DEVICE_GROUP = `$(AppIdentifierPrefix)${DEVICE_KEY_ACCESS_GROUP}`;
const SHARED_GROUP = '$(AppIdentifierPrefix)app.momo.ios.shared';

describe('the device-key group is the app’s alone', () => {
  it('names the same group in JS, Swift and the ci verifier', () => {
    expect(DEVICE_KEY_ACCESS_GROUP).toBe('app.momo.ios.devicekey');
    expect(store).toContain(`accessGroupSuffix = "${DEVICE_KEY_ACCESS_GROUP}"`);
    expect(read(join(IOS, 'ci_scripts/ci_post_xcodebuild.sh'))).toContain(
      `DEVICE_KEY_GROUP_SUFFIX="${DEVICE_KEY_ACCESS_GROUP}"`,
    );
  });

  it('is declared by the app, AFTER the shared group', () => {
    // Keychain writes that name no group land in the FIRST listed group
    // (secureSession.ts). Prepending the new group would move every existing
    // install's items on upgrade.
    expect(keychainGroups(appEnt)).toEqual([SHARED_GROUP, DEVICE_GROUP]);
  });

  it('is NOT declared by the notification extension', () => {
    expect(keychainGroups(nseEnt)).toEqual([SHARED_GROUP]);
    expect(declarations(nseEnt)).not.toContain(DEVICE_KEY_ACCESS_GROUP);
  });

  it('is resolvable from the app Info.plist and absent from the extension’s', () => {
    expect(appPlist).toContain('<key>MomoDeviceKeyAccessGroup</key>');
    expect(appPlist).toContain(`<string>${DEVICE_GROUP}</string>`);
    expect(declarations(nsePlist)).not.toContain('MomoDeviceKeyAccessGroup');
  });

  it('is not linked into the extension target', () => {
    // The extension compiles its own sources; the module must not be one.
    const nseSources = readdirSync(join(IOS, 'NotificationService'))
      .filter(f => f.endsWith('.swift'))
      .map(f => read(join(IOS, 'NotificationService', f)))
      .join('\n');
    expect(nseSources).not.toMatch(/MomoDeviceKey/);
    // No pod — and so no Expo module — is linked into the extension: the
    // Podfile has no target for it at all (Podfile: "deliberately absent").
    const pods = read(join(IOS, 'Podfile')).replace(/#.*$/gm, '');
    expect(pods).toMatch(/target 'MomoMobile' do/);
    expect(pods).not.toMatch(/target ['"]MomoMobileNotificationService/);
  });

  it('carries the Face ID usage description the prompt needs', () => {
    expect(appPlist).toMatch(
      /<key>NSFaceIDUsageDescription<\/key>\s*<string>[^<]*Face ID[^<]*<\/string>/,
    );
  });
});

describe('MomoDeviceKeyStore — the properties no simulator can run', () => {
  const code = swiftCode(store);

  it('only ever makes Secure Enclave keys, never a software P-256 key', () => {
    // `P256.Signing.PrivateKey(` not preceded by `SecureEnclave.` is the
    // software type: a quiet fallback would look identical to JS and server.
    expect(code).not.toMatch(
      /(?<!SecureEnclave\.)P256\.Signing\.PrivateKey\s*\(/,
    );
    expect(code).not.toMatch(/SecKeyCreateRandomKey/);
    expect(code).toMatch(
      /SecureEnclave\.P256\.Signing\.PrivateKey\(accessControl:/,
    );
  });

  it('guards every operation on the enclave, with the simulator hard-wired off', () => {
    expect(code).toMatch(
      /#if targetEnvironment\(simulator\)\s*return false\s*#else\s*return SecureEnclave\.isAvailable/,
    );
    for (const fn of ['create', 'publicKey', 'sign']) {
      const body = code.match(
        new RegExp(`func ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`),
      );
      expect(body?.[1]).toMatch(
        /guard Self\.secureEnclaveAvailable else \{ throw MomoDeviceKeyFailure\.unsupported \}/,
      );
    }
  });

  it('binds the key to the CURRENT biometry set, this device only', () => {
    expect(code).toMatch(/\[\.privateKeyUsage, \.biometryCurrentSet\]/);
    expect(code).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly');
    expect(code).not.toMatch(/\.userPresence|\.devicePasscode|\.biometryAny/);
    expect(code).not.toMatch(/deviceOwnerAuthentication\b(?!WithBiometrics)/);
  });

  it('always names the app-only access group on every keychain call', () => {
    expect(code).toMatch(/kSecAttrAccessGroup as String: accessGroup/);
    // Every keychain call goes through baseQuery().
    const calls =
      code.match(/SecItem(Add|CopyMatching|Delete|Update)\(([^,)]*)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call).toMatch(/query|baseQuery/);
  });

  it('returns only public shapes across the bridge', () => {
    const bridge = swiftCode(wrapper);
    expect(bridge).not.toMatch(
      /dataRepresentation|privateKey|SecKeyCopyExternalRepresentation/,
    );
    expect(code).toContain('publicKey.compressedRepresentation');
    expect(code).toContain('.rawRepresentation');
  });
});
