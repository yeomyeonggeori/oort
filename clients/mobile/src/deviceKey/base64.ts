// Standard base64 (RFC 4648 §4, with padding) — the alphabet Swift's
// `Data.base64EncodedString()` writes and `Data(base64Encoded:)` reads.
//
// Written out rather than borrowed from `atob`/`btoa` so the device-key bridge
// does not depend on which JS engine happens to provide those globals, and so a
// malformed value from the native side is rejected here instead of being
// half-decoded.

/* eslint-disable no-bitwise -- base64 is bit packing; there is no other way to write it. */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>(
  [...ALPHABET].map((char, index) => [char, index]),
);

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[triple & 63] : '=';
  }
  return out;
}

/** Returns null for anything that is not canonical padded base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const body = text.slice(0, text.length - padding);
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of body) {
    const digit = LOOKUP.get(char);
    if (digit === undefined) return null;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  // Non-zero leftover bits mean a non-canonical encoding.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return index === out.length ? out : null;
}
