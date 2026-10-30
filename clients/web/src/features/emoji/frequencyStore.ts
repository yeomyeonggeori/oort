import { useMemo, useSyncExternalStore } from "react";
import {
  createEmojiFrequencyStore,
  mergeEmojiRanking,
  EMOJI_FREQUENCY_LIMIT,
} from "@momo/core/features/emoji/preferences";
export { EMOJI_FREQUENCY_LIMIT } from "@momo/core/features/emoji/preferences";
export const EMOJI_FREQUENCY_STORAGE_KEY = "momo.web.emoji.frequency.v1";
const store = createEmojiFrequencyStore({
  read: () =>
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(EMOJI_FREQUENCY_STORAGE_KEY),
  write: (value) => {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(EMOJI_FREQUENCY_STORAGE_KEY);
    else localStorage.setItem(EMOJI_FREQUENCY_STORAGE_KEY, value);
  },
});
export const recordEmojiUse = store.record;
export const getEmojiFrequency = store.frequency;
export const frequentEmojis = store.frequent;
export const getEmojiRankingSnapshot = store.snapshot;
export const subscribeEmojiFrequency = store.subscribe;
export const resetEmojiFrequencyForTests = store.reset;

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
    store.serverSnapshot
  );
  return useMemo(
    () => mergeEmojiRanking(ranking, seed, limit),
    [ranking, seed, limit]
  );
}
