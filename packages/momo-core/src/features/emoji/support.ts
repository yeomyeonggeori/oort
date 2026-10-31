/** Conservative Apple Color Emoji coverage; unknown future OS releases keep the last verified set.
 * Sources: https://support.apple.com/en-au/123075 (26.4),
 * https://support.apple.com/en-au/121161 (18.4).
 * No glyph-width heuristic: a missing ZWJ glyph can measure like a supported emoji.
 */
export function iosEmojiVersion(version: string): number {
  const [major, minor = 0] = version.split(".").map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return 0;
  const atLeast = (m: number, n: number) =>
    major > m || (major === m && minor >= n);
  if (atLeast(26, 4)) return 17;
  if (atLeast(18, 4)) return 16;
  if (atLeast(17, 4)) return 15.1;
  if (atLeast(16, 4)) return 15;
  if (atLeast(15, 4)) return 14;
  if (atLeast(14, 5)) return 13.1;
  return 0;
}
