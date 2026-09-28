import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { refreshKeySupported, signRefreshProof } from '../src/deviceKey/refreshKey';

// =============================================================================
// #3106 — the phone's refresh key (ADR-0146 D-7 증보 #3079). The enclave path
// cannot run in Jest or a simulator; `sim-check` runs the Swift bytes against
// momo-wire's vector and proves "no enclave, no key". This suite pins the JS
// bridge and reads the Swift source for the properties only a device has.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const MODULE = join(APP_ROOT, 'modules/momo-device-key-native/ios');
const read = (p: string) => readFileSync(p, 'utf8');
const swiftCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const refreshStore = swiftCode(read(join(MODULE, 'MomoRefreshKeyStore.swift')));
const deviceStore = swiftCode(read(join(MODULE, 'MomoDeviceKeyStore.swift')));
const wrapper = swiftCode(read(join(MODULE, 'MomoDeviceKeyNativeModule.swift')));

const vector = JSON.parse(read(join(__dirname, 'fixtures/refresh-proof.vector.json'))) as {
  schema: string;
  payload: string;
  signature: string;
  inputs: {
    workspaceId: string;
    memberId: string;
    publicKey: string;
    refreshToken: string;
    nonce: string;
    signedAtMs: number;
  };
};

const request = {
  refreshToken: vector.inputs.refreshToken,
  workspaceId: vector.inputs.workspaceId,
  memberId: vector.inputs.memberId,
  signedAtMs: vector.inputs.signedAtMs,
};

function fakeNative(answer: unknown | Error) {
  const calls: unknown[][] = [];
  return {
    calls,
    module: {
      secureEnclaveAvailable: true,
      signRefreshProof: async (...args: unknown[]) => {
        calls.push(args);
        if (answer instanceof Error) throw answer;
        return answer as never;
      },
    },
  };
}

const good = {
  publicKey: vector.inputs.publicKey,
  nonce: vector.inputs.nonce,
  signedAtMs: vector.inputs.signedAtMs,
  signature: vector.signature,
};

describe('the JS bridge', () => {
  it('hands native typed fields — never bytes — and returns the checked proof', async () => {
    const native = fakeNative(good);
    await expect(signRefreshProof(request, native.module)).resolves.toEqual(good);
    expect(native.calls).toEqual([
      [request.workspaceId, request.memberId, request.refreshToken, request.signedAtMs],
    ]);
  });

  it('no module, no enclave, or an unsupported build: no proof (null), not a failure', async () => {
    await expect(signRefreshProof(request, null)).resolves.toBeNull();
    const noEnclave = { ...fakeNative(good).module, secureEnclaveAvailable: false };
    await expect(signRefreshProof(request, noEnclave)).resolves.toBeNull();
    for (const code of ['DEVICE_KEY_UNSUPPORTED', 'DEVICE_KEY_MISCONFIGURED']) {
      const error = Object.assign(new Error('no'), { code });
      await expect(signRefreshProof(request, fakeNative(error).module)).resolves.toBeNull();
    }
    const real = Object.assign(new Error('enclave'), { code: 'DEVICE_KEY_FAILED' });
    await expect(signRefreshProof(request, fakeNative(real).module)).rejects.toThrow('enclave');
  });

  it('refuses a malformed proof rather than send one the server would read as another key', async () => {
    for (const bad of [
      { ...good, publicKey: 'AAAA' },
      { ...good, signature: 'AAAA' },
      { ...good, nonce: 'ABCDEF00-0000-4000-8000-000000000003' },
      { ...good, signedAtMs: good.signedAtMs + 1 },
      null,
    ]) {
      await expect(signRefreshProof(request, fakeNative(bad).module)).rejects.toThrow(
        'malformed refresh proof',
      );
    }
  });

  // Sabotage: drop `signRefreshProof` from the port — no refresh carries a
  // proof and no sign-in is bound. RED. And only where an enclave exists (a
  // simulator gets no extra bind refresh).
  it('is wired into the session port where an enclave exists, and only there', () => {
    const expo = jest.requireMock('expo-modules-core') as {
      requireOptionalNativeModule: jest.Mock;
    };
    expo.requireOptionalNativeModule.mockImplementation((name: string) =>
      name === 'MomoDeviceKeyNative' ? { secureEnclaveAvailable: true } : null,
    );
    jest.isolateModules(() => {
      const { sessionPort } = require('../src/storage/secureSession');
      expect(typeof sessionPort.signRefreshProof).toBe('function');
    });
    expo.requireOptionalNativeModule.mockImplementation(() => null);
    jest.isolateModules(() => {
      const { sessionPort } = require('../src/storage/secureSession');
      expect(sessionPort.signRefreshProof).toBeUndefined();
    });
    expect(refreshKeySupported(null)).toBe(false);
  });
});

