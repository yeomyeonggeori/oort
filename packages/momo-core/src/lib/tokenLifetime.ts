/** Scheduling hint only; the server still authenticates every token (#4783). */
export function tokenExpiresAtMs(token: string | null): number | null {
  const payload = token?.split(".")[1];
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  // No atob/Buffer dependency: this also runs on Hermes. JWT claim names and
  // numeric exp are ASCII; other claims are never read or retained.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let bits = 0;
  let value = 0;
  let decoded = "";
  for (const char of payload) {
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((value >>> bits) & 255);
    }
  }
  try {
    const exp: unknown = JSON.parse(decoded)?.exp;
    return typeof exp === "number" && Number.isFinite(exp * 1000) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
