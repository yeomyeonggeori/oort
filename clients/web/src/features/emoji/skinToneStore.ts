import { useCallback, useSyncExternalStore } from "react";
import type { SkinTone } from "@momo/core/features/emoji/catalog";
import { createEmojiSkinToneStore } from "@momo/core/features/emoji/preferences";
export const EMOJI_SKIN_STORAGE_KEY = "momo.web.emoji.skin.v1";
const store = createEmojiSkinToneStore({
  read: () =>
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(EMOJI_SKIN_STORAGE_KEY),
  write: (value) => {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(EMOJI_SKIN_STORAGE_KEY);
    else localStorage.setItem(EMOJI_SKIN_STORAGE_KEY, value);
  },
});
export const getEmojiSkinTone = store.snapshot;
export const setEmojiSkinTone = store.set;
export const subscribeEmojiSkinTone = store.subscribe;
export const resetEmojiSkinToneForTests = store.reset;

export function useEmojiSkinTone(): [SkinTone, (next: SkinTone) => void] {
  const value = useSyncExternalStore(
    subscribeEmojiSkinTone,
    getEmojiSkinTone,
    (): SkinTone => 0
  );
  const set = useCallback((next: SkinTone) => {
    setEmojiSkinTone(next);
  }, []);
  return [value, set];
}