describe('the Swift side, read as text', () => {
  it('the shared vector fixture is docs/api’s copy', () => {
    expect(read(join(__dirname, 'fixtures/refresh-proof.vector.json'))).toBe(
      read(join(APP_ROOT, '../../docs/api/refresh-proof.vector.json')),
    );
    expect(vector.payload.split('\n')).toHaveLength(7);
    expect(vector.payload.split('\n')[0]).toBe(vector.schema);
    expect(refreshStore).toContain(`static let schema = "${vector.schema}"`);
    expect(refreshStore).toContain('static let lineCount = 7');
  });

  // Owner decision 2026-09-28: PrivateKeyUsage only, ThisDeviceOnly, no
  // biometry. Sabotage: add `.biometryCurrentSet` — background refreshes
  // would need Face ID. RED.
  it('the refresh key has no biometry and survives a locked phone, the instruction key keeps Face ID', () => {
    expect(refreshStore).toMatch(
      /static let accessFlags: SecAccessControlCreateFlags = \[\.privateKeyUsage\]/,
    );
    expect(refreshStore).not.toMatch(/biometry(Current|Any)|userPresence|devicePasscode/);
    expect(refreshStore).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(refreshStore).not.toContain('kSecAttrAccessibleWhenUnlocked');
    expect(deviceStore).toContain('[.privateKeyUsage, .biometryCurrentSet]');
    // Never a software key, here either.
    expect(refreshStore).not.toMatch(/(?<!SecureEnclave\.)P256\.Signing\.PrivateKey/);
    expect(refreshStore).toContain('SecureEnclave.P256.Signing.PrivateKey');
  });

  it('is another item in the app-only group, not the extension’s', () => {
    expect(refreshStore).toContain('static let service = "app.momo.ios.refreshkey"');
    expect(refreshStore).toContain('static let keyAccount = "p256-refresh-v1"');
    expect(deviceStore).toContain('static let service = "app.momo.ios.devicekey"');
    expect(refreshStore).toContain('hasSuffix(".\\(MomoDeviceKeyStore.accessGroupSuffix)")');
    expect(refreshStore).not.toContain('app.momo.ios.shared');
  });

  // Cross-sabotage: each key signs only its own statements.
  it('the instruction key does not sign refresh proofs; the refresh key signs nothing but them', () => {
    const table = deviceStore.match(/signingSchemas: \[String: Int\] = \[([\s\S]*?)\]/)?.[1] ?? '';
    expect(table).not.toContain('refresh_proof');
    // The refresh key's only signing call is behind checkProofPayload, on bytes
    // proofBytes built — and native exposes no bytes-in function for it.
    const prove = refreshStore.match(/public func prove\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(prove.indexOf('proofBytes(')).toBeGreaterThan(-1);
    expect(prove.indexOf('checkProofPayload(')).toBeGreaterThan(prove.indexOf('proofBytes('));
    expect(prove.indexOf('.signature(for: bytes)')).toBeGreaterThan(prove.indexOf('checkProofPayload('));
    expect((refreshStore.match(/\.signature\(for:/g) ?? []).length).toBe(1);
    const exposed = wrapper.match(/AsyncFunction\("signRefreshProof"\)[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(exposed).toContain('workspaceId: String, memberId: String, refreshToken: String, signedAtMs: Double');
    expect(exposed).not.toMatch(/messageBase64|Data\(base64Encoded/);
  });
});
