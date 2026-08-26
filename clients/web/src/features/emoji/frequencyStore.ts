import { useMemo, useSyncExternalStore } from "react";

// =============================================================================
// Per-user emoji frequency (#1742).
//
// Ranking is count descending, then glyph for a stable tie-break. Recency is
// not stored and must not be introduced: Mattermost #19258 showed a recency
// sort letting one-off picks bury the emojis a person actually uses.
//
// v1 is this-device localStorage. UX-HT reads the same store for hover-toolbar
// slots. Server per-user sync is out of scope (engine follow-up).
// =============================================================================

export const EMOJI_FREQUENCY_STORAGE_KEY = "momo.web.emoji.frequency.v1";
export const EMOJI_FREQUENCY_LIMIT = 32;

type Counts = Record<string, number>;

const listeners = new Set<() => void>();

function readCounts(): Counts {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(EMOJI_FREQUENCY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Counts = {};
    for (const [glyph, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[glyph] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

let counts: Counts = readCounts();

/** Ranked used-glyphs only. Rebuilt on emit; the same array is returned until then. */
const EMPTY_RANKING: readonly string[] = Object.freeze([]);
let rankingCache: readonly string[] = EMPTY_RANKING;

function rankUsed(): readonly string[] {
  const ranked = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([glyph]) => glyph);
  return ranked.length === 0 ? EMPTY_RANKING : ranked;
}

rankingCache = rankUsed();

function emit() {
  rankingCache = rankUsed();
  for (const listener of listeners) listener();
}

function persist() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(EMOJI_FREQUENCY_STORAGE_KEY, JSON.stringify(counts));
}

export function recordEmojiUse(glyph: string): void {
  if (!glyph) return;
  counts = { ...counts, [glyph]: (counts[glyph] ?? 0) + 1 };
  persist();
  emit();
}

export function getEmojiFrequency(glyph: string): number {
  return counts[glyph] ?? 0;
}

function mergeRanking(
  ranked: readonly string[],
  seed: readonly string[],
  limit: number
): string[] {
  if (ranked.length === 0) return [...seed].slice(0, limit);
  const seen = new Set(ranked);
  const out = [...ranked];
  for (const glyph of seed) {
    if (out.length >= limit) break;
    if (seen.has(glyph)) continue;
    seen.add(glyph);
    out.push(glyph);
  }
  return out.slice(0, limit);
}

export function frequentEmojis(
  limit = EMOJI_FREQUENCY_LIMIT,
  seed: readonly string[] = []
): string[] {
  return mergeRanking(rankUsed(), seed, limit);
}

/** Stable ranking array. Same reference until the next emit. */
export function getEmojiRankingSnapshot(): readonly string[] {
  return rankingCache;
}

function getServerEmojiRankingSnapshot(): readonly string[] {
  return EMPTY_RANKING;
}

export function subscribeEmojiFrequency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * UX-HT and the picker share this hook so slot ranking cannot drift.
 *
 * `getSnapshot` returns the store's ranking array (one reference, rebuilt only
 * on emit). Limit/seed slicing is a hook-local memo: two consumers with
 * different limits cannot evict each other's cache.
 */
export function useFrequentEmojis(
  seed: readonly string[],
  limit = EMOJI_FREQUENCY_LIMIT
): readonly string[] {
  const ranking = useSyncExternalStore(
    subscribeEmojiFrequency,
    getEmojiRankingSnapshot,
    getServerEmojiRankingSnapshot
  );
  return useMemo(
    () => mergeRanking(ranking, seed, limit),
    [ranking, seed, limit]
  );
}

/** Test helper. Not for product code. */
export function resetEmojiFrequencyForTests(): void {
  counts = {};
  rankingCache = EMPTY_RANKING;
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(EMOJI_FREQUENCY_STORAGE_KEY);
  }
  emit();
}
