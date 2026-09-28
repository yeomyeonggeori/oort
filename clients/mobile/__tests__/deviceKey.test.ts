import { base64ToBytes, bytesToBase64 } from '../src/deviceKey/base64';

// =============================================================================
// The JS contract of the device-key bridge (#3026 stage 1). The native module
// is replaced by an in-memory double whose behaviour each test sets; what is
// under test is what src/deviceKey/native.ts lets through and what it refuses.
// Real enclave behaviour is runtime-unverified here (owner device check).
// =============================================================================

type NativeDouble = {
  secureEnclaveAvailable: boolean;
  status: jest.Mock;
  create: jest.Mock;
  publicKey: jest.Mock;
  sign: jest.Mock;
  remove: jest.Mock;
};

// `mock`-prefixed: jest hoists the factory above this file's declarations.
let mockNative: NativeDouble | null = null;

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'MomoDeviceKeyNative' ? mockNative : null,
}));

function nativeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** A syntactically valid compressed P-256 point (0x02 ‖ 32 bytes). */
const COMPRESSED = bytesToBase64(
  Uint8Array.from([0x02, ...new Array(32).fill(7)]),
);
const UNCOMPRESSED = bytesToBase64(
  Uint8Array.from([0x04, ...new Array(64).fill(7)]),
);
const RAW_SIG = bytesToBase64(new Uint8Array(64).fill(9));
/** A DER-encoded ECDSA signature is 70–72 bytes, never 64. */
const DER_SIG = bytesToBase64(
  Uint8Array.from([0x30, 0x44, ...new Array(68).fill(1)]),
);

function secureEnclavePhone(): NativeDouble {
  return {
    secureEnclaveAvailable: true,
    status: jest.fn(async () => 'ready'),
    create: jest.fn(async () => COMPRESSED),
    publicKey: jest.fn(async () => COMPRESSED),
    sign: jest.fn(async () => RAW_SIG),
    remove: jest.fn(async () => undefined),
  };
}

/** What MomoDeviceKeyStore does on a device with no enclave: refuse all. */
function simulator(): NativeDouble {
  const unsupported = async () => {
    throw nativeError('DEVICE_KEY_UNSUPPORTED');
  };
  return {
    secureEnclaveAvailable: false,
    status: jest.fn(async () => 'unsupported'),
    create: jest.fn(unsupported),
    publicKey: jest.fn(unsupported),
    sign: jest.fn(unsupported),
    remove: jest.fn(async () => undefined),
  };
}

function load(
  double: NativeDouble | null,
): typeof import('../src/deviceKey/native') {
  mockNative = double;
  let mod!: typeof import('../src/deviceKey/native');
  jest.isolateModules(() => {
    mod = require('../src/deviceKey/native');
  });
  return mod;
}

