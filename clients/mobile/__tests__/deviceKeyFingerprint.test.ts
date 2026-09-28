import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {bytesToBase64} from '../src/deviceKey/base64';
import {
  deviceKeyFingerprint,
  fingerprintAccessibilityLabel,
} from '../src/deviceKey/fingerprint';
import {hex, sha256, utf8} from '../src/deviceKey/sha256';

/**
 * The Mac's own function, from clients/web as it ships. Loaded with `require`
 * so this project's `tsc` does not type-check the web tree (its `@/` alias is
 * the web project's); jest runs it through babel like the core.
 */
const {deviceKeyFingerprint: webFingerprint} =
  require('../../web/src/features/settings/deviceKeysShared') as {
    deviceKeyFingerprint: (publicKeyB64: string) => Promise<string>;
  };

// =============================================================================
// #3026 stage 2 — the phone shows the SAME fingerprint as the Mac.
//
// A person approves the phone on the Mac by comparing two strings (ADR-0146
// 개정 D-6 ②). If the phone's recipe drifts by one byte, both screens show a
// confident fingerprint and they never match — or worse, a wrong key matches by
// accident of a shared bug. So the phone's function is run against the Mac's own
// code, not against a copy of its output:
//   - the web panel's `deviceKeyFingerprint` (WebCrypto), imported from
//     clients/web as it ships
//   - the desktop shell's `FINGERPRINT_VECTOR`, read out of its Rust test file
// The pure-TS SHA-256 it rests on is checked against node's OpenSSL.
// =============================================================================

const SHARED_KEY = 'A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW';

function desktopVector(): string {
  const source = readFileSync(
    join(
      __dirname,
      '../../desktop/src-tauri/src/device_key/payload/tests.rs',
    ),
    'utf8',
  );
  const match = source.match(/FINGERPRINT_VECTOR: &str = "([0-9A-F ]+)"/);
  if (!match) throw new Error('FINGERPRINT_VECTOR not found in the desktop tests');
  return match[1];
}

function randomCompressedKey(): string {
  const bytes = randomBytes(33);
  bytes[0] = bytes[0] % 2 === 1 ? 0x03 : 0x02;
  return bytesToBase64(Uint8Array.from(bytes));
}

describe('sha256 (pure TypeScript) against node', () => {
  it('matches the FIPS examples', () => {
    expect(hex(sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      hex(
        sha256(
          utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        ),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node for every length across the padding boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = randomBytes(length);
      expect(hex(sha256(Uint8Array.from(bytes)))).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
  });

  it('encodes UTF-8 like node, astral characters included, and refuses lone surrogates', () => {
    for (const text of ['', 'a', '한국어', 'café', 'é', '👍🏽 ok', '\u{10FFFF}']) {
      expect(Buffer.from(utf8(text)).equals(Buffer.from(text, 'utf8'))).toBe(true);
    }
    expect(() => utf8('\ud800')).toThrow(RangeError);
    expect(() => utf8('a\udc00b')).toThrow(RangeError);
  });
});

describe('deviceKeyFingerprint — one string on the phone and the Mac', () => {
  it('gives the shared case the desktop shell pins', () => {
    const vector = desktopVector();
    expect(vector).toBe('5BAF F89D E7DE 5C1D 7B61');
    expect(deviceKeyFingerprint(SHARED_KEY)).toBe(vector);
  });

  it('agrees with the web panel on the shared key and on random keys', async () => {
    expect(deviceKeyFingerprint(SHARED_KEY)).toBe(await webFingerprint(SHARED_KEY));
    for (let i = 0; i < 64; i += 1) {
      const key = randomCompressedKey();
      expect(deviceKeyFingerprint(key)).toBe(await webFingerprint(key));
    }
  });

  it('is five groups of four upper-case hex digits', () => {
    expect(deviceKeyFingerprint(randomCompressedKey())).toMatch(
      /^[0-9A-F]{4}( [0-9A-F]{4}){4}$/,
    );
  });

  it('refuses anything that is not a 33-byte key rather than fingerprinting it', () => {
    expect(deviceKeyFingerprint('')).toBeNull();
    expect(deviceKeyFingerprint('not base64')).toBeNull();
    expect(deviceKeyFingerprint(bytesToBase64(new Uint8Array(65).fill(4)))).toBeNull();
  });

  it('is spelled group by group for VoiceOver', () => {
    expect(fingerprintAccessibilityLabel('5BAF F89D')).toBe('5 B A F, F 8 9 D');
  });
});
