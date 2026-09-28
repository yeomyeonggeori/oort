import {createPublicKey, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  DeviceKeyRebindError,
  type DeviceKey,
  type SigningContext,
} from '@momo/core/features/auth/deviceKeys';

import {base64ToBytes} from '../src/deviceKey/base64';
import {
  DEVICE_REBIND_REASON,
  DEVICE_REBIND_SCHEMA,
  deviceRebindBytes,
  rebindPhoneKey,
  RebindUnavailableError,
  type RebindDeps,
} from '../src/deviceKey/deviceRebind';
import {HumanControlInputError} from '../src/deviceKey/humanControl';

jest.mock('expo-modules-core', () => ({requireOptionalNativeModule: () => null}));

// =============================================================================
// #3103 — the phone's `device_rebind.v1` letter (ADR-0146 D-7 증보 #3097).
// The fixture is what momo-wire's `DeviceRebind` printed for its own golden
// inputs; the desktop shell (`payload/tests.rs`) and the Swift allow-list
// (`sim-check`) read the same file. Bytes equal → the server rebuilds the same
// letter and the signature verifies there.
// =============================================================================

const VECTOR = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/device-rebind.vector.json'), 'utf8'),
) as {
  schema: string;
  inputs: {
    workspaceId: string;
    memberId: string;
    keyId: string;
    publicKey: string;
    sessionId: string;
    signedAtMs: number;
  };
  payload: string;
  signature: string;
};

function p256Verify(publicKeyB64: string, payload: Uint8Array, sigB64: string): boolean {
  const spki = Buffer.concat([
    Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'),
    Buffer.from(base64ToBytes(publicKeyB64)!),
  ]);
  const key = createPublicKey({key: spki, format: 'der', type: 'spki'});
  return verify('sha256', payload, {key, dsaEncoding: 'ieee-p1363'}, Buffer.from(base64ToBytes(sigB64)!));
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

describe('device_rebind.v1 bytes', () => {
  it("are momo-wire's bytes, and momo-wire's signature verifies over them", () => {
    expect(VECTOR.schema).toBe(DEVICE_REBIND_SCHEMA);
    const bytes = deviceRebindBytes(VECTOR.inputs);
    expect(text(bytes)).toBe(VECTOR.payload);
    expect(VECTOR.payload.split('\n')).toHaveLength(7);
    expect(p256Verify(VECTOR.inputs.publicKey, bytes, VECTOR.signature)).toBe(true);
    // Another destination sign-in is another letter.
    const elsewhere = deviceRebindBytes({
      ...VECTOR.inputs,
      sessionId: '00000000-0000-0000-0000-000000000005',
    });
    expect(p256Verify(VECTOR.inputs.publicKey, elsewhere, VECTOR.signature)).toBe(false);
  });

  it('refuses an empty line, a smuggled line break and a bad time', () => {
    expect(() => deviceRebindBytes({...VECTOR.inputs, sessionId: ''})).toThrow(
      HumanControlInputError,
    );
    expect(() =>
      deviceRebindBytes({...VECTOR.inputs, keyId: `${VECTOR.inputs.keyId}\nx`}),
    ).toThrow(HumanControlInputError);
    expect(() => deviceRebindBytes({...VECTOR.inputs, signedAtMs: 0})).toThrow(
      HumanControlInputError,
    );
    expect(() => deviceRebindBytes({...VECTOR.inputs, signedAtMs: 1.5})).toThrow(
      HumanControlInputError,
    );
  });
});

describe('rebindPhoneKey', () => {
  const CONTEXT: SigningContext = {
    instanceId: 'inst',
    serverTimeMs: VECTOR.inputs.signedAtMs,
    maxLifetimeMs: 600_000,
    maxClockSkewMs: 300_000,
    humanControlSignatureRequired: true,
    hostRegisterSignatureRequired: false,
    sessionId: VECTOR.inputs.sessionId,
  };
  const ROW: DeviceKey = {
    id: VECTOR.inputs.keyId,
    workspaceId: VECTOR.inputs.workspaceId,
    memberId: VECTOR.inputs.memberId,
    alg: 'p256',
    publicKey: VECTOR.inputs.publicKey,
    platform: 'ios',
    label: 'iPhone 17 Pro',
    state: 'endorsed',
    canInstruct: true,
    current: false,
    lineageLive: false,
    createdAtMs: 1,
  };

  function deps(over: Partial<RebindDeps> = {}) {
    const signed: {bytes: string; reason: string}[] = [];
    const posted: unknown[] = [];
    const d: RebindDeps = {
      context: async () => CONTEXT,
      sign: async (bytes, reason) => {
        signed.push({bytes: text(bytes), reason});
        return base64ToBytes(VECTOR.signature)!;
      },
      post: async (_ws, input) => {
        posted.push(input);
        return {...ROW, current: true, lineageLive: true};
      },
      // This phone's clock is 7 minutes fast; the letter still carries the
      // server's time.
      now: () => VECTOR.inputs.signedAtMs + 7 * 60_000,
      ...over,
    };
    return {d, signed, posted};
  }

  const input = {
    workspaceId: VECTOR.inputs.workspaceId,
    memberId: VECTOR.inputs.memberId,
    row: ROW,
    publicKey: VECTOR.inputs.publicKey,
  };

  it("signs the letter for the context's sign-in on the server's clock, with a 해요체 Face ID line, and posts it", async () => {
    const {d, signed, posted} = deps();
    const moved = await rebindPhoneKey(input, d);
    expect(moved.current).toBe(true);
    expect(signed).toEqual([{bytes: VECTOR.payload, reason: DEVICE_REBIND_REASON}]);
    expect(DEVICE_REBIND_REASON).toMatch(/요$/);
    expect(posted).toEqual([
      {
        publicKey: VECTOR.inputs.publicKey,
        platform: 'ios',
        label: 'iPhone 17 Pro',
        rebind: {signedAtMs: VECTOR.inputs.signedAtMs, signature: VECTOR.signature},
      },
    ]);
  });

  it('signs nothing when the server gives no sign-in to move to', async () => {
    const {d, signed, posted} = deps({
      context: async () => ({...CONTEXT, sessionId: null}),
    });
    await expect(rebindPhoneKey(input, d)).rejects.toBeInstanceOf(RebindUnavailableError);
    expect(signed).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('passes on the "not current" failure the core raises', async () => {
    const {d} = deps({
      post: async () => {
        throw new DeviceKeyRebindError();
      },
    });
    await expect(rebindPhoneKey(input, d)).rejects.toBeInstanceOf(DeviceKeyRebindError);
  });
});
