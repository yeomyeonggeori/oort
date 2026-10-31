// Platform-free device preferences. Hosts supply storage; React hooks stay in clients.
import type { SkinTone } from "./catalog";

export const EMOJI_FREQUENCY_LIMIT = 32;
export type EmojiCounts = Record<string, number>;
export interface EmojiPreferenceStorage {
  read(): string | null | undefined;
  write(value: string | null): void;
}

export function parseEmojiCounts(raw: string | null | undefined): EmojiCounts {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([glyph, value]) =>
          glyph.length > 0 &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0
      )
    );
  } catch {
    return {};
  }
}

export function mergeEmojiRanking(
  ranked: readonly string[],
  seed: readonly string[],
  limit: number
): string[] {
  return [...new Set([...ranked, ...seed])].slice(0, Math.max(0, limit));
}

export function parseSkinTone(raw: string | null | undefined): SkinTone {
  return raw === "1" || raw === "2" || raw === "3" || raw === "4" || raw === "5"
    ? (Number(raw) as SkinTone)
    : 0;
}

const EMPTY: readonly string[] = Object.freeze([]);

/** Frequency, never recency. Snapshots remain referentially stable between writes. */
export function createEmojiFrequencyStore(storage: EmojiPreferenceStorage) {
  let counts: EmojiCounts;
  try {
    counts = parseEmojiCounts(storage.read());
  } catch {
    counts = {};
  }
  let ranking: readonly string[] = EMPTY;
  const listeners = new Set<() => void>();
  const rebuild = () => {
    const next = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([glyph]) => glyph);
    ranking = next.length ? next : EMPTY;
  };
  rebuild();
  const emit = () => {
    rebuild();
    for (const listener of listeners) listener();
  };
  const persist = (value: string | null) => {
    try {
      storage.write(value);
    } catch {
      /* A full device must not prevent picking. */
    }
  };
  return {
    record(glyph: string) {
      if (!glyph) return;
      counts = { ...counts, [glyph]: (counts[glyph] ?? 0) + 1 };
      persist(JSON.stringify(counts));
      emit();
    },
    frequency: (glyph: string) => counts[glyph] ?? 0,
    frequent: (limit = EMOJI_FREQUENCY_LIMIT, seed: readonly string[] = []) =>
      mergeEmojiRanking(ranking, seed, limit),
    snapshot: () => ranking,
    serverSnapshot: () => EMPTY,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      counts = {};
      persist(null);
      emit();
    },
  };
}

export function createEmojiSkinToneStore(storage: EmojiPreferenceStorage) {
  let tone: SkinTone;
  try {
    tone = parseSkinTone(storage.read());
  } catch {
    tone = 0;
  }
  const listeners = new Set<() => void>();
  return {
    snapshot: () => tone,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: SkinTone) {
      if (tone === next) return;
      tone = next;
      try {
        storage.write(next === 0 ? null : String(next));
      } catch {
        /* Keep the session's choice. */
      }
      for (const listener of listeners) listener();
    },
    reset() {
      tone = 0;
      try {
        storage.write(null);
      } catch {
        /* Device preferences are best effort. */
      }
      for (const listener of listeners) listener();
    },
  };
}
