import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEVICE_KEY_ACCESS_GROUP,
  DEVICE_KEY_ERROR_CODES,
} from '../src/deviceKey/native';

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
        new RegExp(`func ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n {2}\\}`),
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

// Review of #3043 (M-3, M-4) — what the simulator cannot run. The payload
// allowlist and the invalidated classification themselves run for real in
// modules/momo-device-key-native/sim-check against the vectors below.
describe('MomoDeviceKeyStore — hardening before stage 2', () => {
  const code = swiftCode(store);
  const FIXTURE = join(
    __dirname,
    'fixtures/human-control-signing.vectors.json',
  );
  const vectors = JSON.parse(read(FIXTURE)) as {
    cases: { name: string; schema: string; payload: string }[];
  };

  it('mirrors every native error code in JS', () => {
    const swiftCodes = [...code.matchAll(/return "(DEVICE_KEY_[A-Z_]+)"/g)].map(
      m => m[1],
    );
    expect(swiftCodes).toContain('DEVICE_KEY_PAYLOAD_REJECTED');
    const jsOnly = ['DEVICE_KEY_NOT_LINKED', 'DEVICE_KEY_MALFORMED'];
    expect([...swiftCodes].sort()).toEqual(
      DEVICE_KEY_ERROR_CODES.filter(c => !jsOnly.includes(c)).sort(),
    );
  });

  it('allows only momo.human.control.v2/v3 and its own device_rebind.v1 (v1 is retired, #3096), with their vector line counts', () => {
    // ADR-0146 D-6/D-7: endorse/revoke are signed by the root Mac, never the phone.
    const control = vectors.cases.filter(
      c => c.schema === 'momo.human.control.v1',
    );
    expect(control.length).toBeGreaterThanOrEqual(6);
    const counts = new Set(control.map(c => c.payload.split('\n').length));
    expect([...counts]).toEqual([13]);
    const table = code.match(
      /signingSchemas: \[String: Int\] = \[([\s\S]*?)\]/,
    );
    const fromSwift: Record<string, number> = {};
    for (const m of (table?.[1] ?? '').matchAll(/"([^"]+)": (\d+)/g)) {
      fromSwift[m[1]] = Number(m[2]);
    }
    expect(fromSwift).toEqual({
      'momo.human.control.v2': 13,
      'momo.human.control.v3': 13,
      'momo.human.control.v4': 13,
      'momo.human.device_rebind.v1': 7,
    });
    // #3103: the letter momo-wire printed is exactly that many lines.
    const rebind = JSON.parse(
      read(join(__dirname, 'fixtures/device-rebind.vector.json')),
    ) as {schema: string; payload: string};
    expect(rebind.payload.split('\n')[0]).toBe(rebind.schema);
    expect(rebind.payload.split('\n')).toHaveLength(fromSwift[rebind.schema]!);
    // …and the key signs only its own move, checked before Face ID.
    expect(code).toMatch(/static let rebindSchema = "momo\.human\.device_rebind\.v1"/);
    const sign =
      code.match(/func sign\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(sign.indexOf('checkRebindNamesKey')).toBeGreaterThan(-1);
    expect(sign.indexOf('checkRebindNamesKey')).toBeLessThan(sign.indexOf('evaluatePolicy'));
    // #3028: the v2 vectors (docs/api, #3027) are 13 lines too.
    const v2 = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/api/human-control-signing-v2.vectors.json'), 'utf8'),
    ) as {cases: {schema: string; payload: string}[]};
    const v2Counts = new Set(
      v2.cases
        .filter(c => c.schema === 'momo.human.control.v2')
        .map(c => c.payload.split('\n').length),
    );
    expect([...v2Counts]).toEqual([13]);
    // #3128: and the #3118 v3 vectors.
    const v3 = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/api/human-control-signing-v3.vectors.json'), 'utf8'),
    ) as {cases: {schema: string; payload: string}[]};
    expect(v3.cases.length).toBe(7);
    expect([...new Set(v3.cases.map(c => c.payload.split('\n').length))]).toEqual([13]);
    expect([...new Set(v3.cases.map(c => c.schema))]).toEqual(['momo.human.control.v3']);
    // #3592: and the v4 new-work spawn vectors (the phone's fixture copy).
    const v4 = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/human-control-signing-v4.vectors.json'), 'utf8'),
    ) as {cases: {schema: string; payload: string}[]};
    expect(v4.cases.length).toBe(4);
    expect([...new Set(v4.cases.map(c => c.payload.split('\n').length))]).toEqual([13]);
    expect([...new Set(v4.cases.map(c => c.schema))]).toEqual(['momo.human.control.v4']);
  });

  it('keeps the vector fixture identical to the E1 original once both are here', () => {
    // docs/api/… arrives on track/uxui with the engine sync; until then the
    // fixture is the copy (origin/track/engine blob 2fcc3096).
    const original = join(
      APP_ROOT,
      '../../docs/api/human-control-signing.vectors.json',
    );
    let upstream: string | null = null;
    try {
      upstream = read(original);
    } catch {
      upstream = null;
    }
    if (upstream !== null) expect(read(FIXTURE)).toBe(upstream);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(8);
  });

  it('checks the payload before anything else in sign()', () => {
    const body =
      code.match(/func sign\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    const firstStatement = body.trim().split('\n')[0];
    expect(firstStatement).toBe('try Self.checkSigningPayload(message)');
  });

  it('serializes create/delete and writes the key handle add-only (M-4)', () => {
    const create =
      code.match(/public func create\(\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(create).toMatch(/Self\.mutations\.sync \{ try createLocked\(\) \}/);
    const del =
      code.match(/public func delete\(\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(del).toMatch(/Self\.mutations\.sync \{/);
    const locked =
      code.match(/func createLocked\(\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(locked).toMatch(
      /try addItem\(Self\.keyAccount, key\.dataRepresentation\)/,
    );
    expect(locked).not.toMatch(/writeItem\(Self\.keyAccount/);
    const add =
      code.match(/func addItem\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(add).not.toMatch(/deleteItem/);
    expect(add).toMatch(
      /case errSecDuplicateItem: throw MomoDeviceKeyFailure\.alreadyExists/,
    );
  });

  it('takes the enrollment fingerprint from the iOS 18 API, legacy only in one place', () => {
    expect(code.match(/evaluatedPolicyDomainState/g)).toHaveLength(1);
    expect(code).toMatch(/context\.domainState\.biometry\.stateHash/);
  });
});
