import {base64ToBytes} from './base64';
import {sha256} from './sha256';

/**
 * The fingerprint a person compares between this phone and the root Mac
 * (ADR-0146 개정 2026-09-28 D-6 ②): SHA-256 over the 33 compressed key bytes,
 * the first 10 bytes as upper-case hex in five groups of four —
 * `5BAF F89D E7DE 5C1D 7B61`.
 *
 * It has to be the SAME string the Mac shows, or the comparison means nothing.
 * The Mac computes it twice — the web panel (`clients/web/src/features/settings/
 * deviceKeysShared.ts` `deviceKeyFingerprint`, WebCrypto) and the desktop
 * shell's native dialog (`device_key/payload.rs` `fingerprint`, shared case
 * `FINGERPRINT_VECTOR`). `__tests__/deviceKeyFingerprint.test.ts` runs the web
 * function and this one over the same keys.
 *
 * Returns null for anything that is not a 33-byte key: a fingerprint of the
 * wrong bytes would be a confident-looking lie.
 */
export function deviceKeyFingerprint(publicKeyB64: string): string | null {
  const bytes = base64ToBytes(publicKeyB64);
  if (!bytes || bytes.length !== 33) return null;
  const digest = sha256(bytes).slice(0, 10);
  let hexText = '';
  for (const byte of digest) hexText += (byte + 0x100).toString(16).slice(1);
  return (hexText.toUpperCase().match(/.{4}/g) ?? []).join(' ');
}

/** How VoiceOver reads it: each group spelled, so 「5BAF」 is not a word. */
export function fingerprintAccessibilityLabel(fingerprint: string): string {
  return fingerprint
    .split(' ')
    .map(group => group.split('').join(' '))
    .join(', ');
}