describe('base64', () => {
  it('round-trips every length mod 3', () => {
    for (const n of [0, 1, 2, 3, 32, 33, 64, 65]) {
      const bytes = Uint8Array.from(
        { length: n },
        (_, i) => (i * 37 + 11) % 256,
      );
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(base64ToBytes(text) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it('refuses non-canonical input instead of half-decoding it', () => {
    expect(base64ToBytes('abc')).toBeNull();
    expect(base64ToBytes('ab!=')).toBeNull();
    expect(base64ToBytes('AB==')).toBeNull(); // leftover bits set
  });
});

describe('on a phone with a Secure Enclave', () => {
  it('returns the compressed SEC1 public key with alg p256', async () => {
    const m = load(secureEnclavePhone());
    await expect(m.createDeviceKey()).resolves.toEqual({
      alg: 'p256',
      publicKey: COMPRESSED,
    });
    expect(base64ToBytes(COMPRESSED)?.length).toBe(33);
  });

  it('refuses an uncompressed (65-byte) public key from native', async () => {
    const phone = secureEnclavePhone();
    phone.create.mockResolvedValue(UNCOMPRESSED);
    phone.publicKey.mockResolvedValue(UNCOMPRESSED);
    const m = load(phone);
    await expect(m.createDeviceKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_MALFORMED',
    });
    await expect(m.deviceKeyPublicKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_MALFORMED',
    });
  });

  it('refuses a 33-byte value whose prefix is not 0x02/0x03', async () => {
    const phone = secureEnclavePhone();
    phone.create.mockResolvedValue(
      bytesToBase64(Uint8Array.from([0x04, ...new Array(32).fill(7)])),
    );
    await expect(load(phone).createDeviceKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_MALFORMED',
    });
  });

  it('passes the caller bytes through as base64 and returns raw r‖s', async () => {
    const phone = secureEnclavePhone();
    const m = load(phone);
    const message = new TextEncoder().encode('momo.human.control.v1\nanything');
    const sig = await m.signWithDeviceKey(message);
    expect(sig.length).toBe(64);
    expect(phone.sign).toHaveBeenCalledWith(
      bytesToBase64(message),
      m.DEFAULT_SIGN_REASON,
    );
  });

  it('refuses a DER signature (not raw r‖s)', async () => {
    const phone = secureEnclavePhone();
    phone.sign.mockResolvedValue(DER_SIG);
    await expect(
      load(phone).signWithDeviceKey(Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: 'DEVICE_KEY_MALFORMED' });
  });

  it('refuses to sign nothing, and never asks native to', async () => {
    const phone = secureEnclavePhone();
    await expect(
      load(phone).signWithDeviceKey(new Uint8Array(0)),
    ).rejects.toBeDefined();
    expect(phone.sign).not.toHaveBeenCalled();
  });

  it('maps native codes to typed errors', async () => {
    const phone = secureEnclavePhone();
    phone.sign.mockRejectedValue(nativeError('DEVICE_KEY_INVALIDATED'));
    phone.create.mockRejectedValue(nativeError('DEVICE_KEY_ALREADY_EXISTS'));
    phone.status.mockRejectedValue(nativeError('SOMETHING_ELSE'));
    const m = load(phone);
    const err = await m.signWithDeviceKey(Uint8Array.of(1)).catch(e => e);
    expect(err).toBeInstanceOf(m.DeviceKeyError);
    expect(err.code).toBe('DEVICE_KEY_INVALIDATED');
    await expect(m.createDeviceKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_ALREADY_EXISTS',
    });
    await expect(m.deviceKeyStatus()).rejects.toMatchObject({
      code: 'DEVICE_KEY_FAILED',
    });
  });

  it('reports invalidated as its own status (Face ID re-enrolled)', async () => {
    const phone = secureEnclavePhone();
    phone.status.mockResolvedValue('invalidated');
    await expect(load(phone).deviceKeyStatus()).resolves.toBe('invalidated');
  });

  it('refuses a status word it does not know', async () => {
    const phone = secureEnclavePhone();
    phone.status.mockResolvedValue('probably-fine');
    await expect(load(phone).deviceKeyStatus()).rejects.toMatchObject({
      code: 'DEVICE_KEY_MALFORMED',
    });
  });
});

describe('without a Secure Enclave (simulator) — no software fallback', () => {
  it('says unsupported and rejects every key operation with UNSUPPORTED', async () => {
    const keychain = require('react-native-keychain');
    keychain.setGenericPassword.mockClear();
    const m = load(simulator());
    expect(m.deviceKeySupported()).toBe(false);
    await expect(m.deviceKeyStatus()).resolves.toBe('unsupported');
    await expect(m.createDeviceKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_UNSUPPORTED',
    });
    await expect(m.deviceKeyPublicKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_UNSUPPORTED',
    });
    await expect(m.signWithDeviceKey(Uint8Array.of(1))).rejects.toMatchObject({
      code: 'DEVICE_KEY_UNSUPPORTED',
    });
    // Nothing reached for a JS-side key store instead.
    expect(keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  it('with the module not linked at all, rejects NOT_LINKED rather than inventing a key', async () => {
    const m = load(null);
    expect(m.deviceKeySupported()).toBe(false);
    await expect(m.deviceKeyStatus()).resolves.toBe('unsupported');
    await expect(m.createDeviceKey()).rejects.toMatchObject({
      code: 'DEVICE_KEY_NOT_LINKED',
    });
    await expect(m.signWithDeviceKey(Uint8Array.of(1))).rejects.toMatchObject({
      code: 'DEVICE_KEY_NOT_LINKED',
    });
  });
});

describe('the bridge exposes no private material', () => {
  it('has no export that could return a private key', () => {
    const m = load(secureEnclavePhone());
    const names = Object.keys(m);
    expect(
      names.filter(n => /private|secret|export|seed|raw/i.test(n)),
    ).toEqual([]);
  });
});
